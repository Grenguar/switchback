//! `TrailPack` v0 data types. Data is versioned and attributable; this crate has
//! no filesystem or network I/O.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const SUPPORTED_SCHEMA_VERSION: u16 = 0;
pub type Bbox = [f64; 4];

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
    #[error("unsupported TrailPack schema {found}; this build supports schema {supported}")]
    UnsupportedSchema { found: u16, supported: u16 },
    #[error("invalid TrailPack manifest: {0}")]
    InvalidManifest(String),
    #[error("invalid official trail reference: {0}")]
    InvalidOfficialRef(String),
    #[error("official trail reference names unknown source `{0}")]
    UnknownSource(String),
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
}
