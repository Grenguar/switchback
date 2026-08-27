#!/usr/bin/env bash
set -euo pipefail

# Reproducible, network-free MVP evidence. Run from repository root.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

node_bin="${NODE_BIN:-node}"
pnpm_bin="${PNPM_BIN:-pnpm}"

cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
"$pnpm_bin" --dir web test
"$pnpm_bin" --dir web run build
"$node_bin" scripts/evaluate-trailpack.mjs
"$node_bin" scripts/evaluate-static-build.mjs
