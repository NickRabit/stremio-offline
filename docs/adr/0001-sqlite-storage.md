# ADR 0001: SQLite storage runtime and layout

- Status: Accepted
- Date: 2026-11-01

## Context

The application currently persists several domains as whole JSON files. The
selective migration plan in issue #644 moves one domain at a time so each move
can be tested independently. This ADR records the shared storage decisions and
the phase 0-1 infrastructure. Phase 1 starts using it for the image link
registry.

## Decision

### Driver and runtime

Use the built-in `node:sqlite` module and `DatabaseSync`; do not add an npm
dependency. The minimum supported Node version for this module is 22.16 because
the planned backup workflow requires `backup()`, which arrived in that release.
The repository still declares Node 22 generally. Raising `engines` to 22.16
should be a separate later change. Keeping SQLite behind
`server/src/storage/` limits the impact if the driver changes.

Measured on 2026-11-01:

| Runtime | Node | SQLite | Result |
| --- | --- | --- | --- |
| Docker / CI | 22.23.3 | 3.53.4 | WAL, transactions, a worker thread opening the same file and `backup()` worked |
| Electron desktop `utilityProcess` | 24.22.0 | 3.53.4 | WAL, transactions, a worker thread opening the same file and `backup()` worked |

Windows/Linux packaged Electron: not yet verified.

### File layout

Use one database at `${DATA_DIR}/application.sqlite`. It stays at the data
directory root, outside `images/`, `artwork/` and every cache or cleanup path.
Cache cleanup must never be able to delete authoritative application data.

The database file is created with mode `0600`. An existing file is changed to
`0600` only when it has group or other permissions, or owner-execute permission.
A more restrictive existing mode is left alone.

### Threading and API

One dedicated worker thread owns the only SQLite connection. The main/HTTP
thread never prepares or runs SQL. Its asynchronous API submits calls in FIFO
order; the worker executes messages sequentially. Calls wait behind at most
1,000 pending requests by default. Excess calls fail with `StorageError("busy")`
instead of growing an unbounded queue.

A worker crash permanently marks the database `broken`: pending and later calls
reject with `StorageError("broken")`. It is never silently reopened. `close()`
stops accepting calls, drains accepted calls, closes the connection, and waits
for the worker to exit.

Prepared statements may be cached by SQL text up to 200 entries in the worker.
This is a local optimization and does not cross the thread boundary.

### Durability and locking

The connection sets:

- `journal_mode=WAL` when SQLite is at least 3.51.3, or is a patched 3.50.7+
  or 3.44.6+ release; otherwise `journal_mode=DELETE`
- `synchronous=FULL`
- `busy_timeout=5000`
- `foreign_keys=ON`

SQLite versions without the WAL-reset fix must not use WAL. The runtime checks
the actual SQLite version instead of assuming it from the Node version.

The 5-second busy timeout is the only lock wait. Per-call timeouts are deferred
to a later decision. A missing worker response currently keeps the caller
waiting until SQLite returns or the worker fails.

### Migrations and schema versions

Migrations are an ordered list with a monotonically increasing
`user_version`. Each migration runs in its own `BEGIN IMMEDIATE` transaction,
and its `user_version` update commits in that same transaction. A failed
migration rolls back completely.

Before opening a writable connection, the worker reads `user_version` through a
read-only connection. A version newer than the newest migration is rejected
with `StorageError("newer-schema")` before pragmas or migrations can modify the
file.

### Migration cutover and dual writes

There are no permanent dual writes. When a domain moves, the old JSON file
remains a read-only migration source or fallback only for the bounded cutover
window required by that phase. The SQLite representation becomes authoritative
when the domain moves, and subsequent writes have one owner.

### Phase 1: image registry

The `ImageProxy` URL registry moved from `images/index.json` to the
`image_sources` table and the `domain.images` marker in `meta`. The in-memory map
remains the synchronous read path. Scheduled flushes write only changed rows in
one transaction; image bytes remain in `images/` and their eviction policy is
unchanged. No other JSON store moved in this phase.

### Phase 2: hourly counts

Picture and provider-call statistics moved from `image-stats.json` and
`provider-stats.json` to the shared `hourly_counts` table. Their in-memory
hourly buckets remain the synchronous read path. A flush upserts only pairs
changed since the previous write, with generation tracking keeping counts that
change during a write pending for the next flush. The same batch prunes hours
outside the 400-day retention window. A domain marker in `meta` controls the
one-time JSON import, and the old files are moved to `migration-backup/`.

### Backup

Backups are offline in this phase: stop the server, then copy the entire data
directory, including `application.sqlite`, `application.sqlite-wal` and
`application.sqlite-shm` when present. Copying the live database file alone is
not a valid backup of a WAL database. Online backup is deferred.
