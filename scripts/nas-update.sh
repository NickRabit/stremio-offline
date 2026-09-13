#!/usr/bin/env sh
# Pull a fresh image on the NAS and restart the project.
#
# Container Manager only downloads an image it does not have yet, so a project
# that already holds :latest just starts the old one again. This asks for the
# image explicitly and then recreates the container.
#
# Run it from DSM: Control Panel -> Task Scheduler -> Create -> User-defined
# script, run as root, with the project directory below.
set -eu

PROJECT="${1:-/volume2/docker/stremio-offline}"

cd "$PROJECT"

# DSM 7.2 ships compose v2 as a docker plugin; older builds carry the standalone binary.
if docker compose version >/dev/null 2>&1; then
  compose() { docker compose "$@"; }
else
  compose() { docker-compose "$@"; }
fi

echo "==> Pulling the image"
compose pull

echo "==> Recreating the container"
compose up -d

echo "==> Removing images nothing uses any more"
docker image prune -f >/dev/null || true

echo "==> Running version"
sleep 5
PORT=$(sed -n 's/^STREMIO_OFFLINE_PORT=//p' .env 2>/dev/null | head -1)
curl -fsS "http://127.0.0.1:${PORT:-8090}/api/status" 2>/dev/null || echo "(server is not responding, check the log)"
echo
