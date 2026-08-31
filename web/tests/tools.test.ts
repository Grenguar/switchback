import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { TrailPlanner, type PlannedRoute } from "../src/planner";
import { setGpxRenderer, setPlanTargetRenderer, setRouteRenderer, setToolInvocationObserver, setTrailPlanner, toolContracts, type PreparedGpx } from "../src/tools";
import { loadTrailPack, parseManifest, type TrailPackArtifact, type TrailPackManifest } from "../src/trailpack";

const manifest: TrailPackManifest = {
  schema_version: 1, region_id: "tarragona", region_name: "Tarragona", bbox: [0.8, 41.2, 1, 41.4], built_at: "2026-08-27T00:00:00Z", tile_zoom: 12, tiles: ["demo"],
  sources: [{ id: "osm", name: "OpenStreetMap", licence: "ODbL-1.0", attribution: "© OpenStreetMap contributors", extract_date: "2026-08-27" }],
};
const artifact: TrailPackArtifact = {
  manifest,
  tiles: { demo: { nodes: [{ lat_e7: 414277930, lon_e7: 21176235 }, { lat_e7: 414287000, lon_e7: 21180000 }, { lat_e7: 414272000, lon_e7: 21183000 }], edges: [
    { id: "a+", physical_id: "a", from: 0, to: 1, length_m: 1000, ascent_m: null, descent_m: null, geometry: [], terrain: { surface: null, sac_scale: null, visibility: null, width_hint: null }, official: { source_id: "osm", ref_code: "GR", name: "GR test", confidence: 1 } },
    { id: "b+", physical_id: "b", from: 1, to: 2, length_m: 900, ascent_m: null, descent_m: null, geometry: [], terrain: { surface: null, sac_scale: null, visibility: null, width_hint: null }, official: null },
    { id: "c+", physical_id: "c", from: 2, to: 0, length_m: 900, ascent_m: null, descent_m: null, geometry: [], terrain: { surface: null, sac_scale: null, visibility: null, width_hint: null }, official: null },
    { id: "x+", physical_id: "x", from: 0, to: 1, length_m: 1000, ascent_m: null, descent_m: null, geometry: [], terrain: { surface: null, sac_scale: null, visibility: null, width_hint: null }, official: null },
  ] } },
};

test("all six tool contracts are present and have strict object schemas", () => {
  assert.deepEqual(toolContracts.map((tool) => tool.name), ["plan_route", "get_route_summary", "explain_segment", "avoid_segment", "prepare_gpx", "describe_last_edit"]);
  for (const tool of toolContracts) { assert.equal(tool.inputSchema.type, "object"); assert.equal(tool.inputSchema.additionalProperties, false); assert.equal(tool.annotations.untrustedContentHint, true); }
});

test("avoid_segment replans without the physical segment and GPX preserves the full trace", async () => {
  setTrailPlanner(new TrailPlanner(artifact)); setRouteRenderer(() => undefined);
  const plan = toolContracts.find((candidate) => candidate.name === "plan_route"); assert.ok(plan);
  await plan.execute({ start: "font_groga_parking", target_km: 3, prefer_waymarked: true });
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
  await assert.rejects(() => tool.execute({ start: "font_groga_parking", target_km: 3, prefer_waymarked: true, max_ascent_m: 900 }), /no elevation/);
  await assert.rejects(() => tool.execute({ start: "font_groga_parking", target_km: 31, prefer_waymarked: true }), /no greater than 30/);
  const observed: string[] = [];
  let renderedTarget: number | undefined;
  setPlanTargetRenderer((targetKm) => { renderedTarget = targetKm; });
  setToolInvocationObserver((name) => observed.push(name));
  const result = await tool.execute({ start: "font_groga_parking", target_km: 3, prefer_waymarked: true }) as { rendered: boolean; distance_km: number; official_match_percent: number };
  assert.equal(result.rendered, true); assert.equal(result.distance_km, 2.8); assert.equal(result.official_match_percent, 36); assert.equal("waymarked_percent" in result, false); assert.ok(rendered); assert.deepEqual(observed, ["plan_route"]); assert.ok(JSON.stringify(result).length <= 1_500);
  assert.equal(renderedTarget, 3);
  const summary = toolContracts.find((candidate) => candidate.name === "get_route_summary"); assert.ok(summary);
  const summaryResult = await summary.execute({}) as { notable_segments: Array<Record<string, unknown>> };
  assert.equal("waymarked" in summaryResult.notable_segments[0]!, false);
  assert.equal("official_match" in summaryResult.notable_segments[0]!, true);
  setToolInvocationObserver(undefined);
  setPlanTargetRenderer(undefined);
});

test("planner probe reports snap, closure, distance, and reuse evidence without widening route acceptance", () => {
  const planner = new TrailPlanner(artifact);
  const available = planner.probe({ latitude: 41.427793, longitude: 2.1176235, targetKm: 3, preferWaymarked: true });
  assert.equal(available.snap.status, "accepted");
  assert.equal(available.result.status, "loop_available");
  assert.ok(available.candidates.viable_loops >= 1);
  assert.ok(available.candidates.nearest_viable_loop_km);
  assert.equal(available.rejected.snap, 0);

  const farAway = planner.probe({ latitude: 0, longitude: 0, targetKm: 3, preferWaymarked: true });
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
    const diagnostic = planner.probe({ latitude: 41.427793, longitude: 2.1176235, targetKm: 3, preferWaymarked: true });
    assert.equal(diagnostic.result.status, "loop_available");
  }
});

test("published Collserola TrailPack loads every static tile with Barcelona provenance", async () => {
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
  assert.equal(result.manifest.region_id, "es-ct-collserola-vallvidrera");
  assert.equal(result.manifest.tiles.length, 33);
  assert.equal(result.manifest.sources[0]?.id, "osm-barcelona-bbbike");
  assert.equal(Object.keys(result.artifact.tiles).length, 33);
  const planner = new TrailPlanner(result.artifact);
  const circuit = planner.plan("font_groga_parking", 7, true);
  assert.ok(Math.abs(circuit.distanceKm - 7) <= 7 * 0.15, `expected a circuit close to 7 km, received ${circuit.distanceKm} km`);
});
