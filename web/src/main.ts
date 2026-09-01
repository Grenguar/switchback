import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { clearActiveRoute, documentedStarts, setGpxRenderer, setPlanTargetRenderer, setRouteRenderer, setToolInvocationObserver, setTrailPackProvenance, setTrailPlanner, toolContracts, type PreparedGpx } from "./tools";
import { TrailPlanner, circuitDistancesFor, circuitOptionsFor, type PlannedRoute, type StartId } from "./planner";
import { loadTrailPack, type TrailPackLoadState } from "./trailpack";
import { TrailMap } from "./trail-map";
import { registerWebMcpTools, type BridgeStatus } from "./webmcp";
import { estimateRouteAscent } from "./elevation";

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
        <form id="plan-form"><fieldset class="arrival-picker"><legend>Getting there</legend><div class="transport-options" role="group" aria-label="Arrival mode"><button class="transport-option" type="button" data-transport="car" aria-pressed="true">By car</button><button class="transport-option" type="button" data-transport="public_transport" aria-pressed="false">Public transport</button></div></fieldset><fieldset class="start-picker"><legend>Choose a start</legend><div class="start-options" role="group" aria-label="Verified circuit starts">${Object.values(documentedStarts).filter((start) => start.circuitStatus === "verified").map((start, index) => `<button class="start-option" type="button" data-start="${start.id}" data-transport="${start.transportMode}" aria-pressed="${index === 0}"><strong>${start.name}</strong><small>${start.description}</small></button>`).join("")}</div><p class="field-hint">Only starts with a graph-verified return circuit are shown.</p></fieldset><fieldset class="distance-picker"><div class="distance-heading"><legend>Choose a loop</legend><span class="distance-unit">verified profiles</span></div><input id="distance" name="distance" type="hidden" value="7" /><div class="circuit-options" id="circuit-options" role="group" aria-describedby="distance-help"></div><p class="field-hint" id="distance-help">Distance profiles describe outing length, not terrain difficulty.</p></fieldset><button class="plan-button" type="submit">Generate my loop <span aria-hidden="true">↗</span></button><p class="field-hint">Trail-first circuit planning. Prepare the GPX after the loop looks right.</p></form>
        <section class="evidence" aria-labelledby="trailpack-title"><p class="eyebrow" id="trailpack-title">TrailPack data</p><p class="data-status loading" id="trailpack-status" role="status">Loading static graph…</p><strong id="trailpack-region">No graph loaded</strong><ul id="trailpack-sources" class="source-list" aria-label="TrailPack attributions"></ul></section>
      </aside>
    <section class="map-panel" id="map-panel" aria-label="Interactive TrailPack route preview"><div class="map-stage"><div class="trail-map" id="trail-map" aria-label="Interactive terrain map. Drag to explore; use the zoom controls, scroll wheel, keyboard, or pinch to zoom. Click a start marker to select it, or click an official marked path to identify it."></div><p class="map-description" id="map-description" role="status">Loading the interactive terrain map.</p><div class="map-key"><span><i class="route-swatch"></i><span id="route-state">Choose a start</span></span><span class="official-network-key"><i class="network-swatch"></i>Official marked paths A–E</span><span id="map-data-label">Data loading</span></div></div><article class="route-card" id="route-card" aria-live="polite"><p class="eyebrow" id="route-kicker">Choose a start</p><h2 id="route-name">Your circuit will appear here</h2><dl><div><dt>Distance</dt><dd id="route-distance">—</dd></div><div><dt>Climb</dt><dd id="route-ascent">—</dd></div><div><dt>Moving time</dt><dd id="route-duration">—</dd></div></dl><p class="route-note" id="route-note">Choose a start and a verified loop length, then generate a real trail circuit.</p><button class="prepare-gpx" id="prepare-gpx" type="button" hidden>Prepare GPX download <span aria-hidden="true">↓</span></button><section class="gpx-export" id="gpx-export" hidden aria-labelledby="gpx-status"><p id="gpx-status" role="status">No GPX prepared.</p><a id="gpx-download" download>Download GPX</a></section><button class="change-start" id="change-start" type="button">Plan another route</button></article></section>
    </section>
    <section class="tooling" aria-labelledby="tools-title"><div><p class="eyebrow">Agent surface</p><h2 id="tools-title">Nine small tools.<br>One accountable route.</h2></div><div class="tool-list">${toolContracts.map((tool, index) => `<button class="tool" type="button" data-tool="${tool.name}"><span>${String(index + 1).padStart(2, "0")}</span><strong>${tool.name.replaceAll("_", " ")}</strong><small>${tool.description}</small><b>Run ↗</b></button>`).join("")}</div></section>
    <section class="log-section" aria-labelledby="log-title"><div><p class="eyebrow">Tool invocation log</p><h2 id="log-title">Nothing hidden in the route.</h2></div><ol id="log" class="log"><li class="empty">Choose a route action to inspect its validated input and source-backed output.</li></ol></section>
  </main>`;

const log = document.querySelector<HTMLOListElement>("#log");
const trailMapElement = document.querySelector<HTMLElement>("#trail-map");
const mapDescription = document.querySelector<HTMLElement>("#map-description");
const trailMap = trailMapElement && mapDescription ? new TrailMap(trailMapElement, mapDescription, (startId) => setStart(startId as StartId)) : undefined;
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

async function renderRoute(route: PlannedRoute): Promise<void> {
  clearPreparedGpx();
  const prepareGpx = document.querySelector<HTMLButtonElement>("#prepare-gpx");
  if (prepareGpx) prepareGpx.hidden = true;
  const state = document.querySelector<HTMLElement>("#route-state");
  const name = document.querySelector<HTMLElement>("#route-name"); const distance = document.querySelector<HTMLElement>("#route-distance"); const ascent = document.querySelector<HTMLElement>("#route-ascent"); const duration = document.querySelector<HTMLElement>("#route-duration"); const kicker = document.querySelector<HTMLElement>("#route-kicker"); const note = document.querySelector<HTMLElement>("#route-note");
  if (state) state.textContent = "Checking elevation…"; if (name) name.textContent = route.name; if (distance) distance.textContent = `${route.distanceKm} km`; if (ascent) ascent.textContent = "Estimating…"; if (duration) duration.textContent = `${route.durationHours} h`; if (kicker) kicker.textContent = "Circuit found"; if (note) note.textContent = "Drawing the verified circuit and sampling its terrain profile…";
  trailMap?.setRoute(route);
  route.ascentM = await estimateRouteAscent(route.coordinates);
  if (state) state.textContent = "Closed circuit"; if (ascent) ascent.textContent = route.ascentM === null ? "Unavailable" : `${route.ascentM} m`; if (kicker) kicker.textContent = "Ready to walk"; if (note) note.textContent = `Returns to your start · ${route.sharedAccessPercent}% shared access · ${route.waymarkedPercent}% marked paths · ${route.ascentM === null ? "elevation unavailable" : `${route.ascentM} m estimated climb (ICGC LiDAR)`}. Check local conditions before you go.`;
  if (prepareGpx) { prepareGpx.hidden = false; prepareGpx.disabled = false; prepareGpx.innerHTML = `Prepare GPX download <span aria-hidden="true">↓</span>`; }
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
type TransportMode = "car" | "public_transport";
let selectedTransport: TransportMode = "car";
let selectedStart: StartId = "vista_rica_parking";
const renderCircuitOptions = (): void => {
  const options = document.querySelector<HTMLElement>("#circuit-options");
  if (!options) return;
  const selectedKm = Number(document.querySelector<HTMLInputElement>("#distance")?.value ?? documentedStarts[selectedStart].recommendedKm);
  options.innerHTML = circuitOptionsFor(documentedStarts[selectedStart]).map((option) => `<button class="circuit-option ${option.profile}" type="button" data-distance="${option.targetKm}" aria-pressed="${option.targetKm === selectedKm}"><strong>${option.label}</strong><span>${option.detail}</span></button>`).join("");
  options.querySelectorAll<HTMLButtonElement>(".circuit-option").forEach((button) => button.addEventListener("click", () => setDistance(Number(button.dataset.distance))));
};
const renderRequestPreview = (): void => {
  const start = documentedStarts[selectedStart];
  const distanceKm = Number(document.querySelector<HTMLInputElement>("#distance")?.value ?? 7);
  clearPreparedGpx();
  const state = document.querySelector<HTMLElement>("#route-state");
  const name = document.querySelector<HTMLElement>("#route-name");
  const distance = document.querySelector<HTMLElement>("#route-distance");
  const duration = document.querySelector<HTMLElement>("#route-duration");
  const kicker = document.querySelector<HTMLElement>("#route-kicker");
  const note = document.querySelector<HTMLElement>("#route-note");
  const help = document.querySelector<HTMLElement>("#distance-help");
  if (state) state.textContent = `${distanceKm} km ready to generate`;
  if (name) name.textContent = `${start.name}: ${distanceKm} km loop`;
  if (distance) distance.textContent = `${distanceKm} km`;
  if (duration) duration.textContent = "—";
  if (kicker) kicker.textContent = start.transportMode === "car" ? "Car park selected" : "Public transport start";
  if (note) note.textContent = `Generate to draw a circuit from ${start.name}. It must return to this start without a long retraced leg.`;
  if (help) help.textContent = `Verified loop lengths here: ${circuitDistancesFor(start).join(", ")} km.`;
  const prepareGpx = document.querySelector<HTMLButtonElement>("#prepare-gpx");
  if (prepareGpx) prepareGpx.hidden = true;
  document.querySelectorAll<HTMLButtonElement>(".circuit-option").forEach((button) => button.setAttribute("aria-pressed", String(Number(button.dataset.distance) === distanceKm)));
  trailMap?.clearRoute();
};
const setDistance = (requestedKm: number): void => {
  const available = circuitDistancesFor(documentedStarts[selectedStart]);
  const distanceKm = available.reduce((closest, candidate) => Math.abs(candidate - requestedKm) < Math.abs(closest - requestedKm) ? candidate : closest, available[0]!);
  const distance = document.querySelector<HTMLInputElement>("#distance");
  if (distance) distance.value = String(distanceKm);
  renderRequestPreview();
};
const setStart = (start: StartId): void => {
  if (start === selectedStart) return;
  if (documentedStarts[start].circuitStatus !== "verified") return;
  selectedStart = start;
  clearActiveRoute();
  document.querySelectorAll<HTMLButtonElement>(".start-option").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.start === start)));
  const distance = document.querySelector<HTMLInputElement>("#distance");
  if (distance) distance.value = String(documentedStarts[start].recommendedKm);
  renderCircuitOptions();
  renderRequestPreview();
  trailMap?.previewStart(documentedStarts[start]);
  trailMap?.setSelectableStarts(Object.values(documentedStarts).filter((candidate) => candidate.transportMode === selectedTransport && candidate.circuitStatus === "verified"), documentedStarts[start]);
};
const setTransport = (mode: TransportMode): void => {
  selectedTransport = mode;
  document.querySelectorAll<HTMLButtonElement>(".transport-option").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.transport === mode)));
  document.querySelectorAll<HTMLButtonElement>(".start-option").forEach((button) => { button.hidden = button.dataset.transport !== mode; });
  if (documentedStarts[selectedStart].transportMode !== mode) {
    const next = (Object.values(documentedStarts).find((start) => start.transportMode === mode && start.circuitStatus === "verified"));
    if (next) setStart(next.id as StartId);
  }
  trailMap?.setSelectableStarts(Object.values(documentedStarts).filter((start) => start.transportMode === mode && start.circuitStatus === "verified"), documentedStarts[selectedStart]);
};
const planInput = (): Record<string, unknown> => ({ start: selectedStart, arrival_mode: selectedTransport, target_km: Number(document.querySelector<HTMLInputElement>("#distance")?.value ?? 7), prefer_waymarked: true });
document.querySelector<HTMLFormElement>("#plan-form")?.addEventListener("submit", (event) => { event.preventDefault(); void invoke("plan_route", planInput()); });
document.querySelectorAll<HTMLButtonElement>(".start-option").forEach((button) => button.addEventListener("click", () => setStart(button.dataset.start as StartId)));
document.querySelectorAll<HTMLButtonElement>(".transport-option").forEach((button) => button.addEventListener("click", () => setTransport(button.dataset.transport as TransportMode)));
document.querySelector<HTMLButtonElement>("#change-start")?.addEventListener("click", () => {
  clearActiveRoute();
  clearPreparedGpx();
  renderRequestPreview();
  trailMap?.previewStart(documentedStarts[selectedStart]);
  document.querySelector<HTMLElement>(".planner")?.scrollIntoView({ behavior: "smooth", block: "start" });
});
document.querySelector<HTMLButtonElement>("#prepare-gpx")?.addEventListener("click", async () => {
  const button = document.querySelector<HTMLButtonElement>("#prepare-gpx");
  if (button) { button.disabled = true; button.textContent = "Preparing GPX…"; }
  await invoke("prepare_gpx", {});
  if (button) { button.disabled = false; button.textContent = "GPX prepared"; }
});
setTransport(selectedTransport);
renderCircuitOptions();
renderRequestPreview();
trailMap?.previewStart(documentedStarts[selectedStart]);
setPlanTargetRenderer(setDistance);
document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((button) => button.addEventListener("click", () => { const name = button.dataset.tool ?? ""; const inputs: Record<string, Record<string, unknown>> = { list_circuit_options: {}, validate_circuit: planInput(), record_session_note: { kind: "test", note: "In-page test recorded from the Switchback tool surface." }, plan_route: planInput(), get_route_summary: {}, explain_segment: { segment_name: "" }, avoid_segment: { segment_name: "" }, describe_last_edit: {} }; void invoke(name, inputs[name] ?? {}); }));
document.querySelector<HTMLButtonElement>("#register")?.addEventListener("click", () => { void checkModelContext(); });
const agentTestPrompt = "Use the site tools on this Switchback page. First call list_circuit_options, choose one returned easy, medium, or hard distance profile, then call validate_circuit for that start and target. Record the result with record_session_note. Finally use plan_route for that same option, call get_route_summary, and tell the user the verified distance, closure, and ICGC elevation estimate.";
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
