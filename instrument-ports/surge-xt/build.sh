#!/usr/bin/env bash
# Builds Surge XT (surge-common, no JUCE) as an AudioWorklet instrument.
#
#   ./build.sh            -> dist/surge-xt.wasm, dist/surge-xt.worklet.js,
#                            dist/surge-xt.js, dist/surge-xt-data.bin
#
# Needs git, cmake, ninja, node and emscripten (installed with Homebrew when missing).
set -euo pipefail

SURGE_REPO=https://github.com/surge-synthesizer/surge.git
SURGE_COMMIT=d152d7930b0b3a28ca9cbb61fc6851017d3ac8b6
# Surge processes in blocks of this many samples (32 is upstream's default); a note
# starts on the block edge nearest its time
BLOCK_SIZE=${SURGE_BLOCK_SIZE:-32}

# Only the submodules surge-common needs (no JUCE, LuaJIT, MTS-ESP, pybind11, ...)
SUBMODULES=(
  libs/eurorack/eurorack
  libs/fmt
  libs/simde
  libs/tuning-library
  libs/PEGTL
  libs/pffft
  libs/r8brain-free-src
  libs/zstd
  libs/sst/sst-basic-blocks
  libs/sst/sst-cmake
  libs/sst/sst-cpputils
  libs/sst/sst-effects
  libs/sst/sst-filters
  libs/sst/sst-plugininfra
  libs/sst/sst-waveshapers
)

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/build/surge"
BLD="$HERE/build/wasm"
DIST="$HERE/dist"

for tool in git cmake ninja node; do
  command -v "$tool" >/dev/null || { echo "build.sh: $tool is required" >&2; exit 1; }
done
if ! command -v emcc >/dev/null; then
  echo "== Installing emscripten with Homebrew"
  brew install emscripten
fi

echo "== Surge XT source at $SURGE_COMMIT"
if [ ! -d "$SRC/.git" ]; then
  mkdir -p "$SRC"
  git -C "$SRC" init -q
  git -C "$SRC" remote add origin "$SURGE_REPO"
fi
if [ "$(git -C "$SRC" rev-parse -q --verify HEAD 2>/dev/null || true)" != "$SURGE_COMMIT" ]; then
  git -C "$SRC" fetch -q --depth 1 origin "$SURGE_COMMIT"
  git -C "$SRC" checkout -q --force "$SURGE_COMMIT"
fi
git -C "$SRC" submodule update --init --depth 1 --recursive "${SUBMODULES[@]}"

# Small source patches for emscripten, applied once (patches/<submodule name>.patch)
apply_patch() {
  local dir="$1" patch="$2"
  if git -C "$dir" apply --reverse --check "$patch" 2>/dev/null; then return; fi
  git -C "$dir" apply "$patch"
}
apply_patch "$SRC" "$HERE/patches/surge.patch"
apply_patch "$SRC/libs/sst/sst-plugininfra" "$HERE/patches/sst-plugininfra.patch"

echo "== Configuring (emscripten, block size $BLOCK_SIZE)"
FLAGS="-msimd128 -msse4.1 -fwasm-exceptions -sWASM_LEGACY_EXCEPTIONS=1 -Wno-error"
emcmake cmake -S "$SRC" -B "$BLD" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS="$FLAGS" \
  -DCMAKE_CXX_FLAGS="$FLAGS" \
  -DCMAKE_EXE_LINKER_FLAGS="-fwasm-exceptions -sWASM_LEGACY_EXCEPTIONS=1" \
  -DCMAKE_PROJECT_Surge_INCLUDE="$HERE/cmake/port.cmake" \
  -DENABLE_LTO=OFF \
  -DSURGE_SKIP_JUCE_FOR_RACK=TRUE \
  -DSURGE_SKIP_LUA=TRUE \
  -DSURGE_SKIP_ODDSOUND_MTS=TRUE \
  -DSURGE_SKIP_WERROR=TRUE \
  -DSURGE_BUILD_32BIT_LINUX=ON \
  -DSURGE_BUILD_TESTRUNNER=OFF \
  -DSURGE_BUILD_XT=OFF \
  -DSURGE_BUILD_FX=OFF \
  -DSURGE_BUILD_CLAP=OFF \
  -DSURGE_COMPILE_BLOCK_SIZE="$BLOCK_SIZE" \
  >"$HERE/build/configure.log" 2>&1 || { tail -40 "$HERE/build/configure.log"; exit 1; }

echo "== Building"
cmake --build "$BLD" --target surge-xt-engine

echo "== Writing dist/"
mkdir -p "$DIST"
cp "$BLD/surge-xt-engine.wasm" "$DIST/surge-xt.wasm"
{
  echo "// Surge XT AudioWorklet instrument. GPL-3.0-or-later; source: $SURGE_REPO at $SURGE_COMMIT"
  cat "$BLD/surge-xt-engine.js"
  echo
  cat "$HERE/src/worklet.js"
} >"$DIST/surge-xt.worklet.js"
cp "$HERE/src/surge-xt.js" "$DIST/surge-xt.js"
# Twice: the engine reads each preset's parameter values out of the first bundle
VALUES="$HERE/build/preset-values.json"
echo '{}' >"$VALUES"
node "$HERE/tools/pack-data.mjs" "$SRC/resources/data" "$VALUES" "$DIST/surge-xt-data.bin" >/dev/null
node "$HERE/tools/preset-values.mjs" "$DIST" "$VALUES"
node "$HERE/tools/pack-data.mjs" "$SRC/resources/data" "$VALUES" "$DIST/surge-xt-data.bin"

ls -l "$DIST"
