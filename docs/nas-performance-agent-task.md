# NAS performance follow-up

Reduce durable writes when queuing a series, reduce idle Jellyfin traffic, and let the server accept requests while FFmpeg capabilities are being detected. Investigate Jellyfin request amplification and add-on DNS cost with measurements. Give embedded subtitle seeking its own playback change.

The starting evidence is from main at `1a3e237a`, after PR #889. Read [AGENTS.md](../AGENTS.md) and [the testing guide](testing.md), then verify the relevant paths on current main. Start with bulk admission, then paused reporting. Keep each subsequent change independently reviewable. Put measurements and decisions in the corresponding PR or investigation report. Record the commit, hardware, storage backend, fixture size and cache state so another developer can repeat the comparison. Label local or simulated measurements separately from measurements on the owner's NAS.

## 1. Persist a series admission as a batch

Start in `server/src/routes/downloads.ts` at POST /api/downloads/bulk. Both catalogue and remote series loop over episodes and await `DownloadQueue.admitPending` in `server/src/downloads.ts`. Each accepted job goes through durable admission and wakes the scheduler.

- Exercise the public bulk route with a fixed season, for example 24 episodes. Count admission commits, scheduler wakes and elapsed request time. Isolate admission writes from writes caused by downloads starting.
- Reuse the queue's admission rules for both series origins. Prepare expensive lookups outside the database transaction. At publication, preserve per-owner duplicate detection across concurrent requests, current access checks, episode order, pinned targets and every existing per-episode outcome.
- Persist accepted jobs in one queue write per batch, publish them to the scheduler after success, and wake it once. A batch with zero accepted episodes should produce zero admission writes. Cover each supported persistence backend.
- Verify a mixed season with new, already queued and locally available episodes. Submit overlapping requests, inject a persistence failure and retry. Compare the response, the runnable jobs and the queue reloaded after restart. A failed commit must leave zero jobs from that commit runnable.

## 2. Reduce Jellyfin reports during pause

The remote reporting loop in `web/src/Player.tsx` and Android TV's `PlaybackController.kt` runs every 10 seconds during pause. This is separate from saving local progress. The server's `server/src/media-server-playing.ts` expires a silent session after 60 seconds by default.

- Keep immediate reports for start, pause, resume, seek and stop. During an unchanged pause, use a slower heartbeat with room for timer jitter. Start by testing 30 seconds against the current expiry. Keep the normal playing cadence.
- Count client reports and actual upstream reports over a three-minute pause on web and TV. Use controlled clocks for the regression test. Verify that the session stays paused, a seek while paused updates the position promptly, resume uses the same play session and closing it sends stop. Check server cleanup after a client disappears.

## 3. Measure Jellyfin requests per user action

Trace `openOriginal`, `openDownloadOriginal`, `revalidateDownloadOriginal` and `runtimeFacts` in `server/src/media-server-manager.ts`. The manager already caches session facts, shares some in-flight requests and reuses recent source checks. Explicit download revalidation contacts the provider.

- Count requests by operation during first playback, a seek, and a segmented download including resume. Run cold and warm cases. Distinguish metadata and permission reads from HEAD, byte ranges, playback reports and retries. Use the provider test doubles or a controlled Jellyfin instance. Record counts, bytes transferred, time to first byte and completion time without credentials or signed URLs.
- If a trace shows the same upstream read repeated for the same account, connection generation, operation and source, remove the duplicate at the narrowest shared call site. Check the reason for explicit revalidation before changing its frequency.
- Repeat the trace. Test simultaneous consumers, one consumer cancelling, loss of library access, disabled downloading and a source replaced mid-operation. If the trace only shows necessary requests, report the counts and close the investigation there.

## 4. Measure add-on DNS resolution

In `server/src/security.ts`, URL validation resolves public hostnames. The shared HTTP agent also checks the address when opening a connection. A reused connection can skip the second lookup. A system resolver call and a DNS packet are distinct measurements.

- Compare a cold connection, repeated requests using one connection, concurrent requests to one host and a redirect to another host. Count resolver invocations and new connections and measure lookup latency. Report wire-level DNS counts only when directly observed.
- If repeated lookups materially affect latency, first evaluate sharing concurrent equivalent resolutions. Preserve address-family semantics, validation of candidate addresses, the connection-time address check and validation of every redirect destination. Keep the existing tests for these properties and add coverage for concurrent callers and resolver failures. Record the measured gain before considering a cross-request TTL cache.

## 5. Make subtitle reads follow an actual seek

Start in `server/src/player-sidecars.ts` and trace the seek event through each consuming player. Each reader currently issues a revision. A request carrying an old revision can receive a 404. A quiet interval in a sparse subtitle track is valid playback.

- Measure time from seek to the first **correct** cue and count reader starts. Use embedded subtitles with known cue times, including a long silent interval.
- Use the player's seek event and the reader's known coverage to decide whether to reuse or reposition the reader. Define how the client obtains a replacement revision before it polls again and how late responses from the previous reader are discarded.
- Exercise forward, backward and rapid consecutive seeks, direct play and transcode, and a subtitle track change during a seek. Sparse subtitles should cause zero restarts during ordinary playback. Verify cue timestamps and continued polling after the seek.

## 6. Start FFmpeg capability detection after listen

`PlaybackManager.load()` in `server/src/playback.ts` prepares the playback directory and probes FFmpeg and platform encoders. `server/src/index.ts` awaits the entire method before listening.

- Complete directory preparation, fallback selection and cleanup before sessions can create files. Start one shared capability probe after listen. Operations that need its result should await that same probe. Make pending, unavailable and failed capabilities distinguishable wherever that affects playback decisions.
- Measure process start to successful /api/status and time to first playable frame, for direct play and first transcode. Exercise slow probing, missing FFmpeg, hardware probe failure, simultaneous first plays and shutdown during probing. Verify that an ordinary API request completes while a deliberately delayed probe is still pending.

## Storage and credential decisions

Keep SQLite at `synchronous=FULL`, as specified in [the SQLite storage decision](adr/0001-sqlite-storage.md). Measure the bulk admission gain with that setting. With WAL and NORMAL, power loss can roll back acknowledged transactions, and the loss window has no fixed duration in seconds.

Keep decrypted Jellyfin credentials scoped to the operation. `server/src/media-server-secrets.ts` deliberately rereads the key and envelope so removing or replacing them takes effect on the next operation. If vault I/O shows up in traces, count repeated reads inside one logical operation and look for redundant session creation there.

## Delivery

For each implementation PR, include a repeatable before/after comparison, the user-visible behavior covered by regression tests, and the checks actually run. Follow repository rules for versioning, rebasing, Docker health verification and merge authorization. For a measurement-only investigation, report the evidence and decision, including any hardware or workload that remains unverified.
