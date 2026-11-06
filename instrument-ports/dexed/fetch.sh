#!/usr/bin/env bash
# Dexed sources (GPL-3.0; MSFA engine Apache-2.0), pinned
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
"$here/../common/fetch.sh" https://github.com/asb2m10/dexed fea2f0f0f2c397799f59b27eb11c038cd34b22c5 "$here/upstream/dexed"
