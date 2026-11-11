# Agent task: stop writing film that nobody will watch

Follow-up to issue #682 (conversion buffer on the NAS disk), analysed on
`main` at `9d9bc797` (2026-11-10, version 0.7.88). Read `AGENTS.md` first; it
governs branches, pull requests, version bumps and the Docker check. Read
`docs/playback.md` and `docs/playback-buffer-spec.md` before touching the
code. File locations below are from that revision and will drift.

## Why

A remux or transcode writes the film to `DATA_DIR/playback` (or
`PLAYBACK_DIR`) as 2-second fMP4 HLS segments. Three kinds of bytes land on
the disk:

1. **The film that is watched.** Written once. Only a RAM buffer removes it;
   that is not part of this task.
2. **Run-ahead that is never watched.** A remux reads at 3x, a transcode at
   1.5x, and neither stops while the player is paused. A session lives as long
   as the tab is open, because the player pings every 30 s
   (`PlaybackManager.attended`, `reap`, `ORPHAN_MS`). A paused tab therefore
   writes the whole rest of the film.
3. **Run-ahead thrown away by a seek.** Every seek outside the produced part
   starts a new generation at the target; what the old one produced beyond the
   playhead is deleted unseen.

This task removes kinds 2 and 3. For a two-hour film at 8 Mbit/s (about 7 GB):

| Case | Today | With a 5-minute lead cap |
| --- | --- | --- |
| Paused at minute 10, tab left open | whole film, 7 GB | 15 minutes, about 0.9 GB |
| Seek from minute 10 to minute 60 | 20 minutes discarded | at most 5 minutes discarded |
| Watched to the end, no seeks | 7 GB | 7 GB (unchanged) |

Pausing the producer was deferred on 2026-11-02 because a stalled source
connection could end the film. That risk now has three safety nets, all on
`main`: the source proxy resumes a broken transfer with a Range request
(`SOURCE_RESUMES` in `server/src/routes/playback.ts`); a conversion that ends
short or fails is restarted by the client at its position (#792,
`GET /api/playback/:id/status`); a session the server closed is replaced by
the web player (#794) and by Android TV (`onDeadSession`).

## What two experiments showed

Both ran in a disposable container from the local image (FFmpeg 6.1.1, no
network), remuxing a 300 s test file with the same HLS arguments as
`PlaybackManager.args` and `-readrate 3 -readrate_initial_burst 30`.

- **`SIGSTOP` / `SIGCONT` works, but the resume is a burst.** Stopped at 10 s
  with 29 segments; still 29 after 30 s; 2 s after `SIGCONT` there were 77.
  `-readrate` is measured against the wall clock since start, so FFmpeg makes
  up the whole pause at full speed. A lead cap enforced by a slow timer will
  be overrun; it has to be checked as output is produced.
- **HLS over local HTTP `PUT` gives no backpressure.** While the server held
  its answer to one segment for 25 s, FFmpeg delivered 44 more. Do not build
  on delaying the answer.

## Ground rules for every item

- Failing test first, then the change. Server logic gets `node:test` cases
  beside `server/src/playback.test.ts`; the tests that drive the real `run`
  through a fake FFmpeg (`FFMPEG_PATH`) are the model. Web behaviour gets
  Vitest cases in `web/src/Player.test.tsx`; Android TV gets cases beside
  `PlaybackControllerTest.kt`.
- One pull request per item, merged in order. Read `main`'s version and tags
  right before any version bump.
- Reliable playback outranks saved writes. Whenever the two conflict, keep
  the conversion running.
- No new periodic writes. The NAS must not get a timer that writes to disk or
  to SQLite; one log line per session is the budget for item 1.
- A new `/api` route must be added to `USER_ALLOWED` in `server/src/roles.ts`
  (not expected here: items 2 and 3 extend the existing ping).
- New user-visible text goes through `web/src/i18n/en.ts` and `cs.ts`; Android
  TV strings come from `strings.keys`. Run `lintDebug` before pushing TV
  changes. Android TV must keep working on Android 9 and 11 (minSdk 24).
- No test traffic to third-party media servers. Simulate a remote source with
  a local HTTP server; for a real media server use the local spike Jellyfin.
- Do not redeploy the shared container on port 8090. Verify on a side port
  and remove your container afterwards.

## Out of scope

- A RAM or `tmpfs` buffer, deleting segments behind the playhead, rolling
  playlists. They need item 2 in production first and a separate design.
- Changing `-readrate`, the HLS arguments, segment length, `ORPHAN_MS`,
  `UNCLAIMED_MS`, `IDLE_MS` or `RETIRED_MS`.
- Progressive fMP4 through a pipe, and HLS over HTTP `PUT`.
- Direct play. It writes nothing.

## 1. Measure what is written and what is fetched

### What is missing

Nothing in the log says how much a session wrote or how far the client got.
The dev instance's log cannot answer how much run-ahead is wasted, and the
Synology was never measured. The owner needs this number to judge item 2 and
a later RAM buffer.

### Required behaviour

- Track per session, in memory only: bytes written and seconds produced per
  generation, and the furthest position the client fetched. The client's
  position is known on the server already: every segment request passes the
  playback route (`/api/playback/:id/:generation/...` in
  `server/src/routes/playback.ts`). Derive the segment's time from the
  playlist or the segment index; do not assume a file name pattern without
  checking what FFmpeg writes.
- When a session stops, write one `INFO` line with: mode, number of
  generations, seconds produced, bytes written, seconds fetched, seconds
  produced but never fetched, and how the session ended (closed by the
  player, orphaned, idle).
- Bytes written must not cost disk reads on a timer. Prefer the `-progress`
  stream (`ProgressReader` in `server/src/conversion-pace.ts`; check whether
  `total_size` is usable with the HLS muxer) or a single directory read when
  a generation is retired or the session stops.
- No change in what clients see or receive.

### Tests

- A session driven through the fake FFmpeg with segment requests up to a
  known index logs the expected produced, fetched and never-fetched values.
- A seek adds a generation; the summary counts both.
- A direct session logs no conversion summary.

## 2. Cap how far the conversion runs ahead of the client

### Required behaviour

- While the produced position is more than a high mark ahead of the furthest
  fetched position of the current generation, the conversion is suspended
  (`SIGSTOP`). When the lead falls under a low mark it is resumed
  (`SIGCONT`). Starting values: high 300 s, low 180 s.
- The produced position comes from the `-progress` stream the monitor already
  reads, checked on every update, so the resume burst is stopped again within
  about a second. A timer alone is not acceptable (see the experiment).
- Controlled by one environment variable holding the high mark in seconds;
  `0` or unset means off. **Ship it off by default.** The default flips in a
  separate, later pull request once the gates below have passed on the
  owner's instance. Document the variable in `docs/playback.md` and wherever
  the other `FFMPEG_*` / `PLAYBACK_DIR` variables are listed.
- On a platform without `SIGSTOP` (Windows) the feature is off; say so once
  in the log at start if the variable is set.

### Rules that must hold

- Never suspend before the client has fetched its first segment of the
  generation, and never while a restart (seek, track, escalate) is in flight.
- Resume before every kill. A stopped process does not act on `SIGTERM` until
  it is continued; `kill` / `killChild` (`server/src/playback.ts`) and the
  shutdown path must send `SIGCONT` first. Test that no FFmpeg survives a
  session stopped while suspended.
- A suspended conversion is still `running` for `status()`, is still a usable
  fallback for a failed seek (`usableFallback`), and must not be reported as
  slow: `ConversionMonitor` must not log "behind" warnings, count suspended
  time into the pace, or produce a quality hint from it. Log the suspend and
  the resume at `DEBUG`, and add the total suspended time to item 1's
  summary.
- When the session falls back to the previous generation after a failed seek,
  that generation's lead is evaluated again; it must not stay suspended with
  the client at its edge.
- A seek slightly past the produced edge must not get slower than today. The
  web player waits for the producer there (`planSeek` returns `wait`,
  `waitForSeekable` in `web/src/player-hls.ts`) without asking the server, so
  a suspended producer would let that wait time out. Either let the client
  tell the server what it is waiting for (the existing ping is the natural
  carrier) or resume on a signal the server already has; show with a test
  that the wait is served. Android TV sends every HLS seek to `/seek`, so it
  is not affected; confirm that in the code.
- Subtitle sidecars and previews are independent readers; do not suspend
  them.
- The source transfer behind a suspended FFmpeg stalls. `onStop` in
  `server/src/index.ts` destroys the session's media responses; confirm with
  a test that a session stopped while suspended leaves no open upstream
  connection and no response waiting on `drain`
  (`server/src/routes/playback.ts` has two `await once(res, "drain")` without
  an abort signal).

### Tests

- Fake FFmpeg that reports progress: the process is suspended at the high
  mark, resumed when segment requests bring the lead under the low mark, and
  the session ends normally with `status` `complete`.
- After a resume the fake FFmpeg reports a jump of several minutes at once;
  it is suspended again on the next progress update.
- Stop, seek, track change and server shutdown while suspended: no process is
  left, the new generation starts, the old directory is removed.
- Feature off: no signal is ever sent (guards today's behaviour).
- Real FFmpeg in the image, local file: paused playback for two minutes
  produces no new segment files; resumed playback continues without a gap in
  the segment sequence and plays to the end.
- Remote source simulated by a local HTTP server that closes a connection
  idle for 20 s: after a longer suspension the conversion either continues
  (proxy resume) or ends short and the client restarts at its position. The
  film must not end and must not show an error.
- Web end-to-end (Playwright, like `e2e/tests/player-session-lost.spec.ts`):
  play, pause for longer than the high mark allows, play again, then seek
  beyond the cap; playback continues each time.

### Gates before the default may flip

Run with the variable set on a side-port container and report the numbers in
the pull request:

- Start time and seek time for a local remux and a local transcode, feature
  off against on. No measurable difference at start; a forward seek beyond
  the cap is a restart and its time is reported.
- A 30-minute pause on a local source and on the local spike Jellyfin, then
  resume: playback continues.
- Hardware conversion if the test machine has it; otherwise state that it was
  not covered and leave the default off.
- Android TV on the API 28, 31 and 34 emulators with a converted session:
  pause 10 minutes, resume, seek forward and back.
- Item 1's summary before and after for the same viewing script: the
  never-fetched seconds must drop to at most the high mark per generation.

## 3. Release a converted session after a long pause

### Why

With item 2 a paused session stops writing, but it still holds an FFmpeg
process, its memory, a hardware encoder slot and, for a remote source, a
connection that a quota-limited media server may count as an active stream.
Clients recover from a closed session on their own now.

### Required behaviour

- The ping carries the player's paused state (web `api.pingPlayback`, TV
  `ApiClient.pingPlayback`, route `POST /api/playback/:id/ping`). A ping
  without the field keeps today's meaning, so an older client is never
  released early.
- A converted session whose client has reported paused without interruption
  for longer than a limit is stopped like an orphan, with its own log line.
  Starting value 30 minutes, one environment variable, `0` means never.
  Direct sessions are left alone.
- Any sign of playing resets the clock: a ping reporting playing, a seek, a
  track change, a segment request beyond the furthest fetched one.
- When the viewer presses play afterwards, the web player's lost-session
  recovery (#794) and the TV's `onDeadSession` start a new session at the
  same position with the same audio track and quality. Check both paths with
  the session released while paused; fix what does not hold. The viewer must
  see buffering, never an error, and the saved progress must be unchanged.

### Tests

- Server: paused pings for longer than the limit stop the session; one
  playing ping in between keeps it; pings without the field never trigger it.
- Web (Vitest and the existing lost-session end-to-end test, extended): pause,
  server releases, play resumes at the paused position.
- Android TV (`PlaybackControllerTest`): the same, including the paused state
  being sent with the ping.

## Done means

- Three pull requests merged in order, each with tests seen failing first.
- `docs/playback.md` describes the summary line, the lead cap with its
  variable and platform limit, and the paused release.
- A comment on issue #682 with the measured before/after numbers from item 1
  and the gate results from item 2, so the owner can decide on the default
  and on the RAM buffer.
