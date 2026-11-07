#!/usr/bin/env bash
# Builds Vital (its SoundEngine, no JUCE and no interface) as a WebAssembly
# AudioWorklet: dist/vital.wasm, dist/vital.worklet.js, dist/vital.loader.js
# (the Worker that reads presets for it), and each preset's file in
# dist/presets/, which the browser fetches when the preset is played
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/../common/build-lib.sh"

"$here/fetch.sh"
ensure_emcc

vital=$here/upstream/vital
build=$here/build
dist=$here/dist
rm -rf "$build"
mkdir -p "$build" "$dist"

# Vital's source, with Sample given two methods: its data, and taking data
# prepared elsewhere (the port moves a preset's sample between instances)
cp -R "$vital/src" "$build/src"
sample_h=$build/src/synthesis/producers/sample_source.h
perl -pi -e 's|(      json stateToJson\(\);)|      const SampleData* getData() const { return current_data_; }\n      void adoptData(std::unique_ptr<SampleData> data) { data_ = std::move(data); current_data_ = data_.get(); }\n\n$1|' "$sample_h"
grep -q 'void adoptData' "$sample_h" || { echo "sample_source.h changed upstream: adoptData not added" >&2; exit 1; }
# A router (each voice is one) copies a processor added to the graph, such as
# a preset's feedback loop, the first time it runs after the change. prepareAll()
# has every router and every voice do that when a preset loads, so playing
# never allocates.
router_h=$build/src/synthesis/framework/processor_router.h
voices_h=$build/src/synthesis/framework/voice_handler.h
perl -0pi -e 's|(      virtual void resetFeedbacks\(poly_mask reset_mask\);\n)|$1\n      virtual void prepareAll() {\n        if (shouldUpdate())\n          updateAllProcessors();\n        for (Processor* processor : local_order_) {\n          if (ProcessorRouter* router = dynamic_cast<ProcessorRouter*>(processor))\n            router->prepareAll();\n        }\n        for (auto\& idle : idle_processors_) {\n          if (ProcessorRouter* router = dynamic_cast<ProcessorRouter*>(idle.second.get()))\n            router->prepareAll();\n        }\n      }\n|' "$router_h"
perl -0pi -e 's|(      void setTuning\(const Tuning\* tuning\) \{ tuning_ = tuning; \}\n)|$1\n      void prepareAll() override {\n        ProcessorRouter::prepareAll();\n        for (auto\& voice : all_aggregate_voices_) {\n          if (ProcessorRouter* router = dynamic_cast<ProcessorRouter*>(voice->processor.get()))\n            router->prepareAll();\n        }\n      }\n|' "$voices_h"
grep -q 'virtual void prepareAll()' "$router_h" && grep -q 'void prepareAll() override' "$voices_h" ||
  { echo "processor_router.h or voice_handler.h changed upstream: prepareAll not added" >&2; exit 1; }
src=$build/src

# Upstream's preset loading functions, unchanged, and the free banks' presets
node "$here/tools/extract-load-save.mjs" "$src/common/load_save.cpp" "$build/load_save_part.cpp"
node "$here/tools/list-presets.mjs" "$here/upstream/presets" "$build/presets.inc" "$dist"

includes=(-I"$here/shims" -I"$build" -I"$src/unity_build")
while IFS= read -r dir; do includes+=(-I"$dir"); done < <(
  find "$src/synthesis" "$src/common" -type d -not -path '*effects_engine*' | sort)
includes+=(-I"$src/interface/look_and_feel" -I"$vital/third_party")

printf '%s\n' "$here/src/engine.cpp" "$build/load_save_part.cpp" "$here/src/vital_port.cpp" \
  "$common_dir/port.cpp" >"$build/sources.txt"

# Vital's code is written for SSE2, which emscripten maps onto wasm SIMD.
# Exceptions are on: nlohmann::json reports a preset it cannot read by throwing.
flags=(-O3 -msimd128 -msse2 -fwasm-exceptions -sWASM_LEGACY_EXCEPTIONS=1 -fno-math-errno -DNDEBUG
  -std=c++17 -w -I"$common_dir" "${includes[@]}")
compile_objects "$build/obj" "$build/sources.txt" "${flags[@]}" >"$build/objects.txt"

objects=()
while IFS= read -r object; do objects+=("$object"); done <"$build/objects.txt"
em++ "${MP_LDFLAGS[@]}" -O3 -fwasm-exceptions -sWASM_LEGACY_EXCEPTIONS=1 -sINITIAL_MEMORY=64MB \
  "${objects[@]}" -o "$dist/vital.wasm"
emit_worklet vital 0 "$dist"
{
  echo "// Vital preset loader. GPL-3.0-or-later; source: https://github.com/mtytel/vital"
  cat "$here/src/loader.js"
} >"$dist/vital.loader.js"

ls -l "$dist/vital.wasm" "$dist/vital.worklet.js" "$dist/vital.loader.js"
