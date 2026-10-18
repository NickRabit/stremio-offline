#!/usr/bin/env bash
# Attaches files to the release named by GITHUB_REF_NAME, one at a time. A name the release
# already carries is skipped, so a rerun never replaces what was published. Several jobs attach
# the same FFmpeg source archives at once, and the one that loses that race gets an error that
# is not always "already exists" (a 404 has been seen); a failed upload therefore counts as done
# when the release carries the name afterwards, and is tried once more otherwise.
set -euo pipefail

has_asset() {
  gh release view "${GITHUB_REF_NAME}" --json assets --jq '.assets[].name' | grep -qxF -e "$1"
}

for file in "$@"; do
  name="$(basename "$file")"
  if has_asset "$name"; then
    echo "the release already carries $name"
    continue
  fi
  for attempt in 1 2; do
    if gh release upload "${GITHUB_REF_NAME}" "$file" 2>"${RUNNER_TEMP:-/tmp}/asset-upload.err"; then
      echo "attached $name"
      break
    fi
    sleep 5
    if has_asset "$name"; then
      echo "another job attached $name"
      break
    fi
    cat "${RUNNER_TEMP:-/tmp}/asset-upload.err" >&2
    if [ "$attempt" -eq 2 ]; then exit 1; fi
  done
done
