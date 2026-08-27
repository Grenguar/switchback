export type Difficulty = "easy" | "moderate" | "hard";

export interface RoutePlan {
  id: string; name: string; distanceKm: number; ascentM: number; durationHours: number;
  difficulty: Difficulty; source: string; attribution: string; coordinates: Array<[number, number]>; highlights: string[];
}
export interface ToolAnnotations { readOnlyHint: boolean; untrustedContentHint: boolean; }
export interface ToolContract {
  name: "plan_route" | "get_route_summary" | "explain_segment" | "avoid_segment" | "describe_last_edit";
  description: string; inputSchema: Record<string, unknown>; annotations: ToolAnnotations;
  execute: (input: unknown, signal?: AbortSignal) => Promise<unknown>;
}

const OUTPUT_LIMIT = 1_500;
const MANIFEST = {
  dataset: "Switchback demo TrailPack · Montsant–Siurana",
  sources: ["© OpenStreetMap contributors (ODbL-1.0)", "© CNIG/IGN, FEDME (CC-BY-4.0)"],
};
const route: RoutePlan = {
  id: "montsant-spine-01", name: "Cornudella · Montsant spine loop", distanceKm: 13.8, ascentM: 690, durationHours: 5.2,
  difficulty: "hard", source: MANIFEST.dataset, attribution: MANIFEST.sources.join(", "),
  coordinates: [[0.906, 41.266], [0.894, 41.272], [0.884, 41.281], [0.874, 41.277], [0.883, 41.267], [0.906, 41.266]],
  highlights: ["Roca Corbatera ridge", "Siurana reservoir view", "Check current water availability locally"],
};
const segments = [
  { name: "Roca Corbatera ridge", sac_scale: "T3", waymarked: true, note: "Exposed limestone ridge; use a map in low cloud." },
  { name: "Siurana connector", sac_scale: "unknown", waymarked: false, note: "Terrain tags are incomplete in the loaded TrailPack." },
  { name: "Cornudella return", sac_scale: "T1", waymarked: true, note: "Signed village approach." },
];

const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Input must be an object.");
  return value as Record<string, unknown>;
};
const only = (data: Record<string, unknown>, fields: string[]): void => {
  const unexpected = Object.keys(data).filter((key) => !fields.includes(key));
  if (unexpected.length > 0) throw new Error(`Unexpected input field: ${unexpected.join(", ")}.`);
};
const text = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 120) throw new Error(`${field} must be a concise string of at most 120 characters.`);
  return value.trim();
};
const positive = (value: unknown, field: string, maximum: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maximum) throw new Error(`${field} must be a positive number no greater than ${maximum}.`);
  return value;
};
const boolean = (value: unknown, field: string): boolean => {
  if (typeof value !== "boolean") throw new Error(`${field} must be true or false.`);
  return value;
};
const abortable = async <T>(signal: AbortSignal | undefined, result: T): Promise<T> => {
  if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
  await Promise.resolve();
  if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
  if (JSON.stringify(result).length > OUTPUT_LIMIT) throw new Error("Tool output exceeded the 1.5K character budget.");
  return result;
};
const untrusted = { readOnlyHint: false, untrustedContentHint: true };
const readOnly = { readOnlyHint: true, untrustedContentHint: true };

export const toolContracts: ToolContract[] = [
  {
    name: "plan_route", description: "Plan a hiking loop from raw distance, ascent, terrain and waymarking constraints. Renders the proposed route before returning a bounded summary.", annotations: untrusted,
    inputSchema: { type: "object", additionalProperties: false, required: ["target_km", "prefer_waymarked"], properties: { target_km: { type: "number", minimum: 1, maximum: 60, description: "Desired loop distance in kilometres." }, max_ascent_m: { type: "number", minimum: 50, maximum: 4000, description: "Optional maximum ascent in metres." }, max_grade: { type: "string", enum: ["T1", "T2", "T3", "T4"], description: "Maximum accepted Swiss Alpine grade." }, prefer_waymarked: { type: "boolean", description: "Whether to favour waymarked trail as the route spine." } } },
    execute: async (input, signal) => { const data = object(input); only(data, ["target_km", "max_ascent_m", "max_grade", "prefer_waymarked"]); const target_km = positive(data.target_km, "target_km", 60); const prefer_waymarked = boolean(data.prefer_waymarked, "prefer_waymarked"); const max_ascent_m = data.max_ascent_m === undefined ? null : positive(data.max_ascent_m, "max_ascent_m", 4000); if (data.max_grade !== undefined && !["T1", "T2", "T3", "T4"].includes(text(data.max_grade, "max_grade"))) throw new Error("max_grade must be one of T1, T2, T3 or T4."); return abortable(signal, { route: route.name, distance_km: route.distanceKm, ascent_m: route.ascentM, waymarked_percent: 71, requested: { target_km, max_ascent_m, prefer_waymarked }, note: "Route rendered; inspect individual segments before departure.", attribution: MANIFEST }); },
  },
  {
    name: "get_route_summary", description: "Read the active route totals, waymarked percentage and at most five notable segments.", annotations: readOnly, inputSchema: { type: "object", additionalProperties: false, properties: {} },
    execute: async (input, signal) => { const data = object(input); only(data, []); return abortable(signal, { route: route.name, distance_km: route.distanceKm, ascent_m: route.ascentM, duration_hours: route.durationHours, waymarked_percent: 71, notable_segments: segments.map(({ name, sac_scale, waymarked }) => ({ name, sac_scale, waymarked })), attribution: MANIFEST }); },
  },
  {
    name: "explain_segment", description: "Read terrain, waymarking and source evidence for one named segment on the active route.", annotations: readOnly, inputSchema: { type: "object", additionalProperties: false, required: ["segment_name"], properties: { segment_name: { type: "string", maxLength: 120, description: "Natural-language segment name from the route summary." } } },
    execute: async (input, signal) => { const data = object(input); only(data, ["segment_name"]); const segment_name = text(data.segment_name, "segment_name"); const segment = segments.find((candidate) => candidate.name === segment_name); if (!segment) throw new Error("segment_name must name a segment from get_route_summary."); return abortable(signal, { segment, source: "OSM-derived TrailPack tags", caution: "OSM text is untrusted; verify current local conditions.", attribution: MANIFEST }); },
  },
  {
    name: "avoid_segment", description: "Re-plan the active route around one named segment and return the bounded change from the previous route.", annotations: untrusted, inputSchema: { type: "object", additionalProperties: false, required: ["segment_name"], properties: { segment_name: { type: "string", maxLength: 120, description: "Natural-language segment name to avoid." } } },
    execute: async (input, signal) => { const data = object(input); only(data, ["segment_name"]); const segment_name = text(data.segment_name, "segment_name"); if (!segments.some((segment) => segment.name === segment_name)) throw new Error("segment_name must name a segment from get_route_summary."); return abortable(signal, { route: route.name, avoided: segment_name, delta_distance_km: 1.1, delta_ascent_m: -80, waymarked_percent: 76, note: "Route rerendered with the selected segment avoided.", attribution: MANIFEST }); },
  },
  {
    name: "describe_last_edit", description: "Read the most recent manual map edit and its measured change to the active route.", annotations: readOnly, inputSchema: { type: "object", additionalProperties: false, properties: {} },
    execute: async (input, signal) => { const data = object(input); only(data, []); return abortable(signal, { edit: "No manual waypoint edit has been made in this demo session.", delta_distance_km: 0, delta_ascent_m: 0, next_step: "Drag a waypoint in the full map view to inspect an edit.", attribution: MANIFEST }); },
  },
];

export const baseToolContracts = toolContracts.filter((tool) => tool.name !== "explain_segment" && tool.name !== "avoid_segment");
export const activeRouteToolContracts = toolContracts;
export const demoRoute = route;
