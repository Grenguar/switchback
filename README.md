# Switchback

Source-backed Collserola trails, made loopable at the length you have time for
— planned with an agent on a live map.

Switchback is an entry for the OpenAI WebMCP Challenge. Its first region is
Collserola, Barcelona: an offline pipeline produces a portable, tiled
**TrailPack** from local OSM and CNIG/FEDME inputs. A hiker and an agent share
the same live route-planning surface: the agent calls inspectable site tools,
and the person sees the resulting directed route on the map.

## MVP status

This repository is being built as a feasibility spike. The goal is to prove a
small, honest end-to-end loop before expanding the product:

1. Build and load a provenance-carrying TrailPack with 72 Collserola tiles.
2. Generate a directed loop on the browser map from the verified GR-6 Horta access.
3. Expose six planning actions as browser-native WebMCP site tools.
4. Let the person inspect, alter, and export the same route the agent planned.

The app is intentionally static: no user account, private trail history, or
server-side itinerary store is required for the MVP.

## Development

The frontend lives in [`web/`](web/). Once its dependencies are installed:

```sh
pnpm --dir web install
pnpm --dir web dev
```

Netlify builds from `web/` with `pnpm run build` and publishes `dist`. Routing
uses only the local TrailPack graph; OpenStreetMap raster tiles are a visual
reference layer with visible attribution, not a routing dependency.

Run the complete offline validation and evidence bundle from a Node 24 shell:

```sh
bash scripts/evaluate-mvp-offline.sh
```

See [`docs/MVP-EVALUATION.md`](docs/MVP-EVALUATION.md) for measured Q3/Q6
evidence and [`docs/DEMO.md`](docs/DEMO.md) for the WebMCP walkthrough.

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
