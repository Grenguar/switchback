# Switchback submission video script

Target: **2 minutes 35 seconds**. Record a public, audible video in a real
WebMCP-capable ChatGPT in-app browser. Keep the browser and the shared
Switchback page visible whenever the agent acts.

## 0:00–0:16 — Hook

**Show:** Switchback landing page and Collserola map.

**Say:** “Planning a walk is a shared decision. An assistant can suggest a
trail, but it normally cannot prove that the loop closes on the exact map I am
looking at. Switchback makes that route state shared and inspectable.”

## 0:16–0:34 — WebMCP connection

**Show:** WebMCP connected status and the fourteen-tool surface.

**Say:** “This page registers fourteen WebMCP tools directly with the browser
model context. The agent sees the same TrailPack, route card, and map that I do;
there is no separate hidden planning backend.”

## 0:34–1:08 — Natural-language request and route

**In ChatGPT, say:**

> Plan a 7 km family-friendly loop from Vista Rica, prefer marked paths, and
> tell me the best time in the next three days.

**Show:** Tool discovery/call, shared trail ledger, rendered route, route card
with distance and sampled ascent.

**Say:** “The agent asks the local directed TrailPack for a verified circuit.
The route renders before the tool returns, so I can inspect the result instead
of trusting prose.”

## 1:08–1:36 — Live planning context

**Show:** Forecast panel, original Catalan Park notices, English machine
translations, source link, and caveat.

**Say:** “One conversational route action also checks the next three forecast
days and the Park’s active notices. The original Catalan notice stays visible;
English is clearly marked as a machine translation. These are planning context,
not a safety clearance or an automatic closure decision.”

## 1:36–2:03 — Human-friendly handoff

**In ChatGPT, say:**

> Prepare a family / friends briefing with the route facts and the available
> forecast and alert context.

**Show:** Briefing panel and Copy briefing. Then say: “Prepare the GPX.” Show
the visible `Download GPX` control but do not click it unless you want to show
the browser download.

**Say:** “The agent prepares a briefing I can review and copy. It can prepare
the GPX trace, but only I can start the download. It never sends a message or
accesses a messaging account.”

## 2:03–2:25 — Evidence and limits

**Show:** Invocation log, ledger, route difficulty caveat, Park source link.

**Say:** “Every agent action is visible in the shared ledger and tool log.
Switchback is honest about what it does not know: live conditions, signs,
surface, exposure, and route-specific alert applicability still need local
confirmation.”

## 2:25–2:35 — Closing line

**Show:** Rendered route and WebMCP connected badge.

**Say:** “WebMCP turns trail planning from a text suggestion into a shared,
auditable decision on the open web.”

## Recording checklist

- Use the deployed HTTPS URL in the ChatGPT in-app browser, not a normal
  browser fallback.
- Start a fresh conversation so the site tools are discovered on the current
  page load.
- Record audible narration and keep the total under three minutes.
- If forecast or Park data is unavailable, state that plainly in the recording;
  do not substitute a fabricated result.
- Capture the agent tool call, visible map mutation, live-context panels,
  briefing, and user-controlled GPX handoff.
