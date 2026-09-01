import { TrailPlanner, documentedStarts, selectableCircuitStartIds, type PlannedRoute, type Waypoint } from "./planner";
import { RouteSession, type WaypointEdit } from "./route-session";

export interface ToolAnnotations { readOnlyHint: boolean; untrustedContentHint: boolean; }
export interface ToolContract { name: "plan_route" | "get_route_summary" | "explain_segment" | "avoid_segment" | "prepare_gpx" | "describe_last_edit"; description: string; inputSchema: Record<string, unknown>; annotations: ToolAnnotations; execute: (input: unknown, signal?: AbortSignal) => Promise<unknown>; }
export type ToolInvocationObserver = (name: ToolContract["name"], input: unknown, result: unknown | undefined, error: unknown | undefined) => void;
export type PreparedGpx = Readonly<{ filename: string; content: string; exportedPoints: number; originalPoints: number; transitions: ReadonlyArray<Readonly<{ name: string; segmentName: string; latitude: number; longitude: number }>> }>;
export type GpxRenderer = (prepared: PreparedGpx) => void | Promise<void>;

const OUTPUT_LIMIT = 1_500;
const untrusted = { readOnlyHint: false, untrustedContentHint: true };
const readOnly = { readOnlyHint: true, untrustedContentHint: true };
let provenance = { dataset: "No TrailPack loaded", sources: ["No published TrailPack has been loaded."] };
let planner: TrailPlanner | undefined;
let activeRoute: PlannedRoute | undefined;
let routeSession: RouteSession | undefined;
let renderRoute: ((route: PlannedRoute) => void | Promise<void>) | undefined;
let renderPlanTarget: ((targetKm: number) => void | Promise<void>) | undefined;
let renderGpx: GpxRenderer | undefined;
let invocationObserver: ToolInvocationObserver | undefined;

export function setTrailPackProvenance(dataset: string, sources: string[]): void { provenance = { dataset, sources: [...sources] }; }
export function setTrailPlanner(next: TrailPlanner): void { planner = next; activeRoute = undefined; routeSession = undefined; }
/**
 * A new parking origin invalidates the prior circuit everywhere, including
 * read-only WebMCP tools and a pending GPX hand-off. Keeping it explicit
 * prevents a selected car park and an older active route from drifting apart.
 */
export function clearActiveRoute(): void { activeRoute = undefined; routeSession = undefined; }
export function setRouteRenderer(renderer: (route: PlannedRoute) => void | Promise<void>): void { renderRoute = renderer; }
/** Keeps the visible route brief aligned when an agent, rather than the form, plans a route. */
export function setPlanTargetRenderer(renderer: ((targetKm: number) => void | Promise<void>) | undefined): void { renderPlanTarget = renderer; }
/** Receives a prepared GPX before the tool confirms completion to an agent. */
export function setGpxRenderer(renderer: GpxRenderer | undefined): void { renderGpx = renderer; }
/** Receives every UI or browser-agent tool call after it settles, without changing its result. */
export function setToolInvocationObserver(observer: ToolInvocationObserver | undefined): void { invocationObserver = observer; }
export function getActiveRoute(): PlannedRoute | undefined { return activeRoute; }
export { documentedStarts };

export type WaypointEditResult = Readonly<{ route: PlannedRoute; edit: WaypointEdit }>;

/**
 * Applies a manual through-point to the current route. The session only
 * changes after TrailPlanner has completed a valid graph replan, so callers
 * can safely leave the previously rendered route in place when this throws.
 */
export async function commitWaypointEdit(waypoint: Waypoint, preferWaymarked = true): Promise<WaypointEditResult> {
  if (!planner || !routeSession) throw new Error("Plan a route before moving a waypoint.");
  const edit = routeSession.commitWaypoint(planner, waypoint, preferWaymarked);
  activeRoute = routeSession.route;
  await renderRoute?.(activeRoute);
  return { route: activeRoute, edit };
}

const object = (value: unknown): Record<string, unknown> => { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Input must be an object."); return value as Record<string, unknown>; };
const only = (data: Record<string, unknown>, fields: string[]): void => { const unexpected = Object.keys(data).filter((key) => !fields.includes(key)); if (unexpected.length > 0) throw new Error(`Unexpected input field: ${unexpected.join(", ")}.`); };
const halfKilometres = (value: unknown, field: string): number => { if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 30 || !Number.isInteger(value * 2)) throw new Error(`${field} must be a whole or half kilometre from 1 through 30.`); return value; };
const choice = <T extends string>(value: unknown, field: string, values: readonly T[]): T => { if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`${field} must be one of: ${values.join(", ")}.`); return value as T; };
const text = (value: unknown, field: string): string => { if (typeof value !== "string" || value.trim().length === 0 || value.length > 120) throw new Error(`${field} must be a concise string of at most 120 characters.`); return value.trim(); };
const abortable = async <T>(signal: AbortSignal | undefined, result: T): Promise<T> => { if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError"); await Promise.resolve(); if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError"); if (JSON.stringify(result).length > OUTPUT_LIMIT) throw new Error("Tool output exceeded the 1.5K character budget."); return result; };
const current = (): PlannedRoute => { if (!activeRoute) throw new Error("No route has been planned yet. Ask for a loop from Vista Rica parking or Passeig de les Aigües parking first."); return activeRoute; };
const routeOutput = (route: PlannedRoute) => ({ route: route.name, start: route.start.name, arrival_mode: route.start.transportMode, distance_km: route.distanceKm, ascent_m: route.ascentM, duration_hours: route.durationHours, returns_to_start: true, shared_access_percent: route.sharedAccessPercent, official_match_percent: route.waymarkedPercent, source: route.source, attribution: provenance });
const segmentOutput = (segment: PlannedRoute["segments"][number]) => ({ name: segment.name, surface: segment.surface, sac_scale: segment.sac_scale, official_match: segment.waymarked, official_match_ref: segment.official_ref });
const xml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;");
const transitionWaypointsFor = (route: PlannedRoute): PreparedGpx["transitions"] => {
  const count = 5;
  return Array.from({ length: count }, (_, index) => {
    const point = route.coordinates[Math.round(index * (route.coordinates.length - 1) / (count - 1))] ?? route.coordinates[0]!;
    const segment = route.segments[Math.min(route.segments.length - 1, Math.floor(index * route.segments.length / count))] ?? { name: "TrailPack route" };
    return Object.freeze({ name: `Transition ${String(index + 1).padStart(2, "0")} - ${segment.name}`, segmentName: segment.name, latitude: point[0], longitude: point[1] });
  });
};
const gpxFor = (route: PlannedRoute): PreparedGpx => {
  // GPX consumers such as Wikiloc draw straight lines between track points.
  // Preserve every graph vertex so that the exported line follows the actual
  // trail geometry rather than cutting across the terrain between samples.
  const points = route.coordinates;
  const transitions = transitionWaypointsFor(route);
  const attribution = provenance.sources.join("; ");
  const content = `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="Switchback TrailPack" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>${xml(route.name)}</name><desc>${xml(`Full TrailPack graph trace. Elevation values are unavailable in this TrailPack. ${route.source}. ${attribution}`)}</desc></metadata>${transitions.map((point) => `<wpt lat="${point.latitude.toFixed(6)}" lon="${point.longitude.toFixed(6)}"><name>${xml(point.name)}</name><desc>${xml(`TrailPack transition on ${point.segmentName}`)}</desc></wpt>`).join("")}<trk><name>${xml(route.name)}</name><trkseg>${points.map(([latitude, longitude]) => `<trkpt lat="${latitude.toFixed(6)}" lon="${longitude.toFixed(6)}"/>`).join("")}</trkseg></trk></gpx>`;
  return Object.freeze({ filename: "switchback-trailpack-route.gpx", content, exportedPoints: points.length, originalPoints: route.coordinates.length, transitions });
};

const rawToolContracts: ToolContract[] = [
  {
    name: "plan_route", description: "Plan and render a genuine Collserola circuit from a selectable car or public-transport origin. Every listed start is verified to close a loop at its suggested distance; it rejects long out-and-back retracing. The pack excludes urban footways and paved access roads. An ICGC LiDAR-based ascent estimate is added after the route renders, but elevation and grade filters remain unsupported.", annotations: untrusted,
    inputSchema: { type: "object", additionalProperties: false, required: ["start", "target_km", "prefer_waymarked"], properties: { start: { type: "string", enum: selectableCircuitStartIds, description: "Verified circuit origin. Use arrival_mode to choose car or public transport; the enum contains all currently selectable origins." }, arrival_mode: { type: "string", enum: ["car", "public_transport"], description: "Optional arrival context. When supplied, it must agree with the chosen origin." }, target_km: { type: "number", minimum: 1, maximum: 30, multipleOf: 0.5, description: "Desired circuit distance in 0.5 km steps, from 1 through 30. A result is accepted only within ±0.5 km." }, prefer_waymarked: { type: "boolean", description: "Bias toward the Park’s published A–E marked-path network while retaining OSM trail connectors needed to close a loop. It does not confirm present-day conditions." }, max_ascent_m: { type: "number", description: "Unsupported at plan-selection time; ascent is estimated after the route has rendered." }, max_grade: { type: "string", description: "Unsupported: this TrailPack has incomplete grade tags." } } },
    execute: async (input, signal) => {
      const data = object(input); only(data, ["start", "arrival_mode", "target_km", "prefer_waymarked", "max_ascent_m", "max_grade"]);
      if (data.max_ascent_m !== undefined) throw new Error("max_ascent_m is unsupported: the loaded TrailPack has no elevation values.");
      if (data.max_grade !== undefined) throw new Error("max_grade is unsupported: the loaded TrailPack has incomplete grade tags.");
      const start = choice(data.start, "start", selectableCircuitStartIds); const targetKm = halfKilometres(data.target_km, "target_km");
      const startDefinition = documentedStarts[start];
      if (startDefinition.circuitStatus !== "verified") throw new Error(`${startDefinition.name} is saved as a ${startDefinition.transportMode === "car" ? "car" : "public-transport"} access point, but this TrailPack has not verified a circuit there. Choose a verified circuit origin or plan a future point-to-point route.`);
      if (data.arrival_mode !== undefined && data.arrival_mode !== startDefinition.transportMode) throw new Error(`arrival_mode must be ${startDefinition.transportMode} for ${startDefinition.name}.`);
      if (typeof data.prefer_waymarked !== "boolean") throw new Error("prefer_waymarked must be true or false.");
      if (!planner) throw new Error("TrailPack graph is not ready; wait for its data status before planning.");
      const next = planner.plan(start, targetKm, data.prefer_waymarked);
      // Rendering is part of the tool's completion contract: a response never claims a loop before the map receives it.
      await renderPlanTarget?.(targetKm);
      await renderRoute?.(next);
      activeRoute = next;
      routeSession = new RouteSession(next, targetKm);
      return abortable(signal, { ...routeOutput(next), requested: { start, target_km: targetKm, prefer_waymarked: data.prefer_waymarked }, rendered: true, note: "Directed graph loop rendered from the loaded TrailPack. Verify current local conditions before departure." });
    },
  },
  {
    name: "get_route_summary", description: "Read the active data-backed route totals and at most five TrailPack segments.", annotations: readOnly, inputSchema: { type: "object", additionalProperties: false, properties: {} },
    execute: async (input, signal) => { only(object(input), []); const route = current(); return abortable(signal, { ...routeOutput(route), notable_segments: route.segments.map(segmentOutput) }); },
  },
  {
    name: "explain_segment", description: "Read OSM terrain tags and official-match evidence for a segment of the active route.", annotations: readOnly, inputSchema: { type: "object", additionalProperties: false, required: ["segment_name"], properties: { segment_name: { type: "string", maxLength: 120, description: "physical_id from get_route_summary.notable_segments." } } },
    execute: async (input, signal) => { const data = object(input); only(data, ["segment_name"]); const segmentName = text(data.segment_name, "segment_name"); const segment = current().segments.find((candidate) => candidate.name === segmentName); if (!segment) throw new Error("segment_name must name a segment from get_route_summary."); return abortable(signal, { segment: segmentOutput(segment), source: "OSM-derived TrailPack v1 edge tags", caution: "OSM tags are untrusted field information; verify current local conditions.", attribution: provenance }); },
  },
  {
    name: "avoid_segment", description: "Replan the active directed TrailPack loop while blocking one active physical segment. The route changes only after a verified replacement loop is found and rendered; otherwise it fails closed.", annotations: untrusted, inputSchema: { type: "object", additionalProperties: false, required: ["segment_name"], properties: { segment_name: { type: "string", maxLength: 120, description: "physical_id from get_route_summary.notable_segments." } } },
    execute: async (input, signal) => {
      const data = object(input); only(data, ["segment_name"]); const segmentName = text(data.segment_name, "segment_name");
      const before = current();
      if (!before.segments.some((segment) => segment.name === segmentName)) throw new Error("segment_name must name a segment from get_route_summary.");
      if (!planner) throw new Error("TrailPack graph is not ready; wait for its data status before replanning.");
      const next = planner.replanAvoidingSegment(before, segmentName, true);
      // Do not change activeRoute or its session until both graph verification
      // and rendering succeed. A throw above leaves the route/session intact.
      await renderRoute?.(next);
      activeRoute = next;
      routeSession = new RouteSession(next, routeSession?.targetKm ?? before.distanceKm);
      return abortable(signal, {
        ...routeOutput(next), avoided: true, segment_name: segmentName,
        before: { distance_km: before.distanceKm, official_match_percent: before.waymarkedPercent },
        delta_distance_km: Math.round((next.distanceKm - before.distanceKm) * 10) / 10,
        delta_official_match_percent: next.waymarkedPercent - before.waymarkedPercent,
        caution: "Official-match coverage is TrailPack evidence, not a claim that every segment is currently waymarked. Verify local conditions.",
      });
    },
  },
  {
    name: "prepare_gpx", description: "Prepare a full-resolution GPX 1.1 trail trace with five named TrailPack transitions and reveal a user-gesture download control. It never starts a download or shares a file itself.", annotations: untrusted, inputSchema: { type: "object", additionalProperties: false, properties: {} },
    execute: async (input, signal) => {
      only(object(input), []);
      const route = current();
      const gpx = gpxFor(route);
      // Create the user-gesture download control before claiming readiness.
      await renderGpx?.(gpx);
      return abortable(signal, {
        filename: gpx.filename,
        mime_type: "application/gpx+xml",
        distance_km: route.distanceKm,
        transition_waypoints: gpx.transitions.map((point) => ({ name: point.name, segment_name: point.segmentName })),
        download_ready: renderGpx !== undefined,
        elevation_values: "unavailable in this TrailPack",
        original_route_points: gpx.originalPoints,
        exported_points: gpx.exportedPoints,
        trace_detail: "Every TrailPack graph vertex is included so GPX viewers can draw the routed trail line.",
        next_step: "Tell the user that Switchback has revealed the Download GPX control. They must click it themselves to save or import the file; no download was started.",
      });
    },
  },
  {
    name: "describe_last_edit", description: "Read the most recent manual map edit and its measured route effect.", annotations: readOnly, inputSchema: { type: "object", additionalProperties: false, properties: {} },
    execute: async (input, signal) => {
      only(object(input), []);
      const edit = routeSession?.lastEdit;
      if (!edit) return abortable(signal, {
        edit: "No manual waypoint edit has been made in this session.",
        delta_distance_km: 0,
        delta_ascent_m: null,
        next_step: "Use plan_route from a listed car park, then drag the through-point or move it with arrow keys and press Enter.",
        attribution: provenance,
      });
      return abortable(signal, {
        edit: "A manual through-point was accepted and the route was replanned on the loaded directed TrailPack graph.",
        route_revision: edit.revision,
        waypoint: edit.waypoint,
        requested_target_km: edit.requestedTargetKm,
        before: { distance_km: edit.before.distanceKm, official_match_percent: edit.before.officialMatchPercent },
        after: { distance_km: edit.after.distanceKm, official_match_percent: edit.after.officialMatchPercent },
        delta_distance_km: edit.delta.distanceKm,
        target_error_km: edit.targetErrorKm,
        delta_ascent_m: null,
        delta_official_match_percent: edit.delta.officialMatchPercent,
        caution: "Official-match coverage is evidence from the TrailPack, not a claim that every segment is waymarked. Verify current local conditions.",
        attribution: provenance,
      });
    },
  },
];

// WebMCP calls execute the same contract function as buttons in the page. This
// wrapper makes external agent activity inspectable in the visible audit log.
export const toolContracts: ToolContract[] = rawToolContracts.map((tool) => ({
  ...tool,
  execute: async (input, signal) => {
    try {
      const result = await tool.execute(input, signal);
      invocationObserver?.(tool.name, input, result, undefined);
      return result;
    } catch (error) {
      invocationObserver?.(tool.name, input, undefined, error);
      throw error;
    }
  },
}));

export const baseToolContracts = toolContracts;
export const activeRouteToolContracts = toolContracts;
