const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

export type TrailPackSource = { id: string; name: string; licence: string; attribution: string; extract_date: string };
export type TrailPackManifest = { schema_version: 1; region_id: string; region_name: string; bbox: [number, number, number, number]; built_at: string; tile_zoom: number; tiles: string[]; sources: TrailPackSource[] };
export type TrailPackNode = { lat_e7: number; lon_e7: number };
export type TrailPackEdge = { id: string; physical_id: string; from: number; to: number; length_m: number; ascent_m: number | null; descent_m: number | null; geometry: Array<[number, number]>; terrain: { surface: string | null; sac_scale: string | null; visibility: string | null; width_hint: string | null }; official: { source_id: string; ref_code: string; name: string; confidence: number } | null };
export type TrailPackArtifact = { manifest: TrailPackManifest; tiles: Record<string, { nodes: TrailPackNode[]; edges: TrailPackEdge[] }> };
export type TrailPackLoadState = { status: "loading" } | { status: "ready"; manifest: TrailPackManifest; artifact: TrailPackArtifact } | { status: "unavailable"; message: string };

const requiredString = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`TrailPack ${name} is missing.`);
  return value.trim();
};
const object = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`TrailPack ${label} must be a JSON object.`);
  return value as Record<string, unknown>;
};
const finite = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`TrailPack ${label} is invalid.`);
  return value;
};
const integer = (value: unknown, label: string): number => {
  const number = finite(value, label);
  if (!Number.isInteger(number)) throw new Error(`TrailPack ${label} must be an integer.`);
  return number;
};

export function parseManifest(value: unknown): TrailPackManifest {
  const data = object(value, "manifest");
  if (data.schema_version !== 1) throw new Error("TrailPack schema version is unsupported.");
  if (!Array.isArray(data.bbox) || data.bbox.length !== 4) throw new Error("TrailPack bbox is invalid.");
  const bbox = data.bbox.map((coordinate) => finite(coordinate, "bbox")) as [number, number, number, number];
  if (!(bbox[0] < bbox[2] && bbox[1] < bbox[3])) throw new Error("TrailPack bbox is invalid.");
  if (!Array.isArray(data.tiles) || data.tiles.length === 0 || !data.tiles.every((tile) => typeof tile === "string" && tile.trim().length > 0)) throw new Error("TrailPack tile index is invalid.");
  const tileZoom = integer(data.tile_zoom, "tile zoom");
  if (tileZoom < 0 || tileZoom > 22) throw new Error("TrailPack tile zoom is invalid.");
  if (!Array.isArray(data.sources) || data.sources.length === 0) throw new Error("TrailPack provenance is missing.");
  const sources = data.sources.map((sourceValue) => {
    const source = object(sourceValue, "source");
    return { id: requiredString(source.id, "source id"), name: requiredString(source.name, "source name"), licence: requiredString(source.licence, "source licence"), attribution: requiredString(source.attribution, "source attribution"), extract_date: requiredString(source.extract_date, "source extract date") };
  });
  return { schema_version: 1, region_id: requiredString(data.region_id, "region id"), region_name: requiredString(data.region_name, "region name"), bbox, built_at: requiredString(data.built_at, "build timestamp"), tile_zoom: tileZoom, tiles: data.tiles as string[], sources };
}

function parseArtifact(value: unknown, expectedManifest: TrailPackManifest): TrailPackArtifact {
  const data = object(value, "artifact");
  const manifest = parseManifest(data.manifest);
  if (manifest.region_id !== expectedManifest.region_id || manifest.built_at !== expectedManifest.built_at) throw new Error("TrailPack graph artifact does not match its manifest.");
  const tiles = object(data.tiles, "tiles");
  const parsedTiles: TrailPackArtifact["tiles"] = {};
  for (const id of manifest.tiles) {
    const tile = object(tiles[id], `tile ${id}`);
    if (!Array.isArray(tile.nodes) || !Array.isArray(tile.edges)) throw new Error(`TrailPack tile ${id} is invalid.`);
    const nodes = tile.nodes.map((nodeValue, index) => {
      const node = object(nodeValue, `node ${index}`);
      const lat_e7 = integer(node.lat_e7, `node ${index} latitude`);
      const lon_e7 = integer(node.lon_e7, `node ${index} longitude`);
      if (Math.abs(lat_e7) > 900_000_000 || Math.abs(lon_e7) > 1_800_000_000) throw new Error(`TrailPack node ${index} is outside WGS84 bounds.`);
      return { lat_e7, lon_e7 };
    });
    const edges = tile.edges.map((edgeValue, index) => {
      const edge = object(edgeValue, `edge ${index}`);
      const from = integer(edge.from, `edge ${index} origin`);
      const to = integer(edge.to, `edge ${index} destination`);
      if (from < 0 || from >= nodes.length || to < 0 || to >= nodes.length || from === to) throw new Error(`TrailPack edge ${index} references an invalid node.`);
      const nullableInteger = (candidate: unknown, label: string): number | null => candidate === null ? null : integer(candidate, label);
      const terrainRaw = object(edge.terrain, `edge ${index} terrain`);
      const terrainValue = (candidate: unknown, label: string): string | null => candidate === null ? null : requiredString(candidate, label);
      const official = edge.official === null ? null : (() => { const value = object(edge.official, `edge ${index} official reference`); return { source_id: requiredString(value.source_id, "official source id"), ref_code: requiredString(value.ref_code, "official reference"), name: requiredString(value.name, "official name"), confidence: finite(value.confidence, "official confidence") }; })();
      if (!Array.isArray(edge.geometry) || !edge.geometry.every((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isInteger))) throw new Error(`TrailPack edge ${index} geometry is invalid.`);
      return { id: requiredString(edge.id, `edge ${index} id`), physical_id: requiredString(edge.physical_id, `edge ${index} physical id`), from, to, length_m: integer(edge.length_m, `edge ${index} length`), ascent_m: nullableInteger(edge.ascent_m, `edge ${index} ascent`), descent_m: nullableInteger(edge.descent_m, `edge ${index} descent`), geometry: edge.geometry as Array<[number, number]>, terrain: { surface: terrainValue(terrainRaw.surface, "surface"), sac_scale: terrainValue(terrainRaw.sac_scale, "sac scale"), visibility: terrainValue(terrainRaw.visibility, "visibility"), width_hint: terrainValue(terrainRaw.width_hint, "width hint") }, official };
    });
    parsedTiles[id] = { nodes, edges };
  }
  return { manifest, tiles: parsedTiles };
}

async function readJson(response: Response, byteLimit: number): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > byteLimit) throw new Error("TrailPack artifact exceeds the browser safety limit.");
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > byteLimit) throw new Error("TrailPack artifact exceeds the browser safety limit.");
  return JSON.parse(new TextDecoder().decode(buffer)) as unknown;
}

/** Loads a static same-origin, directed TrailPack graph. */
export async function loadTrailPack(fetcher: typeof fetch = fetch): Promise<TrailPackLoadState> {
  try {
    const manifestResponse = await fetcher("/trailpack/manifest.json", { cache: "no-store" });
    if (!manifestResponse.ok) throw new Error("TrailPack manifest is not published for this deployment.");
    const manifest = parseManifest(await readJson(manifestResponse, 256 * 1024));
    const artifactResponse = await fetcher("/trailpack/tarragona-demo.json", { cache: "no-store" });
    if (!artifactResponse.ok || !(artifactResponse.headers.get("content-type") ?? "").includes("application/json")) throw new Error("TrailPack graph artifact is not published for this deployment.");
    return { status: "ready", manifest, artifact: parseArtifact(await readJson(artifactResponse, MAX_ARTIFACT_BYTES), manifest) };
  } catch (error) {
    return { status: "unavailable", message: error instanceof Error ? error.message : "TrailPack data could not be loaded." };
  }
}
