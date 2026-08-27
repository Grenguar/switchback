# Changelog

All notable changes to Switchback are documented here.

## [0.1.3] - 2026-08-27

### Added

- Deterministic two-pass OSM geometry resolution that keeps coordinates only for node IDs used by safe walkable routing candidates and reports incomplete ways explicitly.
- A validated, deterministic static TrailPack JSON artifact with browser-size limits, exact manifest/tile indexing, graph-reference checks, and provenance enforcement.

### Changed

- Extended OSM inspection to report resolved ways and nodes from the actual PBF input rather than only tag-filter counts.
- Bumped the Rust workspace and web application versions from `0.1.2` to `0.1.3`.

## [0.1.2] - 2026-08-27

### Added

- A bounded offline CNIG/FEDME KML adapter that preserves official identifiers and WGS84 geometry, records CC-BY-4.0 provenance, and retains legacy GPX support.
- A strict OSM PBF extractor for `path`, `footway`, and `track` ways. It retains only typed routing tags and deliberately excludes untrusted names, descriptions, notes, URLs, and user identifiers.
- CLI inspection commands for local CNIG KML and OSM PBF inputs, plus reproducible Tarragona source records and independently-qualified Q7 starts for Ulldemolins, Prades, and Albarca.

### Changed

- Configured Netlify’s build to use pnpm on Node 24, matching the pinned local Node package manager.
- Bumped the Rust workspace and web application versions from `0.1.1` to `0.1.2`.

## [0.1.1] - 2026-08-27

### Added

- Static Vite/TypeScript Switchback MVP with a Montsant–Siurana route-planning surface, visible invocation log, source attribution, and the exact WebMCP tools: `plan_route`, `get_route_summary`, `explain_segment`, `avoid_segment`, and `describe_last_edit`.
- Raw, feature-detected WebMCP registration with lifecycle cancellation, strict input validation, bounded tool outputs, read-only/untrusted-content annotations, and visible UI updates for every call.
- Rust workspace for TrailPack v0, a deterministic I/O-free spine-and-connectors loop router, a CNIG/FEDME source-adapter boundary, confidence-aware matching, and CLI scaffolding for coverage, density, and match metrics.
- Fixture-based tests for TrailPack validation, routing, matching, and evidence commands.
- Apache-2.0 licensing, OSM and CNIG/FEDME attribution guidance, repository hygiene, and Netlify static-hosting configuration.

### Changed

- Bumped the Rust workspace and web application versions from `0.1.0` to `0.1.1`.
- Migrated the web workspace to pnpm and added the pinned pnpm package-manager declaration.

### Deployment

- Created and deployed the production MVP site at https://switchback-mvp-igor.netlify.app.
