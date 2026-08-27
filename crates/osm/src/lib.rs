//! Safe extraction of walkable routing ways from a local OSM PBF stream.
//!
//! This crate deliberately keeps only routing-relevant, typed tags. It never
//! forwards arbitrary OpenStreetMap text such as names, descriptions, notes,
//! URLs, or user identifiers into a `TrailPack`.

use std::fmt;
use std::io::Read;

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
}
