#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

const [inputPath, outputPath, routingKmlPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error("Usage: node scripts/build-collserola-official-network.mjs <xdup.kml> <output.geojson>");
}

const source = await readFile(inputPath, "utf8");
const featureCollection = { type: "FeatureCollection", features: [] };
const fields = (placemark, key) => {
  const match = placemark.match(new RegExp(`<td>${key}</td>\\s*<td>([\\s\\S]*?)</td>`));
  return match?.[1]?.replace(/<[^>]*>/g, "").replaceAll("&amp;", "&").replace(/\s+/g, " ").trim() ?? "";
};

for (const match of source.matchAll(/<Placemark\b[^>]*>([\s\S]*?)<\/Placemark>/g)) {
  const placemark = match[1];
  const code = fields(placemark, "CODIPEPNAT");
  if (!/^[A-E]\d{2}$/.test(code)) continue;
  const name = fields(placemark, "NOMCAMI");
  const coordinateMatch = placemark.match(/<coordinates>\s*([\s\S]*?)\s*<\/coordinates>/);
  if (!coordinateMatch) continue;
  const coordinates = coordinateMatch[1]
    .trim()
    .split(/\s+/)
    .map((coordinate) => coordinate.split(",").slice(0, 2).map(Number))
    .filter(([longitude, latitude]) => Number.isFinite(longitude) && Number.isFinite(latitude));
  if (coordinates.length < 2) continue;
  featureCollection.features.push({
    type: "Feature",
    properties: { code, name, source: "Parc Natural de la Serra de Collserola · Xarxa Dinàmica d'Ús Públic" },
    geometry: { type: "LineString", coordinates },
  });
}

featureCollection.features.sort((left, right) => left.properties.code.localeCompare(right.properties.code));
if (featureCollection.features.length === 0) throw new Error("No A-E PEPNat paths found in KML.");
await writeFile(outputPath, `${JSON.stringify(featureCollection)}\n`);
if (routingKmlPath) {
  const escape = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const placemarks = featureCollection.features.map((feature) => {
    const coordinates = feature.geometry.coordinates.map(([longitude, latitude]) => `${longitude},${latitude},0`).join(" ");
    return `<Placemark><name>${escape(`${feature.properties.code} · ${feature.properties.name}`)}</name><LineString><coordinates>${coordinates}</coordinates></LineString></Placemark>`;
  }).join("");
  await writeFile(routingKmlPath, `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>${placemarks}</Document></kml>\n`);
}
console.log(`official_network_features=${featureCollection.features.length} codes=${new Set(featureCollection.features.map((feature) => feature.properties.code)).size}`);
