#!/usr/bin/env node
/**
 * Offline Q3 evidence: reports exactly which routable TrailPack edges carry
 * terrain tags. It does not infer terrain coverage from absent OSM tags.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const artifactPath = resolve(root, process.argv[2] ?? "web/public/trailpack/tarragona-demo.json");
const artifact = JSON.parse(await readFile(artifactPath, "utf8"));

const terrainFields = ["surface", "sac_scale", "visibility", "width_hint"];
const tiles = Object.values(artifact.tiles ?? {});
const edges = tiles.flatMap((tile) => tile.edges ?? []);
if (edges.length === 0) throw new Error("TrailPack has no edges to evaluate.");

const present = Object.fromEntries(terrainFields.map((field) => [field, 0]));
const metres = Object.fromEntries(terrainFields.map((field) => [field, 0]));
let anyTerrainEdges = 0;
let anyTerrainMetres = 0;
let totalMetres = 0;

for (const edge of edges) {
  const length = Number(edge.length_m);
  if (!Number.isFinite(length) || length <= 0) throw new Error(`Invalid edge length for ${edge.id ?? "unknown edge"}.`);
  totalMetres += length;
  const hasAny = terrainFields.some((field) => edge.terrain?.[field] !== null && edge.terrain?.[field] !== undefined);
  if (hasAny) {
    anyTerrainEdges += 1;
    anyTerrainMetres += length;
  }
  for (const field of terrainFields) {
    if (edge.terrain?.[field] !== null && edge.terrain?.[field] !== undefined) {
      present[field] += 1;
      metres[field] += length;
    }
  }
}

const percent = (value) => Number((100 * value / totalMetres).toFixed(2));
const output = {
  evaluation: "Q3 terrain-tag coverage (evidence only)",
  artifact: artifactPath,
  schema_version: artifact.manifest?.schema_version ?? null,
  region_id: artifact.manifest?.region_id ?? null,
  edges: edges.length,
  directed_edge_metres: Number(totalMetres.toFixed(1)),
  any_terrain_tag: {
    edges: anyTerrainEdges,
    edge_percent: Number((100 * anyTerrainEdges / edges.length).toFixed(2)),
    metres: Number(anyTerrainMetres.toFixed(1)),
    length_percent: percent(anyTerrainMetres)
  },
  fields: Object.fromEntries(terrainFields.map((field) => [field, {
    edges: present[field],
    edge_percent: Number((100 * present[field] / edges.length).toFixed(2)),
    metres: Number(metres[field].toFixed(1)),
    length_percent: percent(metres[field])
  }])),
  interpretation: "Absent tags are reported as absent; this output is not a terrain-quality or route-safety claim."
};
console.log(JSON.stringify(output, null, 2));
