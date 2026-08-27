import type { PlannedRoute } from "./planner";
import type { TrailPackArtifact } from "./trailpack";

type Point = { latitude: number; longitude: number };
type Segment = { from: Point; to: Point; official: boolean };

/** Draws the static TrailPack graph itself; no map tiles or routing service. */
export class TrailMap {
  private artifact: TrailPackArtifact | undefined;
  private route: PlannedRoute | undefined;
  private network: Segment[] = [];
  private observer: ResizeObserver;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly fallback: HTMLElement) {
    this.observer = new ResizeObserver(() => this.draw());
    this.observer.observe(canvas);
  }

  setTrailPack(artifact: TrailPackArtifact): void {
    this.artifact = artifact;
    const physicalIds = new Set<string>();
    const segments: Segment[] = [];
    for (const tileId of artifact.manifest.tiles) {
      const tile = artifact.tiles[tileId]!;
      for (const edge of tile.edges) {
        // Directed edges come in pairs; one physical segment keeps the map legible.
        if (physicalIds.has(edge.physical_id)) continue;
        physicalIds.add(edge.physical_id);
        const from = tile.nodes[edge.from]!;
        const to = tile.nodes[edge.to]!;
        segments.push({ from: { latitude: from.lat_e7 / 1e7, longitude: from.lon_e7 / 1e7 }, to: { latitude: to.lat_e7 / 1e7, longitude: to.lon_e7 / 1e7 }, official: edge.official !== null });
      }
    }
    this.network = segments;
    this.fallback.textContent = `${segments.length.toLocaleString()} TrailPack trail segments are visible on this offline map. The selected route is overlaid in light ink.`;
    this.draw();
  }

  setRoute(route: PlannedRoute | undefined): void { this.route = route; this.draw(); }

  private project(point: Point, width: number, height: number): [number, number] {
    const [west, south, east, north] = this.artifact!.manifest.bbox;
    return [((point.longitude - west) / (east - west)) * width, (1 - ((point.latitude - south) / (north - south))) * height];
  }

  private drawRoute(context: CanvasRenderingContext2D, points: Point[], width: number, height: number): void {
    if (points.length < 2) return;
    context.beginPath();
    for (const [index, point] of points.entries()) {
      const [x, y] = this.project(point, width, height);
      if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
    }
    context.stroke();
  }

  private draw(): void {
    const context = this.canvas.getContext("2d");
    const rect = this.canvas.getBoundingClientRect();
    if (!context || !this.artifact || rect.width === 0 || rect.height === 0) return;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(rect.width * pixelRatio); const height = Math.round(rect.height * pixelRatio);
    if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);
    context.lineCap = "round"; context.lineJoin = "round";
    // Official matching is a different visual layer, never a claim that marks are current.
    for (const official of [false, true]) {
      context.beginPath();
      for (const segment of this.network) {
        if (segment.official !== official) continue;
        const [fromX, fromY] = this.project(segment.from, rect.width, rect.height);
        const [toX, toY] = this.project(segment.to, rect.width, rect.height);
        context.moveTo(fromX, fromY); context.lineTo(toX, toY);
      }
      context.strokeStyle = official ? "rgba(204, 219, 152, .73)" : "rgba(27, 67, 48, .63)";
      context.lineWidth = official ? 1.15 : .72;
      context.stroke();
    }
    if (!this.route) return;
    const points = this.route.coordinates.map(([latitude, longitude]) => ({ latitude, longitude }));
    context.strokeStyle = "rgba(20, 49, 38, .7)"; context.lineWidth = 7; this.drawRoute(context, points, rect.width, rect.height);
    context.strokeStyle = "#f4f1db"; context.lineWidth = 4; this.drawRoute(context, points, rect.width, rect.height);
    context.strokeStyle = "#b64f39"; context.lineWidth = 1.25; this.drawRoute(context, points, rect.width, rect.height);
  }
}
