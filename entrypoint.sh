#!/bin/sh
set -e

# On a NAS, shared folders belong to someone other than uid 1000 from the
# image. Instead of rewriting permissions on the whole library, the process
# runs as whoever owns the folder.
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ "$(id -u)" = "0" ]; then
  find /data \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown -h "$PUID:$PGID" {} + 2>/dev/null || true

  if [ "${FIX_PERMISSIONS:-0}" = "1" ]; then
    echo "FIX_PERMISSIONS=1: changing owner of /downloads to $PUID:$PGID (slow on a large library)"
    find /downloads \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown -h "$PUID:$PGID" {} + 2>/dev/null || true
  fi

  CHECK_GROUPS="$PGID"
  if [ -n "${RENDER_GID:-}" ] && [ "$RENDER_GID" != "$PGID" ]; then
    CHECK_GROUPS="$PGID,$RENDER_GID"
  fi
  if ! setpriv --reuid="$PUID" --regid="$PGID" --groups="$CHECK_GROUPS" -- test -w /downloads 2>/dev/null; then
    echo "WARNING: user $PUID:$PGID cannot write to /downloads."
    echo "         Set PUID and PGID to the folder owner, or start with FIX_PERMISSIONS=1."
  fi

  # gosu drops group_add from Docker Compose when switching user. Pass the
  # render group to setpriv explicitly, or /dev/dri on Synology is unreachable.
  exec setpriv --reuid="$PUID" --regid="$PGID" --groups="$CHECK_GROUPS" -- "$@"
fi

exec "$@"
