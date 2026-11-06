#!/usr/bin/env bash
# Fetches one upstream repository at a pinned commit into a directory.
# Usage: fetch.sh <url> <commit> <dir>
# Rerunning is cheap: a checkout already at that commit is kept.
set -euo pipefail
url=$1
commit=$2
dir=$3
if [ -d "$dir/.git" ] && [ "$(git -C "$dir" rev-parse HEAD 2>/dev/null)" = "$commit" ]; then
  exit 0
fi
rm -rf "$dir"
mkdir -p "$dir"
git -C "$dir" init -q
git -C "$dir" remote add origin "$url"
git -C "$dir" fetch -q --depth 1 origin "$commit"
git -C "$dir" -c advice.detachedHead=false checkout -q FETCH_HEAD
echo "fetched $url @ $commit"
