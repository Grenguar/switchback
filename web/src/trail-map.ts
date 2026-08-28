import type { PlannedRoute } from "./planner";
import type { TrailPackArtifact } from "./trailpack";

type Point = { latitude: number; longitude: number };
type Segment = { from: Point; to: Point; official: boolean };
type RasterTile = { x: number; y: number; image: HTMLImageElement };

const TILE_ZOOM = 13;
const TILE_SIZE = 256;

/** Draws the locally routed TrailPack graph over a visible OSM reference map. */
export class TrailMap {
  private artifact: TrailPackArtifact | undefined;
  private route: PlannedRoute | undefined;
  private network: Segment[] = [];
  private rasterTiles: RasterTile[] = [];
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
        if (physicalIds.has(edge.physical_id)) continue;
        physicalIds.add(edge.physical_id);
        const from = tile.nodes[edge.from]!;
        const to = tile.nodes[edge.to]!;
        segments.push({ from: { latitude: from.lat_e7 / 1e7, longitude: from.lon_e7 / 1e7 }, to: { latitude: to.lat_e7 / 1e7, longitude: to.lon_e7 / 1e7 }, official: edge.official !== null });
      }
    }
    this.network = segments;
    this.rasterTiles = [];
    this.loadRasterTiles();
    this.fallback.textContent = `${segments.length.toLocaleString()} TrailPack segments are overlaid on an OpenStreetMap reference map. Routing remains local to the loaded TrailPack graph.`;
    this.draw();
  }

  setRoute(route: PlannedRoute | undefined): void { this.route = route; this.draw(); }

  private worldX(longitude: number): number { return ((longitude + 180) / 360) * TILE_SIZE * (2 ** TILE_ZOOM); }
  private worldY(latitude: number): number {
    const radians = Math.max(-85.05112878, Math.min(85.05112878, latitude)) * Math.PI / 180;
    return (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * TILE_SIZE * (2 ** TILE_ZOOM);
  }

  private project(point: Point, width: number, height: number): [number, number] {
    const [west, south, east, north] = this.artifact!.manifest.bbox;
    return [((this.worldX(point.longitude) - this.worldX(west)) / (this.worldX(east) - this.worldX(west))) * width, ((this.worldY(point.latitude) - this.worldY(north)) / (this.worldY(south) - this.worldY(north))) * height];
  }

  private loadRasterTiles(): void {
    const [west, south, east, north] = this.artifact!.manifest.bbox;
    const minX = Math.floor(this.worldX(west) / TILE_SIZE); const maxX = Math.floor(this.worldX(east) / TILE_SIZE);
    const minY = Math.floor(this.worldY(north) / TILE_SIZE); const maxY = Math.floor(this.worldY(south) / TILE_SIZE);
    const limit = 2 ** TILE_ZOOM;
    for (let y = Math.max(0, minY); y <= Math.min(limit - 1, maxY); y += 1) {
      for (let x = Math.max(0, minX); x <= Math.min(limit - 1, maxX); x += 1) {
        const image = new Image();
        image.addEventListener("load", () => { this.rasterTiles.push({ x, y, image }); this.draw(); }, { once: true });
        image.src = `https://tile.openstreetmap.org/${TILE_ZOOM}/${x}/${y}.png`;
      }
    }
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
    const [west, south, east, north] = this.artifact.manifest.bbox;
    for (const tile of this.rasterTiles) {
      const left = ((tile.x * TILE_SIZE - this.worldX(west)) / (this.worldX(east) - this.worldX(west))) * rect.width;
      const top = ((tile.y * TILE_SIZE - this.worldY(north)) / (this.worldY(south) - this.worldY(north))) * rect.height;
      const tileWidth = (TILE_SIZE / (this.worldX(east) - this.worldX(west))) * rect.width;
      const tileHeight = (TILE_SIZE / (this.worldY(south) - this.worldY(north))) * rect.height;
      context.drawImage(tile.image, left, top, tileWidth, tileHeight);
    }
    context.fillStyle = this.rasterTiles.length > 0 ? "rgba(15, 36, 31, .14)" : "#c4b98d";
    context.fillRect(0, 0, rect.width, rect.height);
    context.lineCap = "round"; context.lineJoin = "round";
    for (const official of [false, true]) {
      context.beginPath();
      for (const segment of this.network) {
        if (segment.official !== official) continue;
        const [fromX, fromY] = this.project(segment.from, rect.width, rect.height);
        const [toX, toY] = this.project(segment.to, rect.width, rect.height);
        context.moveTo(fromX, fromY); context.lineTo(toX, toY);
      }
      context.strokeStyle = official ? "rgba(223, 240, 167, .95)" : "rgba(15, 63, 46, .86)";
      context.lineWidth = official ? 1.5 : 1;
      context.stroke();
    }
    if (!this.route) return;
    const points = this.route.coordinates.map(([latitude, longitude]) => ({ latitude, longitude }));
    context.strokeStyle = "rgba(12, 35, 26, .78)"; context.lineWidth = 8; this.drawRoute(context, points, rect.width, rect.height);
    context.strokeStyle = "#f8f5df"; context.lineWidth = 4.5; this.drawRoute(context, points, rect.width, rect.height);
    context.strokeStyle = "#b64f39"; context.lineWidth = 1.5; this.drawRoute(context, points, rect.width, rect.height);
  }
}
