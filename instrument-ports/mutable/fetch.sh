#!/usr/bin/env bash
# Mutable Instruments eurorack sources (MIT DSP), pinned, with the stmlib
# commit that eurorack pins
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
common=$here/../common
"$common/fetch.sh" https://github.com/pichenettes/eurorack f4cfa7697095a28d292bff758beb51deb49b5a86 "$here/upstream/eurorack"
"$common/fetch-submodule.sh" "$here/upstream/eurorack" stmlib https://github.com/pichenettes/stmlib
