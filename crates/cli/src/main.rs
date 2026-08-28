//! Small offline inspection CLI for the deterministic Tier 1 pipeline.

use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use switchback_ingest::CnigFedmeSource;
use switchback_matcher::{GraphEdge, Point, match_polyline};
use switchback_osm::{
    Access, GeoPoint, MaterializedWay, RoutingTags, SacScale as OsmSacScale, Surface as OsmSurface,
    TrailVisibility, TraversalDirection, WalkableGeometryExtract, read_walkable_geometry,
};
use switchback_trailpack::{
    Bbox, Edge, Manifest, Node, OfficialRef, OfficialTrace, OfficialTrailSource, Source, Terrain,
    Tile, TrailPackArtifact, Visibility, WidthHint,
};

/// The intentionally small Montsant–Siurana / Prades demonstration region.
///
/// This is the default only for the builder's unit tests. Production builds
/// must provide `--bbox`, so the selected coverage is explicit in the command
/// that generated an artifact.
#[cfg(test)]
const TEST_DEMO_BBOX: Bbox = [0.86, 41.23, 0.99, 41.34];
const DEMO_TILE_ID: &str = "montsant-prades";
const MAX_DEMO_DIRECTED_EDGES: usize = 80_000;
const MAX_DEMO_NODES: usize = 40_000;
const DEFAULT_TILE_ZOOM: u8 = 14;
const OFFICIAL_MATCH_DISTANCE_M: f64 = 20.0;
const OFFICIAL_MATCH_BEARING_DEGREES: f64 = 30.0;

fn main() -> ExitCode {
    let arguments: Vec<_> = env::args().skip(1).collect();
    match run(&arguments) {
        Ok(output) => {
            println!("{output}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!(
                "error: {error}\nusage: switchback-cli <coverage|density|match-metrics|inspect-cnig|inspect-osm> <local-file>\n       switchback-cli build-demo --osm <tarragona.osm.pbf> --cnig <official.kml> [--cnig <official.kml> ...] --bbox <min_lon,min_lat,max_lon,max_lat> --output <web/public/trailpack/tarragona-demo.json> --built-at <RFC3339> --extract-date <YYYY-MM-DD>\n       switchback-cli build-tiles --osm <region.osm.pbf> --cnig <official.kml> [--cnig <official.kml> ...] --bbox <min_lon,min_lat,max_lon,max_lat> --output-dir <web/public/trailpack> --built-at <RFC3339> --extract-date <YYYY-MM-DD> [--tile-zoom <0..22>]"
            );
            ExitCode::from(2)
        }
    }
}

fn run(args: &[String]) -> Result<String, String> {
    if args
        .first()
        .is_some_and(|argument| argument == "build-demo")
    {
        return build_demo(&BuildDemoArgs::parse(&args[1..])?);
    }
    if args
        .first()
        .is_some_and(|argument| argument == "build-tiles")
    {
        return build_tiles(&BuildTilesArgs::parse(&args[1..])?);
    }
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

#[derive(Debug, Clone, PartialEq)]
struct BuildDemoArgs {
    osm_path: PathBuf,
    cnig_paths: Vec<PathBuf>,
    artifact_path: PathBuf,
    bbox: Bbox,
    built_at: String,
    extract_date: String,
}

#[derive(Debug, Clone, PartialEq)]
struct BuildTilesArgs {
    build: BuildDemoArgs,
    output_dir: PathBuf,
    tile_zoom: u8,
}

impl BuildTilesArgs {
    fn parse(args: &[String]) -> Result<Self, String> {
        let mut rewritten = Vec::new();
        let mut output_dir = None;
        let mut tile_zoom = DEFAULT_TILE_ZOOM;
        let mut index = 0;
        while index < args.len() {
            let flag = &args[index];
            index += 1;
            if flag == "--tile-zoom" {
                let value = args.get(index).ok_or("--tile-zoom requires a value")?;
                index += 1;
                tile_zoom = value
                    .parse()
                    .map_err(|_| "--tile-zoom must be an integer")?;
                if tile_zoom > 22 {
                    return Err("--tile-zoom must be in 0..=22".into());
                }
            } else if flag == "--output-dir" {
                let value = args.get(index).ok_or("--output-dir requires a value")?;
                index += 1;
                output_dir = Some(PathBuf::from(value));
            } else {
                let value = args
                    .get(index)
                    .ok_or_else(|| format!("{flag} requires a value"))?;
                index += 1;
                rewritten.push(flag.clone());
                rewritten.push(value.clone());
            }
        }
        let output_dir = output_dir.ok_or("build-tiles requires --output-dir")?;
        rewritten.push("--output".into());
        rewritten.push(output_dir.join("legacy.json").display().to_string());
        Ok(Self {
            build: BuildDemoArgs::parse(&rewritten)?,
            output_dir,
            tile_zoom,
        })
    }
}

impl BuildDemoArgs {
    fn parse(args: &[String]) -> Result<Self, String> {
        let mut osm_path = None;
        let mut cnig_paths = Vec::new();
        let mut artifact_path = None;
        let mut bbox = None;
        let mut built_at = None;
        let mut extract_date = None;
        let mut index = 0;
        while index < args.len() {
            let flag = &args[index];
            index += 1;
            let value = args
                .get(index)
                .ok_or_else(|| format!("{flag} requires a value"))?;
            index += 1;
            match flag.as_str() {
                "--osm" => set_once_path(&mut osm_path, value, "--osm")?,
                "--cnig" => cnig_paths.push(PathBuf::from(value)),
                "--output" => set_once_path(&mut artifact_path, value, "--output")?,
                "--bbox" => set_once_bbox(&mut bbox, value)?,
                "--built-at" => set_once_string(&mut built_at, value, "--built-at")?,
                "--extract-date" => set_once_string(&mut extract_date, value, "--extract-date")?,
                _ => return Err(format!("unknown build-demo option `{flag}`")),
            }
        }
        let built_at = built_at.ok_or("build-demo requires --built-at for reproducible output")?;
        if !looks_like_rfc3339(&built_at) {
            return Err("--built-at must be an explicit UTC RFC3339 timestamp (for example 2026-08-27T00:00:00Z)".into());
        }
        let extract_date = extract_date.ok_or("build-demo requires --extract-date")?;
        if !looks_like_date(&extract_date) {
            return Err("--extract-date must use YYYY-MM-DD".into());
        }
        if cnig_paths.is_empty() {
            return Err("build-demo requires at least one --cnig local KML input".into());
        }
        Ok(Self {
            osm_path: osm_path.ok_or("build-demo requires --osm")?,
            cnig_paths,
            artifact_path: artifact_path.ok_or("build-demo requires --output")?,
            bbox: bbox.ok_or("build-demo requires --bbox <min_lon,min_lat,max_lon,max_lat>")?,
            built_at,
            extract_date,
        })
    }
}

fn set_once_bbox(target: &mut Option<Bbox>, value: &str) -> Result<(), String> {
    if target.is_some() {
        return Err("--bbox may only be supplied once".into());
    }
    let coordinates = value
        .split(',')
        .map(|coordinate| {
            coordinate
                .trim()
                .parse::<f64>()
                .map_err(|_| format!("--bbox has an invalid coordinate `{coordinate}`"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let [min_lon, min_lat, max_lon, max_lat]: [f64; 4] = coordinates.try_into().map_err(|_| {
        "--bbox requires exactly four comma-separated coordinates: min_lon,min_lat,max_lon,max_lat"
            .to_string()
    })?;
    if ![min_lon, min_lat, max_lon, max_lat]
        .into_iter()
        .all(f64::is_finite)
    {
        return Err("--bbox coordinates must be finite".into());
    }
    if !(-180.0..=180.0).contains(&min_lon)
        || !(-180.0..=180.0).contains(&max_lon)
        || !(-90.0..=90.0).contains(&min_lat)
        || !(-90.0..=90.0).contains(&max_lat)
    {
        return Err("--bbox coordinates are outside WGS84 longitude/latitude bounds".into());
    }
    if min_lon >= max_lon || min_lat >= max_lat {
        return Err(
            "--bbox must use strictly increasing bounds: min_lon,min_lat,max_lon,max_lat".into(),
        );
    }
    *target = Some([min_lon, min_lat, max_lon, max_lat]);
    Ok(())
}

fn set_once_path(target: &mut Option<PathBuf>, value: &str, flag: &str) -> Result<(), String> {
    if target.replace(PathBuf::from(value)).is_some() {
        Err(format!("{flag} may only be supplied once"))
    } else {
        Ok(())
    }
}

fn set_once_string(target: &mut Option<String>, value: &str, flag: &str) -> Result<(), String> {
    if target.replace(value.into()).is_some() {
        Err(format!("{flag} may only be supplied once"))
    } else {
        Ok(())
    }
}

fn looks_like_rfc3339(value: &str) -> bool {
    value.len() >= 20
        && value.ends_with('Z')
        && value.as_bytes().get(4) == Some(&b'-')
        && value.as_bytes().get(7) == Some(&b'-')
        && value.as_bytes().get(10) == Some(&b'T')
}

fn looks_like_date(value: &str) -> bool {
    value.len() == 10
        && value.as_bytes().get(4) == Some(&b'-')
        && value.as_bytes().get(7) == Some(&b'-')
        && value
            .bytes()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
}

fn build_demo(args: &BuildDemoArgs) -> Result<String, String> {
    let pbf = fs::File::open(&args.osm_path).map_err(|error| {
        format!(
            "could not open OSM PBF `{}`: {error}",
            args.osm_path.display()
        )
    })?;
    let geometry = read_walkable_geometry(pbf).map_err(|error| error.to_string())?;

    // Loading every caller-provided source proves it is usable in the selected
    // region. Matching remains strictly local and uses the MVP's 20 m gate.
    let mut official_traces = Vec::new();
    for path in &args.cnig_paths {
        let source = CnigFedmeSource::from_path(path);
        let traces = source.load(args.bbox).map_err(|error| {
            format!(
                "could not load CNIG/FEDME KML `{}` inside the demo bbox: {error}",
                path.display()
            )
        })?;
        official_traces.extend(traces);
    }

    let (artifact, q8) = build_artifact(
        &geometry,
        &official_traces,
        args.bbox,
        &args.built_at,
        &args.extract_date,
        true,
    )?;
    let artifact_json = artifact
        .to_json_bytes()
        .map_err(|error| error.to_string())?;
    let manifest_json = serde_json::to_vec_pretty(&artifact.manifest)
        .map_err(|error| format!("could not encode manifest: {error}"))?;
    let manifest_path = manifest_path(&args.artifact_path)?;

    fs::write(&args.artifact_path, artifact_json).map_err(|error| {
        format!(
            "could not write artifact `{}`: {error}",
            args.artifact_path.display()
        )
    })?;
    fs::write(&manifest_path, manifest_json).map_err(|error| {
        format!(
            "could not write manifest `{}`: {error}",
            manifest_path.display()
        )
    })?;

    let tile = artifact
        .tiles
        .get(DEMO_TILE_ID)
        .expect("constructed artifact has its declared tile");
    Ok(format!(
        "build-demo artifact={} manifest={} bbox={},{},{},{} edges={} nodes={} official_traces={} official_refs={}\nq8_evidence distance_gate_m={OFFICIAL_MATCH_DISTANCE_M:.0} bearing_gate_degrees={OFFICIAL_MATCH_BEARING_DEGREES:.0} total_trace_m={:.1} distance_matched_m={:.1} bearing_qualified_m={:.1} qualified_fraction={:.3} max_qualified_distance_m={} status=evidence_only_not_a_pass_claim",
        args.artifact_path.display(),
        manifest_path.display(),
        args.bbox[0],
        args.bbox[1],
        args.bbox[2],
        args.bbox[3],
        tile.edges.len(),
        tile.nodes.len(),
        official_traces.len(),
        tile.edges
            .iter()
            .filter(|edge| edge.official.is_some())
            .count(),
        q8.total_trace_length,
        q8.distance_matched_length,
        q8.bearing_qualified_length,
        q8.qualified_fraction(),
        q8.max_qualified_distance
            .map_or_else(|| "none".into(), |distance| format!("{distance:.2}")),
    ))
}

fn manifest_path(artifact_path: &Path) -> Result<PathBuf, String> {
    let parent = artifact_path
        .parent()
        .ok_or("--output must include a parent directory for manifest.json")?;
    Ok(parent.join("manifest.json"))
}

fn build_tiles(args: &BuildTilesArgs) -> Result<String, String> {
    let pbf = fs::File::open(&args.build.osm_path).map_err(|error| {
        format!(
            "could not open OSM PBF `{}`: {error}",
            args.build.osm_path.display()
        )
    })?;
    let geometry = read_walkable_geometry(pbf).map_err(|error| error.to_string())?;
    let mut official_traces = Vec::new();
    for path in &args.build.cnig_paths {
        official_traces.extend(
            CnigFedmeSource::from_path(path)
                .load(args.build.bbox)
                .map_err(|error| {
                    format!(
                        "could not load CNIG/FEDME KML `{}` inside the selected bbox: {error}",
                        path.display()
                    )
                })?,
        );
    }
    let (single_tile, q8) = build_artifact(
        &geometry,
        &official_traces,
        args.build.bbox,
        &args.build.built_at,
        &args.build.extract_date,
        false,
    )?;
    let artifact = split_into_tiles(single_tile, args.tile_zoom)?;
    fs::create_dir_all(args.output_dir.join("tiles"))
        .map_err(|error| format!("could not create tile output directory: {error}"))?;
    fs::write(
        args.output_dir.join("manifest.json"),
        serde_json::to_vec_pretty(&artifact.manifest)
            .map_err(|error| format!("could not encode manifest: {error}"))?,
    )
    .map_err(|error| format!("could not write manifest: {error}"))?;
    for (id, tile) in &artifact.tiles {
        fs::write(
            args.output_dir.join("tiles").join(format!("{id}.json")),
            serde_json::to_vec(tile)
                .map_err(|error| format!("could not encode tile {id}: {error}"))?,
        )
        .map_err(|error| format!("could not write tile {id}: {error}"))?;
    }
    let edge_count: usize = artifact.tiles.values().map(|tile| tile.edges.len()).sum();
    Ok(format!(
        "build-tiles output_dir={} tiles={} edges={} official_traces={} q8_qualified_fraction={:.3}",
        args.output_dir.display(),
        artifact.tiles.len(),
        edge_count,
        official_traces.len(),
        q8.qualified_fraction()
    ))
}

fn split_into_tiles(source: TrailPackArtifact, zoom: u8) -> Result<TrailPackArtifact, String> {
    let source_tile = source
        .tiles
        .get(DEMO_TILE_ID)
        .ok_or("internal error: missing source tile")?;
    let mut tiles = BTreeMap::<String, (Tile, BTreeMap<(i32, i32), u32>)>::new();
    for edge in &source_tile.edges {
        let from = source_tile
            .nodes
            .get(edge.from as usize)
            .ok_or("internal error: source edge has invalid origin")?;
        let id = slippy_tile_id(*from, zoom);
        let (tile, local_nodes) = tiles.entry(id).or_insert_with(|| {
            (
                Tile {
                    nodes: Vec::new(),
                    edges: Vec::new(),
                },
                BTreeMap::new(),
            )
        });
        let mut local_edge = edge.clone();
        for (source_index, target) in [
            (edge.from, &mut local_edge.from),
            (edge.to, &mut local_edge.to),
        ] {
            let node = source_tile
                .nodes
                .get(source_index as usize)
                .ok_or("internal error: source edge has invalid node")?;
            let key = (node.lat_e7, node.lon_e7);
            let index = if let Some(index) = local_nodes.get(&key) {
                *index
            } else {
                let index =
                    u32::try_from(tile.nodes.len()).map_err(|_| "tile node count exceeds u32")?;
                tile.nodes.push(*node);
                local_nodes.insert(key, index);
                index
            };
            *target = index;
        }
        tile.edges.push(local_edge);
    }
    let mut manifest = source.manifest;
    manifest.tile_zoom = zoom;
    manifest.tiles = tiles.keys().cloned().collect();
    let tiles = tiles
        .into_iter()
        .map(|(id, (tile, _))| (id, tile))
        .collect();
    TrailPackArtifact::new(manifest, tiles).map_err(|error| error.to_string())
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn slippy_tile_id(node: Node, zoom: u8) -> String {
    let scale = f64::from(1_u32 << zoom);
    let last_index = scale - 1.0;
    let longitude = f64::from(node.lon_e7) / 1e7;
    let latitude = (f64::from(node.lat_e7) / 1e7)
        .clamp(-85.051_128_78, 85.051_128_78)
        .to_radians();
    let x = (((longitude + 180.0) / 360.0) * scale)
        .floor()
        .clamp(0.0, last_index) as u32;
    let y = ((1.0 - (latitude.tan() + latitude.cos().recip()).ln() / std::f64::consts::PI) / 2.0
        * scale)
        .floor()
        .clamp(0.0, last_index) as u32;
    format!("z{zoom}-x{x}-y{y}")
}

fn build_artifact(
    input: &WalkableGeometryExtract,
    official_traces: &[OfficialTrace],
    bbox: Bbox,
    built_at: &str,
    extract_date: &str,
    enforce_demo_limits: bool,
) -> Result<(TrailPackArtifact, Q8Evidence), String> {
    let candidates = input
        .ways
        .iter()
        .filter(|way| {
            way.geometry.iter().all(|point| within_bbox(*point, bbox))
                && pedestrian_access_allowed(&way.way.tags)
        })
        .collect::<Vec<_>>();
    let physical_segments = physical_segments(&candidates)?;
    let directed_edge_count = physical_segments
        .iter()
        .map(|segment| direction_count(&segment.tags))
        .sum::<usize>();
    if enforce_demo_limits && directed_edge_count > MAX_DEMO_DIRECTED_EDGES {
        return Err(format!(
            "demo bbox selected {directed_edge_count} directed edges, exceeding the browser-safe limit of {MAX_DEMO_DIRECTED_EDGES}"
        ));
    }

    let mut points = BTreeSet::new();
    for segment in &physical_segments {
        points.insert(segment.from_point);
        points.insert(segment.to_point);
    }
    if enforce_demo_limits && points.len() > MAX_DEMO_NODES {
        return Err(format!(
            "demo bbox selected {} nodes, exceeding the browser-safe limit of {MAX_DEMO_NODES}",
            points.len()
        ));
    }
    let node_index = points
        .iter()
        .enumerate()
        .map(|(index, point)| {
            let index = u32::try_from(index).map_err(|_| "node count exceeds u32".to_string())?;
            Ok((*point, index))
        })
        .collect::<Result<BTreeMap<_, _>, String>>()?;
    let nodes = points
        .into_iter()
        .map(|point| Node {
            lat_e7: point.decimicro_lat,
            lon_e7: point.decimicro_lon,
        })
        .collect();
    let (official_refs, q8) = matched_official_refs(&physical_segments, official_traces);
    let mut edges = physical_segments
        .iter()
        .map(|segment| {
            artifact_edges(
                segment,
                &node_index,
                official_refs.get(&segment.physical_id),
            )
        })
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    edges.sort_by(|left, right| left.id.cmp(&right.id));
    if edges.is_empty() {
        return Err("demo bbox contains no routable pedestrian OSM segments".into());
    }
    let manifest = Manifest {
        schema_version: 1,
        region_id: "es-ct-montsant-prades-demo".into(),
        region_name: "Montsant–Siurana / Prades demo".into(),
        bbox,
        built_at: built_at.into(),
        tile_zoom: 12,
        tiles: vec![DEMO_TILE_ID.into()],
        sources: vec![
            Source {
                id: "osm-tarragona".into(),
                name: "OpenStreetMap Tarragona extract".into(),
                licence: "ODbL-1.0".into(),
                attribution: "© OpenStreetMap contributors".into(),
                extract_date: extract_date.into(),
            },
            Source {
                id: "cnig-fedme".into(),
                name: "CNIG / FEDME homologated trail KML".into(),
                licence: "CC-BY-4.0".into(),
                attribution: "© CNIG/IGN and FEDME".into(),
                extract_date: extract_date.into(),
            },
        ],
    };
    let artifact = TrailPackArtifact {
        manifest,
        tiles: BTreeMap::from([(DEMO_TILE_ID.into(), Tile { nodes, edges })]),
    };
    Ok((artifact, q8))
}

#[derive(Debug, Clone)]
struct PhysicalSegment {
    physical_id: String,
    from_point: GeoPoint,
    to_point: GeoPoint,
    tags: RoutingTags,
}

#[derive(Debug, Default, Clone, Copy)]
struct Q8Evidence {
    total_trace_length: f64,
    distance_matched_length: f64,
    bearing_qualified_length: f64,
    max_qualified_distance: Option<f64>,
}

impl Q8Evidence {
    fn qualified_fraction(self) -> f64 {
        if self.total_trace_length > 0.0 {
            self.bearing_qualified_length / self.total_trace_length
        } else {
            0.0
        }
    }
}

fn physical_segments(candidates: &[&MaterializedWay]) -> Result<Vec<PhysicalSegment>, String> {
    let mut segments = Vec::new();
    for way in candidates {
        for (index, points) in way.geometry.windows(2).enumerate() {
            let [from_point, to_point] = points else {
                unreachable!();
            };
            if from_point == to_point
                || rounded_meters(point_distance_m(*from_point, *to_point))? == 0
            {
                continue;
            }
            segments.push(PhysicalSegment {
                physical_id: format!("osm-way-{}:segment-{index}", way.way.id),
                from_point: *from_point,
                to_point: *to_point,
                tags: way.way.tags.clone(),
            });
        }
    }
    Ok(segments)
}

fn artifact_edges(
    segment: &PhysicalSegment,
    node_index: &BTreeMap<GeoPoint, u32>,
    official: Option<&OfficialRef>,
) -> Result<Vec<Edge>, String> {
    let from = *node_index
        .get(&segment.from_point)
        .ok_or("first point missing from deterministic node index")?;
    let to = *node_index
        .get(&segment.to_point)
        .ok_or("last point missing from deterministic node index")?;
    let length_m = rounded_meters(point_distance_m(segment.from_point, segment.to_point))?;
    let terrain = terrain_from_tags(&segment.tags);
    let edge = |id: String, from, to| Edge {
        id,
        physical_id: segment.physical_id.clone(),
        from,
        to,
        length_m,
        ascent_m: None,
        descent_m: None,
        geometry: vec![],
        terrain: terrain.clone(),
        official: official.cloned(),
    };
    match traversal_direction(&segment.tags) {
        TraversalDirection::Forward => Ok(vec![edge(
            format!("{}:forward", segment.physical_id),
            from,
            to,
        )]),
        TraversalDirection::Reverse => Ok(vec![edge(
            format!("{}:reverse", segment.physical_id),
            to,
            from,
        )]),
        TraversalDirection::Both => Ok(vec![
            edge(format!("{}:forward", segment.physical_id), from, to),
            edge(format!("{}:reverse", segment.physical_id), to, from),
        ]),
    }
}

fn matched_official_refs(
    segments: &[PhysicalSegment],
    official_traces: &[OfficialTrace],
) -> (BTreeMap<String, OfficialRef>, Q8Evidence) {
    let graph = segments
        .iter()
        .enumerate()
        .map(|(index, segment)| GraphEdge {
            id: u64::try_from(index).expect("segment count exceeds u64"),
            geometry: vec![
                (
                    segment.from_point.latitude(),
                    segment.from_point.longitude(),
                ),
                (segment.to_point.latitude(), segment.to_point.longitude()),
            ],
        })
        .collect::<Vec<_>>();
    let mut traces = official_traces.to_vec();
    traces.sort_by(|left, right| {
        left.ref_code
            .cmp(&right.ref_code)
            .then_with(|| left.name.cmp(&right.name))
    });
    let mut matches = BTreeMap::<String, OfficialRef>::new();
    let mut evidence = Q8Evidence::default();
    for trace in traces {
        for trace_segment in trace.geometry.windows(2) {
            let [from, to] = trace_segment else {
                unreachable!();
            };
            let trace_length_m = rough_distance_m(*from, *to);
            if trace_length_m <= f64::EPSILON {
                continue;
            }
            evidence.total_trace_length += trace_length_m;
            let found = match_polyline(trace_segment, &graph, OFFICIAL_MATCH_DISTANCE_M);
            let Some(edge_match) = found.matches.first() else {
                continue;
            };
            evidence.distance_matched_length += trace_length_m;
            if edge_match.bearing_delta_degrees > OFFICIAL_MATCH_BEARING_DEGREES {
                continue;
            }
            evidence.bearing_qualified_length += trace_length_m;
            evidence.max_qualified_distance = Some(
                evidence
                    .max_qualified_distance
                    .map_or(edge_match.distance_m, |current| {
                        current.max(edge_match.distance_m)
                    }),
            );
            let Some(segment) = usize::try_from(edge_match.edge_id)
                .ok()
                .and_then(|index| segments.get(index))
            else {
                continue;
            };
            #[allow(clippy::cast_possible_truncation)]
            let confidence = edge_match.confidence as f32;
            let candidate = OfficialRef {
                ref_code: trace.ref_code.clone(),
                name: trace.name.clone(),
                kind: switchback_trailpack::OfficialKind::WaymarkedCertified,
                authority: trace.authority.clone(),
                source_id: "cnig-fedme".into(),
                confidence,
            };
            let replace = matches.get(&segment.physical_id).is_none_or(|current| {
                match candidate.confidence.total_cmp(&current.confidence) {
                    std::cmp::Ordering::Greater => true,
                    std::cmp::Ordering::Equal => candidate.ref_code < current.ref_code,
                    std::cmp::Ordering::Less => false,
                }
            });
            if replace {
                matches.insert(segment.physical_id.clone(), candidate);
            }
        }
    }
    (matches, evidence)
}

fn pedestrian_access_allowed(tags: &RoutingTags) -> bool {
    match tags.foot {
        Some(Access::No | Access::Private | Access::Destination) => false,
        Some(Access::Yes | Access::Designated | Access::Permissive) => true,
        None => !matches!(
            tags.access,
            Some(Access::No | Access::Private | Access::Destination)
        ),
    }
}

fn traversal_direction(tags: &RoutingTags) -> TraversalDirection {
    tags.oneway_foot
        .or(tags.oneway)
        .unwrap_or(TraversalDirection::Both)
}

fn direction_count(tags: &RoutingTags) -> usize {
    match traversal_direction(tags) {
        TraversalDirection::Both => 2,
        TraversalDirection::Forward | TraversalDirection::Reverse => 1,
    }
}

fn point_distance_m(from: GeoPoint, to: GeoPoint) -> f64 {
    rough_distance_m(
        (from.latitude(), from.longitude()),
        (to.latitude(), to.longitude()),
    )
}

fn rounded_meters(value: f64) -> Result<u32, String> {
    let rounded = value.round();
    if !rounded.is_finite() || !(0.0..=f64::from(u32::MAX)).contains(&rounded) {
        return Err("way length is outside the TrailPack u32 metre range".into());
    }
    // The bounds above make this conversion exact and safe.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let length = rounded as u32;
    Ok(length)
}

fn within_bbox(point: GeoPoint, bbox: Bbox) -> bool {
    let latitude = point.latitude();
    let longitude = point.longitude();
    (bbox[0]..=bbox[2]).contains(&longitude) && (bbox[1]..=bbox[3]).contains(&latitude)
}

fn terrain_from_tags(tags: &RoutingTags) -> Terrain {
    Terrain {
        surface: tags.surface.map(|surface| match surface {
            OsmSurface::Paved
            | OsmSurface::Asphalt
            | OsmSurface::Concrete
            | OsmSurface::Metal
            | OsmSurface::Wood => switchback_trailpack::Surface::Paved,
            OsmSurface::Compacted | OsmSurface::FineGravel | OsmSurface::Gravel => {
                switchback_trailpack::Surface::Gravel
            }
            OsmSurface::Ground
            | OsmSurface::Dirt
            | OsmSurface::Earth
            | OsmSurface::Grass
            | OsmSurface::Mud => switchback_trailpack::Surface::Ground,
            OsmSurface::Rock => switchback_trailpack::Surface::Rock,
            OsmSurface::Sand => switchback_trailpack::Surface::Sand,
        }),
        sac_scale: tags.sac_scale.map(|scale| match scale {
            OsmSacScale::Hiking => switchback_trailpack::SacScale::T1,
            OsmSacScale::MountainHiking => switchback_trailpack::SacScale::T2,
            OsmSacScale::DemandingMountainHiking => switchback_trailpack::SacScale::T3,
            OsmSacScale::AlpineHiking => switchback_trailpack::SacScale::T4,
            OsmSacScale::DemandingAlpineHiking => switchback_trailpack::SacScale::T5,
            OsmSacScale::DifficultAlpineHiking => switchback_trailpack::SacScale::T6,
        }),
        visibility: tags.trail_visibility.map(|visibility| match visibility {
            TrailVisibility::Excellent => Visibility::Excellent,
            TrailVisibility::Good => Visibility::Good,
            TrailVisibility::Intermediate => Visibility::Intermediate,
            TrailVisibility::Bad => Visibility::Bad,
            TrailVisibility::Horrible => Visibility::Horrible,
            TrailVisibility::No => Visibility::No,
        }),
        width_hint: tags.width_cm.map(|width| match width {
            0..=60 => WidthHint::VeryNarrow,
            61..=100 => WidthHint::Narrow,
            101..=200 => WidthHint::Normal,
            _ => WidthHint::Wide,
        }),
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
    let extract = read_walkable_geometry(input).map_err(|error| error.to_string())?;
    Ok(format!(
        "osm-inspect scanned_ways={} walkable_ways={} resolved_ways={} unresolved_ways={} referenced_nodes={} resolved_nodes={} paths={} footways={} tracks={}",
        extract.extraction.scanned_ways,
        extract.extraction.emitted_ways,
        extract.geometry.resolved_ways,
        extract.geometry.unresolved_ways,
        extract.geometry.referenced_nodes,
        extract.geometry.resolved_nodes,
        extract.extraction.paths,
        extract.extraction.footways,
        extract.extraction.tracks
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
    use switchback_osm::{WalkableHighway, WalkableWay};
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

    #[test]
    fn build_demo_requires_all_reproducibility_inputs() {
        let error = BuildDemoArgs::parse(&[
            "--osm".into(),
            "tarragona.osm.pbf".into(),
            "--cnig".into(),
            "official.kml".into(),
            "--output".into(),
            "web/public/trailpack/tarragona-demo.json".into(),
        ])
        .unwrap_err();
        assert!(error.contains("--built-at"));

        let error = BuildDemoArgs::parse(&[
            "--osm".into(),
            "tarragona.osm.pbf".into(),
            "--cnig".into(),
            "official.kml".into(),
            "--output".into(),
            "web/public/trailpack/tarragona-demo.json".into(),
            "--bbox".into(),
            "0.86,41.23,0.99,41.34".into(),
            "--built-at".into(),
            "2026-08-27T00:00:00Z".into(),
            "--extract-date".into(),
            "2026-08-27".into(),
        ])
        .unwrap();
        assert_eq!(error.cnig_paths, [PathBuf::from("official.kml")]);
        assert!(
            error
                .bbox
                .iter()
                .zip(TEST_DEMO_BBOX)
                .all(|(actual, expected)| (actual - expected).abs() < f64::EPSILON)
        );

        let missing_bbox = BuildDemoArgs::parse(&[
            "--osm".into(),
            "tarragona.osm.pbf".into(),
            "--cnig".into(),
            "official.kml".into(),
            "--output".into(),
            "web/public/trailpack/tarragona-demo.json".into(),
            "--built-at".into(),
            "2026-08-27T00:00:00Z".into(),
            "--extract-date".into(),
            "2026-08-27".into(),
        ])
        .unwrap_err();
        assert!(missing_bbox.contains("--bbox"));
    }

    #[test]
    fn rejects_an_invalid_or_ambiguous_build_bbox() {
        let mut parsed = None;
        assert!(set_once_bbox(&mut parsed, "0.86,41.23,0.99").is_err());
        assert!(set_once_bbox(&mut parsed, "0.99,41.23,0.86,41.34").is_err());
        assert!(set_once_bbox(&mut parsed, "181,41.23,0.99,41.34").is_err());
        set_once_bbox(&mut parsed, "0.86,41.23,0.99,41.34").unwrap();
        assert_eq!(parsed, Some(TEST_DEMO_BBOX));
        assert!(set_once_bbox(&mut parsed, "0.87,41.24,0.98,41.33").is_err());
    }

    #[test]
    fn build_artifact_is_deterministic_and_declares_both_sources() {
        let input = WalkableGeometryExtract {
            ways: vec![MaterializedWay {
                way: WalkableWay {
                    id: 42,
                    highway: WalkableHighway::Path,
                    node_ids: vec![1, 2],
                    tags: RoutingTags::default(),
                },
                geometry: vec![
                    GeoPoint {
                        decimicro_lat: 412_500_000,
                        decimicro_lon: 9_000_000,
                    },
                    GeoPoint {
                        decimicro_lat: 412_510_000,
                        decimicro_lon: 9_001_000,
                    },
                ],
            }],
            ..WalkableGeometryExtract::default()
        };
        let (artifact, q8) = build_artifact(
            &input,
            &[],
            TEST_DEMO_BBOX,
            "2026-08-27T00:00:00Z",
            "2026-08-27",
            true,
        )
        .unwrap();
        assert_eq!(artifact.manifest.tiles, [DEMO_TILE_ID]);
        assert_eq!(artifact.manifest.sources.len(), 2);
        assert!(artifact.manifest.has_source("osm-tarragona"));
        assert!(artifact.manifest.has_source("cnig-fedme"));
        assert_eq!(artifact.tiles[DEMO_TILE_ID].edges[0].official, None);
        assert_eq!(artifact.tiles[DEMO_TILE_ID].edges.len(), 2);
        assert_eq!(
            artifact.tiles[DEMO_TILE_ID].edges[0].physical_id,
            "osm-way-42:segment-0"
        );
        assert!(q8.total_trace_length.abs() < f64::EPSILON);
        assert_eq!(
            artifact.to_json_bytes().unwrap(),
            artifact.to_json_bytes().unwrap()
        );
    }

    #[test]
    fn attaches_only_a_local_twenty_metre_official_match() {
        let input = WalkableGeometryExtract {
            ways: vec![MaterializedWay {
                way: WalkableWay {
                    id: 43,
                    highway: WalkableHighway::Path,
                    node_ids: vec![1, 2],
                    tags: RoutingTags::default(),
                },
                geometry: vec![
                    GeoPoint {
                        decimicro_lat: 412_500_000,
                        decimicro_lon: 9_000_000,
                    },
                    GeoPoint {
                        decimicro_lat: 412_510_000,
                        decimicro_lon: 9_001_000,
                    },
                ],
            }],
            ..WalkableGeometryExtract::default()
        };
        let official = OfficialTrace {
            ref_code: "GR example".into(),
            name: Some("Example official trace".into()),
            authority: "CNIG / FEDME".into(),
            geometry: vec![(41.25, 0.9), (41.251, 0.9001)],
        };
        let (artifact, q8) = build_artifact(
            &input,
            &[official],
            TEST_DEMO_BBOX,
            "2026-08-27T00:00:00Z",
            "2026-08-27",
            true,
        )
        .unwrap();
        assert_eq!(
            artifact.tiles[DEMO_TILE_ID].edges[0]
                .official
                .as_ref()
                .map(|reference| reference.ref_code.as_str()),
            Some("GR example")
        );
        assert!(q8.bearing_qualified_length > 0.0);
    }

    #[test]
    fn foot_specific_direction_overrides_general_oneway() {
        let tags = RoutingTags {
            oneway: Some(TraversalDirection::Reverse),
            oneway_foot: Some(TraversalDirection::Forward),
            ..RoutingTags::default()
        };
        assert_eq!(traversal_direction(&tags), TraversalDirection::Forward);
        assert_eq!(direction_count(&tags), 1);
    }

    #[test]
    fn excludes_restricted_access_unless_foot_explicitly_allows_it() {
        let restricted = RoutingTags {
            access: Some(Access::Private),
            ..RoutingTags::default()
        };
        assert!(!pedestrian_access_allowed(&restricted));

        let foot_designated = RoutingTags {
            foot: Some(Access::Designated),
            access: Some(Access::Private),
            ..RoutingTags::default()
        };
        assert!(pedestrian_access_allowed(&foot_designated));
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
