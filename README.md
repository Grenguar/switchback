# Switchback

[![Netlify Status](https://api.netlify.com/api/v1/badges/bafb7ab9-419a-4ca2-8376-c944abd91b19/deploy-status)](https://app.netlify.com/projects/switchback-mvp-igor/deploys)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Ask for a loop. See the ground truth.**

Switchback is a WebMCP-native planner for a short, car-accessible or transit-accessible walk in Collserola–Vallvidrera. A person and an agent work on the same map: the agent discovers site tools, chooses a graph-verified circuit, explains its evidence and limits, and leaves the resulting route visible for the person to inspect and export.

**Live demo:** [switchback-mvp-igor.netlify.app](https://switchback-mvp-igor.netlify.app)

![Switchback showing a rendered Vista Rica circuit, its graph-verified length choices, and estimated climb.](docs/screenshots/switchback-route-planner.png)

## Why WebMCP

Trail planning is a shared decision, not a text answer. A generic assistant can suggest a scenic walk but cannot show whether that proposal closes as a non-retracing circuit on the map the person is looking at. Switchback gives the agent page-bound tools that act on the same TrailPack and route state as the UI.

The result is inspectable: a person can see the selected trailhead, rendered line, distance, sampled climb, marked-path coverage, GPX handoff, and every tool call in the visible worklog.

## What an agent can do

The app registers ten browser-native WebMCP tools:

1. List graph-verified circuit choices.
2. Dry-run a circuit before altering the map.
3. Record a visible session note.
4. Plan and render a closed circuit.
5. Summarize the active route.
6. Explain the route’s difficulty evidence and gaps.
7. Explain a TrailPack segment.
8. Avoid a segment and replan without silently changing a failed route.
9. Prepare a full-resolution GPX handoff.
10. Describe the last accepted map edit.

For a live agent run, open the demo in a WebMCP-capable ChatGPT browser context and use the page’s **Copy agent test prompt** control. The agent must explicitly choose to call tools; the app shows whether a browser model context is connected.

## Honest route evidence

Switchback only offers starts and target lengths that its directed graph can close without a long retraced leg. The route card distinguishes the selected target from the rendered route distance; for example, a 3.5 km target may render as a 3.6 km circuit within the accepted tolerance.

Length profiles are **Short / Medium / Long**, never difficulty labels. `explain_difficulty` classifies a rendered route conservatively using sampled ICGC LiDAR ascent plus available OSM terrain tags. It returns `unrated` when those facts cannot support a responsible call.

The current TrailPack does **not** prove current signs, closures, weather, surface condition, obstacles, exposure, grade, or technical difficulty. Park marked-path preference is evidence from the published network, not a statement of present-day waymarking. Check local conditions before departure.

## Run locally

Prerequisites: Node 24+ and pnpm. Rust is only needed to rebuild TrailPack data.

```sh
pnpm --dir web install
pnpm --dir web dev
```

Open the local Vite URL. The manual planner works in any modern browser; agent tools require a browser that exposes a WebMCP model context.

Validate the shipped web app:

```sh
pnpm --dir web run build
pnpm --dir web run test
```

The offline evidence bundle is also available:

```sh
bash scripts/evaluate-mvp-offline.sh
```

## Data and reproducibility

The static TrailPack consists of 66 Collserola tiles with source records in its manifest. It combines OpenStreetMap trail data (ODbL) with the Park’s Dynamic Public-Use Network A–E, used as a preference signal where it helps close a route.

To rebuild the official overlay and tiles, follow the commands and source notes in [docs/MVP-EVALUATION.md](docs/MVP-EVALUATION.md). The app routes locally over the TrailPack; map tiles are a visual reference layer, not a routing dependency.

Useful supporting material:

- [WebMCP demo walkthrough](docs/DEMO.md)
- [MVP evaluation evidence](docs/MVP-EVALUATION.md)
- [Apache-2.0 license](LICENSE)

## Devpost demo checklist

- [x] Public live URL
- [x] WebMCP registration and visible agent-tool worklog
- [x] End-to-end route generation and user-click GPX handoff
- [x] Open-source license file
- [ ] Public GitHub repository — currently private; change visibility before submission
- [ ] Public, audible demo video under three minutes
- [ ] Devpost submission completed (not merely saved as a draft)
- [ ] Teammates invited and accepted, if applicable

## License

Source code is licensed under [Apache-2.0](LICENSE). Third-party map tiles and trail datasets retain their respective terms and attributions.
