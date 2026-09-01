import { GeoJSONSource, LngLatBounds, Map as MapLibreMap, NavigationControl, Popup } from "maplibre-gl";
import type { PlannedRoute, StartDefinition } from "./planner";
import { mapConfiguration } from "./map-config";
import type { TrailPackArtifact } from "./trailpack";

type RouteFeature = {
  type: "Feature";
  properties: Record<string, never>;
  geometry: { type: "LineString"; coordinates: Array<[number, number]> };
};

type StartFeature = {
  type: "Feature";
  properties: Record<string, never>;
  geometry: { type: "Point"; coordinates: [number, number] };
};

type OfficialNetwork = {
  type: "FeatureCollection";
  features: Array<{ type: "Feature"; properties: { code: string; name: string; source: string }; geometry: { type: "LineString"; coordinates: Array<[number, number]> } }>;
};

const routeFeature = (route: PlannedRoute): RouteFeature => ({
  type: "Feature",
  properties: {},
  geometry: { type: "LineString", coordinates: route.coordinates.map(([latitude, longitude]) => [longitude, latitude]) },
});

const startFeature = (start: Pick<StartDefinition, "latitude" | "longitude">): StartFeature => ({
  type: "Feature",
  properties: {},
  geometry: { type: "Point", coordinates: [start.longitude, start.latitude] },
});

// Keep discovery in the intended running area. The graph may contain nearby
// Barcelona connections, but this map is for Collserola–Vallvidrera outings.
const COLLSEROLA_BOUNDS: [[number, number], [number, number]] = [[2.075, 41.395], [2.17, 41.46]];

/** An interactive basemap; only the selected, graph-planned circuit is drawn. */
export class TrailMap {
  private artifact: TrailPackArtifact | undefined;
  private route: PlannedRoute | undefined;
  private selectedStart: StartDefinition | undefined;
  private officialNetwork: OfficialNetwork | undefined;
  private loaded = false;
  private readonly map: MapLibreMap;

  constructor(container: HTMLElement, private readonly status: HTMLElement) {
    this.map = new MapLibreMap({
      container,
      style: mapConfiguration.style,
      center: [2.126, 41.431],
      zoom: 13.2,
      minZoom: 12.2,
      maxZoom: 17,
      dragPan: true,
      scrollZoom: true,
      touchZoomRotate: true,
      keyboard: true,
      doubleClickZoom: true,
      transformRequest: (url) => ({ url: mapConfiguration.withApiKey(url) }),
      // AWS Maps V2 styles include dynamic terrain extensions. Their
      // MapLibre guidance disables generic style validation for these styles.
      validateStyle: false,
    });
    this.map.addControl(new NavigationControl({ showCompass: false, showZoom: true, visualizePitch: false }), "top-left");
    this.map.on("load", () => { this.loaded = true; this.sync(); });
    this.map.on("style.load", () => { this.loaded = true; this.sync(); this.addOfficialNetwork(); });
    this.map.on("error", () => {
      if (mapConfiguration.provider === "amazon-location") {
        this.status.textContent = "Amazon Location map could not load. Check the deployed key and its allowed referrer.";
      }
    });
    void this.loadOfficialNetwork();
    this.renderStatus();
  }

  setTrailPack(artifact: TrailPackArtifact): void {
    this.artifact = artifact;
    if (this.loaded && !this.route && !this.selectedStart) this.fitToArtifact();
    this.renderStatus();
  }

  setRoute(route: PlannedRoute | undefined): void {
    this.route = route;
    if (this.loaded) {
      this.sync();
      if (route) this.fitToRoute(route);
    }
  }

  previewStart(start: StartDefinition): void {
    this.selectedStart = start;
    this.route = undefined;
    if (!this.loaded) return;
    this.hideRoute();
    this.placeStartMarker(start);
    this.map.flyTo({ center: [start.longitude, start.latitude], zoom: 14.1, duration: 420, essential: true });
  }

  clearRoute(): void {
    this.route = undefined;
    if (!this.loaded) return;
    // Remove old geometry rather than merely hiding it. This prevents an old
    // orange circuit being retained by the renderer while a new car park is
    // being previewed or a fresh graph plan is still in progress.
    if (this.map.getLayer("switchback-route")) this.map.removeLayer("switchback-route");
    if (this.map.getLayer("switchback-route-casing")) this.map.removeLayer("switchback-route-casing");
    if (this.map.getSource("switchback-route")) this.map.removeSource("switchback-route");
  }

  private renderStatus(): void {
    const graph = this.artifact ? " TrailPack routes stay local." : "";
    const official = this.officialNetwork ? ` ${this.officialNetwork.features.length} official A–E path segments loaded.` : "";
    this.status.textContent = mapConfiguration.provider === "amazon-location"
      ? `Amazon Location terrain and contours.${official}${graph}`
      : `OpenStreetMap fallback.${official}${graph} Add the scoped Amazon Location key to enable the terrain map.`;
  }

  private sync(): void {
    this.renderStatus();
    if (!this.route) {
      this.hideRoute();
      if (this.selectedStart) this.placeStartMarker(this.selectedStart);
      else this.fitToArtifact();
      return;
    }
    const data = routeFeature(this.route);
    const existing = this.map.getSource("switchback-route") as GeoJSONSource | undefined;
    if (existing) {
      existing.setData(data);
      this.map.setLayoutProperty("switchback-route-casing", "visibility", "visible");
      this.map.setLayoutProperty("switchback-route", "visibility", "visible");
    }
    else {
      this.map.addSource("switchback-route", { type: "geojson", data });
      this.map.addLayer({ id: "switchback-route-casing", type: "line", source: "switchback-route", paint: { "line-color": "#173328", "line-width": 8, "line-opacity": 0.8, "line-blur": 0.6 } });
      this.map.addLayer({ id: "switchback-route", type: "line", source: "switchback-route", paint: { "line-color": "#ff9d2e", "line-width": 4.5, "line-opacity": 1 } });
    }
    this.selectedStart = this.route.start;
    this.placeStartMarker(this.route.start);
  }

  private hideRoute(): void {
    if (this.map.getLayer("switchback-route-casing")) this.map.setLayoutProperty("switchback-route-casing", "visibility", "none");
    if (this.map.getLayer("switchback-route")) this.map.setLayoutProperty("switchback-route", "visibility", "none");
  }

  private async loadOfficialNetwork(): Promise<void> {
    try {
      const response = await fetch("/trailpack/collserola-official-network-a-e.geojson", { cache: "force-cache" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const network = await response.json() as OfficialNetwork;
      if (network.type !== "FeatureCollection" || !Array.isArray(network.features) || network.features.length === 0) throw new Error("invalid feature collection");
      this.officialNetwork = network;
      if (this.loaded) this.addOfficialNetwork();
      this.renderStatus();
    } catch {
      this.status.textContent = "Official marked-path overlay could not load. TrailPack routing remains available.";
    }
  }

  private addOfficialNetwork(): void {
    if (!this.officialNetwork || this.map.getSource("official-network")) return;
    const beforeRoute = this.map.getLayer("switchback-route-casing") ? "switchback-route-casing" : undefined;
    this.map.addSource("official-network", { type: "geojson", data: this.officialNetwork });
    this.map.addLayer({ id: "official-network-line", type: "line", source: "official-network", paint: { "line-color": "#315c48", "line-width": ["interpolate", ["linear"], ["zoom"], 11, 1, 14, 2.2, 17, 3.2], "line-opacity": 0.78 } }, beforeRoute);
    this.map.addLayer({ id: "official-network-hit", type: "line", source: "official-network", paint: { "line-color": "#315c48", "line-width": 18, "line-opacity": 0 } }, beforeRoute);
    this.map.addLayer({ id: "official-network-code", type: "symbol", source: "official-network", minzoom: 12.7, layout: { "symbol-placement": "line", "text-field": ["get", "code"], "text-font": ["Noto Sans Regular"], "text-size": 10, "symbol-spacing": 430, "text-keep-upright": true }, paint: { "text-color": "#173328", "text-halo-color": "#edf0e5", "text-halo-width": 1.25 } }, beforeRoute);
    this.map.on("mouseenter", "official-network-hit", () => { this.map.getCanvas().style.cursor = "pointer"; });
    this.map.on("mouseleave", "official-network-hit", () => { this.map.getCanvas().style.cursor = "grab"; });
    this.map.on("click", "official-network-hit", (event) => {
      const properties = event.features?.[0]?.properties;
      if (!properties?.code || !properties.name) return;
      new Popup({ closeButton: false, offset: 10 }).setLngLat(event.lngLat).setText(`${properties.code} · ${properties.name}`).addTo(this.map);
    });
  }

  private placeStartMarker(start: Pick<StartDefinition, "latitude" | "longitude">): void {
    const data = startFeature(start);
    const existing = this.map.getSource("switchback-start") as GeoJSONSource | undefined;
    if (existing) {
      existing.setData(data);
      return;
    }
    this.map.addSource("switchback-start", { type: "geojson", data });
    this.map.addLayer({ id: "switchback-start-casing", type: "circle", source: "switchback-start", paint: { "circle-radius": 13, "circle-color": "#f8f5df", "circle-stroke-color": "#173328", "circle-stroke-width": 2 } });
    this.map.addLayer({ id: "switchback-start", type: "circle", source: "switchback-start", paint: { "circle-radius": 8, "circle-color": "#427e2e", "circle-stroke-color": "#dce9a0", "circle-stroke-width": 2 } });
  }

  private fitToArtifact(): void {
    if (!this.artifact) return;
    this.map.fitBounds(COLLSEROLA_BOUNDS, { padding: 48, duration: 0, maxZoom: 13.2 });
  }

  private fitToRoute(route: PlannedRoute): void {
    const coordinates = route.coordinates.map(([latitude, longitude]) => [longitude, latitude] as [number, number]);
    if (coordinates.length < 2) return;
    const bounds = coordinates.reduce((result, coordinate) => result.extend(coordinate), new LngLatBounds(coordinates[0], coordinates[0]));
    this.map.fitBounds(bounds, { padding: { top: 72, right: 56, bottom: 72, left: 56 }, duration: 650, maxZoom: 15 });
  }
}
