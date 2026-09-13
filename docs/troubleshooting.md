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
not logged at all.

`LOG_LEVEL=DEBUG` adds request and conversion detail.

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

## Rolling the image back

An upgrade to a build with libraries rewrites `state.json`: stored paths gain a
library id in front of them (`lib_ab12cd34/Show/01 serie/01.mkv`) and
`schemaVersion` becomes `2`. An older image reading that file cannot resolve the
paths, so the library would come up with no match history and no thumbnails.

The migration copies the file it found to `state.json.v1.bak` in `DATA_DIR`
before touching anything. To roll back, stop the container, copy that file over
`state.json` and start the old image:

```sh
cp data/state.json.v1.bak data/state.json
```

Nothing in the library itself is renamed or moved by the migration, so a
rollback loses nothing but the time spent on the newer build.

## Common situations

| Symptom | Where to look |
| --- | --- |
| Downloads fail to write | [Install on Synology → When writes fail](install-synology.md#when-writes-fail) |
| Transcode pegs the CPU | [Hardware acceleration](hardware-acceleration.md) |
| The NAS freezes during playback | [Keeping the NAS responsive](install-synology.md#keeping-the-nas-responsive) |
| `unknown libva error` | [When the driver does not start](hardware-acceleration.md#when-the-driver-does-not-start) |
| A stream is listed but will not play | A raw torrent needs a Real-Debrid token, or it is still leeching on their side; see [Real-Debrid](downloads.md#real-debrid-and-other-debrid-services) |
| Locked out of the account | [Security → Forgotten password](../README.md#security) |
