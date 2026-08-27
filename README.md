# Switchback

Source-backed trails, made loopable at the length you have time for — planned
with an agent on a live offline map.

Switchback is an entry for the OpenAI WebMCP Challenge. Its first region is
Tarragona, Catalunya: the offline pipeline produces a portable **TrailPack**
from authorised sources, and the static web app will help a hiker or trail
runner explore routes around the Montsant–Siurana demo area.

## MVP status

This repository is being built as a feasibility spike. The goal is to prove a
small, honest end-to-end loop before expanding the product:

1. Build and load a TrailPack containing walking graph tiles and provenance.
2. Generate plausible loops on the browser map.
3. Expose six planning actions as browser-native WebMCP tools.
4. Keep the static app publicly deployable and independently testable.

The app is intentionally static: no user account, private trail history, or
server-side itinerary store is required for the MVP.

## Development

The frontend lives in [`web/`](web/). Once its dependencies are installed:

```sh
pnpm --dir web install
pnpm --dir web dev
```

Netlify is configured to build from `web/` with `pnpm run build` and publish
`dist`. The shipped map draws the local TrailPack graph directly on Canvas; it
does not depend on a runtime routing or map-tile service.

Run the complete offline validation and evidence bundle from a Node 24 shell:

```sh
bash scripts/evaluate-mvp-offline.sh
```

See [`docs/MVP-EVALUATION.md`](docs/MVP-EVALUATION.md) for measured Q3/Q6
evidence and the remaining manual browser-host checks.

## Data, attribution, and scope

TrailPack manifests carry their own source records. The application must render
the attribution supplied in `manifest.sources` rather than baking individual
source names into its UI. Planned sources include OpenStreetMap (ODbL) and
Senderos FEDME/CNIG (CC-BY 4.0); each imported dataset remains subject to its
own terms and required attribution.

This is a standalone hackathon repository. It contains no code, assets, or
data imported from the adjacent Die Hard Running work.

## Licence

The source code is licensed under [Apache-2.0](LICENSE). The licence applies to
this repository's code, not to third-party map tiles or trail datasets.

## Project references

The product and implementation planning documents are maintained in the local
Brain vault. The repository issue tracker is the executable MVP board:

- [MVP Spike milestone](https://github.com/Grenguar/switchback/milestone/1)
- [Rust pipeline and TrailPack epic](https://github.com/Grenguar/switchback/issues/36)
- [WebMCP integration epic](https://github.com/Grenguar/switchback/issues/7)
- [Browser routing and loop generation epic](https://github.com/Grenguar/switchback/issues/12)
