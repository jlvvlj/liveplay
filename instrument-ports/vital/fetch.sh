#!/usr/bin/env bash
# Vital's source (GPL-3.0) and the free preset banks, pinned. Only the folders
# the port builds from are checked out (not JUCE, the VST SDK, Firebase, or
# the banks' zipped copies).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)

# fetch_sparse <url> <commit> <dir> <path...>
fetch_sparse() {
  local url=$1 commit=$2 dir=$3
  shift 3
  if [ -d "$dir/.git" ] && [ "$(git -C "$dir" rev-parse HEAD 2>/dev/null)" = "$commit" ]; then
    return
  fi
  rm -rf "$dir"
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" remote add origin "$url"
  git -C "$dir" sparse-checkout set --no-cone "$@"
  git -C "$dir" fetch -q --depth 1 --filter=blob:none origin "$commit"
  git -C "$dir" -c advice.detachedHead=false checkout -q FETCH_HEAD
  echo "fetched $url @ $commit"
}

fetch_sparse https://github.com/mtytel/vital 636ca0ef517a4db087a6a08a6a8a5e704e21f836 "$here/upstream/vital" \
  /LICENSE /src/synthesis/ /src/common/ /src/unity_build/ /src/interface/look_and_feel/synth_strings.h \
  /third_party/json/ /third_party/kissfft/

banks=$here/upstream/presets
fetch_sparse https://github.com/jpriebe/qub1t-vital-presets a45e933ba4c83dc8309db2e2a89c157a624ba614 \
  "$banks/jpriebe_qub1t-vital-presets" /README.md /Presets/
fetch_sparse https://github.com/nahush2321/Vitalium-presets 025728f9a630d921050cf7eac0d514baee6b6994 \
  "$banks/nahush2321_Vitalium-presets" '/Presets (1)/' /LICENSE
fetch_sparse https://github.com/Mxm40b/vital-presets c6e8bc13e474bb35726f44812750b37b72d0016d \
  "$banks/Mxm40b_vital-presets" '/*.vital' /LICENSE
fetch_sparse https://github.com/abstractionmage/Vital-Presets 023763ab9b394f5adf65089def75f6a4f6e3aa85 \
  "$banks/abstractionmage_Vital-Presets" /Presets/ /LICENSE
fetch_sparse https://github.com/christ-offer/vitalium-presets 8c6c93cb7763d684b6ef66f700e71d9a4814471f \
  "$banks/christ-offer_vitalium-presets" /Presets/ /LICENSE
