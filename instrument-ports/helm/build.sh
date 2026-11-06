#!/usr/bin/env bash
# Builds Helm as a WebAssembly AudioWorklet: dist/helm.wasm, dist/helm.worklet.js
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/../common/build-lib.sh"

"$here/fetch.sh"
ensure_emcc

helm=$here/upstream/helm
build=$here/build
dist=$here/dist
rm -rf "$build"
mkdir -p "$build/mopo" "$dist"

# mopo, with the arpeggiator's std::map and vectors swapped for containers
# that do not allocate while notes play
cp "$helm"/mopo/src/*.h "$helm"/mopo/src/*.cpp "$build/mopo/"
arp=$build/mopo/arpeggiator.h
perl -pi \
  -e 's|#include "processor.h"|#include "processor.h"\n#include "arp_containers.h"|;' \
  -e 's|std::vector<mopo_float> as_played_;|helm_port::ReservedVector as_played_;|;' \
  -e 's|std::vector<mopo_float> ascending_;|helm_port::ReservedVector ascending_;|;' \
  -e 's|std::vector<mopo_float> decending_;|helm_port::ReservedVector decending_;|;' \
  -e 's|std::map<mopo_float, mopo_float> active_notes_;|helm_port::NoteVelocityMap active_notes_;|;' \
  "$arp"
for swapped in arp_containers.h 'ReservedVector as_played_' 'ReservedVector ascending_' \
  'ReservedVector decending_' 'NoteVelocityMap active_notes_'; do
  grep -q "$swapped" "$arp" || { echo "arpeggiator.h changed upstream: $swapped not applied" >&2; exit 1; }
done

# Routers clone new processors (a preset's modulation routings) the first
# time each voice plays, and each voice's stutter allocates its memory the
# first time it runs. visitAll() lets the port do both up front, when a preset
# loads or the stutter is switched on, so playing never allocates.
perl -pi -e 's|virtual void removeProcessor\(const Processor\* processor\);|$&\n      virtual void visitAll(void (*visit)(Processor*));|' \
  "$build/mopo/processor_router.h"
perl -pi -e 's|virtual void setBufferSize\(int buffer_size\) override;|$&\n      virtual void visitAll(void (*visit)(Processor*)) override;|' \
  "$build/mopo/voice_handler.h"
perl -pi -e 's|virtual void process\(\) override;|$&\n      void allocateMemory() { if (memory_ == nullptr) memory_ = new Memory(size_); }|' \
  "$build/mopo/stutter.h"
cat "$here/shims/prepare_clones_router.inc" >>"$build/mopo/processor_router.cpp"
cat "$here/shims/prepare_clones_voices.inc" >>"$build/mopo/voice_handler.cpp"
grep -q 'virtual void visitAll(void (\*visit)(Processor\*));' "$build/mopo/processor_router.h" &&
  grep -q 'virtual void visitAll(void (\*visit)(Processor\*)) override;' "$build/mopo/voice_handler.h" &&
  grep -q 'void allocateMemory()' "$build/mopo/stutter.h" ||
  { echo "processor_router.h, voice_handler.h or stutter.h changed upstream: visitAll not added" >&2; exit 1; }

# Factory patches as a table
node "$here/convert-presets.mjs" "$helm" "$build/presets.inc" "$build/authors.json"

ls "$build"/mopo/*.cpp "$helm"/src/synthesis/*.cpp >"$build/sources.txt"
echo "$helm/src/common/helm_common.cpp" >>"$build/sources.txt"
echo "$here/port.cpp" >>"$build/sources.txt"
echo "$common_dir/port.cpp" >>"$build/sources.txt"

flags=("${MP_CFLAGS[@]}" -std=c++17 -w
  -I"$here/shims" -I"$build/mopo" -I"$helm/src/synthesis" -I"$helm/src/common" -I"$build")
compile_objects "$build/obj" "$build/sources.txt" "${flags[@]}" >"$build/objects.txt"

objects=()
while IFS= read -r object; do objects+=("$object"); done <"$build/objects.txt"
em++ "${MP_LDFLAGS[@]}" -O3 "${objects[@]}" -o "$dist/helm.wasm"
emit_worklet helm 0 "$dist"

ls -l "$dist/helm.wasm" "$dist/helm.worklet.js"
