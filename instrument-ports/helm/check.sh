#!/usr/bin/env bash
# Renders notes through dist/helm.wasm and fails on silence, NaN or
# allocation while playing; plays every factory preset
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
node "$here/../common/check.mjs" "$here/dist" helm --presets all "$@"
node "$here/check-presets.mjs" "$here/dist"
