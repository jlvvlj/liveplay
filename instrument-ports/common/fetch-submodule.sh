#!/usr/bin/env bash
# Fetches one submodule of an already fetched repository, at the commit that
# repository pins for it.
# Usage: fetch-submodule.sh <repository dir> <submodule path> <url>
set -euo pipefail
repo=$1
sub=$2
url=$3
commit=$(git -C "$repo" ls-tree HEAD "$sub" | awk '$2 == "commit" { print $3 }')
if [ -z "$commit" ]; then
  echo "$repo does not pin a submodule at $sub" >&2
  exit 1
fi
"$(dirname "$0")/fetch.sh" "$url" "$commit" "$repo/$sub"
