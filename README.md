# Switchback

Source-backed Collserola–Vallvidrera trails, made loopable at the length you have time for
— planned with an agent on a live map.

Switchback is an entry for the OpenAI WebMCP Challenge. Its first region is
Collserola–Vallvidrera: an offline pipeline produces a portable, tiled
**TrailPack** from local OSM and CNIG/FEDME inputs. A hiker and an agent share
the same live route-planning surface: the agent calls inspectable site tools,
and the person sees the resulting directed route on the map.

## MVP status

This repository is being built as a feasibility spike. The goal is to prove a
small, honest end-to-end loop before expanding the product:

1. Build and load a provenance-carrying TrailPack with 66 Collserola tiles.
2. Generate a directed loop from a verified parking start: Vista Rica or Passeig de les Aigües.
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
uses only the local TrailPack graph; the map is a visual reference layer, not a
routing dependency.

### Interactive map setup

The map uses MapLibre. It automatically uses Amazon Location Maps V2 terrain
when these **build** variables are set in Netlify, then
falls back to OpenStreetMap when they are absent:

```text
VITE_AWS_LOCATION_API_KEY=<restricted public Maps V2 key>
VITE_AWS_LOCATION_REGION=eu-west-1
```

`VITE_` values are intentionally visible to the browser. Never use AWS access
keys here: create an Amazon Location API key restricted to `geo-maps:*`,
`arn:aws:geo-maps:eu-west-1::provider/default`, and the production site
referrer only. Rebuild the Netlify site after adding or rotating the key.
For local work, copy [`.env.example`](.env.example) to the repository root as
`.env`; Vite reads that root file while serving `web/`.

Run the complete offline validation and evidence bundle from a Node 24 shell:

```sh
bash scripts/evaluate-mvp-offline.sh
```

See [`docs/MVP-EVALUATION.md`](docs/MVP-EVALUATION.md) for measured Q3/Q6
evidence and [`docs/DEMO.md`](docs/DEMO.md) for the WebMCP walkthrough.

## Data, attribution, and scope

TrailPack manifests carry their own source records. The application must render
the attribution supplied in `manifest.sources` rather than baking individual
source names into its UI. The current Collserola pack combines OpenStreetMap
(ODbL) trails with the Park’s Dynamic Public-Use Network A–E codes. The latter
is displayed as a clickable marked-path overlay and biases routing when
`prefer_waymarked` is true; OSM trail connections remain available when they
are needed to close a non-retracing loop. The Park does not state a licence on
that KML, so its attribution and source date are carried explicitly in the
manifest.

To refresh the official overlay from the Park’s published KML, first download
`https://parcnaturalcollserola.cat/kml/xdup.kml`, then run:

```sh
node scripts/build-collserola-official-network.mjs /path/to/xdup.kml \
  web/public/trailpack/collserola-official-network-a-e.geojson \
  /tmp/collserola-official-a-e.kml
target/debug/switchback-cli build-tiles --osm /path/to/barcelona.osm.pbf \
  --official-network /tmp/collserola-official-a-e.kml \
  --bbox 2.055,41.38,2.20,41.52 --output-dir web/public/trailpack \
  --built-at 2026-09-01T00:00:00Z --extract-date 2026-09-01 \
  --region-id es-ct-collserola --region-name Collserola \
  --osm-source-id osm-barcelona-bbbike --osm-source-name OSM-Barcelona-Bounded
```

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
