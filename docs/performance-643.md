# Polling and write-amplification changes

This note records the synthetic measurements for issue #643. They are application-level
measurements, based on the same fixtures and code path before and after the change. They do not
claim physical disk bytes, NAS CPU time, or a fixed speed-up on a particular Synology model.

## Results

### Download artwork polling

Fixture: 100 unchanged completed targets, one poll every 5 seconds for 5 minutes, and a 30-second
freshness window. The counter is the number of `currentTargetArtwork` discovery loads, not the
number of ordinary library walks.

| Revision | Discovery loads | Reduction |
| --- | ---: | ---: |
| `origin/main` before the change | 6,000 | -- |
| This branch | 1,000 | 83.3% |

Concurrent callers share one load, and a target with no artwork is cached as a negative result
for the same window. Internal library, metadata, path, and artwork mutations clear the cache.
Completion changes add a new revision to the key immediately. The 30-second expiry remains the
bounded refresh for external changes on mounts that do not deliver watcher events. A lookup that
itself stops responding is released after two seconds and returns the job's captured artwork, so
a dead mount cannot hold the download list open indefinitely. The timed-out lookup is retained
until the filesystem call settles, rather than starting another blocked call on every poll.

### Image and provider statistics

Both stores used a one-second write debounce. A sustained event stream therefore produced up to
60 complete-history writes per minute. The write interval is now 45 seconds, while counters and
summaries remain current in memory.

| Revision | Writes per minute | Reduction |
| --- | ---: | ---: |
| `origin/main` before the change | 60 | -- |
| This branch | 1.34 | 97.8% |

Orderly shutdown flushes dirty data. A failed write leaves the state dirty and is retried by the
next scheduled flush as well as by shutdown. An abrupt crash can lose up to 45 seconds of recent
statistics; queue admissions, configuration, and download state keep their existing durability
rules.

### Gallery serving

A gallery response used to schedule a full artwork-index rewrite two seconds after every
last-use update. Repeated reads now share a ten-minute lazy write, while structural artwork
changes keep the prompt two-second schedule and shutdown still flushes a lone touch.
A failed index write is retried after a bounded minute rather than waiting for an unrelated write.

The gallery manifest now versions each image with both its size and replacement-sensitive mtime
stamp. A matching version is private and immutable for a year; an unversioned or stale address
is `private, no-store`. This keeps browser caching safe while ensuring a replaced picture is
handed out under a new address even when the filesystem rounds its old and new mtimes together.
Every completed poster or frame write, and every generated-art removal, clears the download
artwork cache so the next poll sees the structural change immediately.

### Poster logging

Routine successful poster responses moved from `INFO` to `DEBUG`. At normal `INFO` verbosity,
catalogue browsing now appends no success line per picture. Warnings and errors are unchanged,
and `DEBUG` retains the diagnostic fields without exposing source URLs.

### Active download checkpoints

The queue already waited 1.5 seconds between progress checkpoints. With a 5,000-job completed
history, one serialized state snapshot was 1,935,562 bytes in the synthetic fixture.

| Revision | Checkpoints per minute | Serialized bytes per minute |
| --- | ---: | ---: |
| Before this branch | 40 | 77,422,480 |
| This branch (10-second interval) | 6 | 11,613,372 |

That is 85% fewer application-level serialized bytes during uninterrupted progress. Admission,
completion, pause/cancel, retries, and other terminal transitions remain on their immediate,
error-reporting writes. On restart, an actual `.part` file size and segment records determine
where transfer resumes; the relaxed window can make the pre-start display up to ten seconds old,
but does not make the transfer restart from zero. A segment plan is written before its part file
is allocated to full size, and the first Real-Debrid torrent id is written immediately because
every later poll needs that id.

## Reproduction

The deterministic tests that guard the scheduling and cache behavior are:

```sh
npx tsx --test \
  server/src/value-cache.test.ts \
  server/src/artwork-cache.test.ts \
  server/src/image-stats.test.ts \
  server/src/provider-stats.test.ts \
  server/src/routes/content.test.ts
```

The serialized queue fixture used the same 5,000-row shape for both intervals:

```sh
node -e 'const jobs=Array.from({length:5000},(_,i)=>({id:`job-${i}`,title:`Movie ${i}`,status:"completed",target:`lib_01234567/Movies/Movie ${i}/Movie ${i}.mkv`,received:4_000_000_000,total:4_000_000_000,speed:0,ownerUserId:"usr_00000001",createdAt:"2026-01-01T00:00:00.000Z",updatedAt:"2026-01-02T00:00:00.000Z",completedAt:"2026-01-02T00:00:00.000Z"})); const bytes=Buffer.byteLength(JSON.stringify(jobs,null,2)); console.log(bytes, bytes*40, bytes*6);'
```

## Deferred validation

The original `live.cpuprofile` describes `origin/main` before #642 and is not a post-change
profile. A comparable CPU, latency, and physical-I/O run still needs the same NAS or a controlled
container fixture, the same media, and the same warm-up. This change was validated with the full
server test suite, TypeScript builds, and Docker health checks; visual/E2E tests are deferred
until the functional change is stable.
