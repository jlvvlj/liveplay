#!/usr/bin/env bash
# Helm sources (GPL-3.0; factory presets CC BY 4.0), pinned
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
"$here/../common/fetch.sh" https://github.com/mtytel/helm abdedd527e6e1cf86636f0f1e8a3e75b06ed166a "$here/upstream/helm"
