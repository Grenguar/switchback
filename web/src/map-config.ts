import type { StyleSpecification } from "maplibre-gl";

export type MapStyle = "terrain" | "satellite";
export type MapProvider = "amazon-location" | "openstreetmap";

const apiKey = import.meta.env.VITE_AWS_LOCATION_API_KEY?.trim();
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

const amazonStyle = (style: "Standard" | "Satellite"): string => {
  const parameters = new URLSearchParams({ key: apiKey!, "color-scheme": "Light" });
  if (style === "Standard") {
    parameters.set("terrain", "Hillshade");
    parameters.set("contour-density", "High");
  }
  return `https://maps.geo.${region}.amazonaws.com/v2/styles/${style}/descriptor?${parameters}`;
};

/**
 * A public browser map key is safe only when it is constrained at Amazon
 * Location. The app deliberately has no AWS credentials and falls back to OSM
 * if a deployment has not been given that constrained key.
 */
export const mapConfiguration: {
  provider: MapProvider;
  styles: Record<MapStyle, string | StyleSpecification>;
} = apiKey && region
  ? { provider: "amazon-location", styles: { terrain: amazonStyle("Standard"), satellite: amazonStyle("Satellite") } }
  : { provider: "openstreetmap", styles: { terrain: openStreetMapStyle, satellite: openStreetMapStyle } };
