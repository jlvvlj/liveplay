#!/usr/bin/env bash
# Renders notes through each built module in Node (Clouds as an effect, with
# a plucked input); fails on silence, NaN or allocation while playing.
# Plays every preset.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
check=$here/../common/check.mjs
node "$check" "$here/dist" plaits --presets all
node "$check" "$here/dist" rings --presets all
node "$check" "$here/dist" elements --presets all
node "$check" "$here/dist" braids --presets all
node "$check" "$here/dist" clouds --effect --presets all
