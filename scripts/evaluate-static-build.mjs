#!/usr/bin/env node
/** Offline Q6 evidence: verifies the Vite output is self-contained. */
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const dist = resolve(root, process.argv[2] ?? "web/dist");
const required = ["index.html", "trailpack/manifest.json"];
for (const file of required) await access(resolve(dist, file), constants.R_OK);

const [html, manifestText] = await Promise.all([
  readFile(resolve(dist, "index.html"), "utf8"),
  readFile(resolve(dist, "trailpack/manifest.json"), "utf8"),
]);
const manifest = JSON.parse(manifestText);
if (manifest.schema_version !== 1) throw new Error("Published manifest must be TrailPack schema v1.");
if (!Array.isArray(manifest.sources) || manifest.sources.length === 0) throw new Error("Published manifest lacks provenance sources.");
if (!Array.isArray(manifest.tiles) || manifest.tiles.length === 0) throw new Error("Published manifest has no tiles.");
const tileInfo = await Promise.all(manifest.tiles.map((id) => stat(resolve(dist, "trailpack/tiles", `${id}.json`))));
if (!/assets\/index-[^"']+\.js/.test(html)) throw new Error("Vite entry bundle is missing from index.html.");

console.log(JSON.stringify({
  evaluation: "Q6 static sustain (offline build evidence)",
  dist,
  entry_html: "present",
  vite_bundle_reference: "present",
  trailpack_manifest: { schema_version: manifest.schema_version, sources: manifest.sources.length },
  trailpack_tiles: { count: tileInfo.length, bytes: tileInfo.reduce((sum, tile) => sum + tile.size, 0) },
  runtime_services_required: 0,
  interpretation: "This proves a local static build contains its route data and entry bundle. It does not prove a particular hosting provider deployment."
}, null, 2));
