# Switchback WebMCP demo

## Three-minute video plan

1. **0:00–0:20 — problem.** A loop request has to stay inside a real, attributable trail graph; a chat response alone cannot make that route inspectable.
2. **0:20–0:45 — shared surface.** Show the Collserola–Vallvidrera pack loading on the deployed page: OSM reference map, TrailPack provenance, and the Vista Rica parking start.
3. **0:45–1:30 — agent action.** In the ChatGPT desktop app built-in browser, ask: “Plan a 7 km loop from Vista Rica parking, preferring official matches.” Show the site-tools indicator, the invocation log, and the rendered loop.
4. **1:30–2:10 — human control.** Drag the through-point, show the graph-validated replan, then use `get_route_summary` or `explain_segment` to inspect the evidence behind a segment.
5. **2:10–2:35 — handoff.** Prepare and download GPX. State the limits plainly: official matches are evidence, current conditions still need field verification, and elevation/grade constraints are unavailable.
6. **2:35–3:00 — why WebMCP.** The agent does not guess a route in text; it calls the same bounded, auditable planner the person sees and controls.

## Live smoke test

In the ChatGPT desktop app built-in browser, open the production URL and use:

```text
Use the Switchback site tools on this page. Plan a 7 km loop from
vista_rica_parking with prefer_waymarked true. Then call get_route_summary.
```

Expected: `plan_route` renders before it returns; the page invocation log shows
both calls; the map shows a loop; and the summary identifies source-backed
segments. If site tools are not offered for the account/model, record the
normal UI flow separately and do not claim the WebMCP call was verified.
