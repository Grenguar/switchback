//! Deterministic, I/O-free spine-and-connectors loop routing.
//!
//! The caller supplies a compact graph assembled from `TrailPack` tiles. No file,
//! clock, random number generator, or platform-specific type is used here, so
//! this exact implementation can later compile to WASM.

use std::cmp::{Ordering, Reverse};
use std::collections::{BinaryHeap, HashMap, HashSet};

use thiserror::Error;

pub type NodeId = u32;
pub type EdgeId = u64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Graph {
    pub node_count: u32,
    pub edges: Vec<Edge>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edge {
    pub id: EdgeId,
    pub from: NodeId,
    pub to: NodeId,
    pub length_m: u32,
    pub ascent_m: u16,
    pub official: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LoopRequest {
    pub start: NodeId,
    pub target_distance_m: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedLoop {
    /// Edge IDs in travel order: outbound connector, official spine, return connector.
    pub edge_ids: Vec<EdgeId>,
    pub distance_m: u32,
    pub ascent_m: u32,
    pub official_distance_m: u32,
    pub entry: NodeId,
    pub exit: NodeId,
}

impl PlannedLoop {
    #[must_use]
    pub fn official_percent(&self) -> u8 {
        if self.distance_m == 0 {
            return 0;
        }
        let percent = (u64::from(self.official_distance_m) * 100) / u64::from(self.distance_m);
        u8::try_from(percent.min(100)).unwrap_or(100)
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum RouteError {
    #[error("start node {0} is outside the graph")]
    UnknownStart(NodeId),
    #[error("target distance must be greater than zero")]
    ZeroTargetDistance,
    #[error("edge {edge_id} references node {node}, outside a graph with {node_count} nodes")]
    InvalidEdge {
        edge_id: EdgeId,
        node: NodeId,
        node_count: u32,
    },
    #[error("edge IDs must be unique; {0} occurs more than once")]
    DuplicateEdgeId(EdgeId),
    #[error("no reachable official spine can form a loop from start {start}")]
    NoLoop { start: NodeId },
}

impl Graph {
    /// # Errors
    ///
    /// Returns an error for invalid graph input, an invalid request, or when no
    /// reachable official spine can make a loop within the connector envelope.
    pub fn plan_loop(&self, request: LoopRequest) -> Result<PlannedLoop, RouteError> {
        self.validate(request)?;
        let adjacency = self.adjacency();
        let official_nodes = self.official_nodes();
        let max_connector_m = request.target_distance_m / 4;
        let mut best: Option<Candidate> = None;

        for &entry in &official_nodes {
            let Some(outbound) = shortest_path(&adjacency, request.start, entry, false) else {
                continue;
            };
            if outbound.distance_m > max_connector_m {
                continue;
            }
            for &exit in &official_nodes {
                if entry == exit {
                    continue;
                }
                let Some(spine) = shortest_path(&adjacency, entry, exit, true) else {
                    continue;
                };
                let Some(returning) = shortest_path(&adjacency, exit, request.start, false) else {
                    continue;
                };
                if returning.distance_m > max_connector_m {
                    continue;
                }

                let mut edge_ids = outbound.edge_ids.clone();
                edge_ids.extend(spine.edge_ids);
                edge_ids.extend(returning.edge_ids);
                let distance_m = outbound.distance_m + spine.distance_m + returning.distance_m;
                let ascent_m = outbound.ascent_m + spine.ascent_m + returning.ascent_m;
                let official_distance_m = edge_ids
                    .iter()
                    .filter_map(|id| self.edge(*id))
                    .filter(|edge| edge.official)
                    .map(|edge| edge.length_m)
                    .sum();
                let repeated_edges = count_reused_edges(&edge_ids);
                let official_share = u64::from(official_distance_m) * 100 / u64::from(distance_m);
                let candidate = Candidate {
                    route: PlannedLoop {
                        edge_ids,
                        distance_m,
                        ascent_m,
                        official_distance_m,
                        entry,
                        exit,
                    },
                    distance_error_m: distance_m.abs_diff(request.target_distance_m),
                    share_error: share_error(official_share),
                    repeated_edges,
                };
                if best
                    .as_ref()
                    .is_none_or(|current| candidate.rank() < current.rank())
                {
                    best = Some(candidate);
                }
            }
        }
        best.map(|candidate| candidate.route)
            .ok_or(RouteError::NoLoop {
                start: request.start,
            })
    }

    fn validate(&self, request: LoopRequest) -> Result<(), RouteError> {
        if request.target_distance_m == 0 {
            return Err(RouteError::ZeroTargetDistance);
        }
        if request.start >= self.node_count {
            return Err(RouteError::UnknownStart(request.start));
        }
        let mut ids = HashSet::new();
        for edge in &self.edges {
            for node in [edge.from, edge.to] {
                if node >= self.node_count {
                    return Err(RouteError::InvalidEdge {
                        edge_id: edge.id,
                        node,
                        node_count: self.node_count,
                    });
                }
            }
            if !ids.insert(edge.id) {
                return Err(RouteError::DuplicateEdgeId(edge.id));
            }
        }
        Ok(())
    }

    fn adjacency(&self) -> Vec<Vec<&Edge>> {
        let mut adjacency = vec![Vec::new(); self.node_count as usize];
        for edge in &self.edges {
            adjacency[edge.from as usize].push(edge);
        }
        for edges in &mut adjacency {
            edges.sort_by_key(|edge| edge.id);
        }
        adjacency
    }

    fn official_nodes(&self) -> Vec<NodeId> {
        let mut nodes: Vec<_> = self
            .edges
            .iter()
            .filter(|edge| edge.official)
            .flat_map(|edge| [edge.from, edge.to])
            .collect();
        nodes.sort_unstable();
        nodes.dedup();
        nodes
    }

    fn edge(&self, id: EdgeId) -> Option<&Edge> {
        self.edges.iter().find(|edge| edge.id == id)
    }
}

#[derive(Debug)]
struct Candidate {
    route: PlannedLoop,
    distance_error_m: u32,
    share_error: u64,
    repeated_edges: u32,
}
impl Candidate {
    fn rank(&self) -> (u32, u32, u64, u32, Vec<EdgeId>) {
        // Avoiding out-and-back is the primary quality constraint, then target
        // distance, then the requested 50–70% official spine, then stable IDs.
        (
            self.repeated_edges,
            self.distance_error_m,
            self.share_error,
            self.route.ascent_m,
            self.route.edge_ids.clone(),
        )
    }
}
fn share_error(percent: u64) -> u64 {
    (50_u64.saturating_sub(percent)).max(percent.saturating_sub(70))
}
fn count_reused_edges(edge_ids: &[EdgeId]) -> u32 {
    let mut seen = HashSet::new();
    u32::try_from(edge_ids.iter().filter(|edge| !seen.insert(**edge)).count()).unwrap_or(u32::MAX)
}

#[derive(Debug, Clone, Eq, PartialEq)]
struct QueueItem {
    distance_m: u32,
    node: NodeId,
    tie_edge: EdgeId,
}
impl Ord for QueueItem {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.distance_m, self.node, self.tie_edge).cmp(&(
            other.distance_m,
            other.node,
            other.tie_edge,
        ))
    }
}
impl PartialOrd for QueueItem {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Debug, Clone)]
struct Path {
    edge_ids: Vec<EdgeId>,
    distance_m: u32,
    ascent_m: u32,
}
fn shortest_path(
    adjacency: &[Vec<&Edge>],
    start: NodeId,
    goal: NodeId,
    official_only: bool,
) -> Option<Path> {
    if start == goal {
        return Some(Path {
            edge_ids: vec![],
            distance_m: 0,
            ascent_m: 0,
        });
    }
    let mut queue = BinaryHeap::new();
    let mut best: HashMap<NodeId, (u32, Vec<EdgeId>, u32)> = HashMap::new();
    best.insert(start, (0, vec![], 0));
    queue.push(Reverse(QueueItem {
        distance_m: 0,
        node: start,
        tie_edge: 0,
    }));
    while let Some(Reverse(item)) = queue.pop() {
        let (distance, path, ascent) = best.get(&item.node)?.clone();
        if distance != item.distance_m {
            continue;
        }
        if item.node == goal {
            return Some(Path {
                edge_ids: path,
                distance_m: distance,
                ascent_m: ascent,
            });
        }
        for edge in &adjacency[item.node as usize] {
            if official_only && !edge.official {
                continue;
            }
            let next_distance = distance.checked_add(edge.length_m)?;
            let mut next_path = path.clone();
            next_path.push(edge.id);
            let next = (next_distance, next_path, ascent + u32::from(edge.ascent_m));
            let replace = best
                .get(&edge.to)
                .is_none_or(|current| (next.0, &next.1) < (current.0, &current.1));
            if replace {
                best.insert(edge.to, next);
                queue.push(Reverse(QueueItem {
                    distance_m: next_distance,
                    node: edge.to,
                    tie_edge: edge.id,
                }));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    fn edge(id: u64, from: u32, to: u32, length: u32, official: bool) -> Edge {
        Edge {
            id,
            from,
            to,
            length_m: length,
            ascent_m: 10,
            official,
        }
    }

    #[test]
    fn makes_a_real_loop_with_an_official_spine() {
        // 0=start; 1/2=GR 7 entry/exit; 3/4 provide distinct connectors.
        let graph = Graph {
            node_count: 5,
            edges: vec![
                edge(1, 0, 1, 100, false),
                edge(2, 1, 2, 350, true),
                edge(3, 2, 4, 50, false),
                edge(4, 4, 0, 100, false),
                edge(5, 0, 3, 100, false),
                edge(6, 3, 1, 100, false),
                edge(7, 2, 0, 700, false),
            ],
        };
        let route = graph
            .plan_loop(LoopRequest {
                start: 0,
                target_distance_m: 600,
            })
            .unwrap();
        assert_eq!(route.edge_ids, vec![1, 2, 3, 4]);
        assert_eq!(route.distance_m, 600);
        assert_eq!(route.official_distance_m, 350);
        assert_eq!(route.official_percent(), 58);
    }

    #[test]
    fn ties_are_stable_by_edge_id() {
        let graph = Graph {
            node_count: 5,
            edges: vec![
                edge(20, 0, 1, 50, false),
                edge(10, 0, 3, 25, false),
                edge(30, 1, 2, 200, true),
                edge(40, 2, 4, 50, false),
                edge(50, 4, 0, 50, false),
                edge(60, 3, 1, 25, false),
            ],
        };
        let first = graph
            .plan_loop(LoopRequest {
                start: 0,
                target_distance_m: 400,
            })
            .unwrap();
        for _ in 0..10 {
            assert_eq!(
                graph
                    .plan_loop(LoopRequest {
                        start: 0,
                        target_distance_m: 400
                    })
                    .unwrap(),
                first
            );
        }
        assert_eq!(first.edge_ids, vec![10, 60, 30, 40, 50]);
    }

    #[test]
    fn refuses_to_invent_a_loop_without_an_official_spine() {
        let graph = Graph {
            node_count: 2,
            edges: vec![edge(1, 0, 1, 100, false), edge(2, 1, 0, 100, false)],
        };
        assert!(matches!(
            graph.plan_loop(LoopRequest {
                start: 0,
                target_distance_m: 400
            }),
            Err(RouteError::NoLoop { .. })
        ));
    }
}
