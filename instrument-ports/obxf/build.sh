#!/usr/bin/env bash
# Builds dist/obxf.wasm and dist/obxf.worklet.js from the pinned OB-Xf sources.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/../common/build-lib.sh"

"$here/fetch.sh"
ensure_emcc

src=$here/upstream/OB-Xf
gen=$here/build/gen
dist=$here/dist
mkdir -p "$gen" "$dist"

node "$here/gen.mjs" "$src" "$gen"

# The generated SynthParam.h and Utils.h, then the JUCE and MTS-ESP stand-ins,
# come before upstream's own directories. Program.h (the plugin's patch store)
# is left out by defining its include guard.
em++ -std=c++20 "${MP_CFLAGS[@]}" "${MP_LDFLAGS[@]}" \
  -DOBXF_SRC_ENGINE_PARAMETERS_H \
  -Wno-deprecated-declarations \
  -I"$gen" -I"$here/shim" \
  -I"$src/src" -I"$src/src/core" -I"$src/src/engine" \
  -I"$src/libs/sst/sst-basic-blocks/include" -I"$src/libs/simde" \
  "$here/port.cpp" "$common_dir/port.cpp" \
  -o "$dist/obxf.wasm"

emit_worklet obxf 0 "$dist"
ls -l "$dist"
