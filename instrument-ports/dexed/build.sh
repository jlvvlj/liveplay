#!/usr/bin/env bash
# Builds dist/dexed.wasm and dist/dexed.worklet.js (processor melodics-dexed)
# from the pinned Dexed sources. One command from a clean checkout.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/../common/build-lib.sh"

"$here/fetch.sh"
ensure_emcc

up=$here/upstream/dexed
src=$up/source
build=$here/build
dist=$here/dist
rm -rf "$build"
mkdir -p "$build/carts" "$dist"

# The bundled cartridges, unpacked into a header
unzip -o -q "$up/assets/builtin_pgm.zip" -d "$build/carts"
node "$here/cartridges.mjs" "$build/carts" "$build/cartridges.h"

cat >"$build/sources.txt" <<EOF
$src/msfa/dx7note.cc
$src/msfa/env.cc
$src/msfa/exp2.cc
$src/msfa/fm_core.cc
$src/msfa/fm_op_kernel.cc
$src/msfa/freqlut.cc
$src/msfa/lfo.cc
$src/msfa/pitchenv.cc
$src/msfa/porta.cpp
$src/msfa/sin.cc
$src/engine/EngineMkI.cpp
$src/engine/EngineOpl.cpp
$src/PluginFx.cpp
$here/standard_tuning.cpp
$here/port.cpp
$common_dir/port.cpp
EOF

# The shims stand in for JUCE, the MTS-ESP client and the tuning library;
# PLUGINPROCESSOR_H_INCLUDED keeps PluginFx.cpp from reading the JUCE plugin
# header it does not use.
flags=(
  "${MP_CFLAGS[@]}" -std=c++17
  -I"$here/shim/inc" -I"$src" -I"$src/msfa" -I"$build"
  -DPLUGINPROCESSOR_H_INCLUDED
  -Wno-deprecated-declarations -Wno-unused-variable
)
compile_objects "$build/obj" "$build/sources.txt" "${flags[@]}" >"$build/objects.txt"
objects=()
while IFS= read -r o; do objects+=("$o"); done <"$build/objects.txt"
em++ "${MP_LDFLAGS[@]}" -O3 "${objects[@]}" -o "$dist/dexed.wasm"
emit_worklet dexed 0 "$dist"

ls -l "$dist/dexed.wasm" "$dist/dexed.worklet.js"
