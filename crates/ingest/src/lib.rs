//! Offline adapters for official trail authorities.
//!
//! Adapters accept explicit local paths only. They never fetch source data, so
//! a `TrailPack` build remains reproducible and its data provenance stays clear.

use std::fs;
use std::path::{Path, PathBuf};

use switchback_trailpack::{
    Bbox, OfficialKind, OfficialTrace, OfficialTrailSource, SourceLoadError,
};

const CNIG_FEDME_ID: &str = "cnig-fedme";
const CNIG_FEDME_LICENCE: &str = "See source extract terms";

/// A CNIG/FEDME GPX extract supplied by the caller as a local file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CnigFedmeSource {
    path: PathBuf,
}

impl CnigFedmeSource {
    #[must_use]
    pub fn from_path(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl OfficialTrailSource for CnigFedmeSource {
    fn id(&self) -> &'static str {
        CNIG_FEDME_ID
    }

    fn licence(&self) -> &'static str {
        CNIG_FEDME_LICENCE
    }

    fn kind(&self) -> OfficialKind {
        OfficialKind::WaymarkedCertified
    }

    fn load(&self, bbox: Bbox) -> Result<Vec<OfficialTrace>, SourceLoadError> {
        validate_bbox(bbox)?;
        let gpx = fs::read_to_string(&self.path).map_err(|error| {
            SourceLoadError::InvalidData(format!(
                "could not read `{}`: {error}",
                self.path.display()
            ))
        })?;
        parse_gpx(&gpx, bbox)
    }
}

/// Placeholder for the IGN France adapter. Its typed failure prevents a
/// partial integration from being mistaken for production source coverage.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct IgniteFranceSource;

impl OfficialTrailSource for IgniteFranceSource {
    fn id(&self) -> &'static str {
        "ign-france"
    }
    fn licence(&self) -> &'static str {
        "Not loaded"
    }
    fn kind(&self) -> OfficialKind {
        OfficialKind::AgencyInventory
    }
    fn load(&self, _bbox: Bbox) -> Result<Vec<OfficialTrace>, SourceLoadError> {
        Err(SourceLoadError::UnsupportedSource(self.id().into()))
    }
}

/// Placeholder for the USGS National Digital Trails adapter.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct UsgsNdtSource;

impl OfficialTrailSource for UsgsNdtSource {
    fn id(&self) -> &'static str {
        "usgs-ndt"
    }
    fn licence(&self) -> &'static str {
        "Not loaded"
    }
    fn kind(&self) -> OfficialKind {
        OfficialKind::AgencyInventory
    }
    fn load(&self, _bbox: Bbox) -> Result<Vec<OfficialTrace>, SourceLoadError> {
        Err(SourceLoadError::UnsupportedSource(self.id().into()))
    }
}

fn parse_gpx(input: &str, bbox: Bbox) -> Result<Vec<OfficialTrace>, SourceLoadError> {
    let mut traces = Vec::new();
    for (index, _) in input.match_indices("<trk>") {
        let rest = &input[index..];
        let end = rest
            .find("</trk>")
            .ok_or_else(|| SourceLoadError::InvalidData("unterminated <trk> element".into()))?;
        let track = &rest[..end];
        let name = element_text(track, "name");
        let geometry = points(track)?
            .into_iter()
            .filter(|&(lat, lon)| within(bbox, lat, lon))
            .collect::<Vec<_>>();
        if geometry.len() >= 2 {
            let ref_code = name
                .clone()
                .unwrap_or_else(|| format!("CNIG-FEDME-{}", traces.len() + 1));
            traces.push(OfficialTrace {
                ref_code,
                name,
                authority: "CNIG / FEDME".into(),
                geometry,
            });
        }
    }
    if traces.is_empty() {
        return Err(SourceLoadError::InvalidData(
            "GPX contains no track with two points inside the requested bbox".into(),
        ));
    }
    Ok(traces)
}

fn points(track: &str) -> Result<Vec<(f64, f64)>, SourceLoadError> {
    let mut result = Vec::new();
    let mut remainder = track;
    while let Some(start) = remainder.find("<trkpt") {
        remainder = &remainder[start..];
        let close = remainder
            .find('>')
            .ok_or_else(|| SourceLoadError::InvalidData("unterminated <trkpt> tag".into()))?;
        let tag = &remainder[..=close];
        let lat = attribute(tag, "lat")?
            .parse::<f64>()
            .map_err(|_| SourceLoadError::InvalidData("invalid GPX latitude".into()))?;
        let lon = attribute(tag, "lon")?
            .parse::<f64>()
            .map_err(|_| SourceLoadError::InvalidData("invalid GPX longitude".into()))?;
        if !lat.is_finite()
            || !lon.is_finite()
            || !(-90.0..=90.0).contains(&lat)
            || !(-180.0..=180.0).contains(&lon)
        {
            return Err(SourceLoadError::InvalidData(
                "GPX point is outside geographic bounds".into(),
            ));
        }
        result.push((lat, lon));
        remainder = &remainder[close + 1..];
    }
    Ok(result)
}

fn attribute<'a>(tag: &'a str, key: &str) -> Result<&'a str, SourceLoadError> {
    let prefix = format!("{key}=\"");
    let start = tag
        .find(&prefix)
        .ok_or_else(|| SourceLoadError::InvalidData(format!("GPX point lacks {key} attribute")))?
        + prefix.len();
    let end = tag[start..]
        .find('"')
        .ok_or_else(|| SourceLoadError::InvalidData(format!("unterminated {key} attribute")))?
        + start;
    Ok(&tag[start..end])
}

fn element_text(input: &str, name: &str) -> Option<String> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let start = input.find(&open)? + open.len();
    let end = input[start..].find(&close)? + start;
    let text = input[start..end].trim();
    (!text.is_empty()).then(|| text.to_owned())
}

fn validate_bbox([west, south, east, north]: Bbox) -> Result<(), SourceLoadError> {
    if !(west < east && south < north) {
        return Err(SourceLoadError::InvalidData("invalid bbox".into()));
    }
    Ok(())
}

fn within([west, south, east, north]: Bbox, lat: f64, lon: f64) -> bool {
    (west..=east).contains(&lon) && (south..=north).contains(&lat)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GPX: &str = r#"<gpx><trk><name>GR 7</name><trkseg><trkpt lat="41.20" lon="0.80"/><trkpt lat="41.21" lon="0.81"/></trkseg></trk></gpx>"#;

    #[test]
    fn parses_explicit_gpx_path_and_applies_bbox() {
        let path =
            std::env::temp_dir().join(format!("switchback-ingest-{}.gpx", std::process::id()));
        fs::write(&path, GPX).unwrap();
        let source = CnigFedmeSource::from_path(&path);
        let traces = source.load([0.7, 41.1, 0.9, 41.3]).unwrap();
        fs::remove_file(path).unwrap();
        assert_eq!(traces[0].ref_code, "GR 7");
        assert_eq!(traces[0].geometry.len(), 2);
    }

    #[test]
    fn unimplemented_sources_fail_with_typed_error() {
        assert!(matches!(
            IgniteFranceSource.load([0.0, 0.0, 1.0, 1.0]),
            Err(SourceLoadError::UnsupportedSource(_))
        ));
        assert!(matches!(
            UsgsNdtSource.load([0.0, 0.0, 1.0, 1.0]),
            Err(SourceLoadError::UnsupportedSource(_))
        ));
    }
}
