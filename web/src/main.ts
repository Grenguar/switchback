import "./style.css";
import { demoRoute, toolContracts } from "./tools";
import { registerWebMcpTools } from "./webmcp";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing application root.");

const bridge = { status: "unavailable" as "unavailable" | "registered", count: 0 };
let routeReady = false;
void registerWebMcpTools(false);
let logSequence = 0;

app.innerHTML = `
  <main class="shell">
    <header class="masthead">
      <a class="wordmark" href="/" aria-label="Switchback home">SWITCHBACK<span>↗</span></a>
      <div class="status"><i class="status-dot ${bridge.status}"></i><span>${bridge.status === "registered" ? "WebMCP connected" : "Browser demo mode"}</span></div>
      <button class="plain-button" id="register" type="button">${bridge.status === "registered" ? `${bridge.count} tools live` : "Check model context"}</button>
    </header>
    <section class="intro" aria-labelledby="intro-title">
      <p class="eyebrow">Trail intelligence, made inspectable</p>
      <h1 id="intro-title">Ask for a loop.<br><em>See the ground truth.</em></h1>
      <p class="lede">A WebMCP-native route planner for the places where a paper map still matters. This live MVP follows a Montsant–Siurana loop from evidence to TrailPack.</p>
    </section>
    <section class="workspace" aria-label="Route planning workspace">
      <aside class="planner">
        <div class="section-label"><span>01</span><p>Route brief</p></div>
        <form id="plan-form">
          <label>Starting point<input id="start" name="start" value="Cornudella de Montsant" maxlength="120" required /></label>
          <label>Maximum distance <span class="field-value"><output id="distance-value">15</output> km</span><input id="distance" name="distance" type="range" min="6" max="30" value="15" /></label>
          <fieldset><legend>Route character</legend><div class="choices"><label><input type="radio" name="character" value="ridge" checked /> Ridge</label><label><input type="radio" name="character" value="water" /> Water</label><label><input type="radio" name="character" value="quiet" /> Quiet</label></div></fieldset>
          <button class="plan-button" type="submit">Generate loop <span>↗</span></button>
        </form>
        <div class="evidence"><p class="eyebrow">Data provenance</p><strong>${demoRoute.source}</strong><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">${demoRoute.attribution} ↗</a></div>
      </aside>
      <section class="map-panel" aria-label="Demo route map">
        <div class="map-grain"></div><div class="contours"><i></i><i></i><i></i><i></i><i></i></div>
        <svg class="route-line" viewBox="0 0 640 520" aria-hidden="true"><path d="M478 403 C388 355 311 250 245 186 C202 142 145 165 133 224 C115 315 237 395 352 396 C440 397 489 360 478 403" /></svg>
        <span class="place place-one">Cornudella</span><span class="place place-two">Montsant</span><span class="place place-three">Siurana</span>
        <div class="map-key"><span><i class="route-swatch"></i> Proposed loop</span><span>Demo TrailPack</span></div>
        <article class="route-card" id="route-card" aria-live="polite">
          <p class="eyebrow">Current proposal</p><h2>${demoRoute.name}</h2>
          <dl><div><dt>Distance</dt><dd>${demoRoute.distanceKm} km</dd></div><div><dt>Climb</dt><dd>${demoRoute.ascentM} m</dd></div><div><dt>Moving time</dt><dd>${demoRoute.durationHours} h</dd></div></dl>
          <p class="route-note">${demoRoute.highlights[0]} · ${demoRoute.highlights[1]}</p>
        </article>
      </section>
    </section>
    <section class="tooling" aria-labelledby="tools-title">
      <div><p class="eyebrow">Agent surface</p><h2 id="tools-title">Five small tools.<br>One accountable route.</h2></div>
      <div class="tool-list">${toolContracts.map((tool, index) => `<button class="tool" type="button" data-tool="${tool.name}"><span>0${index + 1}</span><strong>${tool.name.replaceAll("_", " ")}</strong><small>${tool.description}</small><b>Run ↗</b></button>`).join("")}</div>
    </section>
    <section class="log-section" aria-labelledby="log-title"><div><p class="eyebrow">Tool invocation log</p><h2 id="log-title">Nothing hidden in the route.</h2></div><ol id="log" class="log"><li class="empty">Choose a route action to inspect its validated input and source-backed output.</li></ol></section>
  </main>`;

const log = document.querySelector<HTMLOListElement>("#log");
const addLog = (name: string, input: unknown, result: unknown, error?: unknown) => {
  if (!log) return;
  log.querySelector(".empty")?.remove();
  const item = document.createElement("li");
  item.innerHTML = `<span>${String(++logSequence).padStart(2, "0")}</span><div><strong>${name}</strong><code>${error ? `Error: ${error instanceof Error ? error.message : String(error)}` : JSON.stringify({ input, result }, null, 0)}</code></div>`;
  log.prepend(item);
};

async function invoke(name: string, input: Record<string, unknown>) {
  const tool = toolContracts.find((candidate) => candidate.name === name);
  if (!tool) return;
  const controller = new AbortController();
  try {
    const result = await tool.execute(input, controller.signal);
    addLog(name, input, result);
    const card = document.querySelector<HTMLElement>("#route-card");
    if (card) {
      card.dataset.lastAction = name;
      const note = card.querySelector<HTMLElement>(".route-note");
      if (note) note.textContent = `${name.replaceAll("_", " ")} completed — inspect the invocation log for its bounded response.`;
    }
    if (name === "plan_route" && !routeReady) { routeReady = true; void registerWebMcpTools(true); }
  }
  catch (error) { addLog(name, input, null, error); }
}

document.querySelector<HTMLFormElement>("#plan-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const maxDistanceKm = Number(document.querySelector<HTMLInputElement>("#distance")?.value ?? 15);
  void invoke("plan_route", { target_km: maxDistanceKm, max_ascent_m: 900, max_grade: "T3", prefer_waymarked: true });
});
document.querySelector<HTMLInputElement>("#distance")?.addEventListener("input", (event) => {
  const value = (event.currentTarget as HTMLInputElement).value;
  const output = document.querySelector<HTMLOutputElement>("#distance-value");
  if (output) output.value = value;
});
document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((button) => button.addEventListener("click", () => {
  const name = button.dataset.tool ?? "";
  const inputs: Record<string, Record<string, unknown>> = {
    plan_route: { target_km: 15, max_ascent_m: 900, max_grade: "T3", prefer_waymarked: true }, get_route_summary: {}, explain_segment: { segment_name: "Roca Corbatera ridge" }, avoid_segment: { segment_name: "Siurana connector" }, describe_last_edit: {},
  };
  void invoke(name, inputs[name] ?? {});
}));
document.querySelector<HTMLButtonElement>("#register")?.addEventListener("click", async () => {
  const next = await registerWebMcpTools(routeReady);
  addLog("webmcp_registration", { requested: true, routeReady }, next);
});
