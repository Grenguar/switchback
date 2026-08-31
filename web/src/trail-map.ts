import { GeoJSONSource, LngLatBounds, Map as MapLibreMap, Marker, NavigationControl } from "maplibre-gl";
import type { PlannedRoute } from "./planner";
import { mapConfiguration, type MapStyle } from "./map-config";
import type { TrailPackArtifact } from "./trailpack";

type RouteFeature = {
  type: "Feature";
  properties: Record<string, never>;
  geometry: { type: "LineString"; coordinates: Array<[number, number]> };
};

const routeFeature = (route: PlannedRoute): RouteFeature => ({
  type: "Feature",
  properties: {},
  geometry: { type: "LineString", coordinates: route.coordinates.map(([latitude, longitude]) => [longitude, latitude]) },
});

/** An interactive basemap; only the selected, graph-planned circuit is drawn. */
export class TrailMap {
  private artifact: TrailPackArtifact | undefined;
  private route: PlannedRoute | undefined;
  private loaded = false;
  private currentStyle: MapStyle = "terrain";
  private startMarker: Marker | undefined;
  private readonly map: MapLibreMap;

  constructor(container: HTMLElement, private readonly status: HTMLElement) {
    this.map = new MapLibreMap({
      container,
      style: mapConfiguration.styles.terrain,
      center: [2.126, 41.431],
      zoom: 12.5,
    });
    this.map.addControl(new NavigationControl({ visualizePitch: true }), "top-left");
    this.map.on("load", () => { this.loaded = true; this.sync(); });
    this.map.on("style.load", () => { this.loaded = true; this.sync(); });
    this.map.on("error", () => {
      if (mapConfiguration.provider === "amazon-location") {
        this.status.textContent = "Amazon Location map could not load. Check the deployed key and its allowed referrer.";
      }
    });
    this.renderStatus();
  }

  get supportsSatellite(): boolean { return mapConfiguration.provider === "amazon-location"; }

  setTrailPack(artifact: TrailPackArtifact): void {
    this.artifact = artifact;
    if (this.loaded && !this.route) this.fitToArtifact();
    this.renderStatus();
  }

  setRoute(route: PlannedRoute | undefined): void {
    this.route = route;
    if (this.loaded) {
      this.sync();
      if (route) this.fitToRoute(route);
    }
  }

  setStyle(style: MapStyle): void {
    if (style === "satellite" && !this.supportsSatellite) return;
    this.currentStyle = style;
    this.loaded = false;
    this.map.setStyle(mapConfiguration.styles[style]);
  }

  private renderStatus(): void {
    const graph = this.artifact ? " TrailPack routes stay local." : "";
    this.status.textContent = mapConfiguration.provider === "amazon-location"
      ? `Amazon Location ${this.currentStyle === "terrain" ? "terrain and contours" : "satellite"}.${graph}`
      : `OpenStreetMap fallback.${graph} Add the scoped Amazon Location key to enable terrain and satellite.`;
  }

  private sync(): void {
    this.renderStatus();
    if (!this.route) {
      this.fitToArtifact();
      return;
    }
    const data = routeFeature(this.route);
    const existing = this.map.getSource("switchback-route") as GeoJSONSource | undefined;
    if (existing) existing.setData(data);
    else {
      this.map.addSource("switchback-route", { type: "geojson", data });
      this.map.addLayer({ id: "switchback-route-casing", type: "line", source: "switchback-route", paint: { "line-color": "#173328", "line-width": 8, "line-opacity": 0.8, "line-blur": 0.6 } });
      this.map.addLayer({ id: "switchback-route", type: "line", source: "switchback-route", paint: { "line-color": "#ff9d2e", "line-width": 4.5, "line-opacity": 1 } });
    }
    this.placeStartMarker(this.route);
  }

  private placeStartMarker(route: PlannedRoute): void {
    if (!this.startMarker) {
      const element = document.createElement("div");
      element.className = "trailhead-marker";
      element.setAttribute("aria-label", "Route start car park");
      this.startMarker = new Marker({ element, anchor: "bottom" }).addTo(this.map);
    }
    this.startMarker.setLngLat([route.start.longitude, route.start.latitude]);
  }

  private fitToArtifact(): void {
    if (!this.artifact) return;
    const [west, south, east, north] = this.artifact.manifest.bbox;
    this.map.fitBounds([[west, south], [east, north]], { padding: 48, duration: 0, maxZoom: 13 });
  }

  private fitToRoute(route: PlannedRoute): void {
    const coordinates = route.coordinates.map(([latitude, longitude]) => [longitude, latitude] as [number, number]);
    if (coordinates.length < 2) return;
    const bounds = coordinates.reduce((result, coordinate) => result.extend(coordinate), new LngLatBounds(coordinates[0], coordinates[0]));
    this.map.fitBounds(bounds, { padding: { top: 72, right: 56, bottom: 72, left: 56 }, duration: 650, maxZoom: 15 });
  }
}
