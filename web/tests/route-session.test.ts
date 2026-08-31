import assert from "node:assert/strict";
import test from "node:test";
import { TrailPlanner } from "../src/planner";
import { RouteSession } from "../src/route-session";
import type { TrailPackArtifact, TrailPackManifest } from "../src/trailpack";

const manifest: TrailPackManifest = {
  schema_version: 1, region_id: "session-test", region_name: "Session test", bbox: [0.9, 41.2, 1, 41.4], built_at: "2026-08-27T00:00:00Z", tile_zoom: 12, tiles: ["demo"],
  sources: [{ id: "osm", name: "OpenStreetMap", licence: "ODbL-1.0", attribution: "© OpenStreetMap contributors", extract_date: "2026-08-27" }],
};
const point = (latitude: number, longitude: number) => ({ lat_e7: Math.round(latitude * 1e7), lon_e7: Math.round(longitude * 1e7) });
const edge = (id: string, physical_id: string, from: number, to: number, official: boolean) => ({
  id, physical_id, from, to, length_m: 1000, ascent_m: null, descent_m: null, geometry: [],
  terrain: { surface: null, sac_scale: null, visibility: null, width_hint: null },
  official: official ? { source_id: "cnig", ref_code: "GR", name: "GR test", confidence: 1 } : null,
});
const artifact: TrailPackArtifact = {
  manifest,
  tiles: { demo: { nodes: [point(41.431472, 2.126), point(41.432, 2.129), point(41.4305, 2.132), point(41.429, 2.1265)], edges: [
    edge("a+", "a", 0, 1, true), edge("b+", "b", 1, 2, true), edge("c+", "c", 2, 0, false),
    edge("d+", "d", 0, 3, false), edge("e+", "e", 3, 0, false),
  ] } },
};

test("replanViaWaypoint returns a bounded directed non-retracing loop", () => {
  const planner = new TrailPlanner(artifact);
  const original = planner.plan("vista_rica_parking", 3, true);
  const replanned = planner.replanViaWaypoint(original, { latitude: 41.429, longitude: 2.1265 }, true);

  assert.equal(replanned.distanceKm, 2);
  assert.equal(replanned.waymarkedPercent, 0);
  assert.deepEqual(replanned.edgeIds, ["d+", "e+"]);
  assert.equal(new Set(replanned.edgeIds).size, replanned.edgeIds.length);
  assert.ok(replanned.name.endsWith("via waypoint"));
});

test("RouteSession commits waypoint route and measured deltas atomically", () => {
  const planner = new TrailPlanner(artifact);
  const initial = planner.plan("vista_rica_parking", 3, true);
  const session = new RouteSession(initial, 3);

  const edit = session.commitWaypoint(planner, { latitude: 41.429, longitude: 2.1265 }, true);
  assert.equal(session.route.distanceKm, 2);
  assert.equal(edit.before.distanceKm, 3);
  assert.equal(edit.after.distanceKm, 2);
  assert.equal(edit.delta.distanceKm, -1);
  assert.equal(edit.before.officialMatchPercent, 67);
  assert.equal(edit.after.officialMatchPercent, 0);
  assert.equal(edit.delta.officialMatchPercent, -67);
  assert.equal(edit.revision, 1);
  assert.equal(edit.requestedTargetKm, 3);
  assert.equal(edit.targetErrorKm, -1);
  assert.equal(session.revision, 1);
  assert.equal(session.lastEdit, edit);

  const committedRoute = session.route;
  const committedEdit = session.lastEdit;
  assert.throws(() => session.commitWaypoint(planner, { latitude: 0, longitude: 0 }, true), /refuses to snap/);
  assert.equal(session.route, committedRoute);
  assert.equal(session.lastEdit, committedEdit);
});
