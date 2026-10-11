# Bounded playback storage: analysis and implementation brief

Status: proposed, not implemented. Analysis date: 2026-10-11. Repository baseline:
`5536b75f7cba43a0808a1395ab5ac69ef49ca22c` (`main`).

## Decision

Pursue an opt-in, byte-bounded playback buffer backed by Linux `tmpfs`, subject
to the compatibility gates below. Do not deploy a RAM mount alone or switch
FFmpeg to `delete_segments` alone. Neither provides a safe bounded buffer for
this player. Preserve the existing disk mode as the default and rollback path.

The target use case is a Synology DS920+ with 20 GB RAM playing large local and
remote films. A 50 GB source must not require 50 GB of temporary RAM. Reliability
of seeking, pause/resume, subtitles, and recovery from refused source requests
takes priority over reducing writes. This PR contains the specification and a
disposable experiment, with no playback behavior changes.

The difficult work is playback coordination, not the RAM filesystem. A local
source prototype is feasible now. Remote-source support is a separate release
gate: pausing a writer can leave its upstream connection idle long enough to be
closed, and reopening it can be refused. A local-only prototype does not solve
the remote-addon use case and must not be advertised as doing so.

## What the code actually does

| Area | Current behavior | Consequence for bounded storage |
| --- | --- | --- |
| `server/src/playback.ts`: constructor, `load`, `spawnAt` | Uses `DATA_DIR/playback/<session>/<generation>`; removes the playback root on startup | Configurable storage must use a dedicated child directory, never remove a mount root or an arbitrary configured directory |
| `PlaybackManager.args` | fMP4 HLS, nominal 2 s segments, `EVENT`, list size zero, atomic temporary files | Completed segments accumulate for the whole generation; keyframes determine actual remux segment lengths |
| Input pacing | Default read rates: remux 3x, transcode 1.5x, initial burst 30 s when supported | A speed ratio is not a bound on lead, bytes, or paused playback; lowering it to 1x still reads during a user pause |
| `routes/playback.ts`: segment route | Serves files; an absent file returns 404 | There is no transparent regeneration of evicted segments |
| `web/src/player-hls.ts`: `planSeek`, `waitForSeekable` | Checks a target against the end of the produced interval; only a negative relative target means it is before the interval | A positive target can become unavailable after eviction; the start and holes must also be checked |
| `web/src/Player.tsx`: `seekTo` | Uses `generation offset + video.currentTime`; waits up to 8 s for a nearby target, otherwise restarts | Window movement must not change the absolute film position or strand a catch-up wait behind a paused producer |
| Web HLS buffer | 25 s target, 45 s maximum time setting, 60 s back buffer, 40 MB size setting | Browser memory is separate from server storage; these settings do not bound FFmpeg output |
| `/ping` and clients | Empty heartbeat every 30 s; progress saves are separate, keyed by film | The server does not have authoritative generation-specific playhead/pause state for eviction |
| Restart/fallback | Old FFmpeg and output survive while replacement is attempted; failed seek can return `seekRestored` | A seek may temporarily need two writers, two output sets, and two source connections; reserve capacity before attempting it |
| Retirement | Successful replacement grants 15 s plus a wait for the old writer to exit | Per-segment retention needs its own rules; this timer is not proof that an individual segment is safe to delete |
| Android TV | Direct native playback where supported; HLS seeks use the server with debounce | Preserve direct play and the TV's offset/subtitle mapping; do not enable a changed HLS contract for old clients |

Direct play generates no HLS output and already avoids these temporary writes.
Downloads, thumbnails, subtitle extraction, the proxy's small range cache, and
browser buffers are different resource owners and are outside the initial
buffer budget. Count their RAM separately when sizing the container.

`docs/testing.md` retains an older description of keeping a closed player warm
for 45 s. At this baseline DELETE calls `stop` and removes the session. Do not
design new eviction around that historical paragraph; use the actual lifecycle.
AirPlay is currently disabled in the custom player, although receiver routes
remain. This work must not re-enable it.

## Prior regressions that constrain the design

- `3bf75b6`: retirement starts only after a successful seek; fallback stays
  reachable throughout both attempts. Twelve failed seeks must not accumulate
  timers that later delete the active generation.
- `d6757fe` and `66cdf51`: output must not be removed while its writer is alive;
  cleanup must distinguish a killed/abandoned process from a live writer.
- `25cf194` and `d4a7868`: a confirmed failed seek resumes the actual fallback,
  preserves user pause, and shows a temporary notice instead of an error curtain.
- `49f9182` and `3dca403`: a remux can have buffered media and still stick near
  its first frame. Preserve the three-segment start reserve, start alignment,
  and narrowly scoped recovery while testing a changed playlist.
- Source retries and subtitle-reader release exist because providers limit
  connections. Periodically restarting FFmpeg to keep memory low would put
  pressure on exactly the behavior these fixes protect.

Relevant regression suites are `server/src/playback.test.ts`,
`server/src/routes/playback.test.ts`, `web/src/player-hls.test.ts`,
`e2e/tests/player-seek-resume.spec.ts`, `e2e/tests/player-seek-cancel.spec.ts`,
the embedded-subtitle tests, and Android's `PlaybackControllerTest.kt`.

## How other projects approach it

### Jellyfin: separate production, retention, and missing-segment handling

Inspected source revision: `a45d1415d4da7c9b69d6e7a6895fc63d2d68e8f1`;
this is a source snapshot, not a claim about every installed release.

- [EncodingOptions](https://github.com/jellyfin/jellyfin/blob/a45d1415d4da7c9b69d6e7a6895fc63d2d68e8f1/MediaBrowser.Model/Configuration/EncodingOptions.cs):
  throttling and deletion default to false; configured default thresholds are
  180 s of throttle delay and 720 s of retention.
- [TranscodingThrottler](https://github.com/jellyfin/jellyfin/blob/a45d1415d4da7c9b69d6e7a6895fc63d2d68e8f1/MediaBrowser.Controller/MediaEncoding/TranscodingThrottler.cs):
  compares generated position with download position and sends FFmpeg pause/
  resume commands. Download position is not necessarily the viewer's playhead.
- [TranscodeManager](https://github.com/jellyfin/jellyfin/blob/a45d1415d4da7c9b69d6e7a6895fc63d2d68e8f1/MediaBrowser.MediaEncoding/Transcoding/TranscodeManager.cs):
  the throttling eligibility check requires a local file of at least five
  minutes. Segment cleaning can also apply to HTTP inputs. Pause support is
  checked against the FFmpeg implementation/version.
- [TranscodingSegmentCleaner](https://github.com/jellyfin/jellyfin/blob/a45d1415d4da7c9b69d6e7a6895fc63d2d68e8f1/MediaBrowser.Controller/MediaEncoding/TranscodingSegmentCleaner.cs):
  periodically deletes sufficiently old served segments behind download
  position, with a delay before deletion.
- [DynamicHlsController](https://github.com/jellyfin/jellyfin/blob/a45d1415d4da7c9b69d6e7a6895fc63d2d68e8f1/Jellyfin.Api/Controllers/DynamicHlsController.cs):
  a missing segment can start or reposition a transcoder under a playlist lock;
  active requests are coordinated before replacing the job.

The transferable idea is coordinated retention and production. Copying the
cleaner alone would turn valid requests into 404s in our file-serving route.
Jellyfin's interactive FFmpeg controls are not a portable contract for the
stock Debian FFmpeg or all bundled desktop encoders we use.

### Plex: configurable storage and throttle lead, not a documented RAM bound

[Plex's official transcoder settings](https://support.plex.tv/articles/transcoder/)
expose a temporary directory and a throttle buffer in seconds. The same page
asks for free temporary space approximately the source size plus 100 MB.
Its public documentation does not establish a strict global byte bound or
prove that an arbitrary RAM disk cannot fill. We did not inspect proprietary
implementation details. Treat RAM-disk setup advice as storage placement, not
as proof of a safe bounded cache.

### HLS and FFmpeg are the underlying constraints

[FFmpeg's HLS documentation](https://ffmpeg.org/ffmpeg-formats.html#hls-2)
says that `EVENT` forces an unlimited list and that segment cuts occur at
keyframes. [RFC 8216, sections 6.2.1 and 6.2.2](https://datatracker.ietf.org/doc/html/rfc8216#section-6.2.1)
restricts mutation of EVENT playlists and requires a retention interval after
removing a segment URI from a live playlist. A server cannot safely unlink a
file as soon as it publishes a shorter playlist. A stalled rolling playlist
also needs client verification: live clients expect advancement and may try to
catch up to the edge after a pause.

## Reproducible experiment

The manual script [playback-buffer.mjs](../scripts/experiments/playback-buffer.mjs)
uses generated media only. It runs in a disposable container, without network
or host mounts; input and output are inside a 128 MiB tmpfs. It does not touch
the running application, user media, or playback directories. Build the local
image first if it is unavailable, then run from the repository root:

```sh
docker run --rm -i --network none --tmpfs /lab:rw,size=128m \
  --entrypoint node stremio-offline:local --input-type=module \
  < scripts/experiments/playback-buffer.mjs
```

Observed with Docker Engine 27.3.1, FFmpeg `7.1.5-0+deb13u1`, Node 22, Linux
container on the development Mac. Local image ID:
`sha256:b9eef7e6a251fe85fee627a0193aa10958e8ebf027bbff414b87c9e30704b0e3`.
Fixture: 40 s of 160x90 H.264 at 10 fps, copied into fMP4 HLS.

| Experiment | Observed result | Interpretation |
| --- | --- | --- |
| EVENT + list size 3 + `delete_segments` | All 20 two-second segments remained; sequence 0; 792,078 bytes including playlists/init | Adding deletion flags to today's playlist does not bound storage |
| Sliding list size 3, deletion threshold 1 | Three listed segments, four files, sequence 17; 157,505 bytes | Producer-driven deletion bounds count but removes media without consulting a viewer |
| A hypothetical paused reader still requesting segment 0 | Segment 0 absent; published window now starts at 34 s | A reader left behind would get a missing file; this is a filesystem observation, not a browser playback test |
| Same sliding settings, source with ten-second GOP | Three listed segments of 10 s each; four files, 747,312 bytes | Neither segment count nor nominal `hls_time=2` is a byte/time guarantee |
| SIGSTOP/SIGCONT during local remux | Output unchanged during 500 ms observed pause; resumed to 20 segments and decoded through EOF | Linux process suspension can stop this local producer; remote timeout, GPU, and long-pause behavior remain unproved |
| Delete the empty tmpfs mount root using Node `rm` | `EBUSY` | Mounting directly at today's `DATA_DIR/playback` would conflict with startup root removal |

The script asserts these properties. Timing-dependent segment counts during
suspension are informational. This is not a benchmark, a measurement of NAS
disk wear, a browser compatibility result, or a test on QuickSync/DS920+.

## Options considered

| Option | Verdict |
| --- | --- |
| Move today's output to tmpfs | Reject as the solution: a full film or concurrent sessions can exhaust it; direct mount also needs startup cleanup changes |
| Delete old files on a timer | Reject: age is unrelated to pause, download completion, fallback ownership, or stale playlists |
| FFmpeg sliding list plus deletion only | Reject: production can outrun viewing and erase its current position |
| Lower `readrate` | Can reduce bursts; cannot impose a memory limit or handle pauses |
| Short successive FFmpeg jobs | Do not use for initial implementation: repeated provider connections, GOP landing, discontinuities, and subtitle timing increase risk |
| Jellyfin-style virtual full-film playlist and regenerate missing segments | Valid alternative architecture, but larger change: random segment service, index/timestamp stability, locks, init segments, and codec continuity need redesign |
| Server-owned rolling manifest, playhead-aware retention, producer control, byte budget | Preferred prototype, gated on player timing and long-pause behavior; reuse explicit generation restarts outside retained coverage |

Deleting files on a disk reduces space usage; it does not undo the writes
already performed. Reducing output writes requires RAM placement, avoiding
unneeded conversion, or avoiding remux via direct play. Do not promise a
quantified extension of HDD/SSD life without measurements. The measurable
target here is lower temporary-media block I/O with stable playback.

### Sizing the trial

For remux, use output bitrate, not encoder quality, to estimate memory:
`bytes = bits per second * retained seconds / 8`.
A 50 GB film over two hours averages about 55.6 Mb/s; a 180 s window alone is
about 1.25 GB. At 100 Mb/s it is 2.25 GB. These are decimal units and exclude
VBR peaks, a growing fragment, HTTP response pins, and seek overlap.

A rolling playlist also promises availability after URI removal: a roughly
180 s published window can require roughly another window of retention behind
it under RFC 8216. Thus a nominal three-minute window is not a three-minute
memory ceiling. At 100 Mb/s that pair alone is about 4.5 GB, already above a
4 GiB trial budget before overlap. The implementation must shorten its published
window/lead when possible, reserve capacity in advance, or refuse bounded mode
for that combination. Two viewers multiply these obligations. Never size the
buffer solely as a percentage of the NAS's installed RAM.

## Implementation requirements

### 1. Opt-in storage and compatibility contract

Proposed server configuration (names may be refined together in the code/docs):

| Setting | Proposed meaning |
| --- | --- |
| `PLAYBACK_BUFFER_MODE=legacy\|bounded` | Default `legacy`; bounded mode enabled only after the gates below |
| `PLAYBACK_TEMP_DIR` | Dedicated storage parent; server owns only a marked child directory beneath it |
| `PLAYBACK_BUFFER_MAX_MB` | Global MiB ceiling for all bounded playback output, including overlap and pending deletion; proposed trial value 4096 |
| `PLAYBACK_BUFFER_AHEAD_SECONDS` | Soft lead target, initially 120 s; byte pressure takes precedence |
| `PLAYBACK_BUFFER_BEHIND_SECONDS` | Soft rewind target, initially 60 s; active readers and promised retention take precedence over eviction |

These values are trial parameters, not a proven DS920+ capacity recommendation.
The Docker tmpfs limit must exceed the application budget by a documented
emergency margin; it is a final filesystem guard, not the normal controller.
Use a mount such as `/playback-ram` and an owned child below it. Validate
permissions for `PUID`/`PGID`, symlinks, unsafe paths, capacity and supported
backend at startup. Do not accept arbitrary storage paths from playback clients.
Do not delete the configured parent, data directory, library, or mount point.

The initial producer-control implementation may target Linux Docker only.
Mac/Windows desktop servers retain legacy mode until their control mechanism is
verified. A web/desktop client talking to a Linux server is a separate case.
Negotiate a new playback capability and report the effective mode/reason in
diagnostics; an old client must not receive an unsupported bounded playlist.

RAM-only policy must never silently spill to media/data disks on pressure.
For unsupported sources/clients, choose legacy disk behavior before session
creation and disclose it, or reject under an explicitly selected strict policy.
Keep existing sessions on their original mode when configuration changes.
[Docker tmpfs](https://docs.docker.com/engine/storage/tmpfs/) can use swap;
measure host swap activity rather than promising zero physical writes.

### 2. Observe the actual consumer before changing retention

Extend an authenticated session heartbeat to carry explicit generation ID,
monotonic report sequence, absolute film position, paused/seeking state and
playback rate. Send on state transitions and initially every 5 s while open.
Reuse ownership checks. Accept finite, plausible values only; a late report
from another generation must not move the eviction boundary.

Keep resume-history writes separate. Optimistic scrub targets are not proof
that the viewer has moved. Distinguish last confirmed rendered position from
requested seek target and from the highest downloaded segment. Record segment
requests and response completion separately; downloading is not watching.

Missing/stale reports freeze eviction near the last confirmed playhead and
stop production before exhausting reserved capacity. They must never mean
"the viewer advanced". Integrate with existing orphan/session cleanup and
background-tab behavior. A paused viewer can remain present indefinitely while
heartbeats continue, with storage stable after the permitted lead is filled.

### 3. Explicit generation state and shared capacity

Introduce a generation resource owner, tracked independently of
`session.process`, for current, preparing, fallback, and retired generations.
Track every writer until exit even after `session.process` points at a newer
one. Integrate with `SerialOperations`, stop/cancel, GPU retries, and shutdown.

Track completed and in-progress bytes, init/manifests, reserved writer slack,
active responses, and files awaiting retention expiry. Open-but-unlinked files
still consume tmpfs capacity until their readers close. Account for filesystem
free space as well as the file index; successful unlink is not necessarily
immediate capacity recovery. Bound manifest metadata too.

Reserve capacity for a candidate generation and its retry before starting it.
Do not evict the fallback to make space. If a safe replacement cannot fit,
reject the jump through the recoverable seek contract and retain the current
picture/pause state. Add an explicit storage-pressure reason without claiming
that a failed source request occurred. Admission of a new session must never
consume another session's protected reserve; reject it clearly when needed.
Refuse admission before mutating generation state. Preserve the distinction
between an unchanged playable descriptor and recovery after a failed restart:
today `seekRestored` after failed source attempts requires a live fallback
writer. Do not infer recovery from a network error, an exited/dead fallback,
or a failed decode escalation.

Use per-session admission reservations inside the global ceiling. Scheduling
must not let a fast remux starve a slow transcode. Define:

`accounted bytes + committed writer reservations <= application budget`.

Reserves include both writers during seek, unpublished output, observation
delay, bytes that cannot yet be deleted, and the minimum restart/startup window.
A periodic folder-size check alone cannot enforce a hard limit: a high-bitrate
or long-GOP segment may grow between observations. The prototype must measure
and bound overshoot, or add writer backpressure with enforced byte accounting.
If a single valid fragment cannot fit, stop/refuse bounded conversion cleanly;
do not delete protected media or crash the container. This is a release blocker,
not a reason to call a best-effort folder sweep a memory limit.

### 4. Manifest publication and safe eviction

Parse actual completed FFmpeg segments and `EXTINF` durations into a generation
index. Keep the writer's private playlist separate from the served manifest;
never edit a file FFmpeg is concurrently replacing. Publish served snapshots
atomically, retaining valid init, discontinuity, target-duration and sequence
information. Only advertise completed, non-empty output.

Use a rolling manifest without the append-only EVENT claim. Preserve a stable
film-time mapping as the window moves; a sequence number is not a timestamp,
and `segment number * 2` is invalid for remux. Keep the init segment for every
generation that remains addressable. Do not signal ENDLIST just to pause a
writer. At actual EOF, retain the reader's playable tail and correct end/next
episode behavior, including a paused viewer and backward seek.

Remove a URI from new manifests before considering its file for deletion.
Honor RFC retention for previously published snapshots and pin open HTTP/Range
responses until finish/close, including aborted transfers. Implement selection,
pinning and eviction atomically so a file cannot disappear between checking it
and opening it. Unpublished temporary files are owned exclusively by the writer.

Maintain retention deadlines for snapshots already served; shortening the
current playlist cannot retroactively shorten promises made by earlier ones.
Retention and fallback grace consume the same capacity budget. Test delayed
playlist/segment requests and a disconnect/reconnect with an older snapshot.

### 5. Coordinate producer throttling with seek and pause

Prototype SIGSTOP/SIGCONT only for Linux, with hysteresis between stop and
resume thresholds. A user pause keeps a small useful lead and then parks the
writer. A requested nearby forward seek must explicitly wake/advance the
producer even though the rendered playhead has not moved; otherwise today's
catch-up wait can deadlock behind throttling.

Measure suspension overshoot and its interaction with `-readrate`, startup
burst, hardware queues and FFmpeg progress output. Exclude intentionally
throttled time from "conversion too slow" diagnostics. Resume a suspended
writer before graceful SIGTERM, retain the existing bounded SIGKILL fallback,
and ensure stop/server shutdown cannot leave a suspended orphan.

For remote inputs, exercise the actual proxy and realistic idle connections.
Its bounded Range-resume retries do not prove that indefinite suspension is
safe. Verify mid-body idle timeout, expiring source URLs, non-Range sources,
connection limits, cancellation while waiting for `drain`, and unknown length.
Do not use periodic reconnects as a hidden default workaround. Live/unknown
duration inputs remain ineligible until separately designed and tested.

### 6. Preserve seeking and the absolute timeline

Seek decisions must consider the full available interval, holes, initialization
readiness and snapshot revision. Seeking within retained media should reuse it;
seeking into evicted history must use the existing explicit restart contract.
Do not turn routine segment GETs into uncoordinated restarts.

Keep film duration, progress/resume, subtitle time, and requested seek targets
absolute. A rolling playlist may change a player's local timeline after reload
or attach. Prove the conversion from media time to film time for both continuous
playback and fresh attachment; do not assume today's `offset + currentTime`
remains correct. Browser-buffered old media is a separate coverage source and
must not authorize deletion of files needed for recovery.

Protect the fallback's actual playhead and useful continuation during a seek;
the requested target must not advance its eviction boundary. Failed candidates
are cleaned without touching the old generation. Successful seek retains the
existing retirement guarantees and response leases. Closing during either
attempt cancels and cleans all owned generations exactly once.

Run the existing coalesced-seek and `seekRestored` scenarios unchanged. Subtitle
readers keep their source-time/cancellation model. Track/quality changes, decode
escalation, late responses, startup nudges, and next-episode transition need
explicit coverage. Android ExoPlayer and native Safari HLS require their own
timeline validation; absence of a crash is insufficient.

## Delivery plan and gates

1. **Instrument, without eviction.** Add generation ownership, position reports,
   byte accounting and dry-run decisions behind a flag. Demonstrate that it
   would never delete a needed segment across existing seek regressions.
2. **Disposable bounded prototype.** Use generated local files, a small tmpfs,
   actual hls.js and the real server. Prove timeline stability, long pause,
   byte-pressure admission and fallback protection. Select rolling manifests
   only if these pass; otherwise evaluate virtual segment serving in a separate
   design review. Do not ship a partially proven protocol by default.
3. **Remote-source qualification.** Use the addon fixture through the real
   proxy, then a real authorized provider. Pass idle/reconnect/refusal tests.
   Until then, label any local-only trial as such.
4. **Opt-in Linux trial on DS920+.** Verify QuickSync, 50 GB-class remux input,
   multiple sessions, a long pause and repeated seeks on actual client devices.
   Choose buffer sizes from observed peak use, swap, and remaining system RAM.
5. **Release supported combinations.** Keep legacy mode available; document
   eligibility and rollback. Expanding to native clients or other server OSes
   requires evidence from those environments, not just a capability flag.

The result may require several focused PRs. This specification authorizes no
claim of seamless eviction until the following acceptance evidence exists.

## Acceptance evidence required before enabling bounded mode

| Scenario | Required observation |
| --- | --- |
| Long film, local remux and actual transcode | Play through EOF under a budget far smaller than total output; continuous picture/audio, stable absolute time and correct completion |
| Sparse keyframes, VBR spikes, oversized segment | Actual duration/bytes drive decisions; no ENOSPC/OOM cascade, runaway output, or silent truncation |
| Pause for 30 minutes, resume near either window boundary | Storage reaches a stable bound; same paused frame/time resumes; no jump to live edge or new source connection unless the source actually requires recovery |
| Seek retained/evicted/near-ahead/far-ahead, rapid alternating seeks | Correct target within existing keyframe accuracy; nearby wait wakes producer; no accidental clamping to window start |
| Slow/refused seek, both attempts, twelve consecutive failures then success | Previous generation remains playable; no premature eviction, stale timers or generation reuse; bounded overlap |
| Close/source switch during seek or suspension | No leaked writer, timer, response, reservation or segment; late responses cannot restart playback |
| Exhaust global reserve with concurrent viewers | Existing playback remains intact; new session/seek gets a controlled result; no silent disk spill |
| EOF while paused; backward seek after EOF | Tail stays available and absolute duration/next episode are correct; no premature ENDLIST during throttling |
| Audio/quality/subtitle changes, decode recovery | Correct track/timing, existing fallback semantics, no new connection churn from subtitle-only changes |
| Delayed requests, old manifests, slow Range responses, stale heartbeat | No eviction-caused 404 for a still-promised segment; stale state cannot delete active coverage |
| Remote idle close, request refusal, interrupted response | Actual proxy recovery is bounded and preserves bytes; failures do not destroy a usable fallback |
| Container restart and cleanup, suspended writer termination | Owned files/processes removed; mount root and unrelated data preserved; no EBUSY startup failure |
| Client matrix | Chromium hls.js, macOS/iOS Safari in its actual selected HLS mode, desktop client against Linux, Android TV where enabled; native HLS separately; AirPlay remains disabled |

Automate ownership, policy and budget invariants in server/client unit tests.
Add real-server, real-FFmpeg integration coverage on constrained tmpfs with
fault injection. Existing seek-resume browser tests use real HLS but mock the
seek API; they cannot by themselves prove cleanup/producer coordination.
Use actual rendered progress, audio/subtitle timing and absence of unexpected
requests as assertions, not just HTTP 200 or FFmpeg exit status.

Measure baseline and bounded mode using identical sources/clients: startup and
seek p50/p95, stall count/duration, output filesystem used/peak bytes, writable
temporary bytes, cgroup memory including tmpfs/page cache, swap, source
connections/retries, open responses, active writers, and post-close residue.
For a matched healthy-source trial, require no additional stalls, no failed
seek recovery, and no p95 startup/seek increase above the greater of 250 ms or
10% without explicit review. Repeat runs to distinguish noise from regressions.
Record source bitrate/GOP and hardware mode beside results. Compare host block
writes as well as file writes; storage occupancy alone does not show saved I/O.

Before the implementation PR ships, run relevant automated suites, then build
and deploy the local Docker application and check `/api/status`, container
state and logs as required by AGENTS.md. Perform UX/device checks once functional
behavior is stable. This analysis PR needs neither a release bump nor a change
to the running application.

## Remaining uncertainties

- Long-paused rolling HLS behavior and fresh-attach timestamp mapping across
  the supported players have not been demonstrated by this experiment.
- Safe per-writer overshoot bounds for sparse-GOP remux and hardware pipelines
  need measurement or stronger output backpressure before a hard byte guarantee.
- Remote provider behavior after suspension is unknown; copied local-file
  success does not establish remote compatibility.
- The practical tmpfs budget depends on other DS920+ services, concurrent
  sessions, retention grace and swap, not just the installed 20 GB RAM.

Proceed with the controlled prototype. Do not treat these open points as a
reason to change the current stable playback path before they are resolved.
