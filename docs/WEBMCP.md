# Switchback WebMCP guide

Switchback makes the currently open trail-planning page usable by both a person
and an agent. The agent does not receive a separate routing API or hidden map
state: it calls page-bound tools, and their effects appear on the same map,
route card, shared trail ledger, and invocation log that the person can inspect.

## Connection lifecycle

1. On load, the page checks `document.modelContext`, then falls back to
   `navigator.modelContext`.
2. In a WebMCP-capable browser, `registerWebMcpTools()` registers each strict
   JSON-schema tool with the browser model context.
3. The agent discovers those tools and calls them from the conversation.
4. A wrapper records `started`, `succeeded`, or `failed` lifecycle events.
5. Switchback renders every meaningful result before reporting success: the
   route is on the map, live planning context is in the route card, and GPX or
   briefing handoffs are visible for the person to review.

In a normal browser, the manual planner remains fully useful and the page says
that it is in browser-demo mode. That is not evidence that WebMCP is connected.

## The thirteen tools

| Tool | What it does | Shared visible effect |
| --- | --- | --- |
| `list_circuit_options` | Lists verified car and public-transport circuit starts and their valid distance profiles. | None; read-only evidence. |
| `validate_circuit` | Checks graph closure and distance without changing the active route. | None; read-only dry run. |
| `record_session_note` | Adds a short test, insight, or handoff note to this tab’s worklog. | Invocation log. |
| `plan_route` | Renders a verified directed loop and, in the browser, automatically checks forecast and Park-alert context. | Map, route card, forecast/alert panels, ledger. |
| `get_route_summary` | Returns totals and selected TrailPack segments for the current loop. | None; read-only evidence. |
| `explain_difficulty` | Applies the conservative measured-ascent and terrain-data rubric. | None; read-only evidence. |
| `explain_segment` | Returns available OSM terrain tags and official-match evidence for one active segment. | None; read-only evidence. |
| `avoid_segment` | Replans around one active physical segment, but fails closed if a verified replacement is unavailable. | Map and route card only after a valid replacement. |
| `prepare_gpx` | Builds the complete GPX trace and exposes a download control. | User-click `Download GPX` control; no automatic download. |
| `get_trail_weather` | Compares three local forecast days and finds a limited least-exposed daytime window. | Forecast planning-context panel. |
| `get_park_alerts` | Reads the official active Park notices through the same-origin adapter. | Alert panel with source links and optional English translations. |
| `prepare_route_briefing` | Builds a short, copyable family / friends briefing. | Reviewable briefing and Copy control; no message is sent. |
| `describe_last_edit` | Describes the last accepted manual route edit and its measured effect. | None; read-only evidence. |

## Conversational route planning

The main conversation can be natural. For example:

> Plan a 7 km family-friendly loop from Vista Rica this week. Prefer marked
> paths, tell me the best time, and prepare something I can send to friends.

`plan_route` returns a chat-ready summary after rendering the graph-verified
loop. It attempts the forecast and official-alert checks concurrently. The
result names what was available and asks whether the person wants a briefing or
GPX next. A failed external source never turns a route into a fake “safe”
recommendation: the response says the route is based on TrailPack evidence only.

## Tool boundaries

- The planner only accepts published, graph-verified starts and target lengths.
- The route map renders before `plan_route` succeeds.
- Forecast and alerts are planning context, not a safety clearance.
- Alert notices retain their official Catalan original; English is labelled as
  machine translation and the source link remains available.
- GPX is prepared but never downloaded, emailed, uploaded, or shared by the
  agent. A person must click the visible control.
- A briefing is prepared and copied only; Switchback never accesses a messaging
  account or sends a message.
- The worklog and shared trail ledger make agent work reviewable in the current
  tab. They are not a hidden audit service or cross-user data store.

## Test prompt for a WebMCP browser

```text
Use the site tools on this Switchback page. First call list_circuit_options and
choose a returned short, medium, or long distance profile; these are not
difficulty ratings. Call validate_circuit, then plan_route and
get_route_summary. Call explain_difficulty, get_park_alerts, and
get_trail_weather before recommending the route. If either external source is
unavailable, state that the recommendation is based on TrailPack evidence only.
Record the result with record_session_note and state its evidence and
limitations.
```

For a live demonstration, capture the agent discovering the tools, the ledger
showing its actions, the map changing, and the resulting briefing in the same
browser tab.
