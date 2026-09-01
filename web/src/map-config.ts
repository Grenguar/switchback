import type { StyleSpecification } from "maplibre-gl";

export type MapProvider = "amazon-location" | "openstreetmap";

// Console/terminal copies can occasionally wrap this browser key. Amazon
// Location keys never contain whitespace, so normalize it before composing
// style, sprite, glyph, and tile requests.
const apiKey = import.meta.env.VITE_AWS_LOCATION_API_KEY?.replace(/\s+/g, "");
const region = import.meta.env.VITE_AWS_LOCATION_REGION?.trim();

const openStreetMapStyle: StyleSpecification = {
  version: 8,
  name: "OpenStreetMap fallback",
  sources: {
    openstreetmap: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "openstreetmap", type: "raster", source: "openstreetmap" }],
};

const amazonTerrainStyle = (): string => {
  const parameters = new URLSearchParams({ key: apiKey!, "color-scheme": "Light" });
  parameters.set("terrain", "Hillshade");
  parameters.set("contour-density", "High");
  return `https://maps.geo.${region}.amazonaws.com/v2/styles/Standard/descriptor?${parameters}`;
};

/**
 * A public browser map key is safe only when it is constrained at Amazon
 * Location. The app deliberately has no AWS credentials and falls back to OSM
 * if a deployment has not been given that constrained key.
 */
export const mapConfiguration: {
  provider: MapProvider;
  style: string | StyleSpecification;
  withApiKey(url: string): string;
} = apiKey && region
  ? {
      provider: "amazon-location",
      style: amazonTerrainStyle(),
      // Amazon's style descriptor references glyphs and sprites without its
      // key. MapLibre requests those independently, so decorate every Maps V2
      // URL while leaving non-AWS sources untouched.
      withApiKey: (url) => {
        const parsed = new URL(url);
        if (parsed.hostname === `maps.geo.${region}.amazonaws.com` && !parsed.searchParams.has("key")) parsed.searchParams.set("key", apiKey);
        return parsed.toString();
      },
    }
  : { provider: "openstreetmap", style: openStreetMapStyle, withApiKey: (url) => url };
