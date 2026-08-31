import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { documentedStarts, setGpxRenderer, setPlanTargetRenderer, setRouteRenderer, setToolInvocationObserver, setTrailPackProvenance, setTrailPlanner, toolContracts, type PreparedGpx } from "./tools";
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
        <form id="plan-form"><fieldset class="start-picker"><legend>Start</legend><div class="start-options" role="group" aria-label="Available parking starts">${Object.values(documentedStarts).map((start, index) => `<button class="start-option" type="button" data-start="${start.id}" aria-pressed="${index === 0}"><strong>${start.name}</strong><small>${start.description}</small></button>`).join("")}</div></fieldset><fieldset class="distance-picker"><div class="distance-heading"><legend>Distance</legend><output id="distance-value">7 km</output></div><div class="distance-control"><button id="distance-down" type="button" aria-label="Reduce distance by half a kilometre">−</button><input id="distance" name="distance" type="range" min="1" max="30" step="0.5" value="7" aria-describedby="distance-help" /><button id="distance-up" type="button" aria-label="Increase distance by half a kilometre">+</button></div><p class="field-hint" id="distance-help">We only keep loops within 0.5 km of your choice.</p></fieldset><button class="plan-button" type="submit">Generate my loop <span aria-hidden="true">↗</span></button><p class="field-hint">Trail-first routing from a parking start. You can download the GPX when it looks right.</p></form>
        <section class="evidence" aria-labelledby="trailpack-title"><p class="eyebrow" id="trailpack-title">TrailPack data</p><p class="data-status loading" id="trailpack-status" role="status">Loading static graph…</p><strong id="trailpack-region">No graph loaded</strong><ul id="trailpack-sources" class="source-list" aria-label="TrailPack attributions"></ul></section>
      </aside>
    <section class="map-panel" id="map-panel" aria-label="Interactive TrailPack route preview"><div class="map-stage"><div class="trail-map" id="trail-map" aria-label="Interactive trail map. Drag to pan, scroll or pinch to zoom."></div><div class="map-style-toggle" role="group" aria-label="Map style"><button type="button" data-map-style="terrain" aria-pressed="true">Terrain</button><button type="button" data-map-style="satellite" aria-pressed="false">Satellite</button></div><p class="map-description" id="map-description" role="status">Loading the interactive trail map.</p><div class="map-key"><span><i class="route-swatch"></i><span id="route-state">No route planned</span></span><span id="map-data-label">Data loading</span></div></div><article class="route-card" id="route-card" aria-live="polite"><p class="eyebrow" id="route-kicker">Choose a car park</p><h2 id="route-name">Your circuit will appear here</h2><dl><div><dt>Distance</dt><dd id="route-distance">—</dd></div><div><dt>Climb</dt><dd id="route-ascent">Unknown</dd></div><div><dt>Moving time</dt><dd id="route-duration">—</dd></div></dl><p class="route-note" id="route-note">Pick a car park and distance, then we will draw a real trail circuit.</p><section class="gpx-export" id="gpx-export" hidden aria-labelledby="gpx-status"><p id="gpx-status" role="status">No GPX prepared.</p><a id="gpx-download" download>Download GPX</a></section></article></section>
    </section>
    <section class="tooling" aria-labelledby="tools-title"><div><p class="eyebrow">Agent surface</p><h2 id="tools-title">Six small tools.<br>One accountable route.</h2></div><div class="tool-list">${toolContracts.map((tool, index) => `<button class="tool" type="button" data-tool="${tool.name}"><span>0${index + 1}</span><strong>${tool.name.replaceAll("_", " ")}</strong><small>${tool.description}</small><b>Run ↗</b></button>`).join("")}</div></section>
    <section class="log-section" aria-labelledby="log-title"><div><p class="eyebrow">Tool invocation log</p><h2 id="log-title">Nothing hidden in the route.</h2></div><ol id="log" class="log"><li class="empty">Choose a route action to inspect its validated input and source-backed output.</li></ol></section>
  </main>`;

const log = document.querySelector<HTMLOListElement>("#log");
const trailMapElement = document.querySelector<HTMLElement>("#trail-map");
const mapDescription = document.querySelector<HTMLElement>("#map-description");
const trailMap = trailMapElement && mapDescription ? new TrailMap(trailMapElement, mapDescription) : undefined;
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
}
setRouteRenderer(renderRoute);

function renderTrailPack(state: TrailPackLoadState): void {
  const status = document.querySelector<HTMLElement>("#trailpack-status"); const region = document.querySelector<HTMLElement>("#trailpack-region"); const sources = document.querySelector<HTMLUListElement>("#trailpack-sources"); const mapLabel = document.querySelector<HTMLElement>("#map-data-label");
  if (!status || !region || !sources || !mapLabel || state.status === "loading") return;
  sources.replaceChildren();
  if (state.status === "unavailable") { status.className = "data-status unavailable"; status.textContent = `TrailPack unavailable — ${state.message}`; region.textContent = "No graph loaded"; mapLabel.textContent = "Graph unavailable"; return; }
  trailMap?.setTrailPack(state.artifact); setTrailPackProvenance(`${state.manifest.region_name} TrailPack`, state.manifest.sources.map((source) => source.attribution)); setTrailPlanner(new TrailPlanner(state.artifact));
  status.className = "data-status ready"; status.textContent = "Static directed TrailPack graph loaded."; region.textContent = state.manifest.region_name; mapLabel.textContent = "TrailPack v1 loaded";
  for (const source of state.manifest.sources) { const item = document.createElement("li"); item.textContent = `${source.attribution} · ${source.licence}`; sources.append(item); }
}
void loadTrailPack().then(renderTrailPack);

async function invoke(name: string, input: Record<string, unknown>): Promise<void> {
  const tool = toolContracts.find((candidate) => candidate.name === name); if (!tool) return;
  try { await tool.execute(input, new AbortController().signal); } catch { /* The shared tool observer already records the failure. */ }
}
let selectedStart: StartId = "vista_rica_parking";
const setDistance = (requestedKm: number): void => {
  const distanceKm = Math.min(30, Math.max(1, Math.round(requestedKm * 2) / 2));
  const distance = document.querySelector<HTMLInputElement>("#distance");
  const value = document.querySelector<HTMLOutputElement>("#distance-value");
  if (distance) distance.value = String(distanceKm);
  if (value) value.value = `${distanceKm} km`;
};
const setStart = (start: StartId): void => {
  selectedStart = start;
  document.querySelectorAll<HTMLButtonElement>(".start-option").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.start === start)));
};
const planInput = (): Record<string, unknown> => ({ start: selectedStart, target_km: Number(document.querySelector<HTMLInputElement>("#distance")?.value ?? 7), prefer_waymarked: true });
document.querySelector<HTMLFormElement>("#plan-form")?.addEventListener("submit", (event) => { event.preventDefault(); void invoke("plan_route", planInput()); });
document.querySelector<HTMLInputElement>("#distance")?.addEventListener("input", (event) => setDistance(Number((event.currentTarget as HTMLInputElement).value)));
document.querySelector<HTMLButtonElement>("#distance-down")?.addEventListener("click", () => setDistance(Number(document.querySelector<HTMLInputElement>("#distance")?.value ?? 7) - 0.5));
document.querySelector<HTMLButtonElement>("#distance-up")?.addEventListener("click", () => setDistance(Number(document.querySelector<HTMLInputElement>("#distance")?.value ?? 7) + 0.5));
document.querySelectorAll<HTMLButtonElement>(".start-option").forEach((button) => button.addEventListener("click", () => setStart(button.dataset.start as StartId)));
document.querySelectorAll<HTMLButtonElement>("[data-map-style]").forEach((button) => {
  const style = button.dataset.mapStyle as "terrain" | "satellite";
  if (style === "satellite" && !trailMap?.supportsSatellite) {
    button.disabled = true;
    button.title = "Add the scoped Amazon Location key to enable satellite.";
  }
  button.addEventListener("click", () => {
    trailMap?.setStyle(style);
    document.querySelectorAll<HTMLButtonElement>("[data-map-style]").forEach((candidate) => candidate.setAttribute("aria-pressed", String(candidate === button)));
  });
});
setPlanTargetRenderer(setDistance);
document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((button) => button.addEventListener("click", () => { const name = button.dataset.tool ?? ""; const inputs: Record<string, Record<string, unknown>> = { plan_route: planInput(), get_route_summary: {}, explain_segment: { segment_name: "" }, avoid_segment: { segment_name: "" }, describe_last_edit: {} }; void invoke(name, inputs[name] ?? {}); }));
document.querySelector<HTMLButtonElement>("#register")?.addEventListener("click", () => { void checkModelContext(); });
const agentTestPrompt = "Use the site tools on this Switchback page. Plan a 7 km loop from Vista Rica parking, preferring official-match evidence. Then call get_route_summary and state the data limitations.";
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
void checkModelContext();
