# Changelog

All notable changes to Switchback are documented here.

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
