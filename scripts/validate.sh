#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
: "${FICHERO_REFERENCE:?Set FICHERO_REFERENCE to the upstream fichero-printer checkout}"
cargo test --locked --manifest-path core/Cargo.toml
cargo build --locked --manifest-path core/Cargo.toml --examples
uv run tools/differential.py --python-reference "$FICHERO_REFERENCE"
