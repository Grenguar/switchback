import { TrailPlanner, documentedStarts, type PlannedRoute, type StartId } from "./planner";

export interface ToolAnnotations { readOnlyHint: boolean; untrustedContentHint: boolean; }
export interface ToolContract { name: "plan_route" | "get_route_summary" | "explain_segment" | "avoid_segment" | "describe_last_edit"; description: string; inputSchema: Record<string, unknown>; annotations: ToolAnnotations; execute: (input: unknown, signal?: AbortSignal) => Promise<unknown>; }

const OUTPUT_LIMIT = 1_500;
const untrusted = { readOnlyHint: false, untrustedContentHint: true };
const readOnly = { readOnlyHint: true, untrustedContentHint: true };
let provenance = { dataset: "No TrailPack loaded", sources: ["No published TrailPack has been loaded."] };
let planner: TrailPlanner | undefined;
let activeRoute: PlannedRoute | undefined;
let renderRoute: ((route: PlannedRoute) => void | Promise<void>) | undefined;

export function setTrailPackProvenance(dataset: string, sources: string[]): void { provenance = { dataset, sources: [...sources] }; }
export function setTrailPlanner(next: TrailPlanner): void { planner = next; activeRoute = undefined; }
export function setRouteRenderer(renderer: (route: PlannedRoute) => void | Promise<void>): void { renderRoute = renderer; }
export function getActiveRoute(): PlannedRoute | undefined { return activeRoute; }
export { documentedStarts };

const object = (value: unknown): Record<string, unknown> => { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Input must be an object."); return value as Record<string, unknown>; };
const only = (data: Record<string, unknown>, fields: string[]): void => { const unexpected = Object.keys(data).filter((key) => !fields.includes(key)); if (unexpected.length > 0) throw new Error(`Unexpected input field: ${unexpected.join(", ")}.`); };
const positive = (value: unknown, field: string, maximum: number): number => { if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maximum) throw new Error(`${field} must be a positive number no greater than ${maximum}.`); return value; };
const choice = <T extends string>(value: unknown, field: string, values: readonly T[]): T => { if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`${field} must be one of: ${values.join(", ")}.`); return value as T; };
const text = (value: unknown, field: string): string => { if (typeof value !== "string" || value.trim().length === 0 || value.length > 120) throw new Error(`${field} must be a concise string of at most 120 characters.`); return value.trim(); };
const abortable = async <T>(signal: AbortSignal | undefined, result: T): Promise<T> => { if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError"); await Promise.resolve(); if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError"); if (JSON.stringify(result).length > OUTPUT_LIMIT) throw new Error("Tool output exceeded the 1.5K character budget."); return result; };
const current = (): PlannedRoute => { if (!activeRoute) throw new Error("No route has been planned yet. Call plan_route with the available GR-65.5 trail access first."); return activeRoute; };
const routeOutput = (route: PlannedRoute) => ({ route: route.name, start: route.start.name, distance_km: route.distanceKm, ascent_m: null, duration_hours: route.durationHours, waymarked_percent: route.waymarkedPercent, source: route.source, attribution: provenance });

export const toolContracts: ToolContract[] = [
  {
    name: "plan_route", description: "Plan and render a directed TrailPack loop from a documented start. `gr65_access` is the only available v1 start: a verified on-trail GR-65.5 access coordinate, not a town or trailhead. Elevation and grade filters explicitly reject because this artifact has no elevation data.", annotations: untrusted,
    inputSchema: { type: "object", additionalProperties: false, required: ["start", "target_km", "prefer_waymarked"], properties: { start: { type: "string", enum: Object.keys(documentedStarts), description: "Use gr65_access. Ulldemolins, Prades, and Albarca remain documented but are unavailable until their access connectors are vetted." }, target_km: { type: "number", minimum: 1, maximum: 60, description: "Desired directed loop distance in kilometres; 7.2 km is the verified v1 loop target from gr65_access." }, prefer_waymarked: { type: "boolean", description: "Bias toward CNIG/FEDME-matched trail edges." }, max_ascent_m: { type: "number", description: "Unsupported: this TrailPack has no elevation values, so the request is rejected." }, max_grade: { type: "string", description: "Unsupported: this TrailPack has incomplete grade tags, so the request is rejected." } } },
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
      return abortable(signal, { ...routeOutput(next), requested: { start, target_km: targetKm, prefer_waymarked: data.prefer_waymarked }, rendered: true, note: "Directed graph loop rendered from the loaded TrailPack. Verify current local conditions before departure." });
    },
  },
  {
    name: "get_route_summary", description: "Read the active data-backed route totals and at most five TrailPack segments.", annotations: readOnly, inputSchema: { type: "object", additionalProperties: false, properties: {} },
    execute: async (input, signal) => { only(object(input), []); const route = current(); return abortable(signal, { ...routeOutput(route), notable_segments: route.segments }); },
  },
  {
    name: "explain_segment", description: "Read OSM terrain tags and official-match evidence for a segment of the active route.", annotations: readOnly, inputSchema: { type: "object", additionalProperties: false, required: ["segment_name"], properties: { segment_name: { type: "string", maxLength: 120, description: "physical_id from get_route_summary.notable_segments." } } },
    execute: async (input, signal) => { const data = object(input); only(data, ["segment_name"]); const segmentName = text(data.segment_name, "segment_name"); const segment = current().segments.find((candidate) => candidate.name === segmentName); if (!segment) throw new Error("segment_name must name a segment from get_route_summary."); return abortable(signal, { segment, source: "OSM-derived TrailPack v1 edge tags", caution: "OSM tags are untrusted field information; verify current local conditions.", attribution: provenance }); },
  },
  {
    name: "avoid_segment", description: "Explain whether the current TrailPack planner can safely avoid an active segment.", annotations: untrusted, inputSchema: { type: "object", additionalProperties: false, required: ["segment_name"], properties: { segment_name: { type: "string", maxLength: 120, description: "physical_id from get_route_summary.notable_segments." } } },
    execute: async (input, signal) => { const data = object(input); only(data, ["segment_name"]); const segmentName = text(data.segment_name, "segment_name"); if (!current().segments.some((segment) => segment.name === segmentName)) throw new Error("segment_name must name a segment from get_route_summary."); return abortable(signal, { route: current().name, avoided: false, segment_name: segmentName, reason: "This T2 planner does not yet support a blocked-edge replan. It intentionally leaves the rendered route unchanged rather than claiming avoidance.", attribution: provenance }); },
  },
  {
    name: "describe_last_edit", description: "Read the most recent manual map edit and its measured route effect.", annotations: readOnly, inputSchema: { type: "object", additionalProperties: false, properties: {} },
    execute: async (input, signal) => { only(object(input), []); return abortable(signal, { edit: "No manual waypoint edit has been made in this session.", delta_distance_km: 0, delta_ascent_m: null, next_step: "Use plan_route with gr65_access to generate a data-backed loop.", attribution: provenance }); },
  },
];

export const baseToolContracts = toolContracts;
export const activeRouteToolContracts = toolContracts;
