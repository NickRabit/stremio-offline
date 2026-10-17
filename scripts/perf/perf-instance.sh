#!/usr/bin/env bash
# Starts an isolated copy of the app for playback measurements, so the shared instance is
# never restarted. The copy takes the data folder of a running container (same accounts and
# media-server connections) and points each media-server connection at a logging proxy.
#
#   scripts/perf/perf-instance.sh <image> <work folder> [source container]
#
# Environment: PERF_PORT (8092), PERF_NAME (stremio-offline-perf),
# PERF_REWRITE ("http://host.docker.internal:8096=http://host.docker.internal:18196 ...").
# The browser's localhost cookie works on the copy too: cookies ignore the port, and the
# session tokens are signed with secrets the copy shares.
set -euo pipefail
image=$1; work=$2; source=${3:-stremio-offline}
port=${PERF_PORT:-8092}; name=${PERF_NAME:-stremio-offline-perf}
here=$(cd "$(dirname "$0")" && pwd)

if [ ! -d "$work/data" ]; then
  mkdir -p "$work"
  docker cp "$source:/data" "$work/data"
  rm -rf "$work/data/playback"/* "$work/data/app.log"
  chmod 700 "$work/data"
  node -e '
    const fs = require("fs"); const file = process.argv[1]; const state = JSON.parse(fs.readFileSync(file, "utf8"));
    const pairs = (process.env.PERF_REWRITE ?? "").split(/\s+/).filter(Boolean).map((pair) => pair.split("="));
    for (const connection of state.mediaConnections ?? []) {
      const hit = pairs.find(([from]) => connection.baseUrl === from);
      if (hit) connection.baseUrl = hit[1];
    }
    fs.writeFileSync(file, JSON.stringify(state));
  ' "$work/data/state.json"
fi

docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" --init -p "$port:8080" \
  -e DATA_DIR=/data -e DOWNLOAD_DIR=/downloads -e LOG_LEVEL=DEBUG -e ALLOW_PRIVATE_ADDONS=1 \
  -e LIBRARY_ROOTS=/downloads,/libraries/perf -e TZ=Europe/Prague \
  --add-host host.docker.internal:host-gateway \
  -v "$work/data:/data" -v "$work/downloads:/downloads" -v "$work/media:/libraries/perf:ro" \
  -v "${PERF_HLS:-$here/../../node_modules/hls.js/dist/hls.min.js}:/app/web/perf-hls.js:ro" \
  -v "$here:/app/web/perf:ro" \
  "$image" >/dev/null
for _ in $(seq 1 60); do
  curl -fsS "http://localhost:$port/api/status" >/dev/null 2>&1 && break
  sleep 1
done
docker cp "$here/cpu-sampler.mjs" "$name:/tmp/cpu-sampler.mjs"
docker exec -d "$name" node /tmp/cpu-sampler.mjs /tmp/cpu.jsonl
curl -fsS "http://localhost:$port/api/status"; echo
