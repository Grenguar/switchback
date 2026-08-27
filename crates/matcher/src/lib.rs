//! Simple, deterministic polyline-to-edge matching.
//!
//! This first tier deliberately has no geospatial index or network dependency:
//! every input edge segment is considered in stable ID order and scored by
//! perpendicular distance plus direction-insensitive bearing agreement.

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
    /// Length-weighted evidence suitable for evaluating a positional threshold
    /// such as the MVP's 20 m Q8 gate.
    pub summary: MatchSummary,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MatchSummary {
    /// Total length of all input trace segments.
    pub total_trace_length_m: f64,
    /// Length of trace segments for which an edge was found within the requested threshold.
    pub matched_trace_length_m: f64,
    /// The complement of `matched_trace_length_m`.
    pub unmatched_trace_length_m: f64,
    /// `matched_trace_length_m / total_trace_length_m`, or zero for an empty trace.
    pub matched_length_fraction: f64,
    /// Match distance averaged by source-trace segment length, not segment count.
    pub length_weighted_mean_distance_m: Option<f64>,
    /// The greatest accepted match distance. This is useful alongside the
    /// requested threshold when reporting a Q8 result.
    pub max_matched_distance_m: Option<f64>,
}

/// Match each adjacent pair in a trace to the best graph edge.
///
/// An edge is accepted only when one of its geometry segments is at most
/// `max_distance_m` from the trace-segment midpoint. Equal scores resolve by
/// edge ID, then geometry segment index, for reproducibility.
#[must_use]
pub fn match_polyline(polyline: &[Point], edges: &[GraphEdge], max_distance_m: f64) -> MatchResult {
    let mut matches = Vec::new();
    let mut unmatched_segments = 0;
    let mut total_trace_length_m = 0.0;
    let mut matched_trace_length_m = 0.0;
    let mut weighted_distance_sum = 0.0;
    let mut max_matched_distance_m: Option<f64> = None;

    for segment in polyline.windows(2) {
        let [start, end] = segment else {
            unreachable!()
        };
        let midpoint = midpoint(*start, *end);
        let bearing = bearing(*start, *end);
        let trace_length_m = haversine_m(*start, *end);
        total_trace_length_m += trace_length_m;
        let best = edges
            .iter()
            .flat_map(|edge| score_edge(edge, midpoint, bearing, max_distance_m))
            .min_by(ScoredMatch::compare);
        match best {
            Some(found) => {
                matched_trace_length_m += trace_length_m;
                weighted_distance_sum += found.edge_match.distance_m * trace_length_m;
                max_matched_distance_m = Some(
                    max_matched_distance_m.map_or(found.edge_match.distance_m, |current| {
                        current.max(found.edge_match.distance_m)
                    }),
                );
                matches.push(found.edge_match);
            }
            None => unmatched_segments += 1,
        }
    }
    let unmatched_trace_length_m = (total_trace_length_m - matched_trace_length_m).max(0.0);
    MatchResult {
        matches,
        unmatched_segments,
        summary: MatchSummary {
            total_trace_length_m,
            matched_trace_length_m,
            unmatched_trace_length_m,
            matched_length_fraction: if total_trace_length_m > 0.0 {
                matched_trace_length_m / total_trace_length_m
            } else {
                0.0
            },
            length_weighted_mean_distance_m: (matched_trace_length_m > 0.0)
                .then(|| weighted_distance_sum / matched_trace_length_m),
            max_matched_distance_m,
        },
    }
}

#[derive(Debug)]
struct ScoredMatch {
    edge_match: EdgeMatch,
    segment_index: usize,
}

impl ScoredMatch {
    fn compare(&self, other: &Self) -> std::cmp::Ordering {
        other
            .edge_match
            .confidence
            .total_cmp(&self.edge_match.confidence)
            .then_with(|| {
                self.edge_match
                    .distance_m
                    .total_cmp(&other.edge_match.distance_m)
            })
            .then_with(|| {
                self.edge_match
                    .bearing_delta_degrees
                    .total_cmp(&other.edge_match.bearing_delta_degrees)
            })
            .then_with(|| self.edge_match.edge_id.cmp(&other.edge_match.edge_id))
            .then_with(|| self.segment_index.cmp(&other.segment_index))
    }
}

fn score_edge(
    edge: &GraphEdge,
    point: Point,
    trace_bearing: f64,
    max_distance_m: f64,
) -> impl Iterator<Item = ScoredMatch> + '_ {
    edge.geometry
        .windows(2)
        .enumerate()
        .filter_map(move |(segment_index, segment)| {
            let [start, end] = segment else {
                unreachable!()
            };
            let distance_m = point_to_segment_distance_m(point, *start, *end);
            if !distance_m.is_finite() || distance_m > max_distance_m {
                return None;
            }
            let bearing_delta_degrees =
                direction_independent_bearing_delta(trace_bearing, bearing(*start, *end));
            let confidence = (1.0 - distance_m / max_distance_m).max(0.0)
                * (1.0 - bearing_delta_degrees / 180.0);
            Some(ScoredMatch {
                edge_match: EdgeMatch {
                    edge_id: edge.id,
                    distance_m,
                    bearing_delta_degrees,
                    confidence,
                },
                segment_index,
            })
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

fn point_to_segment_distance_m(point: Point, start: Point, end: Point) -> f64 {
    // The input data is tiled regional trail data. A local equirectangular
    // projection is therefore accurate enough while avoiding a heavyweight GIS
    // dependency in this deterministic T1/T2 matcher.
    let reference_latitude = (point.0 + start.0 + end.0) / 3.0;
    let (point_x, point_y) = local_xy(point, reference_latitude);
    let (start_x, start_y) = local_xy(start, reference_latitude);
    let (end_x, end_y) = local_xy(end, reference_latitude);
    let delta_x = end_x - start_x;
    let delta_y = end_y - start_y;
    let length_squared = delta_x.mul_add(delta_x, delta_y * delta_y);
    if length_squared <= f64::EPSILON {
        return (point_x - start_x).hypot(point_y - start_y);
    }
    let projection =
        ((point_x - start_x) * delta_x + (point_y - start_y) * delta_y) / length_squared;
    let clamped = projection.clamp(0.0, 1.0);
    let closest_x = start_x + clamped * delta_x;
    let closest_y = start_y + clamped * delta_y;
    (point_x - closest_x).hypot(point_y - closest_y)
}

fn local_xy((latitude, longitude): Point, reference_latitude: f64) -> (f64, f64) {
    let radians_per_degree = std::f64::consts::PI / 180.0;
    let earth_radius_m = 6_371_000.0;
    (
        longitude
            * radians_per_degree
            * earth_radius_m
            * (reference_latitude * radians_per_degree).cos(),
        latitude * radians_per_degree * earth_radius_m,
    )
}

fn bearing((lat_a, lon_a): Point, (lat_b, lon_b): Point) -> f64 {
    let to_rad = std::f64::consts::PI / 180.0;
    let lon_delta = (lon_b - lon_a) * to_rad;
    let y = lon_delta.sin() * (lat_b * to_rad).cos();
    let x = (lat_a * to_rad).cos() * (lat_b * to_rad).sin()
        - (lat_a * to_rad).sin() * (lat_b * to_rad).cos() * lon_delta.cos();
    (y.atan2(x).to_degrees() + 360.0) % 360.0
}

fn direction_independent_bearing_delta(first: f64, second: f64) -> f64 {
    let directional_delta = ((first - second + 180.0).rem_euclid(360.0) - 180.0).abs();
    directional_delta.min(180.0 - directional_delta)
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
        assert!(result.summary.matched_length_fraction.abs() < f64::EPSILON);
        assert!(result.summary.length_weighted_mean_distance_m.is_none());
    }

    #[test]
    fn matches_the_nearest_segment_of_a_long_curved_edge() {
        // The endpoints' midpoint is over 500 m away. The trace nevertheless
        // crosses the second leg of this L-shaped edge, so an endpoint/midpoint
        // approximation would incorrectly fail a 20 m Q8 evaluation.
        let result = match_polyline(
            &[(0.0099, 0.005), (0.0101, 0.005)],
            &[GraphEdge {
                id: 7,
                geometry: vec![(0.0, 0.0), (0.01, 0.0), (0.01, 0.01)],
            }],
            20.0,
        );

        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].edge_id, 7);
        assert!(result.matches[0].distance_m < 0.01);
        assert!((result.summary.matched_length_fraction - 1.0).abs() < f64::EPSILON);
        assert!(result.summary.max_matched_distance_m.unwrap() < 0.01);
    }

    #[test]
    fn treats_reverse_edge_direction_as_bearing_agreement() {
        let result = match_polyline(
            &[(41.2, 0.8), (41.21, 0.8)],
            &[GraphEdge {
                id: 8,
                geometry: vec![(41.21, 0.8), (41.2, 0.8)],
            }],
            5.0,
        );

        let found = &result.matches[0];
        assert!(found.bearing_delta_degrees < 0.000_001);
        assert!(found.confidence > 0.99);
    }

    #[test]
    fn weights_summary_by_trace_length_instead_of_segment_count() {
        let result = match_polyline(
            &[(0.0, 0.0), (0.0, 0.0001), (0.0, 0.0101)],
            &[GraphEdge {
                id: 9,
                geometry: vec![(0.00009, 0.0), (0.00009, 0.0101)],
            }],
            20.0,
        );

        // Both segments match but the long second one dominates the mean: its
        // ~10 m offset, not the short segment's near-zero offset, is reported.
        let average = result.summary.length_weighted_mean_distance_m.unwrap();
        assert!(average > 9.0);
        assert!(average < 11.0);
    }
}
