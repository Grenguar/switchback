import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { clearActiveRoute, documentedStarts, setGpxRenderer, setParkAlertsRenderer, setParkAlertsUnavailableRenderer, setPlanTargetRenderer, setRouteBriefingRenderer, setRouteRenderer, setToolInvocationObserver, setTrailPackProvenance, setTrailPlanner, setTrailWeatherRenderer, setTrailWeatherUnavailableRenderer, toolContracts, type PreparedGpx, type PreparedRouteBriefing } from "./tools";
import type { TrailWeather, WeatherWindow } from "./weather";
import type { ParkAlerts } from "./park-alerts";
import { TrailPlanner, circuitDistancesFor, circuitOptionsFor, type PlannedRoute, type StartId } from "./planner";
import { loadTrailPack, type TrailPackLoadState } from "./trailpack";
import { TrailMap } from "./trail-map";
import { registerWebMcpTools, type BridgeStatus } from "./webmcp";
import { estimateRouteAscent } from "./elevation";
import { assessRouteDifficulty } from "./difficulty";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing application root.");
const bridge = { status: "unavailable" as BridgeStatus, count: 0 };
let logSequence = 0;

app.innerHTML = `
  <main class="shell">
    <header class="masthead"><a class="wordmark" href="/" aria-label="Switchback home">SWITCHBACK<span>↗</span></a><div class="status"><i class="status-dot ${bridge.status}" id="bridge-dot"></i><span id="bridge-label">Checking WebMCP…</span></div><button class="plain-button" id="register" type="button">Check model context</button></header>
    <section class="model-context-check" aria-labelledby="model-context-title"><div><p class="eyebrow" id="model-context-title">WebMCP status</p><p id="model-context-status" role="status" aria-live="polite">Checking this browser for an agent tool context…</p></div><div><p id="model-context-next">If tools are available, an agent on this page can discover them without a separate connection.</p><button class="context-help" id="copy-agent-prompt" type="button">Copy agent test prompt</button><p class="context-help-status" id="copy-agent-prompt-status" role="status" aria-live="polite"></p></div></section>
    <section class="agent-activity" aria-labelledby="agent-activity-title"><div class="agent-activity-lead"><p class="eyebrow">Shared trail ledger</p><h2 id="agent-activity-title">Nothing happens off-map.</h2><p id="agent-activity-status" role="status" aria-live="polite" aria-atomic="true">Waiting for an agent action. You can also run the same actions yourself.</p></div><div class="agent-current" id="agent-current" data-state="idle"><i aria-hidden="true"></i><div><p id="agent-current-kicker">Ready</p><strong id="agent-current-action">The next route decision will appear here.</strong></div></div><ol class="agent-activity-feed" id="agent-activity-feed" aria-label="Recent agent and page actions"><li class="empty">No action has run in this tab yet.</li></ol></section>
    <section class="intro" aria-labelledby="intro-title"><p class="eyebrow">Trail intelligence, made inspectable</p><h1 id="intro-title">Ask for a loop.<br><em>See the ground truth.</em></h1><p class="lede">A WebMCP-native route planner for the places where a paper map still matters. TrailPack provenance is visible before a route is trusted.</p></section>
    <section class="workspace" aria-label="Route planning workspace">
      <aside class="planner"><div class="section-label"><span>01</span><p>Plan a walk</p></div>
        <form id="plan-form"><fieldset class="arrival-picker"><legend>Getting there</legend><div class="transport-options" role="group" aria-label="Arrival mode"><button class="transport-option" type="button" data-transport="car" aria-pressed="true">By car</button><button class="transport-option" type="button" data-transport="public_transport" aria-pressed="false">Public transport</button></div></fieldset><fieldset class="start-picker"><legend>Choose a start</legend><div class="start-options" role="group" aria-label="Verified circuit starts">${Object.values(documentedStarts).filter((start) => start.circuitStatus === "verified").map((start, index) => `<button class="start-option" type="button" data-start="${start.id}" data-transport="${start.transportMode}" aria-pressed="${index === 0}"><strong>${start.name}</strong><small>${start.description}</small></button>`).join("")}</div><p class="field-hint">Only starts with a graph-verified return circuit are shown.</p></fieldset><fieldset class="distance-picker"><div class="distance-heading"><legend>Choose a loop</legend><span class="distance-unit">verified profiles</span></div><input id="distance" name="distance" type="hidden" value="7" /><div class="circuit-options" id="circuit-options" role="group" aria-describedby="distance-help"></div><p class="field-hint" id="distance-help">Distance profiles describe outing length, not terrain difficulty.</p></fieldset><button class="plan-button" type="submit">Generate my loop <span aria-hidden="true">↗</span></button><p class="field-hint">Trail-first circuit planning. Prepare the GPX after the loop looks right.</p></form>
        <section class="evidence" aria-labelledby="trailpack-title"><p class="eyebrow" id="trailpack-title">TrailPack data</p><p class="data-status loading" id="trailpack-status" role="status">Loading static graph…</p><strong id="trailpack-region">No graph loaded</strong><ul id="trailpack-sources" class="source-list" aria-label="TrailPack attributions"></ul></section>
      </aside>
    <section class="map-panel" id="map-panel" aria-label="Interactive TrailPack route preview"><div class="map-stage"><div class="trail-map" id="trail-map" aria-label="Interactive terrain map. Drag to explore; use the zoom controls, scroll wheel, keyboard, or pinch to zoom. Click a start marker to select it, or click an official marked path to identify it."></div><p class="map-description" id="map-description" role="status">Loading the interactive terrain map.</p><div class="map-key"><span><i class="route-swatch"></i><span id="route-state">Choose a start</span></span><span class="official-network-key"><i class="network-swatch"></i>Official marked paths A–E</span><span id="map-data-label">Data loading</span></div></div><article class="route-card" id="route-card" aria-live="polite"><p class="eyebrow" id="route-kicker">Choose a start</p><h2 id="route-name">Your circuit will appear here</h2><dl><div><dt>Distance</dt><dd id="route-distance">—</dd></div><div><dt>Climb</dt><dd id="route-ascent">—</dd></div><div><dt>Moving time</dt><dd id="route-duration">—</dd></div></dl><p class="route-note" id="route-note">Choose a start and a verified loop length, then generate a real trail circuit.</p><button class="prepare-gpx" id="prepare-gpx" type="button" hidden>Prepare GPX download <span aria-hidden="true">↓</span></button><button class="check-alerts" id="check-alerts" type="button" hidden>Check official Park alerts <span aria-hidden="true">↗</span></button><button class="check-weather" id="check-weather" type="button" hidden>Check next 3 days <span aria-hidden="true">↗</span></button><button class="prepare-briefing" id="prepare-briefing" type="button" hidden>Prepare family / friends briefing <span aria-hidden="true">↗</span></button><section class="park-alerts" id="park-alerts" hidden aria-labelledby="park-alerts-title"><p class="eyebrow" id="park-alerts-title">Official Park alerts</p><ul id="park-alerts-list"></ul><a class="park-alerts-source" id="park-alerts-source" target="_blank" rel="noreferrer">View all official alerts</a><p class="park-alerts-status" id="park-alerts-status" role="status" aria-live="polite"></p></section><section class="route-weather" id="route-weather" hidden aria-labelledby="weather-title"><p class="eyebrow" id="weather-title">Forecast planning context</p><p id="weather-best"></p><ul id="weather-days"></ul><p class="weather-status" id="weather-status" role="status" aria-live="polite"></p></section><section class="gpx-export" id="gpx-export" hidden aria-labelledby="gpx-status"><p id="gpx-status" role="status">No GPX prepared.</p><a id="gpx-download" download>Download GPX</a></section><section class="route-briefing" id="route-briefing" hidden aria-labelledby="briefing-title"><p class="eyebrow" id="briefing-title">Share with family or friends</p><pre id="route-briefing-text"></pre><button class="copy-briefing" id="copy-briefing" type="button">Copy briefing</button><p class="briefing-status" id="briefing-status" role="status" aria-live="polite"></p></section><button class="change-start" id="change-start" type="button">Plan another route</button></article></section>
    </section>
    <section class="tooling" aria-labelledby="tools-title"><div><p class="eyebrow">Agent surface</p><h2 id="tools-title">Thirteen small tools.<br>One accountable route.</h2></div><div class="tool-list">${toolContracts.map((tool, index) => `<button class="tool" type="button" data-tool="${tool.name}"><span>${String(index + 1).padStart(2, "0")}</span><strong>${tool.name.replaceAll("_", " ")}</strong><small>${tool.description}</small><b>Run ↗</b></button>`).join("")}</div></section>
    <section class="log-section" aria-labelledby="log-title"><div><p class="eyebrow">Tool invocation log</p><h2 id="log-title">Nothing hidden in the route.</h2></div><ol id="log" class="log"><li class="empty">Choose a route action to inspect its validated input and source-backed output.</li></ol></section>
  </main>`;

const log = document.querySelector<HTMLOListElement>("#log");
const activityFeed = document.querySelector<HTMLOListElement>("#agent-activity-feed");
const trailMapElement = document.querySelector<HTMLElement>("#trail-map");
const mapDescription = document.querySelector<HTMLElement>("#map-description");
const trailMap = trailMapElement && mapDescription ? new TrailMap(trailMapElement, mapDescription, (startId) => setStart(startId as StartId)) : undefined;
let preparedGpxUrl: string | undefined;
let routeBriefingText = "";
let localInvocationDepth = 0;
let activitySequence = 0;
const actionLabel: Record<string, string> = {
  list_circuit_options: "Listing verified loop options", validate_circuit: "Checking a circuit before drawing it", record_session_note: "Writing a visible session note", plan_route: "Planning and drawing the loop", get_route_summary: "Reading the active route", explain_difficulty: "Reviewing route difficulty evidence", explain_segment: "Inspecting a trail segment", avoid_segment: "Replanning around a segment", prepare_gpx: "Preparing the GPX handoff", get_trail_weather: "Comparing the next three forecast days", get_park_alerts: "Checking official Park alerts", prepare_route_briefing: "Preparing the group briefing", describe_last_edit: "Reviewing the latest map edit", webmcp_registration: "Checking the WebMCP connection",
};
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
const clearRouteBriefing = (): void => {
  routeBriefingText = "";
  const briefing = document.querySelector<HTMLElement>("#route-briefing");
  const text = document.querySelector<HTMLElement>("#route-briefing-text");
  const status = document.querySelector<HTMLElement>("#briefing-status");
  if (briefing) briefing.hidden = true;
  if (text) text.textContent = "";
  if (status) status.textContent = "";
};
const forecastText = (window: WeatherWindow): string => `${window.date} · ${window.start}–${window.end} · ${window.summary} · ${window.temperatureC}°C · ${window.precipitationProbability}% rain · gusts ${window.gustKph} km/h`;
const clearTrailWeather = (): void => {
  const panel = document.querySelector<HTMLElement>("#route-weather");
  const best = document.querySelector<HTMLElement>("#weather-best");
  const days = document.querySelector<HTMLUListElement>("#weather-days");
  const status = document.querySelector<HTMLElement>("#weather-status");
  if (panel) panel.hidden = true;
  if (best) best.textContent = "";
  if (days) days.replaceChildren();
  if (status) status.textContent = "";
};
const renderTrailWeather = (forecast: TrailWeather): void => {
  const panel = document.querySelector<HTMLElement>("#route-weather");
  const best = document.querySelector<HTMLElement>("#weather-best");
  const days = document.querySelector<HTMLUListElement>("#weather-days");
  const status = document.querySelector<HTMLElement>("#weather-status");
  const bestByDay = new Map<string, WeatherWindow>();
  for (const window of forecast.windows) {
    const current = bestByDay.get(window.date);
    if (!current || window.score < current.score) bestByDay.set(window.date, window);
  }
  if (best) best.textContent = `Least-exposed forecast window: ${forecastText(forecast.bestWindow)} (${forecast.timezone}).`;
  if (days) {
    days.replaceChildren(...[...bestByDay.values()].sort((left, right) => left.date.localeCompare(right.date)).map((window) => {
      const item = document.createElement("li"); item.textContent = forecastText(window); return item;
    }));
  }
  if (status) status.textContent = "Forecast is planning context only; check official alerts, closures, and local conditions.";
  if (panel) panel.hidden = false;
};
const renderTrailWeatherUnavailable = (reason: string): void => {
  const panel = document.querySelector<HTMLElement>("#route-weather");
  const best = document.querySelector<HTMLElement>("#weather-best");
  const days = document.querySelector<HTMLUListElement>("#weather-days");
  const status = document.querySelector<HTMLElement>("#weather-status");
  if (best) best.textContent = "Forecast unavailable";
  if (days) days.replaceChildren();
  if (status) status.textContent = `Based on TrailPack route evidence only. ${reason} Check a local weather source before departure.`;
  if (panel) panel.hidden = false;
};
const renderParkAlerts = (alerts: ParkAlerts): void => {
  const panel = document.querySelector<HTMLElement>("#park-alerts");
  const list = document.querySelector<HTMLUListElement>("#park-alerts-list");
  const source = document.querySelector<HTMLAnchorElement>("#park-alerts-source");
  const status = document.querySelector<HTMLElement>("#park-alerts-status");
  if (list) {
    list.replaceChildren(...alerts.alerts.slice(0, 3).map((alert) => {
      const item = document.createElement("li"); const link = document.createElement("a"); const date = document.createElement("span"); const excerpt = document.createElement("p");
      link.href = alert.url; link.target = "_blank"; link.rel = "noreferrer"; link.textContent = alert.title;
      date.textContent = alert.published; excerpt.textContent = alert.excerpt;
      item.append(link, date, excerpt);
      if (alert.translation) {
        const translation = document.createElement("div"); const label = document.createElement("strong"); const translatedTitle = document.createElement("p"); const translatedExcerpt = document.createElement("p");
        translation.className = "park-alert-translation"; label.textContent = "English machine translation"; translatedTitle.textContent = alert.translation.title; translatedExcerpt.textContent = alert.translation.excerpt;
        translation.append(label, translatedTitle, translatedExcerpt); item.append(translation);
      }
      return item;
    }));
  }
  if (source) { source.href = alerts.sourceUrl; source.hidden = false; }
  if (status) status.textContent = alerts.alerts.length === 0 ? `No notices were listed in the active Park alert section. ${alerts.caution}` : `Showing the latest ${Math.min(alerts.alerts.length, 3)} of ${alerts.alerts.length} active notices. ${alerts.caution}`;
  if (panel) panel.hidden = false;
};
const renderParkAlertsUnavailable = (reason: string): void => {
  const panel = document.querySelector<HTMLElement>("#park-alerts");
  const list = document.querySelector<HTMLUListElement>("#park-alerts-list");
  const source = document.querySelector<HTMLAnchorElement>("#park-alerts-source");
  const status = document.querySelector<HTMLElement>("#park-alerts-status");
  if (list) list.replaceChildren();
  if (source) { source.href = "https://parcnaturalcollserola.cat/actualitat/avisos/"; source.hidden = false; }
  if (status) status.textContent = `Official alerts unavailable. Based on TrailPack route evidence only; it does not confirm current Park restrictions. ${reason}`;
  if (panel) panel.hidden = false;
};
const renderRouteBriefing = (briefing: PreparedRouteBriefing): void => {
  routeBriefingText = briefing.text;
  const panel = document.querySelector<HTMLElement>("#route-briefing");
  const text = document.querySelector<HTMLElement>("#route-briefing-text");
  const status = document.querySelector<HTMLElement>("#briefing-status");
  if (text) text.textContent = briefing.text;
  if (status) status.textContent = "Review the briefing, then copy it for your group. No message has been sent.";
  if (panel) panel.hidden = false;
};
setGpxRenderer(renderPreparedGpx);
setRouteBriefingRenderer(renderRouteBriefing);
setTrailWeatherRenderer(renderTrailWeather);
setTrailWeatherUnavailableRenderer(renderTrailWeatherUnavailable);
setParkAlertsRenderer(renderParkAlerts);
setParkAlertsUnavailableRenderer(renderParkAlertsUnavailable);
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
  localInvocationDepth += 1;
  renderActivity("webmcp_registration", undefined, "started");
  try {
    const result = await registerWebMcpTools(true);
    renderBridgeStatus(result);
    const error = result.status === "failed" ? result.message : undefined;
    renderActivity("webmcp_registration", error, error ? "failed" : "succeeded");
    addLog("webmcp_registration", { requested: true }, result, error);
  } finally {
    localInvocationDepth -= 1;
    if (button) button.disabled = false;
  }
}
const addLog = (name: string, input: unknown, result: unknown, error?: unknown): void => {
  if (!log) return; log.querySelector(".empty")?.remove();
  const item = document.createElement("li"); const sequence = document.createElement("span"); sequence.textContent = String(++logSequence).padStart(2, "0");
  const details = document.createElement("div"); const heading = document.createElement("strong"); heading.textContent = name; const output = document.createElement("code"); output.textContent = error ? `Error: ${error instanceof Error ? error.message : String(error)}` : JSON.stringify({ input, result }); details.append(heading, output); item.append(sequence, details); log.prepend(item);
};
const renderActivity = (name: string, error: unknown | undefined, phase: "started" | "succeeded" | "failed"): void => {
  const current = document.querySelector<HTMLElement>("#agent-current");
  const kicker = document.querySelector<HTMLElement>("#agent-current-kicker");
  const action = document.querySelector<HTMLElement>("#agent-current-action");
  const status = document.querySelector<HTMLElement>("#agent-activity-status");
  const origin = localInvocationDepth > 0 ? "Your action" : "Agent action";
  const label = actionLabel[name] ?? name.replaceAll("_", " ");
  document.querySelectorAll<HTMLElement>(`.tool[data-tool="${name}"]`).forEach((tool) => tool.classList.toggle("is-active", phase === "started"));
  if (phase === "started") {
    activityFeed?.querySelector(".empty")?.remove();
    const item = document.createElement("li");
    const marker = document.createElement("i"); marker.setAttribute("aria-hidden", "true");
    const details = document.createElement("div"); const title = document.createElement("strong"); const caption = document.createElement("span");
    title.textContent = label; caption.textContent = `${origin} · running`;
    details.append(title, caption); item.append(marker, details); item.id = `agent-activity-${++activitySequence}`; item.dataset.tool = name; item.dataset.state = "running";
    activityFeed?.prepend(item);
    while ((activityFeed?.children.length ?? 0) > 4) activityFeed?.lastElementChild?.remove();
    if (current) current.dataset.state = "running";
    if (kicker) kicker.textContent = `${origin} in progress`;
    if (action) action.textContent = label;
    if (status) status.textContent = `${origin} is ${label.toLowerCase()}.`;
    return;
  }
  const matching = activityFeed?.querySelector<HTMLElement>(`li[data-tool="${name}"][data-state="running"]`);
  if (matching) {
    matching.dataset.state = phase === "succeeded" ? "complete" : "failed";
    const caption = matching.querySelector<HTMLElement>("span");
    if (caption) caption.textContent = `${origin} · ${phase === "succeeded" ? "complete" : "needs attention"}`;
  }
  if (current) current.dataset.state = phase === "succeeded" ? "complete" : "failed";
  if (kicker) kicker.textContent = phase === "succeeded" ? `${origin} complete` : `${origin} needs attention`;
  if (action) action.textContent = phase === "succeeded" ? label : error instanceof Error ? error.message : `Could not complete ${label.toLowerCase()}.`;
  if (status) status.textContent = phase === "succeeded" ? `${origin} completed: ${label.toLowerCase()}.` : `${origin} needs attention: ${error instanceof Error ? error.message : `could not complete ${label.toLowerCase()}`}.`;
};
// Browser-agent WebMCP calls and page button calls share this observer, so the
// visible audit trail does not depend on which surface initiated the action.
setToolInvocationObserver((name, input, result, error, phase) => {
  renderActivity(name, error, phase);
  if (phase !== "started") addLog(name, input, result, error);
});

async function renderRoute(route: PlannedRoute): Promise<void> {
  syncPlannerToRoute(route);
  clearPreparedGpx();
  clearRouteBriefing();
  clearTrailWeather();
  const prepareGpx = document.querySelector<HTMLButtonElement>("#prepare-gpx");
  const checkAlerts = document.querySelector<HTMLButtonElement>("#check-alerts");
  const checkWeather = document.querySelector<HTMLButtonElement>("#check-weather");
  const prepareBriefing = document.querySelector<HTMLButtonElement>("#prepare-briefing");
  if (prepareGpx) prepareGpx.hidden = true;
  if (checkAlerts) checkAlerts.hidden = true;
  if (checkWeather) checkWeather.hidden = true;
  if (prepareBriefing) prepareBriefing.hidden = true;
  const state = document.querySelector<HTMLElement>("#route-state");
  const name = document.querySelector<HTMLElement>("#route-name"); const distance = document.querySelector<HTMLElement>("#route-distance"); const ascent = document.querySelector<HTMLElement>("#route-ascent"); const duration = document.querySelector<HTMLElement>("#route-duration"); const kicker = document.querySelector<HTMLElement>("#route-kicker"); const note = document.querySelector<HTMLElement>("#route-note");
  if (state) state.textContent = "Checking elevation…"; if (name) name.textContent = route.name; if (distance) distance.textContent = `${route.distanceKm} km`; if (ascent) ascent.textContent = "Estimating…"; if (duration) duration.textContent = `${route.durationHours} h`; if (kicker) kicker.textContent = "Circuit found"; if (note) note.textContent = "Drawing the verified circuit and sampling its terrain profile…";
  trailMap?.setRoute(route);
  route.ascentM = await estimateRouteAscent(route.coordinates);
  const assessment = assessRouteDifficulty(route);
  if (state) state.textContent = "Closed circuit"; if (ascent) ascent.textContent = route.ascentM === null ? "Unavailable" : `${route.ascentM} m`; if (kicker) kicker.textContent = assessment.level === "unrated" ? "Difficulty unrated" : `${assessment.level[0]!.toUpperCase()}${assessment.level.slice(1)} route`; if (note) note.textContent = `${assessment.rationale} ${assessment.limitations}`;
  if (prepareGpx) { prepareGpx.hidden = false; prepareGpx.disabled = false; prepareGpx.innerHTML = `Prepare GPX download <span aria-hidden="true">↓</span>`; }
  if (checkAlerts) { checkAlerts.hidden = false; checkAlerts.disabled = false; checkAlerts.innerHTML = `Check official Park alerts <span aria-hidden="true">↗</span>`; }
  if (checkWeather) { checkWeather.hidden = false; checkWeather.disabled = false; checkWeather.innerHTML = `Check next 3 days <span aria-hidden="true">↗</span>`; }
  if (prepareBriefing) { prepareBriefing.hidden = false; prepareBriefing.disabled = false; prepareBriefing.innerHTML = `Prepare family briefing <span aria-hidden="true">↗</span>`; }
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
  localInvocationDepth += 1;
  try { await tool.execute(input, new AbortController().signal); } catch { /* The shared tool observer already records the failure. */ }
  finally { localInvocationDepth -= 1; }
}
type TransportMode = "car" | "public_transport";
let selectedTransport: TransportMode = "car";
let selectedStart: StartId = "vista_rica_parking";
function syncPlannerToRoute(route: PlannedRoute): void {
  selectedStart = route.start.id as StartId; selectedTransport = route.start.transportMode;
  const targets = circuitDistancesFor(route.start); const target = targets.reduce((closest, candidate) => Math.abs(candidate - route.distanceKm) < Math.abs(closest - route.distanceKm) ? candidate : closest, targets[0]!);
  const distance = document.querySelector<HTMLInputElement>("#distance"); if (distance) distance.value = String(target);
  document.querySelectorAll<HTMLButtonElement>(".transport-option").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.transport === selectedTransport)));
  document.querySelectorAll<HTMLButtonElement>(".start-option").forEach((button) => { button.hidden = button.dataset.transport !== selectedTransport; button.setAttribute("aria-pressed", String(button.dataset.start === selectedStart)); });
  renderCircuitOptions();
}
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
  clearRouteBriefing();
  clearTrailWeather();
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
  const checkAlerts = document.querySelector<HTMLButtonElement>("#check-alerts");
  const checkWeather = document.querySelector<HTMLButtonElement>("#check-weather");
  const prepareBriefing = document.querySelector<HTMLButtonElement>("#prepare-briefing");
  if (prepareGpx) prepareGpx.hidden = true;
  if (checkAlerts) checkAlerts.hidden = true;
  if (checkWeather) checkWeather.hidden = true;
  if (prepareBriefing) prepareBriefing.hidden = true;
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
  clearRouteBriefing();
  clearTrailWeather();
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
document.querySelector<HTMLButtonElement>("#check-alerts")?.addEventListener("click", async () => {
  const button = document.querySelector<HTMLButtonElement>("#check-alerts");
  if (button) { button.disabled = true; button.textContent = "Checking Park alerts…"; }
  await invoke("get_park_alerts", {});
  if (button) { button.disabled = false; button.textContent = "Park alerts status shown"; }
});
document.querySelector<HTMLButtonElement>("#check-weather")?.addEventListener("click", async () => {
  const button = document.querySelector<HTMLButtonElement>("#check-weather");
  if (button) { button.disabled = true; button.textContent = "Checking forecast…"; }
  await invoke("get_trail_weather", {});
  if (button) { button.disabled = false; button.textContent = "Forecast status shown"; }
});
document.querySelector<HTMLButtonElement>("#prepare-briefing")?.addEventListener("click", async () => {
  const button = document.querySelector<HTMLButtonElement>("#prepare-briefing");
  if (button) { button.disabled = true; button.textContent = "Preparing briefing…"; }
  await invoke("prepare_route_briefing", {});
  if (button) { button.disabled = false; button.textContent = "Briefing prepared"; }
});
document.querySelector<HTMLButtonElement>("#copy-briefing")?.addEventListener("click", async () => {
  const status = document.querySelector<HTMLElement>("#briefing-status");
  if (!routeBriefingText) return;
  try {
    await navigator.clipboard.writeText(routeBriefingText);
    if (status) status.textContent = "Briefing copied. Paste it into your group chat when you are ready.";
  } catch {
    const area = document.createElement("textarea");
    area.value = routeBriefingText;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    if (status) status.textContent = copied ? "Briefing copied. Paste it into your group chat when you are ready." : "Copy is unavailable here. Select the briefing text and copy it manually.";
  }
});
setTransport(selectedTransport);
renderCircuitOptions();
renderRequestPreview();
trailMap?.previewStart(documentedStarts[selectedStart]);
setPlanTargetRenderer(setDistance);
document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((button) => button.addEventListener("click", () => { const name = button.dataset.tool ?? ""; const inputs: Record<string, Record<string, unknown>> = { list_circuit_options: {}, validate_circuit: planInput(), record_session_note: { kind: "test", note: "In-page test recorded from the Switchback tool surface." }, plan_route: planInput(), get_route_summary: {}, explain_difficulty: {}, explain_segment: { segment_name: "" }, avoid_segment: { segment_name: "" }, get_trail_weather: {}, get_park_alerts: {}, prepare_route_briefing: {}, describe_last_edit: {} }; void invoke(name, inputs[name] ?? {}); }));
document.querySelector<HTMLButtonElement>("#register")?.addEventListener("click", () => { void checkModelContext(); });
const agentTestPrompt = "Use the site tools on this Switchback page. First call list_circuit_options and choose a returned short, medium, or long distance profile; these are not difficulty ratings. Call validate_circuit, then plan_route and get_route_summary. Call explain_difficulty, get_park_alerts, and get_trail_weather before recommending the route. If either external source is unavailable, state that the recommendation is based on TrailPack evidence only. Record the result with record_session_note and state its evidence and limitations.";
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
