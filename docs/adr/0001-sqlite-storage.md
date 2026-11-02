# ADR 0001: SQLite storage runtime and layout

- Status: Accepted
- Date: 2026-11-01

## Context

The application currently persists several domains as whole JSON files. The
selective migration plan in issue #644 moves one domain at a time so each move
can be tested independently. This ADR records the shared storage decisions and
the storage infrastructure and migrated domains. Phases 1 through 2c move
image links, statistics, activity and caches; phases 3 through 5 move downloads,
follows and library metadata. These shipped together in #679 (0.7.7).

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

Startup checks whether `application.sqlite` exists before choosing the storage
mode. If it exists and cannot be opened, start-up fails; the server must not
fall back to JSON because migration may already have moved the authoritative
data into SQLite. JSON fallback is allowed only when the database file does not
exist, as on a first run with a runtime that cannot use SQLite.

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

### Phase 2b: activity and traffic

Activity history and traffic events moved from `activity.json` and `stats.json`
to the `activity` and `traffic_events` tables. Their in-memory arrays remain the
synchronous read path. A flush inserts only new events; activity trimming and
traffic trimming or hourly compaction are deletes and inserts in the same
batch, limited to the rows that changed. The one-time JSON imports use the
`domain.activity` and `domain.traffic` markers and move the old files to
`migration-backup/`.

### Phase 2c: caches

Library file facts and TMDB id mappings moved from `library/file-facts.json` and
`tmdb-ids.json` to the `file_facts` and `tmdb_ids` tables. Their in-memory maps
remain the synchronous read path. A flush upserts only dirty keys and deletes
rows for evicted or trimmed keys in one batch. The one-time JSON imports use the
`domain.fileFacts` and `domain.tmdbIds` markers and move the old files to
`migration-backup/`. Both are caches: an unreadable JSON file or table row is
discarded and rebuilt by probing or querying the source again.

### Phase 3: download queue

Downloads moved to `download_jobs`, retaining job order and the existing
serialized admission and recovery contracts. Writes upsert changed jobs and
delete removed ones in a transaction. The `domain.downloads` marker controls
the one-time import of `downloads.json` into SQLite; the old file moves to
`migration-backup/` after cutover.

### Phase 4: followed series

Followed series and automatic-download decisions moved to `follows`, retaining
order and writing only changed records. The `domain.follows` marker controls
the one-time import of `follows.json`, which then moves to `migration-backup/`.
Follow/queue reconciliation is still required: sharing a database does not make
their separate mutations one transaction.

### Phase 5: library metadata

Matches and suggestions moved to `library_meta`, keyed by library, record kind
and relative path; shared episode metadata moved to `library_episodes`.
Per-library `domain.libraryMeta.<id>` markers and `domain.libraryEpisodes`
control the imports from `library/<id>.json` and `library/episodes.json`.
Writes update changed records rather than rewriting the complete collections;
the imported files move to `migration-backup/`.

Accounts, grants and settings remain in `state.json`; the per-account personal
collections moved in phase 6. Library operations and scan journals remain JSON.

### Phase 6: personal state

The five hot personal collections -- favourites, progress, the watchlist,
watched-series markers and remote-media state -- moved from `state.json` to the
`personal_rows` table. The in-memory `UserData` shape is unchanged, so callers
keep using the existing synchronous accessors and mutators.

The one-time import writes all rows and the `domain.personal` marker in one
transaction, after copying the state file to
`migration-backup/state-<importedAt>.json`. The copy is taken after the boot's
account migration has been saved, not from the original bytes: a pre-accounts
file mints a new account id each time it is loaded, so only the migrated copy
puts the rows back under the id they are keyed by. While personal data still sits
at the top level with no account (an install that has not claimed it yet), the
import is deferred so the claim lands in `state.json` in one write. Once the marker exists, SQLite rows
are authoritative for those collections. A marker-present load ignores any hot
fields left in `state.json` and forces their removal on the next write.

Every write compares the hot fields with the persisted row map and the cold
state with the last written cold JSON. Only changed rows and a changed cold file
are written. The cold file is written first, then the rows. `state.json` names
the accounts, so it is the commit point for account-level changes. If the JSON
write fails, nothing was written and memory is rolled back. If the JSON lands
and the row batch fails, memory is rolled back and deferred retry debt rewrites
both files from memory.

A load never deletes rows. Rows of an account the loaded `state.json` does not
name are neither loaded nor removed: account ids are random and never reused, so
they cannot surface under another account, and a missing, replaced or older
`state.json` can therefore never destroy the only copy of anybody's data. A
deleted account's rows go with the write that deletes it. A start that finds no
`state.json` imports nothing and writes no marker, so the personal data stays in
the file until a start that reads it. A start that finds the marker but no
`state.json` refuses to start: carrying on would come up with no accounts, and
an install with no accounts offers first-run setup to whoever reaches it.

A few operations change both files: account creation and deletion, media-server
connection or library removal, settings import, and library deletion. Such a
write journals its row changes inside the `state.json` it commits
(`personalPending`), then writes the rows, then rewrites `state.json` without
the journal. If the process stops before the rows land, the next start replays
the journal (upserts and deletes are idempotent) and the change is complete, so
nothing is left half done with no request left to retry it. A write that changes
only rows writes no journal and no `state.json`. Rows are keyed in memory by a
JSON array, never by a separator, so map keys may hold any character. The
opposite order (rows first) was rejected because a failed JSON write after the
rows had committed could leave an account whose rows were already deleted.

### Backup

Backups are offline in this phase: stop the server, then copy the entire data
directory, including `application.sqlite`, `application.sqlite-wal` and
`application.sqlite-shm` when present. Copying the live database file alone is
not a valid backup of a WAL database. Online backup is deferred.
