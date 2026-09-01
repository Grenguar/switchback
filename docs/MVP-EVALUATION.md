# MVP evaluation evidence

This is the reproducible, **offline** evidence bundle for the Switchback MVP.
It separates measured facts from the product claims they do not establish.

## Run it

Use Node 24 and pnpm, from the repository root:

```sh
PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH" bash scripts/evaluate-mvp-offline.sh
```

The command performs Rust formatting, strict Clippy, Rust tests, Web tests, a
production Vite build, then emits Q3 and Q6 JSON evidence. It has no network
step and does not contact Netlify, CNIG, OpenStreetMap, or a model provider.

## WebMCP tool acceptance

[`evals/webmcp-tool-contract.json`](../evals/webmcp-tool-contract.json) is the
reviewable fixture for the core browser tool surface. The Web test suite proves
that each active tool is registered with a browser model context and that
registration failure retains the count of successful registrations. It also
proves that `plan_route` renders before it returns and rejects unsupported
elevation/grade requests.

The fixture requires the current thirteen-tool surface. If the tool suite changes,
update the fixture and its acceptance evidence deliberately; do not silently
weaken the expected registration set.

Manual host evidence remains necessary: an actual WebMCP-capable agent browser
must discover the deployed page and call `plan_route`. That host capability
cannot be simulated honestly by an offline unit test.

## Q3 — terrain data coverage

Run only the coverage report with:

```sh
node scripts/evaluate-trailpack.mjs
```

It counts all directed, routable edges and metres with OSM-derived `surface`,
`sac_scale`, `visibility`, and `width_hint` tags. Missing tags remain missing;
the report does not turn them into a difficulty, safety, ascent, or grade
estimate. This is coverage evidence, not a Q3 pass assertion.

## Q6 — static sustain

After a production build, run:

```sh
node scripts/evaluate-static-build.mjs
```

It verifies that `web/dist` contains the Vite entry page and bundle plus the
published TrailPack manifest and graph, that the manifest is v1, and that it
contains provenance. This demonstrates that the built app can be served as
static files without a routing backend or runtime data fetch from a third party.
It does **not** prove an individual Netlify deploy; confirm that separately by
loading the deployed URL and its `/trailpack/manifest.json`.

## Evidence boundary

Q8 remains deliberately below its pass threshold. The deterministic build
reports **70.7%** of official trace length meeting the 20 m and 30-degree
distance/bearing gates; the required pass bar is 80%. Treat it as
`evidence_only_not_a_pass_claim`, never as a claim that all selected segments
are officially waymarked.
