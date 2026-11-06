#!/usr/bin/env bash
# Renders notes through dist/obxf.wasm and every factory patch; fails on
# silence, non-finite samples or allocation while playing.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
node "$here/../common/check.mjs" "$here/dist" obxf --presets all "$@"
