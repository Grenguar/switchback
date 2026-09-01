import { TrailPlanner, circuitDistancesFor, circuitOptionsFor, documentedStarts, selectableCircuitStartIds, type PlannedRoute, type Waypoint } from "./planner";
import { RouteSession, type WaypointEdit } from "./route-session";
import { assessRouteDifficulty } from "./difficulty";
import { fetchTrailWeather, type TrailWeather } from "./weather";
import { fetchParkAlerts, type ParkAlerts } from "./park-alerts";

export interface ToolAnnotations { readOnlyHint: boolean; untrustedContentHint: boolean; }
export interface ToolContract { name: "list_circuit_options" | "validate_circuit" | "record_session_note" | "plan_route" | "get_route_summary" | "explain_difficulty" | "explain_segment" | "avoid_segment" | "prepare_gpx" | "get_trail_weather" | "get_park_alerts" | "prepare_route_briefing" | "describe_last_edit"; description: string; inputSchema: Record<string, unknown>; annotations: ToolAnnotations; execute: (input: unknown, signal?: AbortSignal) => Promise<unknown>; }
export type ToolInvocationPhase = "started" | "succeeded" | "failed";
export type ToolInvocationObserver = (name: ToolContract["name"], input: unknown, result: unknown | undefined, error: unknown | undefined, phase: ToolInvocationPhase) => void;
export type PreparedGpx = Readonly<{ filename: string; content: string; exportedPoints: number; originalPoints: number; transitions: ReadonlyArray<Readonly<{ name: string; segmentName: string; latitude: number; longitude: number }>> }>;
export type GpxRenderer = (prepared: PreparedGpx) => void | Promise<void>;
export type PreparedRouteBriefing = Readonly<{ title: string; text: string }>;
export type RouteBriefingRenderer = (briefing: PreparedRouteBriefing) => void | Promise<void>;
export type TrailWeatherRenderer = (forecast: TrailWeather) => void | Promise<void>;
export type SourceUnavailableRenderer = (message: string) => void | Promise<void>;
export type ParkAlertsRenderer = (alerts: ParkAlerts) => void | Promise<void>;

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
let renderRouteBriefing: RouteBriefingRenderer | undefined;
let renderTrailWeather: TrailWeatherRenderer | undefined;
let renderTrailWeatherUnavailable: SourceUnavailableRenderer | undefined;
let renderParkAlerts: ParkAlertsRenderer | undefined;
let renderParkAlertsUnavailable: SourceUnavailableRenderer | undefined;
let cachedTrailWeather: { routeId: string; forecast: TrailWeather } | undefined;
let cachedParkAlerts: ParkAlerts | undefined;
let weatherAvailability: "not_checked" | "available" | "unavailable" = "not_checked";
let parkAlertsAvailability: "not_checked" | "available" | "unavailable" = "not_checked";
let invocationObserver: ToolInvocationObserver | undefined;
const sessionNotes: Array<{ kind: "test" | "product_insight" | "handoff"; note: string }> = [];

export function setTrailPackProvenance(dataset: string, sources: string[]): void { provenance = { dataset, sources: [...sources] }; }
export function setTrailPlanner(next: TrailPlanner): void { planner = next; activeRoute = undefined; routeSession = undefined; cachedTrailWeather = undefined; cachedParkAlerts = undefined; weatherAvailability = "not_checked"; parkAlertsAvailability = "not_checked"; }
/**
 * A new parking origin invalidates the prior circuit everywhere, including
 * read-only WebMCP tools and a pending GPX hand-off. Keeping it explicit
 * prevents a selected car park and an older active route from drifting apart.
 */
export function clearActiveRoute(): void { activeRoute = undefined; routeSession = undefined; cachedTrailWeather = undefined; cachedParkAlerts = undefined; weatherAvailability = "not_checked"; parkAlertsAvailability = "not_checked"; }
export function setRouteRenderer(renderer: (route: PlannedRoute) => void | Promise<void>): void { renderRoute = renderer; }
/** Keeps the visible route brief aligned when an agent, rather than the form, plans a route. */
export function setPlanTargetRenderer(renderer: ((targetKm: number) => void | Promise<void>) | undefined): void { renderPlanTarget = renderer; }
/** Receives a prepared GPX before the tool confirms completion to an agent. */
export function setGpxRenderer(renderer: GpxRenderer | undefined): void { renderGpx = renderer; }
/** Reveals the exact family-shareable route text before an agent says it is ready. */
export function setRouteBriefingRenderer(renderer: RouteBriefingRenderer | undefined): void { renderRouteBriefing = renderer; }
/** Renders the same limited forecast evidence an agent receives. */
export function setTrailWeatherRenderer(renderer: TrailWeatherRenderer | undefined): void { renderTrailWeather = renderer; }
export function setTrailWeatherUnavailableRenderer(renderer: SourceUnavailableRenderer | undefined): void { renderTrailWeatherUnavailable = renderer; }
/** Reveals official Park notices before an agent summarizes a route. */
export function setParkAlertsRenderer(renderer: ParkAlertsRenderer | undefined): void { renderParkAlerts = renderer; }
export function setParkAlertsUnavailableRenderer(renderer: SourceUnavailableRenderer | undefined): void { renderParkAlertsUnavailable = renderer; }
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
const weatherLine = (forecast: TrailWeather | undefined): string => {
  if (!forecast && weatherAvailability === "unavailable") return "Forecast: unavailable when Switchback checked. This recommendation is based on the TrailPack route evidence, not a live forecast. Check a local weather source before departure.";
  if (!forecast) return "Forecast: not checked. This recommendation is based on the TrailPack route evidence, not a live forecast.";
  const window = forecast.bestWindow;
  return `Forecast (checked ${forecast.checkedAt.slice(0, 10)}): least-exposed forecast window is ${window.date}, ${window.start}–${window.end} (${forecast.timezone}) — ${window.summary}, ${window.temperatureC}°C, ${window.precipitationProbability}% precipitation probability, wind ${window.windKph} km/h and gusts ${window.gustKph} km/h. ${forecast.caution}`;
};
const parkAlertsLine = (alerts: ParkAlerts | undefined): string => {
  if (!alerts && parkAlertsAvailability === "unavailable") return "Official Park alerts: unavailable when Switchback checked. This recommendation is based on TrailPack route evidence and does not confirm current Park restrictions. Open the official alert page before departure.";
  if (!alerts) return "Official Park alerts: not checked. This recommendation is based on TrailPack route evidence and does not confirm current Park restrictions.";
  if (alerts.alerts.length === 0) return `Official Park alerts (checked ${alerts.fetchedAt.slice(0, 10)}): no notices were listed in the Park's active-alert section. ${alerts.caution}`;
  return `Official Park alerts (checked ${alerts.fetchedAt.slice(0, 10)}): ${alerts.alerts.slice(0, 2).map((alert) => `${alert.title} (${alert.published})`).join("; ")}. ${alerts.caution}`;
};
const briefingFor = (route: PlannedRoute, forecast: TrailWeather | undefined, alerts: ParkAlerts | undefined): PreparedRouteBriefing => {
  const ascent = route.ascentM === null ? "unavailable" : `${route.ascentM} m estimated ascent`;
  const title = `${route.name} — route briefing`;
  const text = [
    `${route.name}`,
    `Start and finish: ${route.start.name} (${route.start.transportMode === "car" ? "by car" : "by public transport"})`,
    `Plan: ${route.distanceKm} km loop · about ${route.durationHours} h moving time · ${ascent}.`,
    `Trail evidence: ${route.waymarkedPercent}% matched to the Park's published marked-path network.`,
    weatherLine(forecast),
    parkAlertsLine(alerts),
    "This is a planned route, not proof of current signs, closures, weather, surface, or technical difficulty. Check local conditions before setting out.",
    "Switchback can prepare a GPX for navigation; its download remains a human-controlled click.",
  ].join("\n");
  return Object.freeze({ title, text });
};
const dailyForecast = (forecast: TrailWeather): Array<Pick<TrailWeather["bestWindow"], "date" | "start" | "end" | "summary" | "temperatureC" | "precipitationProbability" | "precipitationMm" | "windKph" | "gustKph">> => {
  const byDate = new Map<string, TrailWeather["bestWindow"]>();
  for (const window of forecast.windows) {
    const currentBest = byDate.get(window.date);
    if (!currentBest || window.score < currentBest.score) byDate.set(window.date, window);
  }
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date)).map(({ date, start, end, summary, temperatureC, precipitationProbability, precipitationMm, windKph, gustKph }) => ({ date, start, end, summary, temperatureC, precipitationProbability, precipitationMm, windKph, gustKph }));
};
type WeatherContext = Readonly<{ available: true; forecast: TrailWeather }> | Readonly<{ available: false; reason: string }>;
type ParkAlertsContext = Readonly<{ available: true; alerts: ParkAlerts }> | Readonly<{ available: false; reason: string }>;

const loadWeatherContext = async (route: PlannedRoute): Promise<WeatherContext> => {
  try {
    const forecast = await fetchTrailWeather(route);
    cachedTrailWeather = { routeId: route.id, forecast }; weatherAvailability = "available";
    await renderTrailWeather?.(forecast);
    return { available: true, forecast };
  } catch (error) {
    cachedTrailWeather = undefined; weatherAvailability = "unavailable";
    const reason = error instanceof Error ? error.message : "Forecast is temporarily unavailable.";
    await renderTrailWeatherUnavailable?.(reason);
    return { available: false, reason };
  }
};

const loadParkAlertsContext = async (): Promise<ParkAlertsContext> => {
  try {
    const alerts = await fetchParkAlerts();
    cachedParkAlerts = alerts; parkAlertsAvailability = "available";
    await renderParkAlerts?.(alerts);
    return { available: true, alerts };
  } catch (error) {
    cachedParkAlerts = undefined; parkAlertsAvailability = "unavailable";
    const reason = error instanceof Error ? error.message : "Official Park alerts are temporarily unavailable.";
    await renderParkAlertsUnavailable?.(reason);
    return { available: false, reason };
  }
};

const conversationalRouteReply = (route: PlannedRoute, weather: WeatherContext, alerts: ParkAlertsContext): string => {
  const routeLine = `I found a ${route.distanceKm} km loop from ${route.start.name} with ${route.ascentM ?? "unavailable"} m estimated ascent.`;
  const weatherLine = weather.available
    ? `The least-exposed forecast window is ${weather.forecast.bestWindow.date}, ${weather.forecast.bestWindow.start}–${weather.forecast.bestWindow.end}: ${weather.forecast.bestWindow.summary}, ${weather.forecast.bestWindow.temperatureC}°C, ${weather.forecast.bestWindow.precipitationProbability}% precipitation probability, and gusts ${weather.forecast.bestWindow.gustKph} km/h.`
    : "I could not refresh the forecast, so I would treat the route recommendation as TrailPack-only planning evidence.";
  const alertsLine = alerts.available
    ? alerts.alerts.alerts.length === 0
      ? "The Park's active-alert section listed no notices when I checked."
      : `The Park's active-alert section has ${alerts.alerts.alerts.length} notice${alerts.alerts.alerts.length === 1 ? "" : "s"}; I have shown the latest notices on the shared page.`
    : "I could not refresh the Park's official alert list, so current restrictions are unconfirmed.";
  return `${routeLine} ${weatherLine} ${alertsLine} Want me to prepare a family / friends briefing or a GPX next?`;
};

const rawToolContracts: ToolContract[] = [
  {
    name: "list_circuit_options", description: "List every selectable Collserola circuit origin, its arrival mode, and graph-verified short, medium, or long distance profiles. These are not difficulty ratings.", annotations: readOnly,
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    execute: async (input, signal) => {
      only(object(input), []);
      return abortable(signal, { options: selectableCircuitStartIds.map((id) => { const start = documentedStarts[id]; return { start: id, name: start.name, arrival_mode: start.transportMode, profiles: circuitOptionsFor(start).map((option) => `${option.profile}:${option.targetKm}km`) }; }), source: "Current static Collserola TrailPack circuit matrix", caution: "Profiles describe distance only; elevation and technical difficulty are incomplete." });
    },
  },
  {
    name: "validate_circuit", description: "Dry-run a listed start and verified target against the loaded directed TrailPack. It proves closure and distance without rendering or changing the customer’s active route.", annotations: readOnly,
    inputSchema: { type: "object", additionalProperties: false, required: ["start", "target_km", "prefer_waymarked"], properties: { start: { type: "string", enum: selectableCircuitStartIds }, target_km: { type: "number", description: "One of the verified_targets_km values returned by list_circuit_options." }, prefer_waymarked: { type: "boolean" } } },
    execute: async (input, signal) => {
      const data = object(input); only(data, ["start", "target_km", "prefer_waymarked"]);
      const start = choice(data.start, "start", selectableCircuitStartIds); const targetKm = halfKilometres(data.target_km, "target_km");
      if (typeof data.prefer_waymarked !== "boolean") throw new Error("prefer_waymarked must be true or false.");
      const definition = documentedStarts[start]; const targets = circuitDistancesFor(definition);
      if (!targets.includes(targetKm)) throw new Error(`${definition.name} has verified circuit targets of ${targets.join(", ")} km.`);
      if (!planner) throw new Error("TrailPack graph is not ready; wait for its data status before validating.");
      const route = planner.plan(start, targetKm, data.prefer_waymarked);
      return abortable(signal, { validated: true, rendered: false, start, arrival_mode: definition.transportMode, requested_km: targetKm, route_km: route.distanceKm, returns_to_start: route.coordinates[0]?.[0] === route.coordinates.at(-1)?.[0] && route.coordinates[0]?.[1] === route.coordinates.at(-1)?.[1], shared_access_percent: route.sharedAccessPercent, official_match_percent: route.waymarkedPercent, note: "Dry-run only. Use plan_route to render the circuit for the customer." });
    },
  },
  {
    name: "record_session_note", description: "Record a short agent test result, product insight, or human handoff in the page’s visible session worklog. It is local to the current tab and makes agent work reviewable.", annotations: untrusted,
    inputSchema: { type: "object", additionalProperties: false, required: ["kind", "note"], properties: { kind: { type: "string", enum: ["test", "product_insight", "handoff"] }, note: { type: "string", minLength: 1, maxLength: 240 } } },
    execute: async (input, signal) => {
      const data = object(input); only(data, ["kind", "note"]);
      const kind = choice(data.kind, "kind", ["test", "product_insight", "handoff"] as const); const note = text(data.note, "note");
      if (note.length > 240) throw new Error("note must be at most 240 characters.");
      sessionNotes.push({ kind, note }); if (sessionNotes.length > 12) sessionNotes.shift();
      return abortable(signal, { recorded: true, local_to_this_tab: true, kind, note, notes_in_session: sessionNotes.length, next_step: "The note is now visible in Switchback’s Tool invocation log for the human to review." });
    },
  },
  {
    name: "plan_route", description: "Plan and render a genuine Collserola circuit, then automatically check the next-three-day forecast and official Park alerts for a conversational, source-labelled recommendation. Either live source can be unavailable without invalidating the graph-verified route. Every listed start has a small set of graph-verified target distances; use only its published values, returned in errors when needed. The pack excludes urban footways and paved access roads. An ICGC LiDAR-based ascent estimate is added after rendering.", annotations: untrusted,
    inputSchema: { type: "object", additionalProperties: false, required: ["start", "target_km", "prefer_waymarked"], properties: { start: { type: "string", enum: selectableCircuitStartIds, description: "Verified circuit origin. Use arrival_mode to choose car or public transport; the enum contains all currently selectable origins." }, arrival_mode: { type: "string", enum: ["car", "public_transport"], description: "Optional arrival context. When supplied, it must agree with the chosen origin." }, target_km: { type: "number", minimum: 1, maximum: 30, multipleOf: 0.5, description: "Desired circuit distance in 0.5 km steps, from 1 through 30. A result is accepted only within ±0.5 km." }, prefer_waymarked: { type: "boolean", description: "Bias toward the Park’s published A–E marked-path network while retaining OSM trail connectors needed to close a loop. It does not confirm present-day conditions." }, max_ascent_m: { type: "number", description: "Unsupported at plan-selection time; ascent is estimated after the route has rendered." }, max_grade: { type: "string", description: "Unsupported: this TrailPack has incomplete grade tags." } } },
    execute: async (input, signal) => {
      const data = object(input); only(data, ["start", "arrival_mode", "target_km", "prefer_waymarked", "max_ascent_m", "max_grade"]);
      if (data.max_ascent_m !== undefined) throw new Error("max_ascent_m is unsupported: the loaded TrailPack has no elevation values.");
      if (data.max_grade !== undefined) throw new Error("max_grade is unsupported: the loaded TrailPack has incomplete grade tags.");
      const start = choice(data.start, "start", selectableCircuitStartIds); const targetKm = halfKilometres(data.target_km, "target_km");
      const startDefinition = documentedStarts[start];
      if (startDefinition.circuitStatus !== "verified") throw new Error(`${startDefinition.name} is saved as a ${startDefinition.transportMode === "car" ? "car" : "public-transport"} access point, but this TrailPack has not verified a circuit there. Choose a verified circuit origin or plan a future point-to-point route.`);
      if (data.arrival_mode !== undefined && data.arrival_mode !== startDefinition.transportMode) throw new Error(`arrival_mode must be ${startDefinition.transportMode} for ${startDefinition.name}.`);
      const supportedDistances = circuitDistancesFor(startDefinition);
      if (!supportedDistances.includes(targetKm)) throw new Error(`${startDefinition.name} has verified circuit targets of ${supportedDistances.join(", ")} km. ${targetKm} km is not offered because it does not close a non-retracing TrailPack loop.`);
      if (typeof data.prefer_waymarked !== "boolean") throw new Error("prefer_waymarked must be true or false.");
      if (!planner) throw new Error("TrailPack graph is not ready; wait for its data status before planning.");
      const next = planner.plan(start, targetKm, data.prefer_waymarked);
      // Rendering is part of the tool's completion contract: a response never claims a loop before the map receives it.
      await renderPlanTarget?.(targetKm);
      await renderRoute?.(next);
      activeRoute = next;
      routeSession = new RouteSession(next, targetKm);
      // WebMCP runs in the browser: enrich its first route answer with the two
      // live planning sources so a natural-language request does not depend on
      // the model remembering a separate tool checklist. Node contract tests
      // intentionally exercise the graph-only core without browser I/O.
      const liveContext = typeof window === "undefined" ? undefined : await Promise.all([loadWeatherContext(next), loadParkAlertsContext()]);
      const [weather, alerts] = liveContext ?? [];
      return abortable(signal, {
        ...routeOutput(next), requested: { start, target_km: targetKm, prefer_waymarked: data.prefer_waymarked }, rendered: true,
        live_context_checked: liveContext !== undefined,
        forecast_available: weather?.available ?? false,
        park_alerts_available: alerts?.available ?? false,
        chat_reply: weather && alerts ? conversationalRouteReply(next, weather, alerts) : "I found and rendered the graph-verified loop. In a WebMCP browser, I also check forecast and Park alerts before suggesting a day.",
        note: "Directed graph loop rendered from the loaded TrailPack. Live forecast and official Park alerts are planning context, not a safety clearance.",
      });
    },
  },
  {
    name: "get_route_summary", description: "Read the active data-backed route totals and at most five TrailPack segments.", annotations: readOnly, inputSchema: { type: "object", additionalProperties: false, properties: {} },
    execute: async (input, signal) => { only(object(input), []); const route = current(); return abortable(signal, { ...routeOutput(route), notable_segments: route.segments.map(segmentOutput) }); },
  },
  {
    name: "explain_difficulty", description: "Classify the active route against Switchback's easy, moderate, and difficult walking rubric, with its measured ascent, evidence, and missing terrain data.", annotations: readOnly, inputSchema: { type: "object", additionalProperties: false, properties: {} },
    execute: async (input, signal) => { only(object(input), []); const route = current(); return abortable(signal, { difficulty: assessRouteDifficulty(route), route_km: route.distanceKm, ascent_m: route.ascentM, source: "ICGC LiDAR sampled ascent plus OSM TrailPack terrain tags", caution: "This is a conservative planning aid, not a field safety assessment." }); },
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
    name: "get_trail_weather", description: "Compare the next three local forecast days for the active route and reveal the least-exposed daytime window. This is planning context, not a trail-safety or weather-alert assessment.", annotations: untrusted, inputSchema: { type: "object", additionalProperties: false, properties: {} },
    execute: async (input, signal) => {
      only(object(input), []);
      const route = current();
      const context = await loadWeatherContext(route);
      if (context.available) {
        const forecast = context.forecast;
        const best = forecast.bestWindow;
        return abortable(signal, {
          forecast_available: true, forecast_ready: renderTrailWeather !== undefined, checked_at: forecast.checkedAt, timezone: forecast.timezone, source: forecast.source,
          best_forecast_window: { date: best.date, time: `${best.start}–${best.end}`, summary: best.summary, temperature_c: best.temperatureC, precipitation_probability_percent: best.precipitationProbability, precipitation_mm: best.precipitationMm, wind_kph: best.windKph, gust_kph: best.gustKph },
          next_3_days: dailyForecast(forecast), caution: forecast.caution,
          next_step: "Use the forecast as limited planning context, then post the route briefing in chat. Do not present this as a safety clearance.",
        });
      }
      return abortable(signal, { forecast_available: false, reason: context.reason, recommendation_basis: "TrailPack route evidence only; no live forecast was available.", next_step: "Continue with the route recommendation only if you state that forecast information is unavailable and ask the user to check a local weather source." });
    },
  },
  {
    name: "get_park_alerts", description: "Read the Park's official active-alert list through Switchback's same-origin adapter. It returns notices with their publication dates and source links; it does not decide whether a notice applies to this exact route or remains in force.", annotations: readOnly, inputSchema: { type: "object", additionalProperties: false, properties: {} },
    execute: async (input, signal) => {
      only(object(input), []);
      const context = await loadParkAlertsContext();
      if (context.available) {
        const alerts = context.alerts;
        return abortable(signal, {
          alerts_available: true, alerts_ready: renderParkAlerts !== undefined, fetched_at: alerts.fetchedAt, source_url: alerts.sourceUrl,
          active_alert_count: alerts.alerts.length,
          latest_active_alerts: alerts.alerts.slice(0, 2).map((alert) => ({ title: alert.title, published: alert.published, excerpt: alert.excerpt.slice(0, 160), url: alert.url })),
          caution: alerts.caution,
          next_step: "Open the source for any relevant notice and state its uncertainty. Do not treat this list as proof that a notice applies to the route or has expired.",
        });
      }
      return abortable(signal, { alerts_available: false, source_url: "https://parcnaturalcollserola.cat/actualitat/avisos/", reason: context.reason, recommendation_basis: "TrailPack route evidence only; current Park restrictions could not be checked.", next_step: "Continue only if you clearly say official Park alerts are unavailable and direct the user to open the official alert page before departure." });
    },
  },
  {
    name: "prepare_route_briefing", description: "Prepare a concise, copyable route briefing for a family or friends chat and reveal the same text in the page for the person to review. It never sends a message or accesses a messaging account.", annotations: untrusted, inputSchema: { type: "object", additionalProperties: false, properties: {} },
    execute: async (input, signal) => {
      only(object(input), []);
      const route = current();
      const forecast = cachedTrailWeather?.routeId === route.id ? cachedTrailWeather.forecast : undefined;
      const briefing = briefingFor(route, forecast, cachedParkAlerts);
      await renderRouteBriefing?.(briefing);
      return abortable(signal, {
        briefing_ready: renderRouteBriefing !== undefined,
        title: briefing.title,
        briefing: briefing.text,
        forecast_included: forecast !== undefined,
        park_alerts_included: cachedParkAlerts !== undefined,
        next_step: "Post this briefing, verbatim or concisely, in your chat response. Switchback has revealed a Copy briefing control for the user to review and copy; no message was sent.",
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
    invocationObserver?.(tool.name, input, undefined, undefined, "started");
    try {
      const result = await tool.execute(input, signal);
      invocationObserver?.(tool.name, input, result, undefined, "succeeded");
      return result;
    } catch (error) {
      invocationObserver?.(tool.name, input, undefined, error, "failed");
      throw error;
    }
  },
}));

export const baseToolContracts = toolContracts;
export const activeRouteToolContracts = toolContracts;
