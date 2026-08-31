import type { TrailPackArtifact, TrailPackEdge } from "./trailpack";

export type StartDefinition = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  availability: "available" | "unavailable";
  description: string;
};

export const documentedStarts = {
  font_groga_parking: {
    id: "font_groga_parking",
    name: "Font Groga car park",
    latitude: 41.427793,
    longitude: 2.1176235,
    availability: "available",
    description: "Car-access trailhead at Mirador de la Font Groga, verified 29 m from the Collserola trail graph.",
  },
  vista_rica_parking: {
    id: "vista_rica_parking",
    name: "Vista Rica car park",
    latitude: 41.431472,
    longitude: 2.126,
    availability: "available",
    description: "Car-access trailhead at the Vista Rica parking area on the Arrabassada road, verified 14 m from the Collserola trail graph.",
  },
  vallvidrera_crest_access: {
    id: "vallvidrera_crest_access",
    name: "Cresta de Collserola access",
    latitude: 41.426059751015,
    longitude: 2.116789968413,
    availability: "available",
    description: "On-trail access coordinate from the CNIG/FEDME PR-C-035 Cresta de Collserola source trace.",
  },
} as const satisfies Record<string, StartDefinition>;
export type StartId = keyof typeof documentedStarts;
export type PlannedSegment = { name: string; surface: string | null; sac_scale: string | null; waymarked: boolean; official_ref: string | null };
export type PlannedRoute = { id: string; name: string; start: (typeof documentedStarts)[StartId]; distanceKm: number; durationHours: number; waymarkedPercent: number; coordinates: Array<[number, number]>; segments: PlannedSegment[]; edgeIds: string[]; source: string };
/** A user-selected coordinate that must resolve to a nearby TrailPack node. */
export type Waypoint = { latitude: number; longitude: number };
export type PlannerProbe = { latitude: number; longitude: number; targetKm: number; preferWaymarked: boolean };
export type PlannerDiagnostic = {
  snap: { status: "accepted" | "rejected"; nearest_node: number; distance_m: number; max_distance_m: number };
  graph: { nodes: number; directed_edges: number; mutually_reachable_nodes: number };
  candidates: { distance_window: number; examined: number; viable_loops: number; nearest_viable_loop_km: number | null };
  rejected: { snap: number; closure: number; distance: number; reuse: number };
  result: { status: "loop_available" | "no_loop" | "snap_rejected"; message: string };
};

type IndexedEdge = TrailPackEdge & { from: number; to: number };
type HeapItem = { node: number; distance: number };

const MIN_LOOP_METRES = 1_000;
const MAX_LOOP_METRES = 60_000;
// A circuit is useful only if it is recognisably close to the requested
// distance. This still permits normal routing variation on a trail network,
// but never silently substitutes a much shorter outing.
const MAX_TARGET_ERROR_FRACTION = 0.15;
// A documented trailhead must land close enough to an actual graph node that
// the UI never silently starts a route from an unrelated trail.
const MAX_SNAP_METRES = 1_000;

const haversineMetres = (fromLat: number, fromLon: number, toLat: number, toLon: number): number => {
  const radians = Math.PI / 180;
  const latitudeDelta = (toLat - fromLat) * radians;
  const longitudeDelta = (toLon - fromLon) * radians;
  const a = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(fromLat * radians) * Math.cos(toLat * radians) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

class MinHeap {
  private values: HeapItem[] = [];
  push(value: HeapItem): void { this.values.push(value); for (let index = this.values.length - 1; index > 0;) { const parent = Math.floor((index - 1) / 2); if (this.values[parent]!.distance <= value.distance) break; this.values[index] = this.values[parent]!; index = parent; this.values[index] = value; } }
  pop(): HeapItem | undefined { const first = this.values[0]; const last = this.values.pop(); if (!first || !last || this.values.length === 0) return first; let index = 0; while (true) { const left = index * 2 + 1; const right = left + 1; if (left >= this.values.length) break; const child = right < this.values.length && this.values[right]!.distance < this.values[left]!.distance ? right : left; if (this.values[child]!.distance >= last.distance) break; this.values[index] = this.values[child]!; index = child; } this.values[index] = last; return first; }
}

export class TrailPlanner {
  private readonly nodes: Array<[number, number]> = [];
  private readonly edges: IndexedEdge[] = [];
  private readonly outgoing: number[][] = [];
  private readonly incoming: number[][] = [];

  constructor(private readonly artifact: TrailPackArtifact) {
    const globalNodes = new Map<string, number>();
    for (const tileId of artifact.manifest.tiles) {
      const tile = artifact.tiles[tileId]!;
      const localToGlobal: number[] = [];
      for (const node of tile.nodes) {
        const key = `${node.lat_e7},${node.lon_e7}`;
        let index = globalNodes.get(key);
        if (index === undefined) { index = this.nodes.length; globalNodes.set(key, index); this.nodes.push([node.lat_e7 / 1e7, node.lon_e7 / 1e7]); this.outgoing.push([]); this.incoming.push([]); }
        localToGlobal.push(index);
      }
      for (const edge of tile.edges) {
        const index = this.edges.length;
        const from = localToGlobal[edge.from]!;
        const to = localToGlobal[edge.to]!;
        this.edges.push({ ...edge, from, to });
        this.outgoing[from]!.push(index);
        this.incoming[to]!.push(index);
      }
    }
  }

  plan(startId: StartId, targetKm: number, preferWaymarked: boolean): PlannedRoute {
    const start = documentedStarts[startId];
    const snapped = this.nearestNode(start.latitude, start.longitude);
    if (snapped.distanceMetres > MAX_SNAP_METRES) {
      throw new Error(`${start.name} is ${Math.round(snapped.distanceMetres)} m from the nearest TrailPack node; the graph refuses to snap beyond ${MAX_SNAP_METRES} m.`);
    }
    const startNode = snapped.node;
    const outward = this.dijkstra(startNode, false, preferWaymarked);
    const homeward = this.dijkstra(startNode, true, preferWaymarked);
    const targetMetres = targetKm * 1000;
    let winner: { score: number; edges: IndexedEdge[] } | undefined;
    const candidates: Array<{ node: number; score: number }> = [];
    for (let node = 0; node < this.nodes.length; node += 1) {
      const away = outward.distance[node]!;
      const home = homeward.distance[node]!;
      const total = away + home;
      if (!Number.isFinite(total) || node === startNode || total < MIN_LOOP_METRES || total > MAX_LOOP_METRES) continue;
      candidates.push({ node, score: Math.abs(total - targetMetres) });
    }
    // The shortest route home often simply reverses the outbound path. Try a
    // bounded set of promising pivots again with those physical edges blocked,
    // so a returned route is a real loop rather than a disguised out-and-back.
    for (const { node } of candidates.sort((a, b) => a.score - b.score).slice(0, 160)) {
      const outEdges = this.forwardEdges(node, outward.previous);
      if (outEdges.length === 0) continue;
      // Blocking a midpoint rather than every outbound edge allows a shared
      // trailhead approach, while still forcing a distinct return branch.
      const blocked = new Set([outEdges[Math.floor(outEdges.length / 2)]!.physical_id]);
      const returnEdges = this.findPath(node, startNode, blocked, preferWaymarked);
      if (!returnEdges || returnEdges.length === 0) continue;
      const outwardPhysical = new Set(outEdges.map((edge) => edge.physical_id));
      const shared = returnEdges.filter((edge) => outwardPhysical.has(edge.physical_id)).length / Math.max(outEdges.length, returnEdges.length);
      if (shared > 0.75) continue;
      const total = outEdges.concat(returnEdges).reduce((sum, edge) => sum + edge.length_m, 0);
      if (total > MAX_LOOP_METRES) continue;
      if (Math.abs(total - targetMetres) > targetMetres * MAX_TARGET_ERROR_FRACTION) continue;
      const officialPenalty = preferWaymarked ? (outEdges.concat(returnEdges).filter((edge) => edge.official === null).length / (outEdges.length + returnEdges.length)) * 500 : 0;
      const score = Math.abs(total - targetMetres) + officialPenalty;
      if (!winner || score < winner.score) winner = { score, edges: [...outEdges, ...returnEdges] };
    }
    if (!winner) {
      const diagnostic = this.probe({ latitude: start.latitude, longitude: start.longitude, targetKm, preferWaymarked });
      throw new Error(`No non-retracing circuit within ${Math.round(MAX_TARGET_ERROR_FRACTION * 100)}% of ${targetKm} km can be formed from this TrailPack start. ${diagnostic.result.message} Rejected candidates: ${diagnostic.rejected.closure} closure, ${diagnostic.rejected.distance} distance, ${diagnostic.rejected.reuse} reuse.`);
    }
    return this.toPlannedRoute(start, winner.edges);
  }

  /**
   * Rebuilds a loop through a user waypoint using directed graph edges only.
   * The return leg is forbidden from using any physical segment used outbound,
   * so a successful edit cannot silently turn a loop into an out-and-back.
   * This method has no mutable planner state: failures leave its input route
   * and any caller-owned session unchanged.
   */
  replanViaWaypoint(route: PlannedRoute, waypoint: Waypoint, preferWaymarked = true): PlannedRoute {
    if (!Number.isFinite(waypoint.latitude) || waypoint.latitude < -90 || waypoint.latitude > 90 || !Number.isFinite(waypoint.longitude) || waypoint.longitude < -180 || waypoint.longitude > 180) {
      throw new Error("Waypoint must contain finite WGS84 latitude and longitude values.");
    }
    if (route.edgeIds.length === 0) throw new Error("Cannot edit an empty route.");
    const edgeById = new Map(this.edges.map((edge) => [edge.id, edge]));
    const existingEdges = route.edgeIds.map((id) => edgeById.get(id));
    if (existingEdges.some((edge) => edge === undefined)) throw new Error("The active route does not belong to this TrailPack graph.");
    const startNode = existingEdges[0]!.from;
    const snapped = this.nearestNode(waypoint.latitude, waypoint.longitude);
    if (snapped.distanceMetres > MAX_SNAP_METRES) {
      throw new Error(`Waypoint is ${Math.round(snapped.distanceMetres)} m from the nearest TrailPack node; the graph refuses to snap beyond ${MAX_SNAP_METRES} m.`);
    }
    if (snapped.node === startNode) throw new Error("Waypoint resolves to the route start; choose a distinct on-trail waypoint.");
    const outward = this.findPath(startNode, snapped.node, new Set(), preferWaymarked);
    if (!outward || outward.length === 0) throw new Error("No directed TrailPack path reaches that waypoint from the current route start.");
    const returnEdges = this.findPath(snapped.node, startNode, new Set(outward.map((edge) => edge.physical_id)), preferWaymarked);
    if (!returnEdges || returnEdges.length === 0) throw new Error("No directed non-retracing return path exists from that waypoint.");
    const loopEdges = outward.concat(returnEdges);
    const distanceMetres = loopEdges.reduce((sum, edge) => sum + edge.length_m, 0);
    if (distanceMetres < MIN_LOOP_METRES || distanceMetres > MAX_LOOP_METRES) {
      throw new Error(`Waypoint loop is ${Math.round(distanceMetres / 100) / 10} km; TrailPack accepts loops between ${MIN_LOOP_METRES / 1000} and ${MAX_LOOP_METRES / 1000} km.`);
    }
    return this.toPlannedRoute(route.start, loopEdges, "via waypoint");
  }

  /**
   * Rebuilds the current loop while excluding one physical TrailPack segment.
   * All candidate calculations happen before a route is returned, which lets
   * callers keep their rendered route and session intact when there is no
   * legal replacement. A physical id is blocked in both directions.
   */
  replanAvoidingSegment(route: PlannedRoute, physicalId: string, preferWaymarked = true): PlannedRoute {
    if (!physicalId) throw new Error("A TrailPack physical segment id is required.");
    const edgeById = new Map(this.edges.map((edge) => [edge.id, edge]));
    const activeEdges = route.edgeIds.map((id) => edgeById.get(id));
    if (activeEdges.some((edge) => edge === undefined)) throw new Error("The active route does not belong to this TrailPack graph.");
    if (!activeEdges.some((edge) => edge!.physical_id === physicalId)) throw new Error("The requested segment is not part of the active TrailPack route.");
    const startNode = activeEdges[0]!.from;
    const loopEdges = this.findLoop(startNode, route.distanceKm * 1_000, preferWaymarked, new Set([physicalId]));
    if (!loopEdges) throw new Error("No bounded directed non-retracing loop can avoid that segment; the current route is unchanged.");
    if (loopEdges.some((edge) => edge.physical_id === physicalId)) throw new Error("TrailPack avoidance verification failed; the current route is unchanged.");
    return this.toPlannedRoute(route.start, loopEdges, "avoiding segment");
  }

  /**
   * Evaluates a prospective trailhead without returning a route. This is used
   * by tests and by planning failures so rejected inputs have inspectable,
   * countable evidence rather than a generic \"no route\" message.
   */
  probe(input: PlannerProbe): PlannerDiagnostic {
    const snapped = this.nearestNode(input.latitude, input.longitude);
    const rejected = { snap: 0, closure: 0, distance: 0, reuse: 0 };
    const base = {
      snap: {
        status: (snapped.distanceMetres <= MAX_SNAP_METRES ? "accepted" : "rejected") as "accepted" | "rejected",
        nearest_node: snapped.node,
        distance_m: Math.round(snapped.distanceMetres),
        max_distance_m: MAX_SNAP_METRES,
      },
      graph: { nodes: this.nodes.length, directed_edges: this.edges.length, mutually_reachable_nodes: 0 },
    };
    if (snapped.distanceMetres > MAX_SNAP_METRES) {
      rejected.snap = 1;
      return {
        ...base,
        candidates: { distance_window: 0, examined: 0, viable_loops: 0, nearest_viable_loop_km: null },
        rejected,
        result: { status: "snap_rejected", message: `Start is ${Math.round(snapped.distanceMetres)} m from the nearest TrailPack node; maximum snap is ${MAX_SNAP_METRES} m.` },
      };
    }

    const outward = this.dijkstra(snapped.node, false, input.preferWaymarked);
    const homeward = this.dijkstra(snapped.node, true, input.preferWaymarked);
    const targetMetres = input.targetKm * 1_000;
    const candidates: Array<{ node: number; score: number }> = [];
    for (let node = 0; node < this.nodes.length; node += 1) {
      const away = outward.distance[node]!;
      const home = homeward.distance[node]!;
      if (Number.isFinite(away) && Number.isFinite(home)) base.graph.mutually_reachable_nodes += 1;
      const total = away + home;
      // A node that is not mutually reachable is omitted before candidate
      // selection. The closure count below is deliberately limited to the
      // bounded candidate set, so it remains an explanation of planner
      // decisions rather than a misleading graph-wide total.
      if (!Number.isFinite(total) || node === snapped.node) continue;
      if (total < MIN_LOOP_METRES || total > MAX_LOOP_METRES) { rejected.distance += 1; continue; }
      candidates.push({ node, score: Math.abs(total - targetMetres) });
    }
    const examined = candidates.sort((a, b) => a.score - b.score).slice(0, 160);
    let viableLoops = 0;
    let nearestViableLoopMetres: number | undefined;
    for (const { node } of examined) {
      const outEdges = this.forwardEdges(node, outward.previous);
      if (outEdges.length === 0) { rejected.closure += 1; continue; }
      const blocked = new Set([outEdges[Math.floor(outEdges.length / 2)]!.physical_id]);
      const returnEdges = this.findPath(node, snapped.node, blocked, input.preferWaymarked);
      if (!returnEdges || returnEdges.length === 0) { rejected.closure += 1; continue; }
      const outwardPhysical = new Set(outEdges.map((edge) => edge.physical_id));
      const shared = returnEdges.filter((edge) => outwardPhysical.has(edge.physical_id)).length / Math.max(outEdges.length, returnEdges.length);
      if (shared > 0.75) { rejected.reuse += 1; continue; }
      const total = outEdges.concat(returnEdges).reduce((sum, edge) => sum + edge.length_m, 0);
      if (total > MAX_LOOP_METRES) { rejected.distance += 1; continue; }
      viableLoops += 1;
      if (nearestViableLoopMetres === undefined || Math.abs(total - targetMetres) < Math.abs(nearestViableLoopMetres - targetMetres)) nearestViableLoopMetres = total;
    }
    const message = viableLoops > 0
      ? `${viableLoops} non-retracing directed loop candidate${viableLoops === 1 ? "" : "s"} available from the snapped start.`
      : `No non-retracing directed loop close to ${input.targetKm} km can be formed from this TrailPack start.`;
    return {
      ...base,
      candidates: { distance_window: candidates.length, examined: examined.length, viable_loops: viableLoops, nearest_viable_loop_km: nearestViableLoopMetres === undefined ? null : Math.round(nearestViableLoopMetres / 100) / 10 },
      rejected,
      result: { status: viableLoops > 0 ? "loop_available" : "no_loop", message },
    };
  }

  private nearestNode(latitude: number, longitude: number): { node: number; distanceMetres: number } {
    let nearest = 0; let nearestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < this.nodes.length; index += 1) {
      const [lat, lon] = this.nodes[index]!;
      const distance = haversineMetres(latitude, longitude, lat, lon);
      if (distance < nearestDistance) { nearest = index; nearestDistance = distance; }
    }
    if (!Number.isFinite(nearestDistance)) throw new Error("TrailPack has no routable nodes.");
    return { node: nearest, distanceMetres: nearestDistance };
  }

  private toPlannedRoute(start: (typeof documentedStarts)[StartId], loopEdges: IndexedEdge[], suffix = ""): PlannedRoute {
    const waymarkedMetres = loopEdges.filter((edge) => edge.official !== null).reduce((sum, edge) => sum + edge.length_m, 0);
    const distanceMetres = loopEdges.reduce((sum, edge) => sum + edge.length_m, 0);
    const coordinates: Array<[number, number]> = [this.nodes[loopEdges[0]!.from]!];
    for (const edge of loopEdges) coordinates.push(this.nodes[edge.to]!);
    const segments = loopEdges.slice(0, 5).map((edge) => ({ name: edge.physical_id, surface: edge.terrain.surface, sac_scale: edge.terrain.sac_scale, waymarked: edge.official !== null, official_ref: edge.official?.ref_code ?? null }));
    return {
      id: `loop-${start.id}-${loopEdges.map((edge) => edge.id).join(".")}`,
      name: `${start.name} TrailPack loop${suffix ? ` ${suffix}` : ""}`,
      start,
      distanceKm: Math.round(distanceMetres / 100) / 10,
      durationHours: Math.round((distanceMetres / 4_000) * 10) / 10,
      waymarkedPercent: Math.round((waymarkedMetres / distanceMetres) * 100),
      coordinates,
      segments,
      edgeIds: loopEdges.map((edge) => edge.id),
      source: `${this.artifact.manifest.region_name} TrailPack v1`,
    };
  }

  private findLoop(startNode: number, targetMetres: number, preferWaymarked: boolean, permanentlyBlocked: Set<string> = new Set()): IndexedEdge[] | undefined {
    const outward = this.dijkstra(startNode, false, preferWaymarked, permanentlyBlocked);
    const homeward = this.dijkstra(startNode, true, preferWaymarked, permanentlyBlocked);
    const candidates: Array<{ node: number; score: number }> = [];
    for (let node = 0; node < this.nodes.length; node += 1) {
      const total = outward.distance[node]! + homeward.distance[node]!;
      if (!Number.isFinite(total) || node === startNode || total < MIN_LOOP_METRES || total > MAX_LOOP_METRES) continue;
      candidates.push({ node, score: Math.abs(total - targetMetres) });
    }
    let winner: { score: number; edges: IndexedEdge[] } | undefined;
    for (const { node } of candidates.sort((a, b) => a.score - b.score).slice(0, 160)) {
      const outEdges = this.forwardEdges(node, outward.previous);
      if (outEdges.length === 0) continue;
      const blocked = new Set(permanentlyBlocked);
      blocked.add(outEdges[Math.floor(outEdges.length / 2)]!.physical_id);
      const returnEdges = this.findPath(node, startNode, blocked, preferWaymarked);
      if (!returnEdges || returnEdges.length === 0) continue;
      const outwardPhysical = new Set(outEdges.map((edge) => edge.physical_id));
      const shared = returnEdges.filter((edge) => outwardPhysical.has(edge.physical_id)).length / Math.max(outEdges.length, returnEdges.length);
      if (shared > 0.75) continue;
      const allEdges = outEdges.concat(returnEdges);
      const total = allEdges.reduce((sum, edge) => sum + edge.length_m, 0);
      if (total < MIN_LOOP_METRES || total > MAX_LOOP_METRES || allEdges.some((edge) => permanentlyBlocked.has(edge.physical_id))) continue;
      const officialPenalty = preferWaymarked ? (allEdges.filter((edge) => edge.official === null).length / allEdges.length) * 500 : 0;
      const score = Math.abs(total - targetMetres) + officialPenalty;
      if (!winner || score < winner.score) winner = { score, edges: allEdges };
    }
    return winner?.edges;
  }

  private dijkstra(start: number, reverse: boolean, preferWaymarked: boolean, blockedPhysicalIds: Set<string> = new Set()): { distance: number[]; previous: Array<number | undefined> } {
    const distance = Array<number>(this.nodes.length).fill(Number.POSITIVE_INFINITY);
    const previous: Array<number | undefined> = Array(this.nodes.length).fill(undefined);
    distance[start] = 0; const queue = new MinHeap(); queue.push({ node: start, distance: 0 });
    for (let item = queue.pop(); item; item = queue.pop()) {
      if (item.distance !== distance[item.node]) continue;
      const candidates = reverse ? this.incoming[item.node]! : this.outgoing[item.node]!;
      for (const edgeIndex of candidates) {
        const edge = this.edges[edgeIndex]!;
        if (blockedPhysicalIds.has(edge.physical_id)) continue;
        const next = reverse ? edge.from : edge.to;
        // The preference must not depend on OSM way segmentation: a fixed
        // per-edge surcharge made densely mapped paths look artificially long
        // and returned dramatically shorter circuits. A small proportional
        // bias retains the preference without changing distance semantics.
        const cost = edge.length_m * (preferWaymarked && edge.official === null ? 1.02 : 1);
        const candidate = item.distance + cost;
        if (candidate < distance[next]!) { distance[next] = candidate; previous[next] = edgeIndex; queue.push({ node: next, distance: candidate }); }
      }
    }
    return { distance, previous };
  }

  private findPath(from: number, destination: number, blockedPhysicalIds: Set<string>, preferWaymarked: boolean): IndexedEdge[] | undefined {
    const distance = Array<number>(this.nodes.length).fill(Number.POSITIVE_INFINITY);
    const previous: Array<number | undefined> = Array(this.nodes.length).fill(undefined);
    distance[from] = 0; const queue = new MinHeap(); queue.push({ node: from, distance: 0 });
    for (let item = queue.pop(); item; item = queue.pop()) {
      if (item.distance !== distance[item.node]) continue;
      if (item.node === destination) break;
      for (const edgeIndex of this.outgoing[item.node]!) {
        const edge = this.edges[edgeIndex]!;
        if (blockedPhysicalIds.has(edge.physical_id)) continue;
        const candidate = item.distance + edge.length_m * (preferWaymarked && edge.official === null ? 1.02 : 1);
        if (candidate < distance[edge.to]!) { distance[edge.to] = candidate; previous[edge.to] = edgeIndex; queue.push({ node: edge.to, distance: candidate }); }
      }
    }
    if (!Number.isFinite(distance[destination]!)) return undefined;
    const reversed: IndexedEdge[] = [];
    for (let cursor = destination; cursor !== from;) { const edgeIndex = previous[cursor]; if (edgeIndex === undefined) return undefined; const edge = this.edges[edgeIndex]!; reversed.push(edge); cursor = edge.from; }
    return reversed.reverse();
  }

  private forwardEdges(node: number, previous: Array<number | undefined>): IndexedEdge[] {
    const reversed: IndexedEdge[] = [];
    for (let cursor = node; previous[cursor] !== undefined;) { const edge = this.edges[previous[cursor]!]!; reversed.push(edge); cursor = edge.from; }
    return reversed.reverse();
  }

}
