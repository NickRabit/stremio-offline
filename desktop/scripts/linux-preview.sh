#!/usr/bin/env bash
# Try the Linux app by hand on a Mac (or any Docker host): an Ubuntu 24.04 desktop in a container,
# shown in the browser. On Apple Silicon the x64 build runs under Docker's emulation: fine for
# the look and behaviour, slow for playback, and there is no GPU for VA-API or NVENC.
#
#   desktop/scripts/linux-preview.sh <file.deb|file.AppImage>   use a file you have
#   desktop/scripts/linux-preview.sh --release [vX.Y.Z]          the release's .deb (latest by default)
#   desktop/scripts/linux-preview.sh --pr <number>               the .deb a pull request's CI built
#   desktop/scripts/linux-preview.sh --stop                      stop and remove the preview
#   desktop/scripts/linux-preview.sh --fresh ...                 forget the preview's app data first
#
# The container is named stremio-offline-linux-preview and publishes only port 6080 on localhost.
set -euo pipefail

NAME=stremio-offline-linux-preview
IMAGE=stremio-offline-linux-preview
VOLUME=stremio-offline-linux-preview-home
PORT="${PREVIEW_PORT:-6080}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
drop="$(mktemp -d "${TMPDIR:-/tmp}/linux-preview.XXXXXX")"
trap 'rm -rf "$drop"' EXIT

stop() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }

fresh=0
if [ "${1:-}" = "--stop" ]; then stop; echo "linux-preview: stopped"; exit 0; fi
if [ "${1:-}" = "--fresh" ]; then fresh=1; shift; fi

case "${1:-}" in
  --release)
    tag="${2:-$(gh release view --repo NickRabit/stremio-offline --json tagName --jq .tagName)}"
    gh release download "$tag" --repo NickRabit/stremio-offline --pattern '*.deb' --dir "$drop"
    ;;
  --pr)
    [ -n "${2:-}" ] || { echo "usage: $0 --pr <number>" >&2; exit 2; }
    branch="$(gh pr view "$2" --repo NickRabit/stremio-offline --json headRefName --jq .headRefName)"
    run="$(gh run list --repo NickRabit/stremio-offline --workflow desktop-package.yml --branch "$branch" --status success --limit 1 --json databaseId --jq '.[0].databaseId')"
    [ -n "$run" ] || { echo "linux-preview: no successful Desktop package run for PR $2" >&2; exit 1; }
    gh run download "$run" --repo NickRabit/stremio-offline --name stremio-offline-linux-x64-deb --dir "$drop"
    ;;
  "")
    echo "usage: $0 <file.deb|file.AppImage> | --release [tag] | --pr <number> | --stop" >&2; exit 2
    ;;
  *)
    [ -f "$1" ] || { echo "linux-preview: no such file: $1" >&2; exit 1; }
    cp "$1" "$drop/"
    ;;
esac
[ -n "$(find "$drop" -maxdepth 1 \( -name '*.deb' -o -name '*.AppImage' \) -print -quit)" ] \
  || { echo "linux-preview: nothing to install in $drop" >&2; exit 1; }

docker build --platform linux/amd64 -t "$IMAGE" "$repo/desktop/linux-preview"
stop
[ "$fresh" = 1 ] && docker volume rm "$VOLUME" >/dev/null 2>&1 || true
# The app's data lives in a named volume, so a new build keeps what the last one set up.
app_dir="$(mktemp -d "${TMPDIR:-/tmp}/linux-preview-app.XXXXXX")"
find "$drop" -maxdepth 1 \( -name '*.deb' -o -name '*.AppImage' \) -exec cp {} "$app_dir"/ \;
docker run -d --name "$NAME" --platform linux/amd64 --shm-size 1g \
  -p "127.0.0.1:$PORT:6080" \
  -v "$app_dir:/opt/app:ro" \
  -v "$VOLUME:/home/tester" \
  "$IMAGE" >/dev/null
echo "linux-preview: starting; the install takes a minute under emulation"
for _ in $(seq 1 90); do
  docker logs "$NAME" 2>&1 | grep -q "desktop ready" && break
  sleep 2
done
docker logs "$NAME" 2>&1 | tail -n 3
echo "linux-preview: open http://localhost:$PORT/vnc.html?autoconnect=1&resize=scale"
echo "linux-preview: stop it with $0 --stop"
