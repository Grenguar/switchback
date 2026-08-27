//! Simple, deterministic polyline-to-edge matching.
//!
//! This first tier deliberately has no geospatial index or network dependency:
//! every input edge is considered in stable ID order and scored by midpoint
//! distance plus bearing agreement.

pub type Point = (f64, f64); // latitude, longitude in degrees

#[derive(Debug, Clone, PartialEq)]
pub struct GraphEdge {
    pub id: u64,
    pub geometry: Vec<Point>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EdgeMatch {
    pub edge_id: u64,
    pub distance_m: f64,
    pub bearing_delta_degrees: f64,
    /// A bounded score: 1 is coincident with the same bearing.
    pub confidence: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MatchResult {
    pub matches: Vec<EdgeMatch>,
    pub unmatched_segments: usize,
}

/// Match each adjacent pair in a trace to the best graph edge.
///
/// An edge is accepted only when its midpoint is at most `max_distance_m` from
/// the segment midpoint. Equal scores resolve by edge ID for reproducibility.
#[must_use]
pub fn match_polyline(polyline: &[Point], edges: &[GraphEdge], max_distance_m: f64) -> MatchResult {
    let mut matches = Vec::new();
    let mut unmatched_segments = 0;
    for segment in polyline.windows(2) {
        let [start, end] = segment else {
            unreachable!()
        };
        let midpoint = midpoint(*start, *end);
        let bearing = bearing(*start, *end);
        let best = edges
            .iter()
            .filter_map(|edge| score_edge(edge, midpoint, bearing, max_distance_m))
            .min_by(EdgeMatch::compare);
        match best {
            Some(found) => matches.push(found),
            None => unmatched_segments += 1,
        }
    }
    MatchResult {
        matches,
        unmatched_segments,
    }
}

impl EdgeMatch {
    fn compare(&self, other: &Self) -> std::cmp::Ordering {
        other
            .confidence
            .total_cmp(&self.confidence)
            .then_with(|| self.distance_m.total_cmp(&other.distance_m))
            .then_with(|| {
                self.bearing_delta_degrees
                    .total_cmp(&other.bearing_delta_degrees)
            })
            .then_with(|| self.edge_id.cmp(&other.edge_id))
    }
}

fn score_edge(
    edge: &GraphEdge,
    point: Point,
    trace_bearing: f64,
    max_distance_m: f64,
) -> Option<EdgeMatch> {
    let (start, end) = edge.geometry.first().zip(edge.geometry.last())?;
    if edge.geometry.len() < 2 {
        return None;
    }
    let distance_m = haversine_m(point, midpoint(*start, *end));
    if !distance_m.is_finite() || distance_m > max_distance_m {
        return None;
    }
    let bearing_delta_degrees = bearing_delta(trace_bearing, bearing(*start, *end));
    let confidence =
        (1.0 - distance_m / max_distance_m).max(0.0) * (1.0 - bearing_delta_degrees / 180.0);
    Some(EdgeMatch {
        edge_id: edge.id,
        distance_m,
        bearing_delta_degrees,
        confidence,
    })
}

fn midpoint((lat_a, lon_a): Point, (lat_b, lon_b): Point) -> Point {
    (lat_a.midpoint(lat_b), lon_a.midpoint(lon_b))
}

fn haversine_m((lat_a, lon_a): Point, (lat_b, lon_b): Point) -> f64 {
    let to_rad = std::f64::consts::PI / 180.0;
    let lat_delta = (lat_b - lat_a) * to_rad;
    let lon_delta = (lon_b - lon_a) * to_rad;
    let value = (lat_delta / 2.0).sin().powi(2)
        + (lat_a * to_rad).cos() * (lat_b * to_rad).cos() * (lon_delta / 2.0).sin().powi(2);
    6_371_000.0 * 2.0 * value.sqrt().atan2((1.0 - value).sqrt())
}

fn bearing((lat_a, lon_a): Point, (lat_b, lon_b): Point) -> f64 {
    let to_rad = std::f64::consts::PI / 180.0;
    let lon_delta = (lon_b - lon_a) * to_rad;
    let y = lon_delta.sin() * (lat_b * to_rad).cos();
    let x = (lat_a * to_rad).cos() * (lat_b * to_rad).sin()
        - (lat_a * to_rad).sin() * (lat_b * to_rad).cos() * lon_delta.cos();
    (y.atan2(x).to_degrees() + 360.0) % 360.0
}

fn bearing_delta(first: f64, second: f64) -> f64 {
    ((first - second + 180.0).rem_euclid(360.0) - 180.0).abs()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn favors_same_bearing_when_edges_are_equally_close() {
        let result = match_polyline(
            &[(41.2, 0.8), (41.21, 0.8)],
            &[
                GraphEdge {
                    id: 2,
                    geometry: vec![(41.2, 0.8001), (41.21, 0.8001)],
                },
                GraphEdge {
                    id: 1,
                    geometry: vec![(41.205, 0.7999), (41.205, 0.8001)],
                },
            ],
            200.0,
        );
        assert_eq!(result.matches[0].edge_id, 2);
        assert!(result.matches[0].confidence > 0.8);
    }

    #[test]
    fn reports_far_segments_as_unmatched() {
        let result = match_polyline(&[(0.0, 0.0), (0.0, 0.01)], &[], 100.0);
        assert_eq!(result.unmatched_segments, 1);
    }
}
