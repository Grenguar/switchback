//! Safe extraction of walkable routing ways from a local OSM PBF stream.
//!
//! This crate deliberately keeps only routing-relevant, typed tags. It never
//! forwards arbitrary OpenStreetMap text such as names, descriptions, notes,
//! URLs, or user identifiers into a `TrailPack`.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::io::{Read, Seek};

use osmpbfreader::{OsmObj, OsmPbfReader};

/// A walkable OSM highway classification accepted by Switchback's first tier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum WalkableHighway {
    /// `highway=path`.
    Path,
    /// `highway=footway`.
    Footway,
    /// `highway=track`.
    Track,
}

impl WalkableHighway {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "path" => Some(Self::Path),
            "footway" => Some(Self::Footway),
            "track" => Some(Self::Track),
            _ => None,
        }
    }
}

/// A constrained access value accepted from `foot` or `access`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Yes,
    Designated,
    Permissive,
    No,
    Private,
    Destination,
}

impl Access {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "yes" => Some(Self::Yes),
            "designated" => Some(Self::Designated),
            "permissive" => Some(Self::Permissive),
            "no" => Some(Self::No),
            "private" => Some(Self::Private),
            "destination" => Some(Self::Destination),
            _ => None,
        }
    }
}

/// A constrained surface classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Surface {
    Paved,
    Asphalt,
    Concrete,
    Compacted,
    FineGravel,
    Gravel,
    Ground,
    Dirt,
    Earth,
    Grass,
    Rock,
    Sand,
    Mud,
    Wood,
    Metal,
}

impl Surface {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "paved" => Some(Self::Paved),
            "asphalt" => Some(Self::Asphalt),
            "concrete" => Some(Self::Concrete),
            "compacted" => Some(Self::Compacted),
            "fine_gravel" => Some(Self::FineGravel),
            "gravel" => Some(Self::Gravel),
            "ground" => Some(Self::Ground),
            "dirt" => Some(Self::Dirt),
            "earth" => Some(Self::Earth),
            "grass" => Some(Self::Grass),
            "rock" => Some(Self::Rock),
            "sand" => Some(Self::Sand),
            "mud" => Some(Self::Mud),
            "wood" => Some(Self::Wood),
            "metal" => Some(Self::Metal),
            _ => None,
        }
    }
}

/// Hiking difficulty classification from `sac_scale`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SacScale {
    Hiking,
    MountainHiking,
    DemandingMountainHiking,
    AlpineHiking,
    DemandingAlpineHiking,
    DifficultAlpineHiking,
}

impl SacScale {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "hiking" => Some(Self::Hiking),
            "mountain_hiking" => Some(Self::MountainHiking),
            "demanding_mountain_hiking" => Some(Self::DemandingMountainHiking),
            "alpine_hiking" => Some(Self::AlpineHiking),
            "demanding_alpine_hiking" => Some(Self::DemandingAlpineHiking),
            "difficult_alpine_hiking" => Some(Self::DifficultAlpineHiking),
            _ => None,
        }
    }
}

/// Visibility classification from `trail_visibility`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrailVisibility {
    Excellent,
    Good,
    Intermediate,
    Bad,
    Horrible,
    No,
}

impl TrailVisibility {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "excellent" => Some(Self::Excellent),
            "good" => Some(Self::Good),
            "intermediate" => Some(Self::Intermediate),
            "bad" => Some(Self::Bad),
            "horrible" => Some(Self::Horrible),
            "no" => Some(Self::No),
            _ => None,
        }
    }
}

/// Track quality classification from `tracktype`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackType {
    Grade1,
    Grade2,
    Grade3,
    Grade4,
    Grade5,
}

impl TrackType {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "grade1" => Some(Self::Grade1),
            "grade2" => Some(Self::Grade2),
            "grade3" => Some(Self::Grade3),
            "grade4" => Some(Self::Grade4),
            "grade5" => Some(Self::Grade5),
            _ => None,
        }
    }
}

/// The allowlisted routing attributes retained from an OSM way.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RoutingTags {
    pub foot: Option<Access>,
    pub access: Option<Access>,
    pub surface: Option<Surface>,
    pub sac_scale: Option<SacScale>,
    pub trail_visibility: Option<TrailVisibility>,
    /// Width in centimetres; only values from 1 cm through 100 m are accepted.
    pub width_cm: Option<u16>,
    /// Incline in whole percent, constrained to -100 through 100.
    pub incline_percent: Option<i8>,
    pub tracktype: Option<TrackType>,
}

/// A way eligible for pedestrian routing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalkableWay {
    pub id: i64,
    pub highway: WalkableHighway,
    /// Ordered OSM node IDs. Geometry is intentionally resolved separately.
    pub node_ids: Vec<i64>,
    pub tags: RoutingTags,
}

/// Stable extraction counts suitable for CLI metrics and regression tests.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ExtractionStats {
    pub scanned_ways: u64,
    pub emitted_ways: u64,
    pub paths: u64,
    pub footways: u64,
    pub tracks: u64,
}

/// The materialized safe way set and its deterministic counts.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct WalkableExtract {
    pub ways: Vec<WalkableWay>,
    pub stats: ExtractionStats,
}

/// A WGS84 coordinate in OSM's native decimicro-degree representation.
///
/// Keeping the source integer representation avoids rounding drift while
/// building a deterministic routing graph. Use [`GeoPoint::latitude`] and
/// [`GeoPoint::longitude`] only when a floating point representation is
/// required at an application boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct GeoPoint {
    pub decimicro_lat: i32,
    pub decimicro_lon: i32,
}

impl GeoPoint {
    /// Returns the latitude in WGS84 degrees.
    #[must_use]
    pub fn latitude(self) -> f64 {
        f64::from(self.decimicro_lat) * 1e-7
    }

    /// Returns the longitude in WGS84 degrees.
    #[must_use]
    pub fn longitude(self) -> f64 {
        f64::from(self.decimicro_lon) * 1e-7
    }
}

/// One walkable way whose ordered node references were resolved to geometry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaterializedWay {
    pub way: WalkableWay,
    /// The full ordered geometry, with one coordinate for every `node_ids`
    /// entry on [`Self::way`].
    pub geometry: Vec<GeoPoint>,
}

/// Counts from the coordinate-resolution pass.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct GeometryStats {
    /// Distinct node IDs referenced by retained pedestrian ways.
    pub referenced_nodes: u64,
    /// Referenced node IDs found in the source PBF.
    pub resolved_nodes: u64,
    /// Ways with complete ordered geometry.
    pub resolved_ways: u64,
    /// Ways omitted because at least one referenced node was not present.
    pub unresolved_ways: u64,
}

/// A safe walkable extract with coordinate-resolved routing geometry.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct WalkableGeometryExtract {
    pub ways: Vec<MaterializedWay>,
    pub extraction: ExtractionStats,
    pub geometry: GeometryStats,
}

/// An error while decoding a local OSM PBF stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PbfReadError(String);

impl fmt::Display for PbfReadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for PbfReadError {}

/// Decode a PBF stream and retain only strict, walkable way records.
///
/// # Errors
///
/// Returns [`PbfReadError`] when the supplied stream cannot be decoded as an
/// OSM PBF file.
pub fn read_walkable_ways(reader: impl Read) -> Result<WalkableExtract, PbfReadError> {
    let mut pbf = OsmPbfReader::new(reader);
    read_walkable_ways_from_pbf(&mut pbf)
}

/// Decode a local PBF twice to retain walkable ways and resolve their geometry.
///
/// The first pass applies the same strict way and tag filtering as
/// [`read_walkable_ways`], retaining only accepted ways and their node IDs.
/// The second pass keeps coordinates only for those referenced IDs. This means
/// memory grows with the routing candidate set rather than all nodes in the
/// PBF, and source ordering cannot affect the returned way ordering.
///
/// Ways whose full geometry cannot be resolved are omitted and reported in
/// [`GeometryStats::unresolved_ways`].
///
/// # Errors
///
/// Returns [`PbfReadError`] when either decoding pass or the rewind between
/// passes fails.
pub fn read_walkable_geometry(
    reader: impl Read + Seek,
) -> Result<WalkableGeometryExtract, PbfReadError> {
    let mut pbf = OsmPbfReader::new(reader);
    let extract = read_walkable_ways_from_pbf(&mut pbf)?;

    let required_nodes: BTreeSet<_> = extract
        .ways
        .iter()
        .flat_map(|way| way.node_ids.iter().copied())
        .collect();
    let mut output = WalkableGeometryExtract {
        extraction: extract.stats,
        geometry: GeometryStats {
            referenced_nodes: required_nodes.len() as u64,
            ..GeometryStats::default()
        },
        ..WalkableGeometryExtract::default()
    };

    pbf.rewind()
        .map_err(|error| PbfReadError(error.to_string()))?;
    let mut coordinates = BTreeMap::new();
    for object in pbf.iter() {
        let object = object.map_err(|error| PbfReadError(error.to_string()))?;
        let OsmObj::Node(node) = object else {
            continue;
        };
        let id = node.id.0;
        if required_nodes.contains(&id) {
            coordinates.insert(
                id,
                GeoPoint {
                    decimicro_lat: node.decimicro_lat,
                    decimicro_lon: node.decimicro_lon,
                },
            );
        }
    }
    output.geometry.resolved_nodes = coordinates.len() as u64;
    materialize_ways(extract.ways, &coordinates, &mut output);
    Ok(output)
}

fn read_walkable_ways_from_pbf<R: Read>(
    pbf: &mut OsmPbfReader<R>,
) -> Result<WalkableExtract, PbfReadError> {
    let mut extract = WalkableExtract::default();

    for object in pbf.iter() {
        let object = object.map_err(|error| PbfReadError(error.to_string()))?;
        let OsmObj::Way(way) = object else {
            continue;
        };
        extract.stats.scanned_ways += 1;
        let Some(highway) = way
            .tags
            .get("highway")
            .and_then(|value| WalkableHighway::parse(value))
        else {
            continue;
        };
        if way.nodes.len() < 2 {
            continue;
        }

        let tags = routing_tags(
            way.tags
                .iter()
                .map(|(key, value)| (key.as_str(), value.as_str())),
        );
        extract.ways.push(WalkableWay {
            id: way.id.0,
            highway,
            node_ids: way.nodes.into_iter().map(|node| node.0).collect(),
            tags,
        });
        extract.stats.emitted_ways += 1;
        match highway {
            WalkableHighway::Path => extract.stats.paths += 1,
            WalkableHighway::Footway => extract.stats.footways += 1,
            WalkableHighway::Track => extract.stats.tracks += 1,
        }
    }
    extract.ways.sort_by_key(|way| way.id);
    Ok(extract)
}

fn materialize_ways(
    ways: Vec<WalkableWay>,
    coordinates: &BTreeMap<i64, GeoPoint>,
    output: &mut WalkableGeometryExtract,
) {
    for way in ways {
        let geometry: Option<Vec<_>> = way
            .node_ids
            .iter()
            .map(|node_id| coordinates.get(node_id).copied())
            .collect();
        let Some(geometry) = geometry else {
            output.geometry.unresolved_ways += 1;
            continue;
        };
        output.ways.push(MaterializedWay { way, geometry });
        output.geometry.resolved_ways += 1;
    }
}

fn routing_tags<'a>(tags: impl IntoIterator<Item = (&'a str, &'a str)>) -> RoutingTags {
    let mut safe = RoutingTags::default();
    for (key, value) in tags {
        match key {
            "foot" => safe.foot = Access::parse(value),
            "access" => safe.access = Access::parse(value),
            "surface" => safe.surface = Surface::parse(value),
            "sac_scale" => safe.sac_scale = SacScale::parse(value),
            "trail_visibility" => safe.trail_visibility = TrailVisibility::parse(value),
            "width" => safe.width_cm = parse_width_cm(value),
            "incline" => safe.incline_percent = parse_incline_percent(value),
            "tracktype" => safe.tracktype = TrackType::parse(value),
            _ => {}
        }
    }
    safe
}

fn parse_width_cm(value: &str) -> Option<u16> {
    let metres = value
        .trim()
        .strip_suffix('m')
        .unwrap_or(value.trim())
        .trim();
    let (whole, fractional) = metres.split_once('.').unwrap_or((metres, ""));
    if fractional.len() > 2
        || !fractional
            .chars()
            .all(|character| character.is_ascii_digit())
    {
        return None;
    }
    let whole_cm = whole.parse::<u16>().ok()?.checked_mul(100)?;
    let fraction = match fractional.len() {
        0 => 0,
        1 => fractional.parse::<u16>().ok()?.checked_mul(10)?,
        2 => fractional.parse::<u16>().ok()?,
        _ => return None,
    };
    let centimetres = whole_cm.checked_add(fraction)?;
    (1..=10_000).contains(&centimetres).then_some(centimetres)
}

fn parse_incline_percent(value: &str) -> Option<i8> {
    let percentage = value
        .trim()
        .strip_suffix('%')
        .unwrap_or(value.trim())
        .trim();
    let parsed = percentage.parse::<i8>().ok()?;
    (-100..=100).contains(&parsed).then_some(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_allowlisted_typed_routing_values() {
        let tags = routing_tags([
            ("foot", "designated"),
            ("access", "private"),
            ("surface", "fine_gravel"),
            ("sac_scale", "mountain_hiking"),
            ("trail_visibility", "good"),
            ("width", "1.25 m"),
            ("incline", "-12%"),
            ("tracktype", "grade3"),
            ("name", "Never retained"),
            ("description", "Nor this"),
        ]);
        assert_eq!(tags.foot, Some(Access::Designated));
        assert_eq!(tags.access, Some(Access::Private));
        assert_eq!(tags.surface, Some(Surface::FineGravel));
        assert_eq!(tags.sac_scale, Some(SacScale::MountainHiking));
        assert_eq!(tags.trail_visibility, Some(TrailVisibility::Good));
        assert_eq!(tags.width_cm, Some(125));
        assert_eq!(tags.incline_percent, Some(-12));
        assert_eq!(tags.tracktype, Some(TrackType::Grade3));
    }

    #[test]
    fn rejects_untrusted_or_out_of_range_values() {
        let tags = routing_tags([
            ("foot", "sometimes"),
            ("surface", "<script>alert(1)</script>"),
            ("width", "500m"),
            ("incline", "120%"),
            ("tracktype", "grade9"),
        ]);
        assert_eq!(tags, RoutingTags::default());
    }

    #[test]
    fn highway_filter_is_explicit() {
        assert_eq!(WalkableHighway::parse("path"), Some(WalkableHighway::Path));
        assert_eq!(
            WalkableHighway::parse("footway"),
            Some(WalkableHighway::Footway)
        );
        assert_eq!(
            WalkableHighway::parse("track"),
            Some(WalkableHighway::Track)
        );
        assert_eq!(WalkableHighway::parse("residential"), None);
    }

    #[test]
    fn materialization_keeps_complete_geometry_in_way_order() {
        let first = WalkableWay {
            id: 10,
            highway: WalkableHighway::Path,
            node_ids: vec![1, 2],
            tags: RoutingTags::default(),
        };
        let missing = WalkableWay {
            id: 11,
            highway: WalkableHighway::Track,
            node_ids: vec![2, 3],
            tags: RoutingTags::default(),
        };
        let coordinates = BTreeMap::from([
            (
                1,
                GeoPoint {
                    decimicro_lat: 412_345_678,
                    decimicro_lon: 12_345_678,
                },
            ),
            (
                2,
                GeoPoint {
                    decimicro_lat: 412_345_679,
                    decimicro_lon: 12_345_679,
                },
            ),
        ]);
        let mut output = WalkableGeometryExtract::default();

        materialize_ways(vec![first, missing], &coordinates, &mut output);

        assert_eq!(output.geometry.resolved_ways, 1);
        assert_eq!(output.geometry.unresolved_ways, 1);
        assert_eq!(output.ways.len(), 1);
        assert_eq!(output.ways[0].way.id, 10);
        assert_eq!(output.ways[0].geometry.len(), 2);
        assert!((output.ways[0].geometry[0].latitude() - 41.234_567_8).abs() < f64::EPSILON);
        assert!((output.ways[0].geometry[1].longitude() - 1.234_567_9).abs() < f64::EPSILON);
    }
}
