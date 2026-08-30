import { TrailPlanner, documentedStarts, type PlannedRoute, type StartId, type Waypoint } from "./planner";
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
const positive = (value: unknown, field: string, maximum: number): number => { if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maximum) throw new Error(`${field} must be a positive number no greater than ${maximum}.`); return value; };
const choice = <T extends string>(value: unknown, field: string, values: readonly T[]): T => { if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`${field} must be one of: ${values.join(", ")}.`); return value as T; };
const text = (value: unknown, field: string): string => { if (typeof value !== "string" || value.trim().length === 0 || value.length > 120) throw new Error(`${field} must be a concise string of at most 120 characters.`); return value.trim(); };
const abortable = async <T>(signal: AbortSignal | undefined, result: T): Promise<T> => { if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError"); await Promise.resolve(); if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError"); if (JSON.stringify(result).length > OUTPUT_LIMIT) throw new Error("Tool output exceeded the 1.5K character budget."); return result; };
const current = (): PlannedRoute => { if (!activeRoute) throw new Error("No route has been planned yet. Call plan_route with the available GR-6 Horta trail access first."); return activeRoute; };
const routeOutput = (route: PlannedRoute) => ({ route: route.name, start: route.start.name, distance_km: route.distanceKm, ascent_m: null, duration_hours: route.durationHours, official_match_percent: route.waymarkedPercent, source: route.source, attribution: provenance });
const segmentOutput = (segment: PlannedRoute["segments"][number]) => ({ name: segment.name, surface: segment.surface, sac_scale: segment.sac_scale, official_match: segment.waymarked, official_match_ref: segment.official_ref });
const xml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;");
const boundedCoordinates = (coordinates: PlannedRoute["coordinates"], maximum = 12): PlannedRoute["coordinates"] => {
  if (coordinates.length <= maximum) return coordinates;
  return Array.from({ length: maximum }, (_, index) => coordinates[Math.round(index * (coordinates.length - 1) / (maximum - 1))]!);
};
const transitionWaypointsFor = (route: PlannedRoute): PreparedGpx["transitions"] => {
  const count = 5;
  return Array.from({ length: count }, (_, index) => {
    const point = route.coordinates[Math.round(index * (route.coordinates.length - 1) / (count - 1))] ?? route.coordinates[0]!;
    const segment = route.segments[Math.min(route.segments.length - 1, Math.floor(index * route.segments.length / count))] ?? { name: "TrailPack route" };
    return Object.freeze({ name: `Transition ${String(index + 1).padStart(2, "0")} - ${segment.name}`, segmentName: segment.name, latitude: point[0], longitude: point[1] });
  });
};
const gpxFor = (route: PlannedRoute): PreparedGpx => {
  const points = boundedCoordinates(route.coordinates);
  const transitions = transitionWaypointsFor(route);
  const attribution = provenance.sources.join("; ");
  const content = `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="Switchback TrailPack" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>${xml(route.name)}</name><desc>${xml(`Simplified TrailPack route. Elevation values are unavailable in this TrailPack. ${route.source}. ${attribution}`)}</desc></metadata>${transitions.map((point) => `<wpt lat="${point.latitude.toFixed(6)}" lon="${point.longitude.toFixed(6)}"><name>${xml(point.name)}</name><desc>${xml(`TrailPack transition on ${point.segmentName}`)}</desc></wpt>`).join("")}<trk><name>${xml(route.name)}</name><trkseg>${points.map(([latitude, longitude]) => `<trkpt lat="${latitude.toFixed(6)}" lon="${longitude.toFixed(6)}"/>`).join("")}</trkseg></trk></gpx>`;
  return Object.freeze({ filename: "switchback-trailpack-route.gpx", content, exportedPoints: points.length, originalPoints: route.coordinates.length, transitions });
};

const rawToolContracts: ToolContract[] = [
  {
    name: "plan_route", description: "Plan and render a directed Collserola TrailPack loop from a documented start. Use `gr6_horta_access`, the verified on-trail GR-6 Horta access coordinate; do not use the legacy Tarragona `gr65_access` start. Elevation and grade filters explicitly reject because this artifact has no elevation data.", annotations: untrusted,
    inputSchema: { type: "object", additionalProperties: false, required: ["start", "target_km", "prefer_waymarked"], properties: { start: { type: "string", enum: Object.keys(documentedStarts), description: "Use gr6_horta_access for the published Collserola TrailPack. Other documented starts may belong to an unavailable or legacy region." }, target_km: { type: "number", minimum: 1, maximum: 60, description: "Desired directed loop distance in kilometres; use 7.2 km for the GR-6 Horta demonstration." }, prefer_waymarked: { type: "boolean", description: "Bias toward CNIG/FEDME official-match evidence. It does not confirm present-day waymarking." }, max_ascent_m: { type: "number", description: "Unsupported: this TrailPack has no elevation values, so the request is rejected." }, max_grade: { type: "string", description: "Unsupported: this TrailPack has incomplete grade tags, so the request is rejected." } } },
    execute: async (input, signal) => {
      const data = object(input); only(data, ["start", "target_km", "prefer_waymarked", "max_ascent_m", "max_grade"]);
      if (data.max_ascent_m !== undefined) throw new Error("max_ascent_m is unsupported: the loaded TrailPack has no elevation values.");
      if (data.max_grade !== undefined) throw new Error("max_grade is unsupported: the loaded TrailPack has incomplete grade tags.");
      const start = choice(data.start, "start", Object.keys(documentedStarts) as StartId[]); const targetKm = positive(data.target_km, "target_km", 60);
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
    name: "prepare_gpx", description: "Prepare a bounded GPX 1.1 route with five named TrailPack transitions and reveal a user-gesture download control. It never starts a download or shares a file itself.", annotations: untrusted, inputSchema: { type: "object", additionalProperties: false, properties: {} },
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
        simplification: "Bounded 12-point track representation; inspect it before using it for navigation.",
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
        next_step: "Use plan_route with gr6_horta_access, then drag the through-point or move it with arrow keys and press Enter.",
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
