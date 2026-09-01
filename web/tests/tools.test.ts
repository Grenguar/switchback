import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { TrailPlanner, circuitDistancesFor, selectableCircuitStartIds, documentedStarts, type PlannedRoute } from "../src/planner";
import { clearActiveRoute, setGpxRenderer, setPlanTargetRenderer, setRouteRenderer, setToolInvocationObserver, setTrailPlanner, toolContracts, type PreparedGpx } from "../src/tools";
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

test("all nine tool contracts are present and have strict object schemas", () => {
  assert.deepEqual(toolContracts.map((tool) => tool.name), ["list_circuit_options", "validate_circuit", "record_session_note", "plan_route", "get_route_summary", "explain_segment", "avoid_segment", "prepare_gpx", "describe_last_edit"]);
  for (const tool of toolContracts) { assert.equal(tool.inputSchema.type, "object"); assert.equal(tool.inputSchema.additionalProperties, false); assert.equal(tool.annotations.untrustedContentHint, true); }
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
  let renderedTarget: number | undefined;
  setPlanTargetRenderer((targetKm) => { renderedTarget = targetKm; });
  setToolInvocationObserver((name) => observed.push(name));
  const result = await tool.execute({ start: "vista_rica_parking", target_km: 7, prefer_waymarked: true }) as { rendered: boolean; distance_km: number; official_match_percent: number };
  assert.equal(result.rendered, true); assert.equal(result.distance_km, 7); assert.equal(result.official_match_percent, 14); assert.equal("waymarked_percent" in result, false); assert.ok(rendered); assert.deepEqual(observed, ["plan_route"]); assert.ok(JSON.stringify(result).length <= 1_500);
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
  const options = await list.execute({}) as { options: Array<{ start: string; verified_targets_km: number[] }> };
  assert.deepEqual(options.options.find((option) => option.start === "passeig_aigues_parking")?.verified_targets_km, [2]);
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
