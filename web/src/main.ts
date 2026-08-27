import "./style.css";
import { documentedStarts, setRouteRenderer, setTrailPackProvenance, setTrailPlanner, toolContracts } from "./tools";
import { TrailPlanner, type PlannedRoute } from "./planner";
import { loadTrailPack, type TrailPackLoadState } from "./trailpack";
import { registerWebMcpTools, type BridgeStatus } from "./webmcp";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing application root.");
const bridge = { status: "unavailable" as BridgeStatus, count: 0 };
let logSequence = 0;

app.innerHTML = `
  <main class="shell">
    <header class="masthead"><a class="wordmark" href="/" aria-label="Switchback home">SWITCHBACK<span>↗</span></a><div class="status"><i class="status-dot ${bridge.status}" id="bridge-dot"></i><span id="bridge-label">Checking WebMCP…</span></div><button class="plain-button" id="register" type="button">Check model context</button></header>
    <section class="model-context-check" aria-labelledby="model-context-title"><div><p class="eyebrow" id="model-context-title">WebMCP status</p><p id="model-context-status" role="status" aria-live="polite">Checking this browser for an agent tool context…</p></div><p id="model-context-next">If tools are available, an agent on this page can discover them without a separate connection.</p></section>
    <section class="intro" aria-labelledby="intro-title"><p class="eyebrow">Trail intelligence, made inspectable</p><h1 id="intro-title">Ask for a loop.<br><em>See the ground truth.</em></h1><p class="lede">A WebMCP-native route planner for the places where a paper map still matters. TrailPack provenance is visible before a route is trusted.</p></section>
    <section class="workspace" aria-label="Route planning workspace">
      <aside class="planner"><div class="section-label"><span>01</span><p>Route brief</p></div>
        <form id="plan-form"><label for="start">Route start<select id="start" name="start">${Object.values(documentedStarts).map((start) => `<option value="${start.id}"${start.availability === "unavailable" ? " disabled" : " selected"}>${start.name}${start.availability === "unavailable" ? " — unavailable in v1" : ""}</option>`).join("")}</select></label><p class="field-hint" id="start-hint">GR-65.5 trail access is a verified on-trail coordinate, not a town or trailhead. Town starts remain visible until their access connectors are vetted.</p><label for="distance">Target distance <span class="field-value"><output id="distance-value">7.2</output> km</span><input id="distance" name="distance" type="range" min="2" max="30" step="0.1" value="7.2" /></label><fieldset><legend>Route character</legend><div class="choices"><label><input type="radio" name="character" value="waymarked" checked /> Waymarked</label><label><input type="radio" name="character" value="neutral" /> Neutral</label></div></fieldset><p class="field-hint">Elevation and grade constraints are not sent: this TrailPack has no elevation values and incomplete grade tags.</p><button class="plan-button" type="submit">Generate data-backed loop <span>↗</span></button></form>
        <section class="evidence" aria-labelledby="trailpack-title"><p class="eyebrow" id="trailpack-title">TrailPack data</p><p class="data-status loading" id="trailpack-status" role="status">Loading static graph…</p><strong id="trailpack-region">No graph loaded</strong><ul id="trailpack-sources" class="source-list" aria-label="TrailPack attributions"></ul></section>
      </aside>
    <section class="map-panel" aria-label="TrailPack route preview"><div class="map-grain"></div><div class="contours" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><svg class="route-line" viewBox="0 0 640 520" aria-hidden="true"><path id="route-path" d="" /></svg><span class="place place-one">Cornudella</span><span class="place place-two">Montsant</span><span class="place place-three">Siurana</span><div class="map-key"><span><i class="route-swatch"></i><span id="route-state">No route planned</span></span><span id="map-data-label">Data loading</span></div><article class="route-card" id="route-card" aria-live="polite"><p class="eyebrow" id="route-kicker">Waiting for graph</p><h2 id="route-name">Use the verified GR-65.5 access</h2><dl><div><dt>Distance</dt><dd id="route-distance">—</dd></div><div><dt>Climb</dt><dd id="route-ascent">Unknown</dd></div><div><dt>Moving time</dt><dd id="route-duration">—</dd></div></dl><p class="route-note" id="route-note">A loop is rendered only after the directed TrailPack graph has found one.</p></article></section>
    </section>
    <section class="tooling" aria-labelledby="tools-title"><div><p class="eyebrow">Agent surface</p><h2 id="tools-title">Five small tools.<br>One accountable route.</h2></div><div class="tool-list">${toolContracts.map((tool, index) => `<button class="tool" type="button" data-tool="${tool.name}"><span>0${index + 1}</span><strong>${tool.name.replaceAll("_", " ")}</strong><small>${tool.description}</small><b>Run ↗</b></button>`).join("")}</div></section>
    <section class="log-section" aria-labelledby="log-title"><div><p class="eyebrow">Tool invocation log</p><h2 id="log-title">Nothing hidden in the route.</h2></div><ol id="log" class="log"><li class="empty">Choose a route action to inspect its validated input and source-backed output.</li></ol></section>
  </main>`;

const log = document.querySelector<HTMLOListElement>("#log");
const bridgeCopy: Record<BridgeStatus, { label: string; next: string }> = {
  unavailable: { label: "Browser demo mode", next: "No browser model context was exposed. Open this page in a WebMCP-capable agent browser, then check again." },
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

function renderRoute(route: PlannedRoute): void {
  const state = document.querySelector<HTMLElement>("#route-state"); const path = document.querySelector<SVGPathElement>("#route-path");
  const name = document.querySelector<HTMLElement>("#route-name"); const distance = document.querySelector<HTMLElement>("#route-distance"); const duration = document.querySelector<HTMLElement>("#route-duration"); const kicker = document.querySelector<HTMLElement>("#route-kicker"); const note = document.querySelector<HTMLElement>("#route-note");
  if (state) state.textContent = "Directed TrailPack loop"; if (name) name.textContent = route.name; if (distance) distance.textContent = `${route.distanceKm} km`; if (duration) duration.textContent = `${route.durationHours} h`; if (kicker) kicker.textContent = "Graph-planned loop"; if (note) note.textContent = `${route.waymarkedPercent}% official-match coverage. Elevation unknown; verify current local conditions.`;
  const [west, south, east, north] = currentManifestBbox;
  const project = ([latitude, longitude]: [number, number]): [number, number] => [((longitude - west) / (east - west)) * 640, (1 - (latitude - south) / (north - south)) * 520];
  const points = route.coordinates.map(project);
  if (path && points.length > 1) path.setAttribute("d", points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" "));
}
let currentManifestBbox: [number, number, number, number] = [0.86, 41.23, 0.99, 41.34];
setRouteRenderer(renderRoute);

function renderTrailPack(state: TrailPackLoadState): void {
  const status = document.querySelector<HTMLElement>("#trailpack-status"); const region = document.querySelector<HTMLElement>("#trailpack-region"); const sources = document.querySelector<HTMLUListElement>("#trailpack-sources"); const mapLabel = document.querySelector<HTMLElement>("#map-data-label");
  if (!status || !region || !sources || !mapLabel || state.status === "loading") return;
  sources.replaceChildren();
  if (state.status === "unavailable") { status.className = "data-status unavailable"; status.textContent = `TrailPack unavailable — ${state.message}`; region.textContent = "No graph loaded"; mapLabel.textContent = "Graph unavailable"; return; }
  currentManifestBbox = state.manifest.bbox; setTrailPackProvenance(`${state.manifest.region_name} TrailPack`, state.manifest.sources.map((source) => source.attribution)); setTrailPlanner(new TrailPlanner(state.artifact));
  status.className = "data-status ready"; status.textContent = "Static directed TrailPack graph loaded."; region.textContent = state.manifest.region_name; mapLabel.textContent = "TrailPack v1 loaded";
  for (const source of state.manifest.sources) { const item = document.createElement("li"); item.textContent = `${source.attribution} · ${source.licence}`; sources.append(item); }
}
void loadTrailPack().then(renderTrailPack);

async function invoke(name: string, input: Record<string, unknown>): Promise<void> {
  const tool = toolContracts.find((candidate) => candidate.name === name); if (!tool) return;
  try { const result = await tool.execute(input, new AbortController().signal); addLog(name, input, result); } catch (error) { addLog(name, input, null, error); }
}
const planInput = (): Record<string, unknown> => ({ start: document.querySelector<HTMLSelectElement>("#start")?.value ?? "gr65_access", target_km: Number(document.querySelector<HTMLInputElement>("#distance")?.value ?? 7.2), prefer_waymarked: document.querySelector<HTMLInputElement>("input[name=character]:checked")?.value === "waymarked" });
document.querySelector<HTMLFormElement>("#plan-form")?.addEventListener("submit", (event) => { event.preventDefault(); void invoke("plan_route", planInput()); });
document.querySelector<HTMLInputElement>("#distance")?.addEventListener("input", (event) => { const output = document.querySelector<HTMLOutputElement>("#distance-value"); if (output) output.value = (event.currentTarget as HTMLInputElement).value; });
document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((button) => button.addEventListener("click", () => { const name = button.dataset.tool ?? ""; const inputs: Record<string, Record<string, unknown>> = { plan_route: planInput(), get_route_summary: {}, explain_segment: { segment_name: "" }, avoid_segment: { segment_name: "" }, describe_last_edit: {} }; void invoke(name, inputs[name] ?? {}); }));
document.querySelector<HTMLButtonElement>("#register")?.addEventListener("click", () => { void checkModelContext(); });
void checkModelContext();
