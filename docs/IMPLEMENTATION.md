# What Switchback prepares and normalises

This note records the work behind the demo. It is deliberately specific about
what each layer establishes and what it does not establish, so an agent and a
person can make a reviewable decision together.

## Submission-period additions

The WebMCP challenge work added the agent-native, human-reviewable experience
to Switchback:

- Thirteen strict browser tools that discover, validate, plan, explain, adapt,
  brief, and prepare a GPX from the page's real state.
- A visible shared action ledger and invocation worklog, so people see each
  agent action and its result rather than receiving an opaque text answer.
- Conversational `plan_route` results that render the graph-verified route
  before returning and check live planning context without making live-source
  availability a precondition for the route.
- Human-controlled briefing copy and GPX download handoffs.
- Three-day forecast comparison, official Park-alert retrieval, original
  Catalan preservation, optional English machine translation, caching, and
  server-side request limiting.

The [README judge quick start](../README.md#judge-quick-start--live-webmcp-demo)
gives the exact live verification flow; [WEBMCP.md](WEBMCP.md) describes each
tool and its visible effect.

## 1. Route-data preparation

Switchback turns published trail data into a static, browser-loadable
**TrailPack** rather than asking an agent to invent a route from prose.

| Preparation step | What happens | Resulting boundary |
| --- | --- | --- |
| Trail extraction | The Rust builder filters routable, pedestrian-accessible trail geometry from OpenStreetMap within the planned area. | The graph is an offline planning dataset, not a live trail report. |
| Official-network overlay | The Park's Dynamic Public-Use Network A–E is parsed from its KML and carried as source-labelled route-preference evidence. | A match is evidence from the published network, not proof of current waymarks or permission. |
| Graph normalisation | Coordinates are stored as fixed-point WGS84 integers (`lat_e7`, `lon_e7`); directed edges retain length, geometry, terrain tags, and source provenance. | Invalid coordinates, references, and manifest data are rejected when the browser loads the pack. |
| Tiling and manifest | The builder writes a versioned manifest and individually cacheable tiles. The production pack currently contains 66 Collserola tiles. | A published manifest and every referenced tile must load before multi-tile routing becomes available. |
| Circuit verification | The planner exposes only start points and lengths that close as a directed circuit without a long retraced leg. `validate_circuit` dry-runs this before a map change. | A valid graph circuit does not certify field conditions, access, or suitability for a particular group. |

The reproducible build and evidence commands are in
[MVP-EVALUATION.md](MVP-EVALUATION.md). The browser validates the manifest,
tile identifiers, source provenance, coordinate ranges, and edge references
before it uses the data.

## 2. Route enrichment after planning

Once a graph-verified loop is rendered, Switchback can add helpful context
without making it a condition of planning:

| Enrichment | Normalisation | How it is presented |
| --- | --- | --- |
| Ascent | Samples the ICGC LiDAR terrain model along the completed line and totals the sampled climb. | An estimate after rendering; ascent or grade cannot yet constrain route selection. |
| Forecast | Converts Open-Meteo hourly values around the rendered route centre into three local daytime windows per day: 08:00–11:00, 11:00–14:00, and 14:00–17:00. Temperature, precipitation, wind, gusts, and weather code are scored to identify a least-exposed window. | Planning context only. It is a forecast grid cell, not an on-trail observation or weather clearance. |
| Official Park notices | The same-origin adapter fetches only the Park page's labelled active-alert section, strips HTML to text, deduplicates by source URL, caps the response at eight notices, and retains publication date and official link. | Notices are shown as Park-published context. Their presence does not prove they apply to this route or remain in force. |

If either live request fails or is unavailable, the graph route remains visible.
The UI and `plan_route` response say which information was unavailable instead
of pretending that the recommendation is complete.

## 3. Catalan-to-English alert translation

The official Catalan notice is always the source of record. Translation is an
optional comprehension aid with these safeguards:

1. The Netlify function keeps AWS credentials server-side and calls AWS
   Translate with `ca` as source and `en` as target language.
2. It applies a 10,000-byte input limit per translated field and isolates
   failures per notice.
3. The original title and excerpt stay in the response and UI. English appears
   only when returned successfully and is labelled **English machine
   translation**.
4. A failed translation becomes `translation: null`; it never substitutes a
   fabricated English summary for the official notice.
5. Each card keeps its Park source link, and the app tells people to read the
   original and source before using it for a safety decision.

The setup, least-privilege IAM policy, and server-only environment variable
names are in [OPERATIONS.md](OPERATIONS.md#translation-configuration).

## 4. Human–agent preparation

WebMCP keeps every meaningful agent action page-bound and visible:

1. An agent discovers the same strict tools used by the planner page.
2. It can list and validate circuits before it plans one.
3. `plan_route` renders the route first, then checks forecast and alert context
   concurrently in the browser.
4. The shared map, route card, trail ledger, and invocation log show the
   accepted action and its result to the person in the same tab.
5. The agent may prepare a briefing or GPX, but it cannot send a message or
   download a file automatically. The person reviews and explicitly copies or
   clicks Download GPX.

See [WEBMCP.md](WEBMCP.md) for the full thirteen-tool contract and a live test
prompt.

## 5. Operational preparation and validation

The alert adapter is a same-origin Netlify function, not browser JavaScript.
It is cacheable and rate-limited to **20 requests per IP per 60 seconds** before
the Park fetch and optional translation calls. This protects the public source,
translation spend, and the user experience while leaving credentials out of the
client bundle.

Before release, the project runs its production build, web test suite, static
TrailPack checks, and browser smoke checks. The checks cover the strict WebMCP
registration contract, route/GPX behavior, source fallback, and the responsive
alert/translation UI. A normal browser smoke test validates the UI but does
not, by itself, prove a hosted WebMCP agent discovered the tools; that final
evidence must be recorded in a WebMCP-capable browser session.

## 6. Non-negotiable limitations

- TrailPack evidence does not prove current signs, closures, surface,
  obstacles, technical grade, exposure, or route safety.
- Forecast and alert content are advisory planning inputs, not go/no-go
  decisions.
- The Park's Catalan original and source page outrank any machine translation.
- A route is only shared or downloaded after a person explicitly chooses the
  visible control.
