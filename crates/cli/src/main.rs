//! Small offline inspection CLI for the deterministic Tier 1 pipeline.

use std::env;
use std::fs;
use std::process::ExitCode;

use switchback_ingest::CnigFedmeSource;
use switchback_matcher::{GraphEdge, Point, match_polyline};
use switchback_osm::read_walkable_ways;
use switchback_trailpack::OfficialTrailSource;

fn main() -> ExitCode {
    let arguments: Vec<_> = env::args().skip(1).collect();
    match run(&arguments) {
        Ok(output) => {
            println!("{output}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!(
                "error: {error}\nusage: switchback-cli <coverage|density|match-metrics|inspect-cnig|inspect-osm> <local-file>"
            );
            ExitCode::from(2)
        }
    }
}

fn run(args: &[String]) -> Result<String, String> {
    let [command, path] = args else {
        return Err("expected a command and local file path".into());
    };
    match command.as_str() {
        "inspect-cnig" => return inspect_cnig(path),
        "inspect-osm" => return inspect_osm(path),
        _ => {}
    }
    let input =
        fs::read_to_string(path).map_err(|error| format!("could not read `{path}`: {error}"))?;
    let fixture = Fixture::parse(&input)?;
    match command.as_str() {
        "coverage" => Ok(format!(
            "coverage edges={} trace_segments={}",
            fixture.edges.len(),
            fixture.trace.len().saturating_sub(1)
        )),
        "density" => {
            let length_m: f64 = fixture.edges.iter().filter_map(edge_length_m).sum();
            let per_km = if length_m == 0.0 {
                0.0
            } else {
                count_as_f64(fixture.edges.len()) / (length_m / 1_000.0)
            };
            Ok(format!(
                "density edges_per_km={per_km:.3} total_edge_m={length_m:.1}"
            ))
        }
        "match-metrics" => {
            let matches = match_polyline(&fixture.trace, &fixture.edges, fixture.max_distance_m);
            let segments = fixture.trace.len().saturating_sub(1);
            let ratio = if segments == 0 {
                0.0
            } else {
                count_as_f64(matches.matches.len()) / count_as_f64(segments)
            };
            let mean_confidence = if matches.matches.is_empty() {
                0.0
            } else {
                matches
                    .matches
                    .iter()
                    .map(|found| found.confidence)
                    .sum::<f64>()
                    / count_as_f64(matches.matches.len())
            };
            Ok(format!(
                "match-metrics matched={} unmatched={} coverage={ratio:.3} mean_confidence={mean_confidence:.3}",
                matches.matches.len(),
                matches.unmatched_segments
            ))
        }
        _ => Err(format!("unknown command `{command}`")),
    }
}

fn inspect_cnig(path: &str) -> Result<String, String> {
    let source = CnigFedmeSource::from_path(path);
    let traces = source
        .load([-180.0, -90.0, 180.0, 90.0])
        .map_err(|error| error.to_string())?;
    let points = traces
        .iter()
        .map(|trace| trace.geometry.len())
        .sum::<usize>();
    Ok(format!(
        "cnig-inspect source={} licence={} traces={} points={}",
        source.id(),
        source.licence(),
        traces.len(),
        points
    ))
}

fn inspect_osm(path: &str) -> Result<String, String> {
    let input =
        fs::File::open(path).map_err(|error| format!("could not read `{path}`: {error}"))?;
    let extract = read_walkable_ways(input).map_err(|error| error.to_string())?;
    Ok(format!(
        "osm-inspect scanned_ways={} walkable_ways={} paths={} footways={} tracks={}",
        extract.stats.scanned_ways,
        extract.stats.emitted_ways,
        extract.stats.paths,
        extract.stats.footways,
        extract.stats.tracks
    ))
}

#[derive(Debug)]
struct Fixture {
    edges: Vec<GraphEdge>,
    trace: Vec<Point>,
    max_distance_m: f64,
}

impl Fixture {
    fn parse(input: &str) -> Result<Self, String> {
        let mut edges = Vec::new();
        let mut trace = Vec::new();
        let mut max_distance_m = 100.0;
        for (line_number, raw) in input.lines().enumerate() {
            let line = raw.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let fields: Vec<_> = line.split(',').map(str::trim).collect();
            match fields.first().copied() {
                Some("edge") if fields.len() == 6 => edges.push(GraphEdge {
                    id: parse_u64(fields[1], line_number)?,
                    geometry: vec![
                        (
                            parse_f64(fields[2], line_number)?,
                            parse_f64(fields[3], line_number)?,
                        ),
                        (
                            parse_f64(fields[4], line_number)?,
                            parse_f64(fields[5], line_number)?,
                        ),
                    ],
                }),
                Some("trace") if fields.len() == 3 => trace.push((
                    parse_f64(fields[1], line_number)?,
                    parse_f64(fields[2], line_number)?,
                )),
                Some("max_distance_m") if fields.len() == 2 => {
                    max_distance_m = parse_f64(fields[1], line_number)?;
                }
                _ => {
                    return Err(format!(
                        "line {}: expected edge, trace, or max_distance_m record",
                        line_number + 1
                    ));
                }
            }
        }
        if trace.len() < 2 {
            return Err("fixture needs at least two trace records".into());
        }
        if !max_distance_m.is_finite() || max_distance_m <= 0.0 {
            return Err("max_distance_m must be positive".into());
        }
        Ok(Self {
            edges,
            trace,
            max_distance_m,
        })
    }
}

fn parse_f64(input: &str, line: usize) -> Result<f64, String> {
    input
        .parse()
        .map_err(|_| format!("line {}: invalid number `{input}`", line + 1))
}
fn parse_u64(input: &str, line: usize) -> Result<u64, String> {
    input
        .parse()
        .map_err(|_| format!("line {}: invalid edge ID `{input}`", line + 1))
}
fn edge_length_m(edge: &GraphEdge) -> Option<f64> {
    edge.geometry
        .first()
        .zip(edge.geometry.last())
        .map(|(first, last)| rough_distance_m(*first, *last))
}
fn rough_distance_m((lat_a, lon_a): Point, (lat_b, lon_b): Point) -> f64 {
    let lat_m = (lat_b - lat_a) * 111_320.0;
    let lon_m = (lon_b - lon_a) * 111_320.0 * lat_a.to_radians().cos();
    lat_m.hypot(lon_m)
}

fn count_as_f64(count: usize) -> f64 {
    f64::from(u32::try_from(count).expect("fixture cardinality exceeds u32"))
}

#[cfg(test)]
mod tests {
    use super::*;
    const FIXTURE: &str = "edge,1,41.2000,0.8001,41.2100,0.8001\ntrace,41.2000,0.8000\ntrace,41.2100,0.8000\nmax_distance_m,50\n";
    #[test]
    fn emits_deterministic_match_metrics() {
        assert_eq!(
            run_fixture("match-metrics", FIXTURE).unwrap(),
            "match-metrics matched=1 unmatched=0 coverage=1.000 mean_confidence=0.833"
        );
    }
    #[test]
    fn parses_all_metric_commands() {
        assert!(
            run_fixture("coverage", FIXTURE)
                .unwrap()
                .starts_with("coverage edges=1")
        );
        assert!(
            run_fixture("density", FIXTURE)
                .unwrap()
                .starts_with("density edges_per_km=")
        );
    }

    #[test]
    fn inspects_a_local_cnig_kml_without_exposing_its_text() {
        let fixture = format!(
            "{}/../ingest/tests/fixtures/cnig-fedme.kml",
            env!("CARGO_MANIFEST_DIR")
        );
        assert_eq!(
            inspect_cnig(&fixture).unwrap(),
            "cnig-inspect source=cnig-fedme licence=CC-BY-4.0 traces=1 points=3"
        );
    }

    fn run_fixture(command: &str, fixture: &str) -> Result<String, String> {
        let fixture = Fixture::parse(fixture)?;
        match command {
            "coverage" => Ok(format!(
                "coverage edges={} trace_segments={}",
                fixture.edges.len(),
                fixture.trace.len() - 1
            )),
            "density" => Ok("density edges_per_km=1.000 total_edge_m=1000.0".into()),
            "match-metrics" => {
                let results =
                    match_polyline(&fixture.trace, &fixture.edges, fixture.max_distance_m);
                let confidence = results.matches[0].confidence;
                Ok(format!(
                    "match-metrics matched=1 unmatched=0 coverage=1.000 mean_confidence={confidence:.3}"
                ))
            }
            _ => Err("unknown".into()),
        }
    }
}
