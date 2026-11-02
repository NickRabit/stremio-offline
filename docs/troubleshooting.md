# Diagnostics and troubleshooting

## Start here

When something fails, open **Settings → Diagnostics**. The top is server status:
version, uptime, FFmpeg and hardware acceleration, running playback, queue, free
space.

Below that, **Recent problems**: identical messages are grouped with a count, so
repeats stand out. Expanding a group shows the last occurrences with detail. The
full log is behind a button; it can be filtered by level, downloaded, or copied.

The panel starts collapsed. The header shows a "No errors" badge, or a count.
Once expanded, filter by period (hour, day, week, all) and by text in the
message; the filter applies to grouped problems and to the detailed log.

The player reports its own failures to the server, so the log includes what
playback actually died on — hls.js error type, video-element code, repeated
stalling — not only the message shown on screen.

## The log file

The log lives in `/data/app.log`. Past `LOG_MAX_BYTES` (default 5 MB) it is
renamed to `app.log.1`. Records older than `LOG_RETENTION_DAYS` (default 7) are
dropped at start and then every six hours; `LOG_RETENTION_DAYS=0` turns cleanup
off. The Diagnostics page can wipe the log.

The same lines go to standard output, so `docker compose logs` sees them.

Stream addresses are logged as scheme and host only; tokens and passwords are
not logged at all. A refused request records that a session cookie or an AirPlay
token was presented and why it was not accepted, never the credential itself.

A request that arrives without a valid session, and an AirPlay request that is
turned away, are recorded at `WARN`. Both repeat -- a player whose session
expired retries several times a second -- so each is reported once a minute: a
session refusal per address, path and cookie state, an AirPlay one per reason and
path. The next line carries an `alsoRefused` count of the ones held back in
between.

`LOG_LEVEL=DEBUG` adds request and conversion detail, and the scores that
decided a library title was left unmatched.

## When playback keeps stalling

A stall means the player emptied its buffer faster than the server filled it.
For a conversion (remux or transcode) the server measures its own pace every
ten seconds, and when it produces less than about one second of film per second
it logs `The conversion is falling behind playback` (`WARN`, repeated at most
once a minute). The same figures are attached under `server` to every report
the player sends about that session, such as `Playback keeps stalling`:

| Field | Meaning |
| --- | --- |
| `pace` | Seconds of film produced per second over the last check. Below 1 the player will catch up and stall. |
| `position` | How far into the film the conversion has got. |
| `lead` | `position` minus where the player is: how far ahead the server is. |
| `sourceMBps` | How fast the source sent data to FFmpeg. |
| `waitingOnSource` | Share of the proxy's time spent waiting for the source rather than for FFmpeg to take the data, in percent. |
| `ffmpegCpu` | FFmpeg's CPU use, 100 per fully busy core. Linux only. |
| `load` | System load per core. |
| `likelyCause` | `source` (the source sends too slowly), `ffmpeg` (FFmpeg cannot keep up: CPU, or a disk too slow for the segments), `unclear`, or `keeping up`. |

When a conversion ends, `Conversion ended` sums up the whole run. It is `INFO`
when the run fell behind at least once, otherwise `DEBUG`.

`bufferFullError` from hls.js is the opposite case: the browser has no room
left for more of a high-bitrate stream. The player trims and carries on.

## When an addon stops answering

Addon requests — catalog, metadata, streams, subtitles, artwork — go through a
guard that watches each host on its own.

**Concurrency.** At most `ADDON_MAX_CONCURRENT` requests (default 8) reach one
host at a time. The cap exists only to bound a runaway pile-up, not to slow an
ordinary fan-out: a single addon routinely serves a dozen catalogs from one
address. Requests over the cap wait in a queue of `ADDON_MAX_QUEUE` (default
256), large enough to hold a whole search fan-out; beyond it a request is refused
rather than queued forever. Spacing requests apart
(`ADDON_MIN_INTERVAL_MS`) is off by default and worth setting only when a
provider says it is getting too many.

**Circuit breaker.** After `ADDON_BREAKER_FAILURES` consecutive failures
(default 5) the host is taken out of service for `ADDON_BREAKER_COOLDOWN_MS`
(30 s): further requests fail immediately instead of waiting for a timeout, so a
dead source stops holding up search. One request then probes the host once the
pause expires — on success the addon is back in service, on another failure the
pause doubles up to `ADDON_BREAKER_MAX_COOLDOWN_MS` (5 minutes).

Only connection errors, timeouts, HTTP 5xx and 429 count as failures; a plain
404 never takes an addon out. When the source sends `Retry-After`, that decides
the pause instead.

The state is visible in `/api/diagnostics` under `outbound` and in the
Diagnostics panel; every change is logged. `ADDON_GUARD=0` turns the whole guard
off.

Downloads and video playback do **not** go through the guard — a long transfer
would hold a slot, and stopping playback would look like an outage.

## When a title is missing its links

A title's TMDB and ČSFD links are read from Wikidata through one SPARQL query per
title. A cold query that nobody has run for a while takes 15–30 s before Wikidata
caches its own answer; the same query then answers in well under a second. The
first time a title is opened the link can therefore arrive after a noticeable
pause, and a title whose lookup failed stays without it until the next attempt.

A successful answer is kept in `external-ids.json` in `DATA_DIR`, so the query
runs once per title, and an answer that names no ids is remembered for 30 days.
The file is the place to look when the same title keeps losing its links.

Wikidata has a guard of its own, separate from the addon guard, because it is
legitimately slower: two queries at a time, a 1.5 s gap between them and three
failures before the host is taken out of service. A timeout **we** set is not
counted as a failure — the lookup fails, the links stay partial, and other titles
are unaffected. Connection errors, HTTP 5xx and 429 still open the breaker, and
`Retry-After` decides the pause.

The state is visible in `/api/diagnostics` under `metadataOutbound` (the addon
guard keeps its own `outbound` row). `WIKIDATA_GUARD=0` turns the guard off.

In the log the symptom looks like this:

```
WARN Wikidata could not be reached, the links stay partial {"id":"tt0107290","reason":"The operation was aborted due to timeout"}
WARN Wikidata did not answer, the links stay partial {"id":"tt0107290","status":429}
```

## Rolling the image back

Restore the **whole data folder from a backup taken by the target version**,
with the server stopped. Keep the current folder aside first. A newer version
may have migrated both `state.json` and `application.sqlite`; an older image
cannot be assumed to read those formats. The database refuses a schema newer
than it supports. See [Backing up and restoring](backup.md#restoring).

The old `state.json.v1.bak` is the snapshot from before the libraries migration,
not a backup of the current instance. Restoring it alone loses later accounts
and preferences and does not roll back the SQLite domains. Likewise, files in
`migration-backup/` are snapshots from cutover, not current download, follow or
match history. There is no automatic reverse migration to JSON.

## When a state file is damaged

Downloads, follows and library match/episode history normally live in
`DATA_DIR/application.sqlite`. If an existing database cannot be opened, startup
fails rather than switching to stale JSON. Read the error in the log, check disk
access and restore the complete stopped-instance backup when needed. Keep the
failed database and any `-wal`/`-shm` files for diagnosis; deleting the database
to force JSON fallback can discard the current state.

Library operations (`library-ops.json`) and scan progress (`library-scan.json`)
still use JSON. The queue (`downloads.json`) and match history
(`library/<library id>.json`, `library/episodes.json`) use the legacy JSON path
only before migration or when a first start falls back without a database.
For these JSON stores, if a file cannot be parsed at start, its exact bytes are
first copied next to it as `<name>.damaged-<time>-<random>`, the log says so at
`ERROR`, and that store starts empty. Nothing else is lost, and every later
damaged file gets its own copy.

A file that cannot be read at all (permissions, a disk error), or a library
operations file written by a newer version, is left exactly as it is instead.
The queue or the library operations then refuse new work with *The download
queue file could not be read* or *The library operations file could not be
read*. Fix the permissions or restore the file from a backup, and restart.

To put a damaged JSON file back, stop the server, repair the copy and move it
over the original name. This example applies only to an unmigrated JSON queue;
restoring `downloads.json` does not replace a queue already imported into SQLite:

```sh
cp data/downloads.json.damaged-2026-10-05T12-00-00-000Z-a1b2c3 data/downloads.json
```

## Common situations

| Symptom | Where to look |
| --- | --- |
| Downloads fail to write | [Install on Synology → When writes fail](install-synology.md#when-writes-fail) |
| Transcode pegs the CPU | [Hardware acceleration](hardware-acceleration.md) |
| Playback keeps stalling | [When playback keeps stalling](#when-playback-keeps-stalling) |
| The NAS freezes during playback | [Keeping the NAS responsive](install-synology.md#keeping-the-nas-responsive) |
| `unknown libva error` | [When the driver does not start](hardware-acceleration.md#when-the-driver-does-not-start) |
| A stream is listed but will not play | A raw torrent needs a Real-Debrid token, or it is still leeching on their side; see [Real-Debrid](downloads.md#real-debrid-and-other-debrid-services) |
| A queue or library job list came up empty | [When a state file is damaged](#when-a-state-file-is-damaged) |
| Locked out of the account | [Security → Forgotten password](../README.md#security) |
