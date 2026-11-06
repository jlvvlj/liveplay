#!/usr/bin/env bash
# OB-Xf sources (GPL-3.0), pinned, with the submodule commits OB-Xf pins for
# the libraries its engine needs (SIMD wrappers and the sst DSP helpers)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
common=$here/../common
repo=$here/upstream/OB-Xf
"$common/fetch.sh" https://github.com/surge-synthesizer/OB-Xf 9c7599edc28022d83dca3af4af772f000c96bd42 "$repo"
"$common/fetch-submodule.sh" "$repo" libs/simde https://github.com/simd-everywhere/simde
"$common/fetch-submodule.sh" "$repo" libs/sst/sst-basic-blocks https://github.com/surge-synthesizer/sst-basic-blocks
