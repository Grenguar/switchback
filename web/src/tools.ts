import { TrailPlanner, documentedStarts, type PlannedRoute, type StartId, type Waypoint } from "./planner";
import { RouteSession, type WaypointEdit } from "./route-session";

export interface ToolAnnotations { readOnlyHint: boolean; untrustedContentHint: boolean; }
export interface ToolContract { name: "plan_route" | "get_route_summary" | "explain_segment" | "avoid_segment" | "describe_last_edit"; description: string; inputSchema: Record<string, unknown>; annotations: ToolAnnotations; execute: (input: unknown, signal?: AbortSignal) => Promise<unknown>; }
export type ToolInvocationObserver = (name: ToolContract["name"], input: unknown, result: unknown | undefined, error: unknown | undefined) => void;

const OUTPUT_LIMIT = 1_500;
const untrusted = { readOnlyHint: false, untrustedContentHint: true };
const readOnly = { readOnlyHint: true, untrustedContentHint: true };
let provenance = { dataset: "No TrailPack loaded", sources: ["No published TrailPack has been loaded."] };
let planner: TrailPlanner | undefined;
let activeRoute: PlannedRoute | undefined;
let routeSession: RouteSession | undefined;
let renderRoute: ((route: PlannedRoute) => void | Promise<void>) | undefined;
let invocationObserver: ToolInvocationObserver | undefined;

export function setTrailPackProvenance(dataset: string, sources: string[]): void { provenance = { dataset, sources: [...sources] }; }
export function setTrailPlanner(next: TrailPlanner): void { planner = next; activeRoute = undefined; routeSession = undefined; }
export function setRouteRenderer(renderer: (route: PlannedRoute) => void | Promise<void>): void { renderRoute = renderer; }
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
const current = (): PlannedRoute => { if (!activeRoute) throw new Error("No route has been planned yet. Call plan_route with the available GR-65.5 trail access first."); return activeRoute; };
const routeOutput = (route: PlannedRoute) => ({ route: route.name, start: route.start.name, distance_km: route.distanceKm, ascent_m: null, duration_hours: route.durationHours, official_match_percent: route.waymarkedPercent, source: route.source, attribution: provenance });
const segmentOutput = (segment: PlannedRoute["segments"][number]) => ({ name: segment.name, surface: segment.surface, sac_scale: segment.sac_scale, official_match: segment.waymarked, official_match_ref: segment.official_ref });

const rawToolContracts: ToolContract[] = [
  {
    name: "plan_route", description: "Plan and render a directed TrailPack loop from a documented start. `gr65_access` is the only available v1 start: a verified on-trail GR-65.5 access coordinate, not a town or trailhead. Elevation and grade filters explicitly reject because this artifact has no elevation data.", annotations: untrusted,
    inputSchema: { type: "object", additionalProperties: false, required: ["start", "target_km", "prefer_waymarked"], properties: { start: { type: "string", enum: Object.keys(documentedStarts), description: "Use gr65_access. Ulldemolins, Prades, and Albarca remain documented but are unavailable until their access connectors are vetted." }, target_km: { type: "number", minimum: 1, maximum: 60, description: "Desired directed loop distance in kilometres; 7.2 km is the verified v1 loop target from gr65_access." }, prefer_waymarked: { type: "boolean", description: "Bias toward CNIG/FEDME official-match evidence. It does not confirm present-day waymarking." }, max_ascent_m: { type: "number", description: "Unsupported: this TrailPack has no elevation values, so the request is rejected." }, max_grade: { type: "string", description: "Unsupported: this TrailPack has incomplete grade tags, so the request is rejected." } } },
    execute: async (input, signal) => {
      const data = object(input); only(data, ["start", "target_km", "prefer_waymarked", "max_ascent_m", "max_grade"]);
      if (data.max_ascent_m !== undefined) throw new Error("max_ascent_m is unsupported: the loaded TrailPack has no elevation values.");
      if (data.max_grade !== undefined) throw new Error("max_grade is unsupported: the loaded TrailPack has incomplete grade tags.");
      const start = choice(data.start, "start", Object.keys(documentedStarts) as StartId[]); const targetKm = positive(data.target_km, "target_km", 60);
      if (typeof data.prefer_waymarked !== "boolean") throw new Error("prefer_waymarked must be true or false.");
      if (!planner) throw new Error("TrailPack graph is not ready; wait for its data status before planning.");
      const next = planner.plan(start, targetKm, data.prefer_waymarked);
      // Rendering is part of the tool's completion contract: a response never claims a loop before the map receives it.
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
    name: "avoid_segment", description: "Explain whether the current TrailPack planner can safely avoid an active segment.", annotations: untrusted, inputSchema: { type: "object", additionalProperties: false, required: ["segment_name"], properties: { segment_name: { type: "string", maxLength: 120, description: "physical_id from get_route_summary.notable_segments." } } },
    execute: async (input, signal) => { const data = object(input); only(data, ["segment_name"]); const segmentName = text(data.segment_name, "segment_name"); if (!current().segments.some((segment) => segment.name === segmentName)) throw new Error("segment_name must name a segment from get_route_summary."); return abortable(signal, { route: current().name, avoided: false, segment_name: segmentName, reason: "This T2 planner does not yet support a blocked-edge replan. It intentionally leaves the rendered route unchanged rather than claiming avoidance.", attribution: provenance }); },
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
        next_step: "Use plan_route with gr65_access, then drag the through-point or move it with arrow keys and press Enter.",
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
