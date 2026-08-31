import "./style.css";
import { commitWaypointEdit, documentedStarts, getActiveRoute, setGpxRenderer, setPlanTargetRenderer, setRouteRenderer, setToolInvocationObserver, setTrailPackProvenance, setTrailPlanner, toolContracts, type PreparedGpx } from "./tools";
import { TrailPlanner, type PlannedRoute, type StartId } from "./planner";
import { loadTrailPack, type TrailPackLoadState } from "./trailpack";
import { TrailMap } from "./trail-map";
import { registerWebMcpTools, type BridgeStatus } from "./webmcp";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing application root.");
const bridge = { status: "unavailable" as BridgeStatus, count: 0 };
let logSequence = 0;

app.innerHTML = `
  <main class="shell">
    <header class="masthead"><a class="wordmark" href="/" aria-label="Switchback home">SWITCHBACK<span>↗</span></a><div class="status"><i class="status-dot ${bridge.status}" id="bridge-dot"></i><span id="bridge-label">Checking WebMCP…</span></div><button class="plain-button" id="register" type="button">Check model context</button></header>
    <section class="model-context-check" aria-labelledby="model-context-title"><div><p class="eyebrow" id="model-context-title">WebMCP status</p><p id="model-context-status" role="status" aria-live="polite">Checking this browser for an agent tool context…</p></div><div><p id="model-context-next">If tools are available, an agent on this page can discover them without a separate connection.</p><button class="context-help" id="copy-agent-prompt" type="button">Copy agent test prompt</button><p class="context-help-status" id="copy-agent-prompt-status" role="status" aria-live="polite"></p></div></section>
    <section class="intro" aria-labelledby="intro-title"><p class="eyebrow">Trail intelligence, made inspectable</p><h1 id="intro-title">Ask for a loop.<br><em>See the ground truth.</em></h1><p class="lede">A WebMCP-native route planner for the places where a paper map still matters. TrailPack provenance is visible before a route is trusted.</p></section>
    <section class="workspace" aria-label="Route planning workspace">
      <aside class="planner"><div class="section-label"><span>01</span><p>Plan a walk</p></div>
        <form id="plan-form"><div class="route-question"><label for="route-request">What sounds good?</label><div class="route-request-row"><input id="route-request" type="text" autocomplete="off" placeholder="A relaxed 7 km loop from Font Groga" /><button class="plan-button compact" type="submit">Plan it <span aria-hidden="true">↗</span></button></div><p class="field-hint" id="route-request-hint">Or pick a car park and distance below. Nothing is sent anywhere.</p></div><fieldset class="start-picker"><legend>Start from your car</legend><div class="start-options" role="group" aria-label="Available trailheads">${Object.values(documentedStarts).map((start, index) => `<button class="start-option" type="button" data-start="${start.id}" aria-pressed="${index === 0}"><strong>${start.name}</strong><small>${start.description}</small></button>`).join("")}</div><p class="field-hint" id="start-hint">Font Groga and Vista Rica are car parks; Cresta is an on-trail alternative.</p></fieldset><fieldset class="distance-picker"><legend>How far today? <output id="distance-value">7</output> km</legend><input id="distance" name="distance" type="range" min="1" max="30" step="1" value="7" aria-describedby="distance-help" /><div class="distance-steps" role="group" aria-label="Distance in kilometres">${Array.from({ length: 30 }, (_, index) => `<button type="button" class="distance-step" data-distance="${index + 1}" aria-pressed="${index + 1 === 7}">${index + 1}</button>`).join("")}</div><p class="field-hint" id="distance-help">Kilometres only — choose any whole number from 1 to 30.</p></fieldset><fieldset><legend>Route character</legend><div class="choices"><label><input type="radio" name="character" value="waymarked" checked /> Prefer official-match evidence</label><label><input type="radio" name="character" value="neutral" /> Just find me a trail loop</label></div></fieldset><p class="field-hint">The graph excludes urban footways and paved access roads. Official matching is evidence, not a waymarking confirmation. Elevation and grade constraints are not available yet.</p></form>
        <section class="evidence" aria-labelledby="trailpack-title"><p class="eyebrow" id="trailpack-title">TrailPack data</p><p class="data-status loading" id="trailpack-status" role="status">Loading static graph…</p><strong id="trailpack-region">No graph loaded</strong><ul id="trailpack-sources" class="source-list" aria-label="TrailPack attributions"></ul></section>
      </aside>
    <section class="map-panel" id="map-panel" aria-label="TrailPack route preview on an OpenStreetMap reference map"><canvas class="trail-map" id="trail-map" aria-hidden="true"></canvas><p class="map-description" id="map-description" role="status">Loading the TrailPack route map.</p><button class="waypoint-handle" id="waypoint-handle" type="button" disabled aria-describedby="waypoint-help waypoint-update" aria-label="Route through-point. Plan a route before moving it."><span aria-hidden="true"></span></button><p class="waypoint-help" id="waypoint-help">Drag the through-point to request a graph replan. Keyboard: use arrow keys to position it, then Enter to apply; Escape cancels.</p><p class="waypoint-update" id="waypoint-update" role="status" aria-live="polite">Plan a route to enable the through-point.</p><div class="map-key"><span><i class="network-swatch"></i>TrailPack network</span><span><i class="route-swatch"></i><span id="route-state">No route planned</span></span><span id="map-data-label">Data loading</span></div><p class="map-attribution">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a></p><article class="route-card" id="route-card" aria-live="polite"><p class="eyebrow" id="route-kicker">Choose a car park</p><h2 id="route-name">Tell us what kind of walk you want</h2><dl><div><dt>Distance</dt><dd id="route-distance">—</dd></div><div><dt>Climb</dt><dd id="route-ascent">Unknown</dd></div><div><dt>Moving time</dt><dd id="route-duration">—</dd></div></dl><p class="route-note" id="route-note">We only draw a loop after the trail graph finds one.</p><section class="gpx-export" id="gpx-export" hidden aria-labelledby="gpx-status"><p id="gpx-status" role="status">No GPX prepared.</p><a id="gpx-download" download>Download GPX</a></section></article></section>
    </section>
    <section class="tooling" aria-labelledby="tools-title"><div><p class="eyebrow">Agent surface</p><h2 id="tools-title">Six small tools.<br>One accountable route.</h2></div><div class="tool-list">${toolContracts.map((tool, index) => `<button class="tool" type="button" data-tool="${tool.name}"><span>0${index + 1}</span><strong>${tool.name.replaceAll("_", " ")}</strong><small>${tool.description}</small><b>Run ↗</b></button>`).join("")}</div></section>
    <section class="log-section" aria-labelledby="log-title"><div><p class="eyebrow">Tool invocation log</p><h2 id="log-title">Nothing hidden in the route.</h2></div><ol id="log" class="log"><li class="empty">Choose a route action to inspect its validated input and source-backed output.</li></ol></section>
  </main>`;

const log = document.querySelector<HTMLOListElement>("#log");
const trailMapCanvas = document.querySelector<HTMLCanvasElement>("#trail-map");
const mapDescription = document.querySelector<HTMLElement>("#map-description");
const trailMap = trailMapCanvas && mapDescription ? new TrailMap(trailMapCanvas, mapDescription) : undefined;
let preparedGpxUrl: string | undefined;
const clearPreparedGpx = (): void => {
  if (preparedGpxUrl) URL.revokeObjectURL(preparedGpxUrl);
  preparedGpxUrl = undefined;
  const exportPanel = document.querySelector<HTMLElement>("#gpx-export");
  const download = document.querySelector<HTMLAnchorElement>("#gpx-download");
  if (exportPanel) exportPanel.hidden = true;
  if (download) download.removeAttribute("href");
};
const renderPreparedGpx = (prepared: PreparedGpx): void => {
  clearPreparedGpx();
  preparedGpxUrl = URL.createObjectURL(new Blob([prepared.content], { type: "application/gpx+xml" }));
  const exportPanel = document.querySelector<HTMLElement>("#gpx-export");
  const status = document.querySelector<HTMLElement>("#gpx-status");
  const download = document.querySelector<HTMLAnchorElement>("#gpx-download");
  if (status) status.textContent = `GPX ready: ${prepared.transitions.length} named transitions. Download requires your click.`;
  if (download) { download.href = preparedGpxUrl; download.download = prepared.filename; }
  if (exportPanel) exportPanel.hidden = false;
};
setGpxRenderer(renderPreparedGpx);
window.addEventListener("pagehide", clearPreparedGpx);
const bridgeCopy: Record<BridgeStatus, { label: string; next: string }> = {
  unavailable: { label: "Browser demo mode", next: "In ChatGPT, start a fresh GPT-5.6 Sol or Terra chat, have it open this URL in its browser, then reload this page or press Check model context. A normal browser tab cannot expose agent tools." },
  registered: { label: "WebMCP connected", next: "Tools are registered on this page. Ask your agent to discover the site tools and call plan_route." },
  failed: { label: "WebMCP registration failed", next: "The browser exposed a model context but did not accept all tools. Check the message, reload the page, then try again." },
};
function renderBridgeStatus(result: { status: BridgeStatus; count: number; message: string }): void {
  bridge.status = result.status; bridge.count = result.count;
  const dot = document.querySelector<HTMLElement>("#bridge-dot"); const label = document.querySelector<HTMLElement>("#bridge-label"); const status = document.querySelector<HTMLElement>("#model-context-status"); const next = document.querySelector<HTMLElement>("#model-context-next"); const button = document.querySelector<HTMLButtonElement>("#register");
  if (dot) dot.className = `status-dot ${result.status}`;
  if (label) label.textContent = bridgeCopy[result.status].label;
  if (status) status.textContent = result.message;
  if (next) next.textContent = bridgeCopy[result.status].next;
  if (button) button.textContent = result.status === "registered" ? "Recheck model context" : "Check model context";
}
async function checkModelContext(): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>("#register");
  if (button) { button.disabled = true; button.textContent = "Checking…"; }
  const result = await registerWebMcpTools(true);
  renderBridgeStatus(result);
  addLog("webmcp_registration", { requested: true }, result, result.status === "failed" ? result.message : undefined);
  if (button) button.disabled = false;
}
const addLog = (name: string, input: unknown, result: unknown, error?: unknown): void => {
  if (!log) return; log.querySelector(".empty")?.remove();
  const item = document.createElement("li"); const sequence = document.createElement("span"); sequence.textContent = String(++logSequence).padStart(2, "0");
  const details = document.createElement("div"); const heading = document.createElement("strong"); heading.textContent = name; const output = document.createElement("code"); output.textContent = error ? `Error: ${error instanceof Error ? error.message : String(error)}` : JSON.stringify({ input, result }); details.append(heading, output); item.append(sequence, details); log.prepend(item);
};
// Browser-agent WebMCP calls and page button calls share this observer, so the
// visible audit trail does not depend on which surface initiated the action.
setToolInvocationObserver((name, input, result, error) => addLog(name, input, result, error));

function renderRoute(route: PlannedRoute): void {
  clearPreparedGpx();
  const state = document.querySelector<HTMLElement>("#route-state");
  const name = document.querySelector<HTMLElement>("#route-name"); const distance = document.querySelector<HTMLElement>("#route-distance"); const duration = document.querySelector<HTMLElement>("#route-duration"); const kicker = document.querySelector<HTMLElement>("#route-kicker"); const note = document.querySelector<HTMLElement>("#route-note");
  if (state) state.textContent = "Your trail circuit"; if (name) name.textContent = route.name; if (distance) distance.textContent = `${route.distanceKm} km`; if (duration) duration.textContent = `${route.durationHours} h`; if (kicker) kicker.textContent = "Ready to walk"; if (note) note.textContent = `${route.waymarkedPercent}% official-match coverage. Elevation unknown; check local conditions before you go.`;
  trailMap?.setRoute(route);
  const midpoint = route.coordinates[Math.floor(route.coordinates.length / 2)];
  if (midpoint) setWaypointPosition(midpoint[0], midpoint[1], false);
  const waypoint = document.querySelector<HTMLButtonElement>("#waypoint-handle");
  const update = document.querySelector<HTMLElement>("#waypoint-update");
  if (waypoint) { waypoint.disabled = false; waypoint.setAttribute("aria-label", "Route through-point. Drag to request a graph replan, or use arrow keys then Enter."); }
  if (update) update.textContent = "Through-point ready. Drag it or use arrow keys, then press Enter to apply a graph replan.";
}
let currentManifestBbox: [number, number, number, number] = [0.86, 41.23, 0.99, 41.34];
setRouteRenderer(renderRoute);

function renderTrailPack(state: TrailPackLoadState): void {
  const status = document.querySelector<HTMLElement>("#trailpack-status"); const region = document.querySelector<HTMLElement>("#trailpack-region"); const sources = document.querySelector<HTMLUListElement>("#trailpack-sources"); const mapLabel = document.querySelector<HTMLElement>("#map-data-label");
  if (!status || !region || !sources || !mapLabel || state.status === "loading") return;
  sources.replaceChildren();
  if (state.status === "unavailable") { status.className = "data-status unavailable"; status.textContent = `TrailPack unavailable — ${state.message}`; region.textContent = "No graph loaded"; mapLabel.textContent = "Graph unavailable"; return; }
  currentManifestBbox = state.manifest.bbox; trailMap?.setTrailPack(state.artifact); setTrailPackProvenance(`${state.manifest.region_name} TrailPack`, state.manifest.sources.map((source) => source.attribution)); setTrailPlanner(new TrailPlanner(state.artifact));
  status.className = "data-status ready"; status.textContent = "Static directed TrailPack graph loaded."; region.textContent = state.manifest.region_name; mapLabel.textContent = "TrailPack v1 loaded";
  for (const source of state.manifest.sources) { const item = document.createElement("li"); item.textContent = `${source.attribution} · ${source.licence}`; sources.append(item); }
}
void loadTrailPack().then(renderTrailPack);

async function invoke(name: string, input: Record<string, unknown>): Promise<void> {
  const tool = toolContracts.find((candidate) => candidate.name === name); if (!tool) return;
  try { await tool.execute(input, new AbortController().signal); } catch { /* The shared tool observer already records the failure. */ }
}
let selectedStart: StartId = "font_groga_parking";
const setDistance = (requestedKm: number): void => {
  const distanceKm = Math.min(30, Math.max(1, Math.round(requestedKm)));
  const distance = document.querySelector<HTMLInputElement>("#distance");
  const value = document.querySelector<HTMLOutputElement>("#distance-value");
  if (distance) distance.value = String(distanceKm);
  if (value) value.value = String(distanceKm);
  document.querySelectorAll<HTMLButtonElement>(".distance-step").forEach((button) => button.setAttribute("aria-pressed", String(Number(button.dataset.distance) === distanceKm)));
};
const setStart = (start: StartId): void => {
  selectedStart = start;
  document.querySelectorAll<HTMLButtonElement>(".start-option").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.start === start)));
};
const planInput = (): Record<string, unknown> => ({ start: selectedStart, target_km: Number(document.querySelector<HTMLInputElement>("#distance")?.value ?? 7), prefer_waymarked: document.querySelector<HTMLInputElement>("input[name=character]:checked")?.value === "waymarked" });
const applyPlainLanguageRequest = (): void => {
  const request = document.querySelector<HTMLInputElement>("#route-request")?.value.trim().toLocaleLowerCase() ?? "";
  const requestedDistance = request.match(/\b([1-9]|[12]\d|30)\s*(?:km|kilomet(?:re|er|ers|res)?s?)\b/i)?.[1];
  if (requestedDistance) setDistance(Number(requestedDistance));
  if (request.includes("vista rica")) setStart("vista_rica_parking");
  else if (request.includes("cresta") || request.includes("vallvidrera")) setStart("vallvidrera_crest_access");
  else if (request.includes("font groga") || request.includes("groga")) setStart("font_groga_parking");
  if (request.includes("neutral") || request.includes("any trail")) document.querySelector<HTMLInputElement>("input[name=character][value=neutral]")!.checked = true;
  const hint = document.querySelector<HTMLElement>("#route-request-hint");
  if (hint && request) hint.textContent = `Got it: ${documentedStarts[selectedStart].name}, ${document.querySelector<HTMLInputElement>("#distance")?.value} km.`;
};
document.querySelector<HTMLFormElement>("#plan-form")?.addEventListener("submit", (event) => { event.preventDefault(); applyPlainLanguageRequest(); void invoke("plan_route", planInput()); });
document.querySelector<HTMLInputElement>("#distance")?.addEventListener("input", (event) => setDistance(Number((event.currentTarget as HTMLInputElement).value)));
document.querySelectorAll<HTMLButtonElement>(".distance-step").forEach((button) => button.addEventListener("click", () => setDistance(Number(button.dataset.distance))));
document.querySelectorAll<HTMLButtonElement>(".start-option").forEach((button) => button.addEventListener("click", () => setStart(button.dataset.start as StartId)));
setPlanTargetRenderer(setDistance);
document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((button) => button.addEventListener("click", () => { const name = button.dataset.tool ?? ""; const inputs: Record<string, Record<string, unknown>> = { plan_route: planInput(), get_route_summary: {}, explain_segment: { segment_name: "" }, avoid_segment: { segment_name: "" }, describe_last_edit: {} }; void invoke(name, inputs[name] ?? {}); }));
document.querySelector<HTMLButtonElement>("#register")?.addEventListener("click", () => { void checkModelContext(); });
const agentTestPrompt = "Use the site tools on this Switchback page. Plan a 7 km loop from Font Groga car park, preferring official-match evidence. Then call get_route_summary and state the data limitations.";
document.querySelector<HTMLButtonElement>("#copy-agent-prompt")?.addEventListener("click", async () => {
  const status = document.querySelector<HTMLElement>("#copy-agent-prompt-status");
  try {
    await navigator.clipboard.writeText(agentTestPrompt);
    if (status) status.textContent = "Test prompt copied. Paste it into the same ChatGPT conversation after the page shows WebMCP connected.";
  } catch {
    if (status) status.textContent = `Copy unavailable. Use this prompt: ${agentTestPrompt}`;
  }
});

// Some agent browsers attach their model context after the document's first
// script turn. Retry once when the tab becomes active, without polling or
// changing a successfully registered tool set.
window.addEventListener("focus", () => { if (bridge.status === "unavailable") void checkModelContext(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && bridge.status === "unavailable") void checkModelContext(); });

type MapWaypoint = { latitude: number; longitude: number };
let stagedWaypoint: MapWaypoint | undefined;
let draggingWaypoint = false;

const mercatorY = (latitude: number): number => {
  const radians = Math.max(-85.05112878, Math.min(85.05112878, latitude)) * Math.PI / 180;
  return (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2;
};
const latitudeFromMercatorY = (value: number): number => Math.atan(Math.sinh(Math.PI * (1 - 2 * value))) * 180 / Math.PI;

const mapPointForEvent = (event: PointerEvent): MapWaypoint | undefined => {
  const panel = document.querySelector<HTMLElement>("#map-panel");
  if (!panel) return undefined;
  const rect = panel.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return undefined;
  const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
  const [west, south, east, north] = currentManifestBbox;
  return { latitude: latitudeFromMercatorY(mercatorY(north) + (y * (mercatorY(south) - mercatorY(north)))), longitude: west + (x * (east - west)) };
};
const setWaypointPosition = (latitude: number, longitude: number, announce: boolean): void => {
  stagedWaypoint = { latitude, longitude };
  const handle = document.querySelector<HTMLElement>("#waypoint-handle");
  const update = document.querySelector<HTMLElement>("#waypoint-update");
  const [west, south, east, north] = currentManifestBbox;
  const left = ((longitude - west) / (east - west)) * 100;
  const top = ((mercatorY(latitude) - mercatorY(north)) / (mercatorY(south) - mercatorY(north))) * 100;
  if (handle) { handle.style.left = `${Math.max(0, Math.min(100, left))}%`; handle.style.top = `${Math.max(0, Math.min(100, top))}%`; }
  if (announce && update) update.textContent = "Through-point repositioned. Press Enter to request a graph replan, or Escape to return to the active route.";
};
const applyWaypoint = async (): Promise<void> => {
  const handle = document.querySelector<HTMLButtonElement>("#waypoint-handle");
  const update = document.querySelector<HTMLElement>("#waypoint-update");
  if (!stagedWaypoint || !handle) return;
  handle.disabled = true;
  if (update) update.textContent = "Checking the through-point against the directed TrailPack graph…";
  try {
    const result = await commitWaypointEdit(stagedWaypoint, document.querySelector<HTMLInputElement>("input[name=character]:checked")?.value === "waymarked");
    addLog("manual_waypoint_edit", { waypoint: result.edit.waypoint }, { before: result.edit.before, after: result.edit.after, delta: result.edit.delta });
    if (update) update.textContent = `Route updated: ${result.edit.delta.distanceKm >= 0 ? "+" : ""}${result.edit.delta.distanceKm} km; ${result.edit.delta.officialMatchPercent >= 0 ? "+" : ""}${result.edit.delta.officialMatchPercent}% official-match coverage.`;
  } catch (error) {
    addLog("manual_waypoint_edit", { waypoint: stagedWaypoint }, null, error);
    const route = getActiveRoute();
    const midpoint = route?.coordinates[Math.floor(route.coordinates.length / 2)];
    if (midpoint) setWaypointPosition(midpoint[0], midpoint[1], false);
    if (update) update.textContent = `No route change: ${error instanceof Error ? error.message : String(error)}`;
  } finally { handle.disabled = false; }
};
const handle = document.querySelector<HTMLButtonElement>("#waypoint-handle");
handle?.addEventListener("pointerdown", (event) => { if (handle.disabled) return; draggingWaypoint = true; handle.setPointerCapture(event.pointerId); const point = mapPointForEvent(event); if (point) setWaypointPosition(point.latitude, point.longitude, false); event.preventDefault(); });
handle?.addEventListener("pointermove", (event) => { if (!draggingWaypoint) return; const point = mapPointForEvent(event); if (point) setWaypointPosition(point.latitude, point.longitude, false); });
handle?.addEventListener("pointerup", (event) => { if (!draggingWaypoint) return; draggingWaypoint = false; handle.releasePointerCapture(event.pointerId); void applyWaypoint(); });
handle?.addEventListener("keydown", (event) => {
  if (!stagedWaypoint || handle.disabled) return;
  const increment = event.shiftKey ? 0.001 : 0.0002;
  const next = { ...stagedWaypoint };
  if (event.key === "ArrowUp") next.latitude += increment;
  else if (event.key === "ArrowDown") next.latitude -= increment;
  else if (event.key === "ArrowLeft") next.longitude -= increment;
  else if (event.key === "ArrowRight") next.longitude += increment;
  else if (event.key === "Enter") { event.preventDefault(); void applyWaypoint(); return; }
  else if (event.key === "Escape") {
    const route = getActiveRoute();
    const midpoint = route?.coordinates[Math.floor(route.coordinates.length / 2)];
    if (midpoint) setWaypointPosition(midpoint[0], midpoint[1], false);
    const active = document.querySelector<HTMLElement>("#waypoint-update");
    if (active) active.textContent = "Through-point move cancelled. The active graph-planned route is unchanged.";
    return;
  }
  else return;
  event.preventDefault(); setWaypointPosition(next.latitude, next.longitude, true);
});
void checkModelContext();
