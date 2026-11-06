#!/usr/bin/env bash
# Renders notes through dist/dexed.wasm in Node; fails on silence, NaN or
# allocation while playing. Plays every bundled voice.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
node "$here/../common/check.mjs" "$here/dist" dexed --presets all "$@"
