import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { TrailPlanner, circuitDistancesFor, circuitOptionsFor, selectableCircuitStartIds, documentedStarts, type PlannedRoute } from "../src/planner";
import { clearActiveRoute, setGpxRenderer, setParkAlertsRenderer, setPlanTargetRenderer, setRouteBriefingRenderer, setRouteRenderer, setToolInvocationObserver, setTrailPlanner, setTrailWeatherRenderer, toolContracts, type PreparedGpx, type PreparedRouteBriefing } from "../src/tools";
// Netlify runs this plain ESM function module; the parser itself is exercised here.
// @ts-expect-error Netlify function modules are not part of the browser TypeScript program.
import { parseActiveAlerts, translateActiveAlerts } from "../netlify/functions/park-alerts.mjs";
import { loadTrailPack, parseManifest, type TrailPackArtifact, type TrailPackManifest } from "../src/trailpack";

const manifest: TrailPackManifest = {
  schema_version: 1, region_id: "tarragona", region_name: "Tarragona", bbox: [0.8, 41.2, 1, 41.4], built_at: "2026-08-27T00:00:00Z", tile_zoom: 12, tiles: ["demo"],
  sources: [{ id: "osm", name: "OpenStreetMap", licence: "ODbL-1.0", attribution: "© OpenStreetMap contributors", extract_date: "2026-08-27" }],
};
const artifact: TrailPackArtifact = {
  manifest,
  tiles: { demo: { nodes: [{ lat_e7: 414277930, lon_e7: 21176235 }, { lat_e7: 414287000, lon_e7: 21180000 }, { lat_e7: 414272000, lon_e7: 21183000 }], edges: [
    { id: "a+", physical_id: "a", from: 0, to: 1, length_m: 1000, ascent_m: null, descent_m: null, geometry: [], terrain: { surface: null, sac_scale: null, visibility: null, width_hint: null }, official: { source_id: "osm", ref_code: "GR", name: "GR test", confidence: 1 } },
    { id: "b+", physical_id: "b", from: 1, to: 2, length_m: 3000, ascent_m: null, descent_m: null, geometry: [], terrain: { surface: null, sac_scale: null, visibility: null, width_hint: null }, official: null },
    { id: "c+", physical_id: "c", from: 2, to: 0, length_m: 3000, ascent_m: null, descent_m: null, geometry: [], terrain: { surface: null, sac_scale: null, visibility: null, width_hint: null }, official: null },
    { id: "x+", physical_id: "x", from: 0, to: 1, length_m: 1000, ascent_m: null, descent_m: null, geometry: [], terrain: { surface: null, sac_scale: null, visibility: null, width_hint: null }, official: null },
  ] } },
};

test("all fourteen tool contracts are present and have strict object schemas", () => {
  assert.deepEqual(toolContracts.map((tool) => tool.name), ["list_circuit_options", "validate_circuit", "record_session_note", "plan_route", "get_route_summary", "explain_difficulty", "explain_segment", "avoid_segment", "prepare_gpx", "get_trail_weather", "get_hiking_conditions", "get_park_alerts", "prepare_route_briefing", "describe_last_edit"]);
  for (const tool of toolContracts) { assert.equal(tool.inputSchema.type, "object"); assert.equal(tool.inputSchema.additionalProperties, false); assert.equal(tool.annotations.untrustedContentHint, true); }
});

test("Park alert adapter parses only the active official-alert section", () => {
  const html = `<div id="avisos actius"><div class="tmb "><h3 class="t-entry-title h6"><a href="https://park.test/closure">Access closure</a></h3><p><span class="t-entry-date">setembre 1, 2026</span></p><div class="t-entry-excerpt "><p>Do not enter the affected sector.</p></div></div><div class="tmb "><h3 class="t-entry-title h6"><a href="https://park.test/wind">Wind warning</a></h3><p><span class="t-entry-date">setembre 2, 2026</span></p><div class="t-entry-excerpt "><p>High winds are expected.</p></div></div>Avisos anteriors<div class="tmb "><h3 class="t-entry-title h6"><a href="https://park.test/old">Old notice</a></h3></div>`;
  assert.deepEqual(parseActiveAlerts(html), [
    { title: "Access closure", published: "setembre 1, 2026", excerpt: "Do not enter the affected sector.", url: "https://park.test/closure" },
    { title: "Wind warning", published: "setembre 2, 2026", excerpt: "High winds are expected.", url: "https://park.test/wind" },
  ]);
});

test("Park alerts retain their Catalan source when AWS translation is unavailable", async () => {
  const source = [{ title: "Alerta d'incendi", published: "setembre 1, 2026", excerpt: "Eviteu la zona afectada.", url: "https://parcnaturalcollserola.cat/alerta" }];
  const translated = await translateActiveAlerts(source, { send: async (command: { input: { Text: string } }) => ({ TranslatedText: command.input.Text === source[0]?.title ? "Fire alert" : "Avoid the affected area." }) });
  assert.deepEqual(translated[0]?.translation, { language: "en", provider: "AWS Translate", title: "Fire alert", excerpt: "Avoid the affected area." });
  const fallback = await translateActiveAlerts(source, undefined);
  assert.equal(fallback[0]?.translation, null); assert.equal(fallback[0]?.title, source[0]?.title);
});

test("get_park_alerts returns sourced notices without claiming route applicability", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ source_url: "https://parcnaturalcollserola.cat/actualitat/avisos/", fetched_at: "2026-09-01T10:00:00Z", alerts: [{ title: "Access closure", published: "setembre 1, 2026", excerpt: "Do not enter the affected sector.", url: "https://parcnaturalcollserola.cat/closure" }], caution: "Open the source before departure." }), { status: 200 });
  try {
    let rendered = false;
    setParkAlertsRenderer(() => { rendered = true; });
    const alerts = toolContracts.find((candidate) => candidate.name === "get_park_alerts"); assert.ok(alerts);
    const result = await alerts.execute({ notice_limit: 1 }) as { alerts_ready: boolean; active_alert_count: number; active_alerts: Array<{ title: string }>; next_step: string };
    assert.equal(result.alerts_ready, true); assert.equal(result.active_alert_count, 1); assert.equal(result.active_alerts[0]?.title, "Access closure"); assert.match(result.next_step, /applies to the route/); assert.equal(rendered, true); assert.ok(JSON.stringify(result).length <= 1_500);
  } finally {
    globalThis.fetch = originalFetch;
    setParkAlertsRenderer(undefined);
  }
});

test("unavailable external sources return availability status without blocking a route recommendation", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "upstream unavailable" }), { status: 502 });
  try {
    setTrailPlanner(new TrailPlanner(artifact)); setRouteRenderer(() => undefined);
    const plan = toolContracts.find((candidate) => candidate.name === "plan_route"); assert.ok(plan);
    await plan.execute({ start: "vista_rica_parking", target_km: 7, prefer_waymarked: true });
    const weather = toolContracts.find((candidate) => candidate.name === "get_trail_weather"); const alerts = toolContracts.find((candidate) => candidate.name === "get_park_alerts"); assert.ok(weather); assert.ok(alerts);
    const weatherResult = await weather.execute({}) as { forecast_available: boolean; recommendation_basis: string };
    const alertsResult = await alerts.execute({}) as { alerts_available: boolean; recommendation_basis: string };
    assert.equal(weatherResult.forecast_available, false); assert.match(weatherResult.recommendation_basis, /TrailPack route evidence only/);
    assert.equal(alertsResult.alerts_available, false); assert.match(alertsResult.recommendation_basis, /TrailPack route evidence only/);
    const briefingTool = toolContracts.find((candidate) => candidate.name === "prepare_route_briefing"); assert.ok(briefingTool);
    const briefing = await briefingTool.execute({}) as { briefing: string };
    assert.match(briefing.briefing, /Forecast: unavailable/); assert.match(briefing.briefing, /Official Park alerts: unavailable/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("get_trail_weather includes evening and daylight context without certifying hiking safety", async () => {
  const originalFetch = globalThis.fetch;
  const dates = ["2026-09-01", "2026-09-02", "2026-09-03"];
  const times = dates.flatMap((date) => Array.from({ length: 12 }, (_, index) => `${date}T${String(index + 8).padStart(2, "0")}:00`));
  const forecastPayload = { timezone: "Europe/Madrid", hourly: {
    time: times, temperature_2m: times.map(() => 20), precipitation_probability: times.map((_, index) => index < 3 ? 5 : 35), precipitation: times.map((_, index) => index < 3 ? 0 : 0.3), weather_code: times.map((_, index) => index < 3 ? 0 : 61), wind_speed_10m: times.map(() => 7), wind_gusts_10m: times.map(() => 15),
  }, daily: { time: dates, sunrise: dates.map((date) => `${date}T07:21`), sunset: dates.map((date) => `${date}T20:16`) } };
  globalThis.fetch = async (input) => String(input).includes("open-meteo")
    ? new Response(JSON.stringify(forecastPayload), { status: 200 })
    : new Response(JSON.stringify({ source_url: "https://parcnaturalcollserola.cat/actualitat/avisos/", fetched_at: "2026-09-01T10:00:00Z", alerts: [{ title: "Wind notice", published: "setembre 1, 2026", excerpt: "Check conditions.", url: "https://parcnaturalcollserola.cat/wind" }], caution: "Open the source before departure." }), { status: 200 });
  try {
    setTrailPlanner(new TrailPlanner(artifact)); setRouteRenderer(() => undefined);
    const plan = toolContracts.find((candidate) => candidate.name === "plan_route"); assert.ok(plan);
    await plan.execute({ start: "vista_rica_parking", target_km: 7, prefer_waymarked: true });
    let renderedWeather = false;
    setTrailWeatherRenderer(() => { renderedWeather = true; });
    const weather = toolContracts.find((candidate) => candidate.name === "get_trail_weather"); assert.ok(weather);
    const forecast = await weather.execute({}) as { forecast_ready: boolean; next_3_days: Array<{ date: string }>; recommended_forecast_window: { time: string } };
    assert.equal(forecast.forecast_ready, true); assert.deepEqual(forecast.next_3_days.map((day) => day.date), ["2026-09-01", "2026-09-02", "2026-09-03"]); assert.equal(forecast.recommended_forecast_window.time, "08:00–11:00"); assert.equal(renderedWeather, true);
    const evening = await weather.execute({ time_of_day: "evening" }) as { requested_time_of_day: string; recommended_forecast_window: { time: string; sunrise: string; sunset: string }; safety_boundary: string };
    assert.equal(evening.requested_time_of_day, "evening"); assert.equal(evening.recommended_forecast_window.time, "17:00–20:00"); assert.equal(evening.recommended_forecast_window.sunrise, "07:21"); assert.equal(evening.recommended_forecast_window.sunset, "20:16"); assert.match(evening.safety_boundary, /Do not call conditions safe/);
    const conditions = toolContracts.find((candidate) => candidate.name === "get_hiking_conditions"); assert.ok(conditions);
    const decision = await conditions.execute({ time_of_day: "evening" }) as { safety_clearance: boolean; forecast: { available: boolean; time: string }; park_alerts: { available: boolean; active_alert_count: number }; decision_boundary: string };
    assert.equal(decision.safety_clearance, false); assert.equal(decision.forecast.available, true); assert.equal(decision.forecast.time, "17:00–20:00"); assert.equal(decision.park_alerts.available, true); assert.equal(decision.park_alerts.active_alert_count, 1); assert.match(decision.decision_boundary, /not a safety verdict/); assert.ok(JSON.stringify(decision).length <= 1_500);
    const briefingTool = toolContracts.find((candidate) => candidate.name === "prepare_route_briefing"); assert.ok(briefingTool);
    const briefing = await briefingTool.execute({}) as { briefing: string; forecast_included: boolean; next_step: string };
    assert.equal(briefing.forecast_included, true); assert.match(briefing.briefing, /least-exposed forecast window/); assert.match(briefing.next_step, /chat response/); assert.ok(JSON.stringify(forecast).length <= 1_500);
  } finally {
    globalThis.fetch = originalFetch;
    setTrailWeatherRenderer(undefined);
  }
});

test("prepare_route_briefing returns a copyable, reviewable human handoff", async () => {
  setTrailPlanner(new TrailPlanner(artifact)); setRouteRenderer(() => undefined);
  const plan = toolContracts.find((candidate) => candidate.name === "plan_route"); assert.ok(plan);
  await plan.execute({ start: "vista_rica_parking", target_km: 7, prefer_waymarked: true });
  let rendered: PreparedRouteBriefing | undefined;
  setRouteBriefingRenderer((briefing) => { rendered = briefing; });
  const briefingTool = toolContracts.find((candidate) => candidate.name === "prepare_route_briefing"); assert.ok(briefingTool);
  const result = await briefingTool.execute({}) as { briefing_ready: boolean; briefing: string; next_step: string };
  assert.ok(rendered); assert.match(rendered.text, /Vista Rica car park/); assert.match(rendered.text, /Check local conditions/);
  assert.equal(result.briefing_ready, true); assert.equal(result.briefing, rendered.text); assert.match(result.next_step, /no message was sent/);
  assert.ok(JSON.stringify(result).length <= 1_500);
  setRouteBriefingRenderer(undefined);
});

test("avoid_segment replans without the physical segment and GPX preserves the full trace", async () => {
  setTrailPlanner(new TrailPlanner(artifact)); setRouteRenderer(() => undefined);
  const plan = toolContracts.find((candidate) => candidate.name === "plan_route"); assert.ok(plan);
  await plan.execute({ start: "vista_rica_parking", target_km: 7, prefer_waymarked: true });
  const avoid = toolContracts.find((candidate) => candidate.name === "avoid_segment"); assert.ok(avoid);
  const result = await avoid.execute({ segment_name: "a" }) as { avoided: boolean; segment_name: string; delta_distance_km: number };
  assert.equal(result.avoided, true); assert.equal(result.segment_name, "a"); assert.equal(result.delta_distance_km, 0);
  const summary = toolContracts.find((candidate) => candidate.name === "get_route_summary"); assert.ok(summary);
  const after = await summary.execute({}) as { notable_segments: Array<{ name: string }> };
  assert.ok(!after.notable_segments.some((segment) => segment.name === "a"));

  await assert.rejects(() => avoid.execute({ segment_name: "b" }), /current route is unchanged/);
  const afterFailedAvoid = await summary.execute({}) as { notable_segments: Array<{ name: string }> };
  assert.deepEqual(afterFailedAvoid.notable_segments, after.notable_segments);

  let renderedGpx: PreparedGpx | undefined;
  setGpxRenderer((prepared) => { renderedGpx = prepared; });
  const gpx = toolContracts.find((candidate) => candidate.name === "prepare_gpx"); assert.ok(gpx);
  const prepared = await gpx.execute({}) as { download_ready: boolean; transition_waypoints: Array<{ name: string }>; exported_points: number; original_route_points: number };
  assert.ok(renderedGpx); assert.match(renderedGpx.content, /<gpx version="1.1"/); assert.match(renderedGpx.content, /<wpt /);
  assert.equal(renderedGpx.transitions.length, 5); assert.equal(prepared.download_ready, true); assert.equal(prepared.transition_waypoints.length, 5);
  assert.equal(prepared.exported_points, prepared.original_route_points);
  assert.ok(JSON.stringify(prepared).length <= 1_500);
  setGpxRenderer(undefined);
});

test("plan_route renders a directed TrailPack loop before returning", async () => {
  setTrailPlanner(new TrailPlanner(artifact)); let rendered: PlannedRoute | undefined; setRouteRenderer((route) => { rendered = route; });
  const tool = toolContracts.find((candidate) => candidate.name === "plan_route"); assert.ok(tool);
  await assert.rejects(() => tool.execute({ start: "vista_rica_parking", target_km: 7, prefer_waymarked: true, max_ascent_m: 900 }), /no elevation/);
  await assert.rejects(() => tool.execute({ start: "vista_rica_parking", target_km: 31, prefer_waymarked: true }), /whole or half kilometre/);
  await assert.rejects(() => tool.execute({ start: "vista_rica_parking", target_km: 3.2, prefer_waymarked: true }), /whole or half kilometre/);
  const observed: string[] = [];
  const phases: string[] = [];
  let renderedTarget: number | undefined;
  setPlanTargetRenderer((targetKm) => { renderedTarget = targetKm; });
  setToolInvocationObserver((name, _input, _result, _error, phase) => { if (name === "plan_route") phases.push(phase); if (phase === "succeeded") observed.push(name); });
  const result = await tool.execute({ start: "vista_rica_parking", target_km: 7, prefer_waymarked: true }) as { rendered: boolean; distance_km: number; official_match_percent: number };
  assert.equal(result.rendered, true); assert.equal(result.distance_km, 7); assert.equal(result.official_match_percent, 14); assert.equal("waymarked_percent" in result, false); assert.ok(rendered); assert.deepEqual(observed, ["plan_route"]); assert.deepEqual(phases, ["started", "succeeded"]); assert.ok(JSON.stringify(result).length <= 1_500);
  assert.equal(renderedTarget, 7);
  const summary = toolContracts.find((candidate) => candidate.name === "get_route_summary"); assert.ok(summary);
  const summaryResult = await summary.execute({}) as { notable_segments: Array<Record<string, unknown>> };
  assert.equal("waymarked" in summaryResult.notable_segments[0]!, false);
  assert.equal("official_match" in summaryResult.notable_segments[0]!, true);
  setToolInvocationObserver(undefined);
  setPlanTargetRenderer(undefined);
});

test("agent test tools disclose verified targets, dry-run without rendering, and record a visible work note", async () => {
  setTrailPlanner(new TrailPlanner(artifact));
  let renders = 0; setRouteRenderer(() => { renders += 1; });
  const list = toolContracts.find((candidate) => candidate.name === "list_circuit_options"); const validate = toolContracts.find((candidate) => candidate.name === "validate_circuit"); const record = toolContracts.find((candidate) => candidate.name === "record_session_note");
  assert.ok(list); assert.ok(validate); assert.ok(record);
  const options = await list.execute({}) as { options: Array<{ start: string; profiles: string[] }> };
  assert.deepEqual(options.options.find((option) => option.start === "passeig_aigues_parking")?.profiles, ["short:2km"]);
  assert.deepEqual(options.options.find((option) => option.start === "vista_rica_parking")?.profiles, ["short:2km", "medium:7km", "long:14km"]);
  assert.deepEqual(circuitOptionsFor(documentedStarts.can_coll_cerdanyola).map((profile) => profile.targetKm), [2, 5, 14]);
  const dryRun = await validate.execute({ start: "vista_rica_parking", target_km: 7, prefer_waymarked: true }) as { validated: boolean; rendered: boolean; returns_to_start: boolean };
  assert.equal(dryRun.validated, true); assert.equal(dryRun.rendered, false); assert.equal(dryRun.returns_to_start, true); assert.equal(renders, 0);
  await assert.rejects(() => validate.execute({ start: "passeig_aigues_parking", target_km: 3, prefer_waymarked: true }), /verified circuit targets/);
  const note = await record.execute({ kind: "test", note: "Validated the customer-facing circuit matrix." }) as { recorded: boolean; local_to_this_tab: boolean };
  assert.equal(note.recorded, true); assert.equal(note.local_to_this_tab, true);
});

test("changing a parking origin clears the active route session", async () => {
  setTrailPlanner(new TrailPlanner(artifact)); setRouteRenderer(() => undefined);
  const plan = toolContracts.find((candidate) => candidate.name === "plan_route"); assert.ok(plan);
  const summary = toolContracts.find((candidate) => candidate.name === "get_route_summary"); assert.ok(summary);
  await plan.execute({ start: "vista_rica_parking", target_km: 7, prefer_waymarked: true });
  clearActiveRoute();
  await assert.rejects(() => summary.execute({}), /No route has been planned/);
});

test("planner probe reports snap, closure, distance, and reuse evidence without widening route acceptance", () => {
  const planner = new TrailPlanner(artifact);
  const available = planner.probe({ latitude: 41.427793, longitude: 2.1176235, targetKm: 7, preferWaymarked: true });
  assert.equal(available.snap.status, "accepted");
  assert.equal(available.result.status, "loop_available");
  assert.ok(available.candidates.viable_loops >= 1);
  assert.ok(available.candidates.nearest_viable_loop_km);
  assert.equal(available.rejected.snap, 0);

  const farAway = planner.probe({ latitude: 0, longitude: 0, targetKm: 7, preferWaymarked: true });
  assert.equal(farAway.snap.status, "rejected");
  assert.equal(farAway.result.status, "snap_rejected");
  assert.equal(farAway.rejected.snap, 1);
  assert.equal(farAway.candidates.examined, 0);
});

test("TrailPack v1 manifest requires provenance and refuses unsupported schemas", () => {
  assert.equal(parseManifest(manifest).schema_version, 1);
  assert.throws(() => parseManifest({ ...manifest, schema_version: 0 }), /unsupported/);
  assert.throws(() => parseManifest({ ...manifest, sources: [] }), /provenance/);
});

test("loadTrailPack validates a same-origin v1 graph before returning it", async () => {
  const fetcher: typeof fetch = async (input) => {
    if (String(input).includes("/tiles/")) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(String(input).endsWith("manifest.json") ? manifest : artifact), { headers: { "content-type": "application/json" } });
  };
  const result = await loadTrailPack(fetcher);
  assert.equal(result.status, "ready");
  if (result.status === "ready") assert.equal(result.artifact.tiles.demo?.edges[0]?.id, "a+");
});

test("loadTrailPack loads every static tile and the planner joins a shared boundary node", async () => {
  const tiledManifest = { ...manifest, tiles: ["west", "east"] };
  const west = { nodes: [artifact.tiles.demo.nodes[0], artifact.tiles.demo.nodes[1]], edges: [artifact.tiles.demo.edges[0]] };
  const east = { nodes: [artifact.tiles.demo.nodes[1], artifact.tiles.demo.nodes[2], artifact.tiles.demo.nodes[0]], edges: [{ ...artifact.tiles.demo.edges[1], from: 0, to: 1 }, { ...artifact.tiles.demo.edges[2], from: 1, to: 2 }] };
  const fetcher: typeof fetch = async (input) => {
    const path = String(input);
    const body = path.endsWith("manifest.json") ? tiledManifest : path.endsWith("west.json") ? west : east;
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
  const result = await loadTrailPack(fetcher);
  assert.equal(result.status, "ready");
  if (result.status === "ready") {
    const planner = new TrailPlanner(result.artifact);
    const diagnostic = planner.probe({ latitude: 41.427793, longitude: 2.1176235, targetKm: 7, preferWaymarked: true });
    assert.equal(diagnostic.result.status, "loop_available");
  }
});

test("published Collserola TrailPack loads every static tile with official A-E park-network provenance", async () => {
  const publishedManifest = await readFile(new URL("../public/trailpack/manifest.json", import.meta.url), "utf8");
  const fetcher: typeof fetch = async (input) => {
    const path = String(input);
    if (path.endsWith("manifest.json")) return new Response(publishedManifest, { headers: { "content-type": "application/json" } });
    const id = path.match(/\/tiles\/([^/]+)\.json$/)?.[1];
    if (!id) return new Response("not found", { status: 404 });
    const tile = await readFile(new URL(`../public/trailpack/tiles/${id}.json`, import.meta.url), "utf8");
    return new Response(tile, { headers: { "content-type": "application/json" } });
  };
  const result = await loadTrailPack(fetcher);
  if (result.status !== "ready") throw new Error(result.status === "unavailable" ? result.message : "TrailPack did not finish loading.");
  assert.equal(result.manifest.region_id, "es-ct-collserola");
  assert.equal(result.manifest.tiles.length, 66);
  assert.equal(result.manifest.sources[0]?.id, "osm-barcelona-bbbike");
  assert.equal(result.manifest.sources[1]?.id, "collserola-public-network");
  assert.equal(Object.keys(result.artifact.tiles).length, 66);
  const planner = new TrailPlanner(result.artifact);
  const vistaRicaCircuit = planner.plan("vista_rica_parking", 7, true);
  assert.ok(Math.abs(vistaRicaCircuit.distanceKm - 7) <= 0.5, `expected a circuit within ±0.5 km of 7 km, received ${vistaRicaCircuit.distanceKm} km`);
  assert.ok(vistaRicaCircuit.waymarkedPercent > 0, "expected the preferred circuit to use official marked paths");
  assert.deepEqual(vistaRicaCircuit.coordinates[0], vistaRicaCircuit.coordinates.at(-1), "a circuit must return to its graph start");
  const physicalIds = vistaRicaCircuit.edgeIds.map((id) => id.replace(/:(forward|reverse)$/, ""));
  const sharedFraction = (physicalIds.length - new Set(physicalIds).size) / physicalIds.length;
  assert.ok(sharedFraction <= 0.30, `expected at most 30% shared access, received ${sharedFraction}`);
  assert.throws(() => planner.plan("passeig_aigues_parking", 3, true), /No non-retracing circuit/, "the planner must reject a long retracing route rather than call it a loop");
});

test("every selectable car or public-transport origin has a verified closed circuit at its suggested distance", async () => {
  const publishedManifest = await readFile(new URL("../public/trailpack/manifest.json", import.meta.url), "utf8");
  const fetcher: typeof fetch = async (input) => {
    const path = String(input);
    if (path.endsWith("manifest.json")) return new Response(publishedManifest, { headers: { "content-type": "application/json" } });
    const id = path.match(/\/tiles\/([^/]+)\.json$/)?.[1];
    if (!id) return new Response("not found", { status: 404 });
    return new Response(await readFile(new URL(`../public/trailpack/tiles/${id}.json`, import.meta.url), "utf8"), { headers: { "content-type": "application/json" } });
  };
  const loaded = await loadTrailPack(fetcher);
  if (loaded.status !== "ready") throw new Error("Published TrailPack did not load.");
  const planner = new TrailPlanner(loaded.artifact);
  for (const id of selectableCircuitStartIds) {
    for (const targetKm of circuitDistancesFor(documentedStarts[id])) {
      let route: PlannedRoute;
      try { route = planner.plan(id, targetKm, true); }
      catch (error) { assert.fail(`${id} at ${targetKm} km was published as a circuit target but failed: ${error instanceof Error ? error.message : String(error)}`); }
      assert.deepEqual(route.coordinates[0], route.coordinates.at(-1), `${id} at ${targetKm} km must return to its graph start`);
      assert.ok(Math.abs(route.distanceKm - targetKm) <= 0.5, `${id} at ${targetKm} km must remain within the requested 0.5 km window`);
    }
  }
});
