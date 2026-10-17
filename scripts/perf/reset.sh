#!/usr/bin/env bash
# Between two measured cells: note the media-server request counters, then restart the
# measurement instance so no inspection, byte or metadata cache carries into the next cell.
#
#   scripts/perf/reset.sh <log folder> [container]
set -euo pipefail
logs=$1; name=${2:-stremio-offline-perf}
port=$(docker port "$name" 8080/tcp | head -1 | sed 's/.*://')
sleep 2 # provider-stats.json is written on a one-second timer
docker exec "$name" node -e '
  const rows = require("/data/provider-stats.json");
  const total = {};
  for (const row of rows) for (const [key, value] of Object.entries(row)) if (typeof value === "number") total[key] = (total[key] ?? 0) + value;
  console.log(JSON.stringify({ at: Date.now(), total }));
' >> "$logs/provider-snapshots.jsonl"
docker restart -t 5 "$name" >/dev/null
for _ in $(seq 1 60); do
  curl -fsS "http://localhost:$port/api/status" >/dev/null 2>&1 && break
  sleep 0.5
done
docker exec -d "$name" node /tmp/cpu-sampler.mjs /tmp/cpu.jsonl
echo "ready $(node -e "console.log(Date.now())")"
