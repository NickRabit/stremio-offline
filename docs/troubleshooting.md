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
