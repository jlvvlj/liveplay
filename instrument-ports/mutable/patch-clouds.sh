#!/usr/bin/env bash
# Writes patched copies of two Clouds files to <out>/clouds/dsp/, leaving the
# pinned checkout untouched. The build compiles them in place of upstream's.
# Usage: patch-clouds.sh <eurorack dir> <out dir>
#
# 1. window.h: commits fbb53ba and 0e3756f ("Duplicate variable assignment",
#    "Fixed double assignments") each removed one of the two `done_ = false;`
#    in Window::Start, so a window never plays after its first one and the
#    Stretch mode is silent. The line is put back.
# 2. correlator.cc: `destination[i + 1] >> (32 - offset_bits)` shifts by 32
#    when offset_bits is 0. The module's ARM core gives 0 for that shift;
#    WebAssembly shifts by 0 instead. The patched line gives 0, as on the module.
set -euo pipefail
eurorack=$1
out=$2/clouds/dsp
mkdir -p "$out"

perl -0pe 's/(    phase_ = 0;\n)(    regenerated_ = false;\n)/$1    done_ = false;\n$2/' \
  "$eurorack/clouds/dsp/window.h" >"$out/window.h"
if [ "$(grep -c 'done_ = false;' "$out/window.h")" != 1 ]; then
  echo "patch-clouds: clouds/dsp/window.h is not the expected upstream version" >&2
  exit 1
fi

perl -pe 's/destination_bits \|= destination\[i \+ 1\] >> \(32 - offset_bits\);/destination_bits |= offset_bits ? destination[i + 1] >> (32 - offset_bits) : 0;/' \
  "$eurorack/clouds/dsp/correlator.cc" >"$out/correlator.cc"
if ! grep -q 'offset_bits ? destination\[i + 1\]' "$out/correlator.cc"; then
  echo "patch-clouds: clouds/dsp/correlator.cc is not the expected upstream version" >&2
  exit 1
fi
