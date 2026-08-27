//! `TrailPack` v0 data types. Data is versioned and attributable; this crate has
//! no filesystem or network I/O.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const SUPPORTED_SCHEMA_VERSION: u16 = 0;
pub type Bbox = [f64; 4];

/// The limits deliberately bound an artifact accepted by the static browser
/// reader. They are validation limits, not an assertion that a route exists.
pub const MAX_TILES: usize = 2_048;
pub const MAX_NODES_PER_TILE: usize = 200_000;
pub const MAX_EDGES_PER_TILE: usize = 400_000;
pub const MAX_GEOMETRY_POINTS_PER_EDGE: usize = 4_096;
pub const MAX_ARTIFACT_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Manifest {
    pub schema_version: u16,
    pub region_id: String,
    pub region_name: String,
    pub bbox: Bbox,
    pub built_at: String,
    pub tile_zoom: u8,
    #[serde(default)]
    pub tiles: Vec<String>,
    #[serde(default)]
    pub sources: Vec<Source>,
}

impl Manifest {
    /// Decode and validate a manifest before its tiles are considered usable.
    ///
    /// # Errors
    ///
    /// Returns an error when JSON is invalid, the schema is unsupported, or a
    /// required manifest invariant is not met.
    pub fn from_json(json: &str) -> Result<Self, TrailPackError> {
        let manifest: Self = serde_json::from_str(json)?;
        manifest.validate()?;
        Ok(manifest)
    }

    /// Refuse schema changes loudly rather than interpreting changed graph data.
    ///
    /// # Errors
    ///
    /// Returns an error for unsupported schemas and invalid manifest metadata.
    pub fn validate(&self) -> Result<(), TrailPackError> {
        if self.schema_version != SUPPORTED_SCHEMA_VERSION {
            return Err(TrailPackError::UnsupportedSchema {
                found: self.schema_version,
                supported: SUPPORTED_SCHEMA_VERSION,
            });
        }
        for (name, value) in [
            ("region_id", &self.region_id),
            ("region_name", &self.region_name),
            ("built_at", &self.built_at),
        ] {
            required(name, value)?;
        }
        if self.tile_zoom > 22 {
            return Err(TrailPackError::InvalidManifest(
                "tile_zoom must be in 0..=22".into(),
            ));
        }
        validate_bbox(self.bbox)?;
        let mut tile_ids = HashSet::new();
        for tile in &self.tiles {
            required("tile id", tile)?;
            if !tile_ids.insert(tile) {
                return Err(TrailPackError::InvalidManifest(format!(
                    "duplicate tile id `{tile}`"
                )));
            }
        }
        let mut source_ids = HashSet::new();
        for source in &self.sources {
            source.validate()?;
            if !source_ids.insert(&source.id) {
                return Err(TrailPackError::InvalidManifest(format!(
                    "duplicate source id `{}`",
                    source.id
                )));
            }
        }
        if self.sources.is_empty() {
            return Err(TrailPackError::InvalidManifest(
                "at least one source with provenance is required".into(),
            ));
        }
        Ok(())
    }

    /// Ordered presentation data for the UI. Never substitute hard-coded copy.
    pub fn attributions(&self) -> impl Iterator<Item = &str> {
        self.sources
            .iter()
            .map(|source| source.attribution.as_str())
    }
    #[must_use]
    pub fn has_source(&self, source_id: &str) -> bool {
        self.sources.iter().any(|source| source.id == source_id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Source {
    pub id: String,
    pub name: String,
    pub licence: String,
    pub attribution: String,
    pub extract_date: String,
}
impl Source {
    fn validate(&self) -> Result<(), TrailPackError> {
        for (name, value) in [
            ("source id", &self.id),
            ("source name", &self.name),
            ("source licence", &self.licence),
            ("source attribution", &self.attribution),
            ("source extract_date", &self.extract_date),
        ] {
            required(name, value)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Tile {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

/// A deterministic, JSON-encoded `TrailPack` v0 artifact.
///
/// This is intentionally a bounded interchange artifact for static browser
/// loading. It validates data and provenance, but it does not plan, join, or
/// otherwise claim that the graph can produce a route.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrailPackArtifact {
    pub manifest: Manifest,
    /// `BTreeMap` keeps emitted tile names stable regardless of ingestion order.
    pub tiles: BTreeMap<String, Tile>,
}

impl TrailPackArtifact {
    /// Construct and validate a browser-loadable `TrailPack` artifact.
    ///
    /// # Errors
    ///
    /// Returns an error for unsupported schemas, missing provenance, invalid
    /// tile membership, or graph data outside the browser safety limits.
    pub fn new(manifest: Manifest, tiles: BTreeMap<String, Tile>) -> Result<Self, TrailPackError> {
        let artifact = Self { manifest, tiles };
        artifact.validate()?;
        Ok(artifact)
    }

    /// Encode a validated artifact as deterministic UTF-8 JSON.
    ///
    /// Tile paths are ordered by `BTreeMap`; edges are sorted by their stable
    /// global id in the emitted representation. The manifest schema version is
    /// the format version and is always revalidated before serialization.
    ///
    /// # Errors
    ///
    /// Returns an error if validation fails or JSON encoding fails.
    pub fn to_json_bytes(&self) -> Result<Vec<u8>, TrailPackError> {
        self.validate()?;
        let mut canonical = self.clone();
        for tile in canonical.tiles.values_mut() {
            tile.edges.sort_by_key(|edge| edge.id);
        }
        let bytes = serde_json::to_vec(&canonical).map_err(TrailPackError::ArtifactJson)?;
        if bytes.len() > MAX_ARTIFACT_BYTES {
            return Err(TrailPackError::InvalidArtifact(format!(
                "encoded artifact exceeds browser limit of {MAX_ARTIFACT_BYTES} bytes"
            )));
        }
        Ok(bytes)
    }

    /// Decode and validate a static `TrailPack` artifact before it is used.
    ///
    /// # Errors
    ///
    /// Returns an error when the artifact is malformed, unversioned, lacks
    /// source provenance, or contains invalid graph references.
    pub fn from_json_bytes(bytes: &[u8]) -> Result<Self, TrailPackError> {
        if bytes.len() > MAX_ARTIFACT_BYTES {
            return Err(TrailPackError::InvalidArtifact(format!(
                "encoded artifact exceeds browser limit of {MAX_ARTIFACT_BYTES} bytes"
            )));
        }
        let artifact: Self = serde_json::from_slice(bytes).map_err(TrailPackError::ArtifactJson)?;
        artifact.validate()?;
        Ok(artifact)
    }

    /// Validate manifest provenance, exact tile membership, and bounded graph
    /// references. This never attempts routing.
    ///
    /// # Errors
    ///
    /// Returns an error when any artifact invariant is violated.
    pub fn validate(&self) -> Result<(), TrailPackError> {
        self.manifest.validate()?;
        if self.manifest.tiles.len() > MAX_TILES {
            return Err(TrailPackError::InvalidArtifact(format!(
                "tile count exceeds browser limit of {MAX_TILES}"
            )));
        }
        let manifest_tiles = self.manifest.tiles.iter().collect::<HashSet<_>>();
        let artifact_tiles = self.tiles.keys().collect::<HashSet<_>>();
        if manifest_tiles != artifact_tiles {
            return Err(TrailPackError::InvalidArtifact(
                "manifest tile index must exactly match artifact tiles".into(),
            ));
        }
        for (tile_id, tile) in &self.tiles {
            validate_tile(tile_id, tile, &self.manifest)?;
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Node {
    pub lat_e7: i32,
    pub lon_e7: i32,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Edge {
    pub id: u64,
    pub from: u32,
    pub to: u32,
    pub length_m: u32,
    pub ascent_m: u16,
    pub descent_m: u16,
    pub geometry: Vec<(i16, i16)>,
    pub terrain: Terrain,
    pub official: Option<OfficialRef>,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Terrain {
    pub surface: Option<Surface>,
    pub sac_scale: Option<SacScale>,
    pub visibility: Option<Visibility>,
    pub width_hint: Option<WidthHint>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Surface {
    Paved,
    Gravel,
    Ground,
    Rock,
    Sand,
    Other,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SacScale {
    T1,
    T2,
    T3,
    T4,
    T5,
    T6,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Visibility {
    Excellent,
    Good,
    Intermediate,
    Bad,
    Horrible,
    No,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WidthHint {
    Wide,
    Normal,
    Narrow,
    VeryNarrow,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OfficialRef {
    pub ref_code: String,
    pub name: Option<String>,
    pub kind: OfficialKind,
    pub authority: String,
    pub source_id: String,
    pub confidence: f32,
}
impl OfficialRef {
    /// # Errors
    ///
    /// Returns an error if the reference cannot be supported by this manifest.
    pub fn validate_against(&self, manifest: &Manifest) -> Result<(), TrailPackError> {
        required("official ref_code", &self.ref_code)?;
        required("official authority", &self.authority)?;
        if !self.confidence.is_finite() || !(0.0..=1.0).contains(&self.confidence) {
            return Err(TrailPackError::InvalidOfficialRef(
                "confidence must be finite and in 0..=1".into(),
            ));
        }
        if !manifest.has_source(&self.source_id) {
            return Err(TrailPackError::UnknownSource(self.source_id.clone()));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OfficialKind {
    WaymarkedCertified,
    AgencyInventory,
    LocalNetwork,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OfficialTrace {
    pub ref_code: String,
    pub name: Option<String>,
    pub authority: String,
    pub geometry: Vec<(f64, f64)>,
}
/// Offline adapter boundary; source implementations own I/O, not this format crate.
pub trait OfficialTrailSource {
    fn id(&self) -> &str;
    fn licence(&self) -> &str;
    fn kind(&self) -> OfficialKind;
    /// # Errors
    ///
    /// Returns a source-specific error when the requested trace data cannot be loaded.
    fn load(&self, bbox: Bbox) -> Result<Vec<OfficialTrace>, SourceLoadError>;
}
#[derive(Debug, Error, PartialEq, Eq)]
pub enum SourceLoadError {
    #[error("official trail source `{0}` is not implemented")]
    UnsupportedSource(String),
    #[error("official trail source data is invalid: {0}")]
    InvalidData(String),
}
#[derive(Debug, Error)]
pub enum TrailPackError {
    #[error("could not decode TrailPack manifest: {0}")]
    Json(#[from] serde_json::Error),
    #[error("could not encode or decode TrailPack artifact: {0}")]
    ArtifactJson(serde_json::Error),
    #[error("unsupported TrailPack schema {found}; this build supports schema {supported}")]
    UnsupportedSchema { found: u16, supported: u16 },
    #[error("invalid TrailPack manifest: {0}")]
    InvalidManifest(String),
    #[error("invalid TrailPack artifact: {0}")]
    InvalidArtifact(String),
    #[error("invalid official trail reference: {0}")]
    InvalidOfficialRef(String),
    #[error("official trail reference names unknown source `{0}")]
    UnknownSource(String),
}

fn validate_tile(tile_id: &str, tile: &Tile, manifest: &Manifest) -> Result<(), TrailPackError> {
    required("tile id", tile_id)?;
    if tile.nodes.len() > MAX_NODES_PER_TILE {
        return Err(TrailPackError::InvalidArtifact(format!(
            "tile `{tile_id}` exceeds node limit of {MAX_NODES_PER_TILE}"
        )));
    }
    if tile.edges.len() > MAX_EDGES_PER_TILE {
        return Err(TrailPackError::InvalidArtifact(format!(
            "tile `{tile_id}` exceeds edge limit of {MAX_EDGES_PER_TILE}"
        )));
    }
    let mut edge_ids = HashSet::new();
    for node in &tile.nodes {
        let lat = f64::from(node.lat_e7) / 10_000_000.0;
        let lon = f64::from(node.lon_e7) / 10_000_000.0;
        if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
            return Err(TrailPackError::InvalidArtifact(format!(
                "tile `{tile_id}` has a node outside geographic bounds"
            )));
        }
    }
    for edge in &tile.edges {
        if usize::try_from(edge.from).map_or(true, |index| index >= tile.nodes.len())
            || usize::try_from(edge.to).map_or(true, |index| index >= tile.nodes.len())
        {
            return Err(TrailPackError::InvalidArtifact(format!(
                "tile `{tile_id}` edge `{}` references a missing node",
                edge.id
            )));
        }
        if edge.geometry.len() > MAX_GEOMETRY_POINTS_PER_EDGE {
            return Err(TrailPackError::InvalidArtifact(format!(
                "tile `{tile_id}` edge `{}` exceeds geometry limit of {MAX_GEOMETRY_POINTS_PER_EDGE}",
                edge.id
            )));
        }
        if !edge_ids.insert(edge.id) {
            return Err(TrailPackError::InvalidArtifact(format!(
                "tile `{tile_id}` contains duplicate edge id `{}`",
                edge.id
            )));
        }
        if let Some(official) = &edge.official {
            official.validate_against(manifest)?;
        }
    }
    Ok(())
}
fn required(field: &str, value: &str) -> Result<(), TrailPackError> {
    if value.trim().is_empty() {
        Err(TrailPackError::InvalidManifest(format!(
            "{field} is required"
        )))
    } else {
        Ok(())
    }
}
fn validate_bbox([west, south, east, north]: Bbox) -> Result<(), TrailPackError> {
    if ![west, south, east, north]
        .iter()
        .all(|value| value.is_finite())
        || !(-180.0..=180.0).contains(&west)
        || !(-180.0..=180.0).contains(&east)
        || !(-90.0..=90.0).contains(&south)
        || !(-90.0..=90.0).contains(&north)
        || west >= east
        || south >= north
    {
        return Err(TrailPackError::InvalidManifest(
            "bbox must be west,south,east,north within geographic bounds".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const MANIFEST: &str = r#"{"schema_version":0,"region_id":"es-cat-t","region_name":"Tarragona","bbox":[0.16,40.51,1.67,41.42],"built_at":"2026-08-28T09:00:00Z","tile_zoom":10,"tiles":["120"],"sources":[{"id":"osm","name":"OpenStreetMap","licence":"ODbL-1.0","attribution":"© OpenStreetMap contributors","extract_date":"2026-08-26"}]}"#;
    #[test]
    fn reads_attribution_from_data() {
        let manifest = Manifest::from_json(MANIFEST).unwrap();
        assert_eq!(
            manifest.attributions().collect::<Vec<_>>(),
            ["© OpenStreetMap contributors"]
        );
    }
    #[test]
    fn refuses_unknown_schema_before_use() {
        let error =
            Manifest::from_json(&MANIFEST.replace("\"schema_version\":0", "\"schema_version\":1"))
                .unwrap_err();
        assert!(matches!(
            error,
            TrailPackError::UnsupportedSchema {
                found: 1,
                supported: 0
            }
        ));
    }
    #[test]
    fn official_references_must_name_a_manifest_source() {
        let manifest = Manifest::from_json(MANIFEST).unwrap();
        let reference = OfficialRef {
            ref_code: "GR 7".into(),
            name: None,
            kind: OfficialKind::WaymarkedCertified,
            authority: "FEEC / FEDME".into(),
            source_id: "cnig-fedme".into(),
            confidence: 0.9,
        };
        assert!(matches!(
            reference.validate_against(&manifest),
            Err(TrailPackError::UnknownSource(_))
        ));
    }

    fn manifest() -> Manifest {
        Manifest::from_json(MANIFEST).unwrap()
    }

    fn tile() -> Tile {
        Tile {
            nodes: vec![
                Node {
                    lat_e7: 41_230_000,
                    lon_e7: 120_000,
                },
                Node {
                    lat_e7: 41_231_000,
                    lon_e7: 121_000,
                },
            ],
            edges: vec![
                Edge {
                    id: 20,
                    from: 0,
                    to: 1,
                    length_m: 120,
                    ascent_m: 4,
                    descent_m: 0,
                    geometry: vec![],
                    terrain: Terrain::default(),
                    official: Some(OfficialRef {
                        ref_code: "GR 65".into(),
                        name: Some("Camí de Sant Jaume".into()),
                        kind: OfficialKind::WaymarkedCertified,
                        authority: "FEDME".into(),
                        source_id: "osm".into(),
                        confidence: 0.9,
                    }),
                },
                Edge {
                    id: 10,
                    from: 1,
                    to: 0,
                    length_m: 120,
                    ascent_m: 0,
                    descent_m: 4,
                    geometry: vec![],
                    terrain: Terrain::default(),
                    official: None,
                },
            ],
        }
    }

    #[test]
    fn artifact_round_trips_and_is_deterministic() {
        let artifact =
            TrailPackArtifact::new(manifest(), BTreeMap::from([("120".into(), tile())])).unwrap();

        let first = artifact.to_json_bytes().unwrap();
        let second = artifact.to_json_bytes().unwrap();
        assert_eq!(first, second);

        let decoded = TrailPackArtifact::from_json_bytes(&first).unwrap();
        assert_eq!(decoded.manifest, artifact.manifest);
        assert_eq!(decoded.tiles["120"].edges[0].id, 10);
        assert_eq!(decoded.tiles["120"].edges[1].id, 20);
    }

    #[test]
    fn artifact_requires_manifest_provenance_and_matching_tile_index() {
        let mut without_sources = manifest();
        without_sources.sources.clear();
        assert!(matches!(
            TrailPackArtifact::new(without_sources, BTreeMap::new()),
            Err(TrailPackError::InvalidManifest(_))
        ));

        assert!(matches!(
            TrailPackArtifact::new(manifest(), BTreeMap::new()),
            Err(TrailPackError::InvalidArtifact(_))
        ));
    }

    #[test]
    fn artifact_refuses_edges_with_missing_nodes() {
        let mut bad_tile = tile();
        bad_tile.edges[0].to = 5;
        assert!(matches!(
            TrailPackArtifact::new(manifest(), BTreeMap::from([("120".into(), bad_tile)])),
            Err(TrailPackError::InvalidArtifact(_))
        ));
    }
}
