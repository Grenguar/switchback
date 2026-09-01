/** Samples the public ICGC LiDAR terrain model along a completed route. */
const ICGC_WMS = "https://geoserveis.icgc.cat/servei/catalunya/elevacions-territorial/wms";
const LAYER = "model-elevacions-terreny-catalunya-lidar-50cm-2021-2023";
type Coordinate = readonly [number, number];

const metresBetween = ([fromLat, fromLon]: Coordinate, [toLat, toLon]: Coordinate): number => {
  const radians = Math.PI / 180;
  const latitude = (toLat - fromLat) * radians;
  const longitude = (toLon - fromLon) * radians;
  const a = Math.sin(latitude / 2) ** 2 + Math.cos(fromLat * radians) * Math.cos(toLat * radians) * Math.sin(longitude / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const evenlySpaced = (coordinates: readonly Coordinate[], spacingMetres = 180, maximum = 42): Coordinate[] => {
  if (coordinates.length < 2) return [...coordinates];
  const sampled: Coordinate[] = [coordinates[0]!];
  let sinceLastSample = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    sinceLastSample += metresBetween(coordinates[index - 1]!, coordinates[index]!);
    if (sinceLastSample >= spacingMetres) { sampled.push(coordinates[index]!); sinceLastSample = 0; }
  }
  if (sampled.at(-1) !== coordinates.at(-1)) sampled.push(coordinates.at(-1)!);
  if (sampled.length <= maximum) return sampled;
  return Array.from({ length: maximum }, (_, index) => sampled[Math.round(index * (sampled.length - 1) / (maximum - 1))]!);
};

const elevationUrl = ([latitude, longitude]: Coordinate): string => {
  const delta = 0.00025;
  // ICGC returns a feature only for an interior pixel; use the centre of a
  // small image rather than its top-left boundary pixel.
  const params = new URLSearchParams({ SERVICE: "WMS", VERSION: "1.1.1", REQUEST: "GetFeatureInfo", LAYERS: LAYER, QUERY_LAYERS: LAYER, STYLES: "", BBOX: `${longitude - delta},${latitude - delta},${longitude + delta},${latitude + delta}`, SRS: "EPSG:4326", WIDTH: "256", HEIGHT: "256", X: "128", Y: "128", INFO_FORMAT: "application/json", FORMAT: "image/png" });
  return `${ICGC_WMS}?${params}`;
};

const readElevation = async (coordinate: Coordinate, fetcher: typeof fetch): Promise<number | null> => {
  const response = await fetcher(elevationUrl(coordinate), { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) return null;
  const payload = await response.json() as { features?: Array<{ properties?: { "Elevació"?: string | number } }> };
  const value = Number(payload.features?.[0]?.properties?.Elevació);
  return Number.isFinite(value) ? value : null;
};

/** Positive ascent in metres, rounded to 5 m, or null if the official service is incomplete. */
export const estimateRouteAscent = async (coordinates: readonly Coordinate[], fetcher: typeof fetch = fetch): Promise<number | null> => {
  const samples = evenlySpaced(coordinates);
  if (samples.length < 2) return null;
  const values: Array<number | null> = [];
  for (let offset = 0; offset < samples.length; offset += 6) values.push(...await Promise.all(samples.slice(offset, offset + 6).map((point) => readElevation(point, fetcher).catch(() => null))));
  if (values.filter((value): value is number => value !== null).length < Math.ceil(samples.length * 0.8)) return null;
  let ascent = 0;
  let previous: number | null = null;
  for (const value of values) { if (value !== null) { if (previous !== null && value > previous) ascent += value - previous; previous = value; } }
  return Math.round(ascent / 5) * 5;
};

export const elevationAttribution = "Elevation estimate: ICGC LiDAR terrain model (2021–2023), sampled along the route.";
