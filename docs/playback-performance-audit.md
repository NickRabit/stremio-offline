# Playback performance audit

Measured 2026-10-17 across every source type, container and playback path. The
question was what makes a film slow to start, slow to seek, heavy on the CPU or
heavy on the source, and what to fix next. No product code changed; the tools are in
`scripts/perf/`.

Two builds are compared:

| Label | What it is |
| --- | --- |
| **0.5.91** | `65a80211`, main before the request-volume work |
| **0.5.93** | main now, with [#448](https://github.com/NickRabit/stremio-offline/pull/448) merged (bounded 1 MiB blocks for media-server and addon reads, one playback preparation reusing the item's short-window reads). This is the **baseline** for what to fix next. |

The 0.5.93 matrix was measured on #448's head (`bd21361a`). The release (`ca4608fb`)
adds two range commits on top. A 12-cell spot check on the release matched it within
noise (see [0.5.93 release, spot check](#0593-release-spot-check)); the transcode-stall
runs used the release itself.

## Summary

- **Transcode stalls (the owner's priority).** Most software transcodes (43 of 56
  cells) stall 1–3 times, right after the start or a seek, never in steady playback.
  It happens on every source type, before and after #448.
  - Most last 20–60 ms; a few last about 1 s.
  - Cause: the server hands over a transcode with a single 2 s segment, and hls.js
    re-reads the live playlist only every 2 s. The buffer runs out just as the
    reload arrives, although FFmpeg is already 7–11× ahead.
  - Fix, measured: handing over at two segments removed every stall in four cells.
    A start or seek took up to 0.3 s longer (median +0.08 s). The player should also stop counting
    these stalls toward its "lower quality" offer.
  - Details in [Transcode stalls](#transcode-stalls).

- **0.5.93 (#448) removed the worst problems.** A remote AVI (two thirds of the files on the
  owner's NAS are AVI) took 5.4–6.0 s from Play to the first frame from Jellyfin or
  Emby, and 29.6 s from an addon host that answers 100 ms late. On 0.5.93 it takes
  0.8 s and 1.1 s. Seeks inside it went from 2.4 s (14.3 s behind the slow host) to
  0.5–0.8 s. Media-server reads per run fell from 632 to 14 and from 4.4 GB to 82 MB.
- **A media-server Play is now as fast as a local one once the probe has answered:**
  on 0.5.93 the warm start answer takes 8 ms, where 0.5.91 took 0.74–0.78 s for direct play.
- **What remains is small and specific:**
  - Cold Play runs two probes of the same file.
  - The detail's source list still waits ~0.6 s on paced media-server reads.
  - Every seek outside the converted stretch restarts FFmpeg (0.3–1.0 s), including
    a seek back to where the viewer already was.
  - A chosen quality forces a software transcode even when the file already fits.
  - Two rare 7–8 s seeks were caused by hls.js, not by the server.
- **One regression in 0.5.93:** the block reading with its 50 ms grace also serves the
  browser's own direct-play reads, which never jump. Addon MP4 direct play went from
  0.26 s to 0.65 s to the first frame, in two runs. Behind a slow host an MP4 probe
  is ~0.25 s slower, because the moov comes in sequential 1 MiB blocks.
- **CPU:** direct play and MP4 remux cost almost nothing (≤ 2 % of a core). An MKV
  remux costs 11–15 % for AC-3 → AAC. A software transcode costs 0.35–0.55 cores for
  SD, 1.0–1.45 for 720p, and 2.2–2.4 for 1080p while FFmpeg runs ahead of playback.

## Transcode stalls

Most transcodes stall 1–3 times: 43 of 56 transcode cells, on every source type.
Remux and direct play had no counted stalls.

**Cause:** the server hands the player a transcode when FFmpeg has published a
single 2 s segment, and hls.js asks for the playlist again only once per segment
length (2 s). Until then the player knows of 2 s of video, although FFmpeg has
long since written ten more segments. It is a handover race, not a lack of CPU,
encoder speed or bandwidth.

**Fix:** handing over only once two segments are listed removed every stall in the
cells tried.

### Where the stalls happen

Every stall the harness recorded, across all transcode runs:

| When | Stall events | Notes |
| --- | --- | --- |
| Within 3 s of the first frame | 25 | Usually right before the 2 s mark |
| Within 3 s of the seek to 50 % | 27 | Every seek is a new FFmpeg generation |
| Within 3 s of the seek back to 0:30 | 27 | Same |
| Steady playback (the 20 s window, 3 s or more after a start or seek) | **0** | |

Totals: 79 events in 56 transcode cells; 0 counted stalls in 39 remux cells.

How long a stall lasts, across the 91 counted stalls of the matrix runs:

| | Duration |
| --- | --- |
| Median | 35 ms |
| 90th percentile | 62 ms |
| Over 400 ms | 3, at about 1 s each |

The player shows its buffering notice only after 400 ms, so most of these are a
hiccup the eye may catch and the notice never shows. The ~1 s ones are visible.
Three came in the matrix runs, and the instrumented runs below caught a fourth:

- Emby AVI on #448's head: 1,111 ms over 3 stalls
- Jellyfin and addon AVI on the release: 1,065 ms and 1,042 ms
- local AVI, instrumented: 1,046 ms

The builds do not differ in any way that matters: 41 stalls in 28 transcode cells on
0.5.91, 50 in 28 on 0.5.93. #448 changed reads, not the handover.

### What the player sees

Local 1080p MKV with quality 1080, on the 0.5.93 release. Times are from pressing Play.

| ms | Event |
| --- | --- |
| 494 | FFmpeg publishes segment 0 (2.0 s). The server answers the start: one segment is enough for `waitForHlsOutput`. |
| 576 | hls.js loads the playlist: 1 segment, live, ends at 2.0 s |
| 617 | Segment 0 buffered: 1.95 s ahead |
| 698 | FFmpeg publishes segment 1, then 2–8 by 2,479 (2 s of video every 150–250 ms) |
| 918 | Playback starts. Chrome held the first frame ~300 ms with a single segment buffered and raised `bufferStalledError`. |
| 2,577 | hls.js reloads the playlist, **2.0 s after the first load**: 9 segments. Playback is at 1.62 s of 1.95 s. |
| 2,589–2,722 | Segments 1–8 loaded and buffered: 17.9 s ahead. From here nothing stalls. |

That run started late, so it made it with 0.3 s to spare. When playback starts
promptly, it reaches the end of segment 0 just before the 2 s reload.

The seek to 50 % in the same run lost that race:

| ms after the seek | Event |
| --- | --- |
| 590 | FFmpeg's new generation publishes segment 0 |
| 652 | The server answers the seek |
| 699 | hls.js loads the new playlist: 1 segment, 2.0 s |
| 845–2,627 | FFmpeg publishes segments 1–11 |
| 2,677 | `waiting`: playback at 1.90 s, buffered to 1.95 s |
| 2,706 | hls.js reloads the playlist (2.0 s after the last load): 12 segments |
| 2,723 | `playing` again: a 46 ms stall |

The ~1 s variant is the same race, ended sooner by Chrome. In the local AVI run:

- Chrome stopped at 0.90 s, with 1.95 s buffered and fourteen segments on disk.
- It waited for its own lookahead until hls.js's 2 s reload appended segment 1.
- That took 1.05 s.

Chrome stops wherever its lookahead runs short. With a single segment buffered,
that can be anywhere in the second half of the segment, so the stall lasts from a
few milliseconds to a second.

### Segment production against playback

From the segment watcher (when each `seg-*.m4s` appeared on disk) and the CPU
sampler, on the 0.5.93 release:

| Cell | First segment after Play | Segments at handover | FFmpeg pace, first 3 s | Pace, 3–20 s | FFmpeg cores, first 3 s | Cores, 3–20 s | First segment after a seek |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Local MKV 1080p transcode | 494 ms | 1 | 7.3× | 2.0× | 7.2 | 1.8 | 590 ms |
| Local MP4 720p transcode | 486 ms | 1 | 10.0× | 1.5× | 4.5 | 0.8 | 609 ms |
| Local MP4 720×360 transcode | 414 ms | 2 | 10.7× | 1.5× | 1.6 | 0.4 | 259 ms |
| Local AVI transcode | 706 ms | 1 | 10.0× | 1.5× | 1.2 | 0.4 | 401 ms |
| Jellyfin MKV 1080p transcode | 674 ms | 1 | 8.0× | 1.9× | 7.0 | 1.6 | 688 ms |
| Addon AVI transcode | 599 ms | 2 | 10.0× | 1.5× | 1.2 | 0.4 | 314 ms |
| Local MKV remux | 307 ms | 3 | 12.5× | 2.9× | 0.3 | 0.1 | 259 ms |
| Jellyfin MKV remux | 303 ms | 1 | 12.5× | 2.9× | 0.3 | 0.1 | 250 ms |

The "segments at handover" column comes from a 50 ms file poll, so it is
approximate. The server log is exact: it records how many segments the playlist
listed when each start or seek was answered, across every run of this audit.

| | 1 segment | 2 | 3 | more |
| --- | --- | --- | --- | --- |
| Transcode start (69) | **53** | 8 | 8 | 0 |
| Transcode seek (134) | **92** | 29 | 13 | 0 |
| Remux start (46) | 8 | 4 | 19 | 15 |
| Remux seek (88) | 17 | 25 | 19 | 27 |

What this shows:

- **FFmpeg is never behind.** It writes 2 s of video every 150–250 ms during the 30 s
  initial burst. Every conversion log says "keeping up".
- **CPU is not the limit here.** 1080p takes 7 cores in the burst and 1.6–1.8 after
  it. On a NAS without QuickSync, 1080p would also be CPU-bound, but that would show
  as stalls in steady playback, which never happened here.
- **Remux escapes the race:**
  - Its segments are cut at the source's keyframes, 1–10 s long; this MKV's segment
    3 is 8.2 s and segment 4 is 10 s.
  - Copying runs at 12× and usually lists three segments by the time the server
    answers.
  - Even a remux handed over with one segment has a first segment of 2.3–2.9 s and
    longer ones queued behind it, so the 2 s reload comes with time to spare.

### Why the handover leaves 2 s

Three settings meet:

1. **The handover:** `waitForHlsOutput` (`server/src/playback.ts`) answers as soon as
   the playlist names one segment and its files exist (`hlsCanStart`: one `#EXTINF`
   and the init file). Start and seek use it alike.
2. **Segment length:** a transcode forces a keyframe every 2 s
   (`-force_key_frames expr:gte(t,n_forced*2)`) with `-hls_time 2`, so every segment
   is exactly 2.0 s.
3. **The reload interval:** the playlist is an EVENT playlist without
   `#EXT-X-ENDLIST` while FFmpeg runs, so hls.js treats it as live. It reloads a live
   playlist one target duration (2 s) after the previous load. The player's
   `HLS_PLAYER_CONFIG` does not change that.

The first reload therefore comes when the buffered video is used up, or nearly.

### Side effects

- **The lower-quality offer:** the web player's `noteStall` (`web/src/Player.tsx`)
  counts every `waiting` outside a seek once playback is past 1 s. These stalls
  happen at ~1–1.9 s, after the seek has finished, so they count.
  - Three within a minute, for example a start and two seeks, log "Playback keeps
    stalling".
  - With hardware acceleration the player then offers a lower quality, which means
    more transcoding, for a problem that is not the network.
- **A slower first frame:** with a single segment buffered, Chrome held the first
  frame ~300 ms in the run above (`bufferStalledError` at 50 ms, playing 300 ms
  later). With two segments buffered, playback started 35 ms after the playlist.

### Experiment: hand over at two segments

The harness can wait until the generation's playlist lists two segments before
giving it to hls.js (`attachAfterSegments: 2`). That stands in for the server
waiting longer; no product code was changed.

| Cell (0.5.93 release) | Stalls, 1 segment | Stalls, 2 segments | First frame, 1 → 2 | Seek to 50 %, 1 → 2 | Seek back, 1 → 2 |
| --- | --- | --- | --- | --- | --- |
| Local MKV 1080p | 2 (84 ms) | **0** | 930 → 852 ms | 762 → 774 ms | 621 → 790 ms |
| Local MP4 720p | 2 (38 ms) | **0** | 654 → 964 ms | 725 → 649 ms | 552 → 508 ms |
| Local AVI | 1 (1,046 ms) | **0** | 743 → 884 ms | 489 → 490 ms | 492 → 605 ms |
| Jellyfin MKV 1080p | 3 (110 ms) | **0** | 789 → 829 ms | 893 → 1,049 ms | 662 → 832 ms |

Eight stalls became none.

**The cost:** the second segment arrives 150–250 ms after the first, so a start or
seek waits about that much longer. Across these twelve measurements the median
change was +0.08 s and the range −0.08 to +0.31 s. Part of it comes back: Chrome
starts at once instead of holding the first frame with one segment.

One run per cell, so the latency figures are indicative. The stall result is not:
8 → 0 in four cells, against stalls in 43 of 56 transcode cells in the matrix runs.

### Options

| Option | Effect | Cost |
| --- | --- | --- |
| **A. Answer a transcode start or seek once two segments (≥ 4 s) are listed.** Make the `hlsCanStart` threshold depend on the mode; remux keeps one. | Measured above: stalls gone; a start or seek takes up to 0.3 s longer (median +0.08 s). | S, server only; the TV client benefits as well |
| **B. Stop `noteStall` counting `waiting` in the first few seconds after a start or seek.** | The lower-quality offer is kept for real network trouble. | S, web player |
| C. Re-read the playlist sooner in the client. hls.js has no option for the live reload interval, so the player would have to trigger a reload itself, or the server would have to advertise a shorter `#EXT-X-TARGETDURATION`. | Would avoid A's extra wait. | M, fights hls.js; not tried |
| D. Shorter segments (`-hls_time 1`) | None: the reload interval shrinks with them, and the race stays. | – |

A and B together cover it. A removes the stalls and B keeps any that remain away
from the quality advice.

## Setup

| Part | Details |
| --- | --- |
| Host | Mac mini, Apple M4 Pro, Docker Desktop VM with 12 CPUs and 8 GB. FFmpeg in the container is software only (no VAAPI/NVENC/VideoToolbox). |
| App | An isolated copy on port 8092 (`scripts/perf/perf-instance.sh`). Same data and media-server connections as the owner's instance, `LOG_LEVEL=DEBUG`, `ALLOW_PRIVATE_ADDONS=1`. The shared 8090 instance was never restarted. |
| Jellyfin | Native on the same Mac (`host.docker.internal:8096`), reading the films from the Synology NAS over SMB |
| Emby | On the Synology NAS (`192.168.1.205:8096`), gigabit LAN |
| Addon | `scripts/perf/range-proxy.mjs`, a minimal Stremio addon on the Mac serving the same files with byte ranges. A second instance answers every request 100 ms late, like a remote debrid/CDN host. |
| Local library | A read-only library over copies of the same files |
| Player | Headless Google Chrome (Playwright), 1280×800, hls.js 1.6.13 with the player's own `HLS_PLAYER_CONFIG` |

The same four real films were used for every source. Jellyfin and Emby serve
byte-identical files from the NAS, and the local and addon copies are those files.

| Key | File | Video / audio | Size, length | Layout |
| --- | --- | --- | --- | --- |
| MKV H.264 | *Alenka v říši divů* (2010) | H.264 High 1920×1080, AC-3 | 3.3 GB, 1 h 49 min | Matroska, cues at the end |
| MP4 faststart | *Sherlock Holmes* (2009) | H.264 1280×720, AAC | 2.8 GB, 2 h 8 min | `moov` at offset 20 |
| MP4 moov at end | *Dívka ve vlaku* (2016) | H.264 720×360, AAC | 1.6 GB, 1 h 47 min | `moov` after `mdat` |
| AVI idx1 at end | *Gladiátor* (2000) | MPEG-4 ASP 720×304, MP3 | 2.7 GB, 2 h 44 min | OpenDML: `idx1` at 2.1 GB, a second RIFF after it |

How each path was reached, the way a real client reaches it:

| Path | How |
| --- | --- |
| direct | The browser's own capability declaration; an MP4 with H.264 and AAC plays as it is |
| remux | MKV: the browser itself (picture copied, AC-3 converted to AAC). MP4: a native client that declares H.264 and AAC but no file container, as the Android TV client does. A browser always plays these MP4s directly. |
| transcode | Quality 1080 chosen in the player (never upscales these sources). The AVI is MPEG-4 ASP and always transcodes. |

## Method

`scripts/perf/run-matrix.mjs` drives headless Chrome through
`scripts/perf/player-harness.js`, which repeats what the web player does, in this order:

1. List the item's sources (mints a `sourceId`).
2. `POST /api/inspect`, as the detail does when a source is selected.
3. `POST /api/playback`.
4. Attach hls.js (or set `src` for direct play).
5. Play 20 s.
6. Seek to 50 %, the way `Player.seekTo` does: native within the converted stretch, otherwise `POST /seek` and attach the new generation. Play 5 s.
7. Seek back to 0:30. Play 5 s.
8. `DELETE` the session.

Every cell runs on a freshly restarted instance (`scripts/perf/reset.sh`), so no
inspection, byte or metadata cache carries over.

| Measured | How |
| --- | --- |
| Play → first frame | From sending `POST /api/playback` to the first frame Chrome paints (`requestVideoFrameCallback`) |
| Cold | Play is pressed together with selecting the source, while its probe still runs |
| Warm | Play is pressed after the probe has answered |
| Seek | From the seek to a painted frame with playback advancing again |
| Upstream requests and bytes | Every request the app makes to Jellyfin, Emby or the addon host, logged by `range-proxy.mjs` in front of them (the media-server connections of the copy point at it). "Media reads" are byte-range reads; "metadata" is everything else. Bytes are what the host sent before the app hung up. |
| Provider counters | Deltas of `data/provider-stats.json` per cell; they agree with the proxy log |
| CPU | `scripts/perf/cpu-sampler.mjs` reads `/proc` for every ffmpeg/ffprobe process every 200 ms. "Steady" is the 20 s of playback after the first frame, in % of one core. |

Each cell ran once. Repeats of the same cell differed by up to ~100 ms on local
sources and a few hundred ms on remote ones. The first cell after an image switch
also carries container warm-up: local MP4 direct took 508 ms there and 111 ms in a
trial run. Read single differences under ~150 ms as noise. `scripts/perf/analyze.mjs`
joins the logs and `scripts/perf/report.mjs` prints the tables below.

#448 does not change how a local file is read, so local cells were measured on 0.5.91 only.

## Results

### Play to first frame (ms)

| Source | Container | Path | Mode | 0.5.91 cold | 0.5.93 cold | 0.5.91 warm | 0.5.93 warm |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Local library | MP4 faststart | direct | direct | 508 | – | 288 | 290 |
| Local library | MP4 faststart | remux | remux (va) | 364 | – | – | – |
| Local library | MP4 faststart | transcode | transcode (-a) | 570 | – | – | – |
| Local library | MP4 moov at end | direct | direct | 232 | – | – | – |
| Local library | MP4 moov at end | remux | remux (va) | 406 | – | – | – |
| Local library | MP4 moov at end | transcode | transcode (-a) | 506 | – | – | – |
| Local library | MKV H.264 | remux | remux (v-) | 419 | – | 292 | 266 |
| Local library | MKV H.264 | transcode | transcode (--) | 630 | – | 597 | 482 |
| Local library | AVI idx1 at end | transcode | transcode (--) | 758 | – | 354 | 465 |
| Addon HTTP | MP4 faststart | direct | direct | 262 | 654 | 64 | 105 |
| Addon HTTP | MP4 faststart | remux | remux (va) | 494 | 551 | – | – |
| Addon HTTP | MP4 faststart | transcode | transcode (-a) | 577 | 742 | – | – |
| Addon HTTP | MP4 moov at end | direct | direct | 274 | 327 | – | – |
| Addon HTTP | MP4 moov at end | remux | remux (va) | 390 | 558 | – | – |
| Addon HTTP | MP4 moov at end | transcode | transcode (-a) | 451 | 577 | – | – |
| Addon HTTP | MKV H.264 | remux | remux (v-) | 446 | 406 | 274 | 300 |
| Addon HTTP | MKV H.264 | transcode | transcode (--) | 816 | 559 | 484 | 482 |
| Addon HTTP | AVI idx1 at end | transcode | transcode (--) | 2.1 s | 769 | 764 | 278 |
| Jellyfin | MP4 faststart | direct | direct | 2.0 s | 609 | 904 | 268 |
| Jellyfin | MP4 faststart | remux | remux (va) | 1.6 s | 751 | – | – |
| Jellyfin | MP4 faststart | transcode | transcode (-a) | 1.7 s | 825 | – | – |
| Jellyfin | MP4 moov at end | direct | direct | 1.8 s | 556 | – | – |
| Jellyfin | MP4 moov at end | remux | remux (va) | 1.6 s | 606 | – | – |
| Jellyfin | MP4 moov at end | transcode | transcode (-a) | 1.9 s | 816 | – | – |
| Jellyfin | MKV H.264 | remux | remux (v-) | 1.8 s | 609 | 1.0 s | 284 |
| Jellyfin | MKV H.264 | transcode | transcode (--) | 1.6 s | 728 | 1.2 s | 607 |
| Jellyfin | AVI idx1 at end | transcode | transcode (--) | 5.4 s | 801 | 3.0 s | 381 |
| Emby | MP4 faststart | direct | direct | 2.0 s | 1.2 s | 826 | 116 |
| Emby | MP4 faststart | remux | remux (va) | 1.6 s | 913 | – | – |
| Emby | MP4 faststart | transcode | transcode (-a) | 1.6 s | 672 | – | – |
| Emby | MP4 moov at end | direct | direct | 1.7 s | 577 | – | – |
| Emby | MP4 moov at end | remux | remux (va) | 1.6 s | 560 | – | – |
| Emby | MP4 moov at end | transcode | transcode (-a) | 1.6 s | 644 | – | – |
| Emby | MKV H.264 | remux | remux (v-) | 1.6 s | 484 | 903 | 278 |
| Emby | MKV H.264 | transcode | transcode (--) | 1.9 s | 792 | 1.3 s | 511 |
| Emby | AVI idx1 at end | transcode | transcode (--) | 6.0 s | 807 | 2.0 s | 366 |

The mode column notes what was copied: `va` video and audio, `v-` video only, `-a` audio only.

### Probe and start answer (ms)

| Source | Container | Path | probe 0.5.91 | probe 0.5.93 | start 0.5.91 | start 0.5.93 | start 0.5.91 warm | start 0.5.93 warm |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Local library | MP4 faststart | direct | 185 | – | 195 | – | 6 | 5 |
| Local library | MP4 faststart | remux | 164 | – | 281 | – | – | – |
| Local library | MP4 faststart | transcode | 185 | – | 509 | – | – | – |
| Local library | MP4 moov at end | direct | 174 | – | 172 | – | – | – |
| Local library | MP4 moov at end | remux | 153 | – | 365 | – | – | – |
| Local library | MP4 moov at end | transcode | 141 | – | 451 | – | – | – |
| Local library | MKV H.264 | remux | 155 | – | 368 | – | 220 | 214 |
| Local library | MKV H.264 | transcode | 149 | – | 567 | – | 528 | 421 |
| Local library | AVI idx1 at end | transcode | 394 | – | 709 | – | 317 | 418 |
| Addon HTTP | MP4 faststart | direct | 193 | 274 | 194 | 282 | 4 | 4 |
| Addon HTTP | MP4 faststart | remux | 200 | 266 | 417 | 480 | – | – |
| Addon HTTP | MP4 faststart | transcode | 207 | 254 | 524 | 669 | – | – |
| Addon HTTP | MP4 moov at end | direct | 205 | 229 | 209 | 223 | – | – |
| Addon HTTP | MP4 moov at end | remux | 201 | 282 | 316 | 497 | – | – |
| Addon HTTP | MP4 moov at end | transcode | 179 | 207 | 401 | 526 | – | – |
| Addon HTTP | MKV H.264 | remux | 162 | 151 | 384 | 362 | 218 | 213 |
| Addon HTTP | MKV H.264 | transcode | 228 | 174 | 754 | 493 | 426 | 420 |
| Addon HTTP | AVI idx1 at end | transcode | 1.3 s | 407 | 2.1 s | 726 | 722 | 215 |
| Jellyfin | MP4 faststart | direct | 1.8 s | 472 | 1.6 s | 472 | 784 | 8 |
| Jellyfin | MP4 faststart | remux | 1.2 s | 382 | 1.6 s | 694 | – | – |
| Jellyfin | MP4 faststart | transcode | 1.2 s | 437 | 1.7 s | 751 | – | – |
| Jellyfin | MP4 moov at end | direct | 1.5 s | 411 | 1.6 s | 400 | – | – |
| Jellyfin | MP4 moov at end | remux | 1.1 s | 321 | 1.5 s | 525 | – | – |
| Jellyfin | MP4 moov at end | transcode | 1.5 s | 443 | 1.9 s | 760 | – | – |
| Jellyfin | MKV H.264 | remux | 1.3 s | 332 | 1.7 s | 542 | 997 | 227 |
| Jellyfin | MKV H.264 | transcode | 1.1 s | 216 | 1.6 s | 658 | 1.1 s | 551 |
| Jellyfin | AVI idx1 at end | transcode | 3.6 s | 547 | 5.3 s | 753 | 2.9 s | 320 |
| Emby | MP4 faststart | direct | 1.8 s | 958 | 1.9 s | 961 | 737 | 8 |
| Emby | MP4 faststart | remux | 1.1 s | 547 | 1.5 s | 855 | – | – |
| Emby | MP4 faststart | transcode | 1.2 s | 310 | 1.5 s | 621 | – | – |
| Emby | MP4 moov at end | direct | 1.3 s | 432 | 1.5 s | 429 | – | – |
| Emby | MP4 moov at end | remux | 1.1 s | 277 | 1.5 s | 501 | – | – |
| Emby | MP4 moov at end | transcode | 1.2 s | 287 | 1.5 s | 588 | – | – |
| Emby | MKV H.264 | remux | 1.2 s | 229 | 1.5 s | 437 | 865 | 221 |
| Emby | MKV H.264 | transcode | 1.5 s | 205 | 1.8 s | 722 | 1.2 s | 434 |
| Emby | AVI idx1 at end | transcode | 3.8 s | 552 | 6.0 s | 762 | 2.0 s | 319 |

In the cold runs the start answer includes waiting for the probe, because Play
arrived while it was still running.

### Seek to 50 % and back to 0:30 (ms)

| Source | Container | Path | how | to 50 % 0.5.91 | to 50 % 0.5.93 | back 0.5.91 | back 0.5.93 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Local library | MP4 faststart | direct | browser | 64 | – | 57 | – |
| Local library | MP4 faststart | remux | restart | 285 | – | 291 | – |
| Local library | MP4 faststart | transcode | restart | 483 | – | 504 | – |
| Local library | MP4 moov at end | direct | browser | 35 | – | 63 | – |
| Local library | MP4 moov at end | remux | restart | 285 | – | 173 | – |
| Local library | MP4 moov at end | transcode | restart | 380 | – | 448 | – |
| Local library | MKV H.264 | remux | restart | 396 | – | 448 | – |
| Local library | MKV H.264 | transcode | restart | 856 | – | 615 | – |
| Local library | AVI idx1 at end | transcode | restart | 536 | – | 511 | – |
| Addon HTTP | MP4 faststart | direct | browser | 59 | 61 | 114 | 69 |
| Addon HTTP | MP4 faststart | remux | restart | 284 | 376 | 293 | 468 |
| Addon HTTP | MP4 faststart | transcode | restart | 660 | 989 | 557 | 507 |
| Addon HTTP | MP4 moov at end | direct | browser | 51 | 49 | 41 | 61 |
| Addon HTTP | MP4 moov at end | remux | restart | 340 | 400 | 295 | 305 |
| Addon HTTP | MP4 moov at end | transcode | restart | 294 | 456 | 323 | 397 |
| Addon HTTP | MKV H.264 | remux | restart | 417 | 400 | 421 | 386 |
| Addon HTTP | MKV H.264 | transcode | restart | 630 | 638 | 622 | 572 |
| Addon HTTP | AVI idx1 at end | transcode | restart | 905 | 495 | 847 | 492 |
| Jellyfin | MP4 faststart | direct | browser | 112 | 190 | 60 | 57 |
| Jellyfin | MP4 faststart | remux | restart | 401 | 415 | 324 | 415 |
| Jellyfin | MP4 faststart | transcode | restart | 656 | 621 | 502 | 683 |
| Jellyfin | MP4 moov at end | direct | browser | 138 | 585 | 73 | 136 |
| Jellyfin | MP4 moov at end | remux | restart | 448 | 293 | 300 | 334 |
| Jellyfin | MP4 moov at end | transcode | restart | 830 | 532 | 393 | 505 |
| Jellyfin | MKV H.264 | remux | restart | 552 | 511 | 498 | 466 |
| Jellyfin | MKV H.264 | transcode | restart | 817 | 718 | 706 | 724 |
| Jellyfin | AVI idx1 at end | transcode | restart | 2.4 s | 807 | 2.4 s | 489 |
| Emby | MP4 faststart | direct | browser | 245 | 186 | 65 | 111 |
| Emby | MP4 faststart | remux | restart | 299 | 388 | 289 | 408 |
| Emby | MP4 faststart | transcode | restart | 656 | 549 | 597 | 655 |
| Emby | MP4 moov at end | direct | browser | 239 | 237 | 112 | 70 |
| Emby | MP4 moov at end | remux | restart | 543 | 290 | 436 | 332 |
| Emby | MP4 moov at end | transcode | restart | 433 | 455 | 538 | 398 |
| Emby | MKV H.264 | remux | restart | 603 | 611 | 389 | 405 |
| Emby | MKV H.264 | transcode | restart | 1.4 s | 762 | 707 | 885 |
| Emby | AVI idx1 at end | transcode | restart | 1.6 s | 603 | 1.7 s | 495 |

"restart" means the target was outside what the current conversion had produced,
so the server started a new FFmpeg at the target. Both seeks were restarts in every
converted cell, including the one back to 0:30, which the first conversion had
already produced.

### Upstream requests and bytes per run

A run is: probe, start, 20 s of play and two seeks.

| Source | Container | Path | media reads 0.5.91 | media reads 0.5.93 | probe / start / seek 0.5.91 | probe / start / seek 0.5.93 | metadata 0.5.91 | metadata 0.5.93 | MB 0.5.91 | MB 0.5.93 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Addon HTTP | MP4 faststart | direct | 13 | 23 | 8 / 11 / 1 | 14 / 17 / 2 | 1 | 1 | 152 | 128 |
| Addon HTTP | MP4 faststart | remux | 16 | 24 | 8 / 10 / 3 | 14 / 16 / 4 | 1 | 1 | 244 | 193 |
| Addon HTTP | MP4 faststart | transcode | 16 | 24 | 8 / 10 / 3 | 14 / 16 / 4 | 1 | 1 | 219 | 178 |
| Addon HTTP | MP4 moov at end | direct | 14 | 21 | 8 / 11 / 1 | 12 / 14 / 2 | 1 | 1 | 128 | 85 |
| Addon HTTP | MP4 moov at end | remux | 16 | 22 | 8 / 10 / 3 | 12 / 14 / 4 | 1 | 1 | 189 | 116 |
| Addon HTTP | MP4 moov at end | transcode | 16 | 22 | 7 / 10 / 3 | 12 / 14 / 4 | 1 | 1 | 171 | 101 |
| Addon HTTP | MKV H.264 | remux | 19 | 16 | 8 / 10 / 5 | 8 / 9 / 4 | 1 | 1 | 249 | 145 |
| Addon HTTP | MKV H.264 | transcode | 19 | 16 | 8 / 10 / 5 | 8 / 9 / 4 | 1 | 1 | 241 | 118 |
| Addon HTTP | AVI idx1 at end | transcode | 526 | 21 | 254 / 361 / 84 | 14 / 15 / 3 | 1 | 1 | 3470 | 90 |
| Jellyfin | MP4 faststart | direct | 11 | 16 | 6 / 9 / 1 | 6 / 8 / 1 | 21 | 9 | 106 | 103 |
| Jellyfin | MP4 faststart | remux | 17 | 17 | 9 / 9 / 4 | 7 / 9 / 4 | 21 | 9 | 270 | 193 |
| Jellyfin | MP4 faststart | transcode | 17 | 17 | 9 / 9 / 4 | 7 / 9 / 4 | 21 | 9 | 241 | 189 |
| Jellyfin | MP4 moov at end | direct | 12 | 15 | 6 / 10 / 1 | 6 / 8 / 1 | 21 | 9 | 101 | 88 |
| Jellyfin | MP4 moov at end | remux | 17 | 16 | 9 / 9 / 4 | 6 / 8 / 4 | 21 | 9 | 227 | 111 |
| Jellyfin | MP4 moov at end | transcode | 17 | 16 | 9 / 9 / 4 | 6 / 8 / 4 | 21 | 9 | 166 | 100 |
| Jellyfin | MKV H.264 | remux | 21 | 12 | 9 / 9 / 6 | 2 / 4 / 5 | 21 | 9 | 226 | 139 |
| Jellyfin | MKV H.264 | transcode | 21 | 12 | 9 / 9 / 6 | 3 / 4 / 5 | 21 | 9 | 257 | 124 |
| Jellyfin | AVI idx1 at end | transcode | 632 | 14 | 267 / 378 / 127 | 6 / 7 / 4 | 24 | 9 | 4364 | 82 |
| Emby | MP4 faststart | direct | 11 | 16 | 6 / 9 / 1 | 6 / 9 / 2 | 21 | 9 | 121 | 108 |
| Emby | MP4 faststart | remux | 17 | 17 | 9 / 9 / 4 | 6 / 9 / 4 | 21 | 9 | 159 | 150 |
| Emby | MP4 faststart | transcode | 17 | 17 | 9 / 9 / 4 | 6 / 9 / 4 | 21 | 9 | 143 | 124 |
| Emby | MP4 moov at end | direct | 11 | 15 | 6 / 9 / 1 | 6 / 8 / 2 | 21 | 9 | 94 | 85 |
| Emby | MP4 moov at end | remux | 17 | 16 | 9 / 9 / 4 | 6 / 8 / 4 | 21 | 9 | 141 | 109 |
| Emby | MP4 moov at end | transcode | 17 | 16 | 9 / 9 / 4 | 6 / 8 / 4 | 21 | 9 | 123 | 99 |
| Emby | MKV H.264 | remux | 21 | 13 | 9 / 9 / 6 | 3 / 4 / 6 | 21 | 9 | 166 | 141 |
| Emby | MKV H.264 | transcode | 21 | 11 | 9 / 9 / 6 | 3 / 4 / 4 | 21 | 9 | 146 | 121 |
| Emby | AVI idx1 at end | transcode | 632 | 13 | 233 / 378 / 127 | 6 / 7 / 3 | 24 | 9 | 510 | 85 |

Per-phase counts are requests started in that phase. In the cold runs the probe
and start overlap, so they share requests. The provider counters agree:

- **0.5.91**, per run: 6 Detail + 6 Ancestors + 6 PlaybackInfo + Info/User/Views, plus
  632 original reads for the AVI.
- **0.5.93**, per run: 2 + 2 + 2 + Info/User/Views, plus 13–14 original reads for the AVI.

The 4.4 GB for one Jellyfin AVI run on 0.5.91 is not file content. Each of the 632
reads was an open-ended range, and Jellyfin (on the same machine) pushed several
megabytes into it before FFmpeg hung up. Emby over the LAN pushed less: 510 MB.

### FFmpeg CPU (0.5.91)

| Source | Container | Path | CPU-s until first frame | steady % of one core | container steady % |
| --- | --- | --- | --- | --- | --- |
| Local library | MP4 faststart | direct | 0.0 | 0 | 5 |
| Local library | MP4 faststart | remux | 0.1 | 2 | 7 |
| Local library | MP4 faststart | transcode | 3.5 | 103 | 108 |
| Local library | MP4 moov at end | direct | 0.0 | 0 | 5 |
| Local library | MP4 moov at end | remux | 0.1 | 2 | 6 |
| Local library | MP4 moov at end | transcode | 1.7 | 36 | 40 |
| Local library | MKV H.264 | remux | 0.5 | 15 | 21 |
| Local library | MKV H.264 | transcode | 3.9 | 218 | 222 |
| Local library | AVI idx1 at end | transcode | 2.2 | 45 | 49 |
| Addon HTTP | MP4 faststart | direct | 0.0 | 0 | 3 |
| Addon HTTP | MP4 faststart | remux | 0.1 | 2 | 7 |
| Addon HTTP | MP4 faststart | transcode | 3.8 | 116 | 121 |
| Addon HTTP | MP4 moov at end | direct | 0.1 | 0 | 5 |
| Addon HTTP | MP4 moov at end | remux | 0.1 | 2 | 8 |
| Addon HTTP | MP4 moov at end | transcode | 1.7 | 53 | 57 |
| Addon HTTP | MKV H.264 | remux | 0.5 | 12 | 18 |
| Addon HTTP | MKV H.264 | transcode | 4.4 | 233 | 238 |
| Addon HTTP | AVI idx1 at end | transcode | 1.3 | 35 | 38 |
| Jellyfin | MP4 faststart | direct | 0.1 | 0 | 4 |
| Jellyfin | MP4 faststart | remux | 0.3 | 2 | 9 |
| Jellyfin | MP4 faststart | transcode | 5.2 | 122 | 127 |
| Jellyfin | MP4 moov at end | direct | 0.1 | 0 | 5 |
| Jellyfin | MP4 moov at end | remux | 0.1 | 2 | 7 |
| Jellyfin | MP4 moov at end | transcode | 4.0 | 49 | 53 |
| Jellyfin | MKV H.264 | remux | 0.6 | 12 | 20 |
| Jellyfin | MKV H.264 | transcode | 5.1 | 226 | 231 |
| Jellyfin | AVI idx1 at end | transcode | 3.0 | 47 | 52 |
| Emby | MP4 faststart | direct | 0.1 | 0 | 4 |
| Emby | MP4 faststart | remux | 0.2 | 2 | 8 |
| Emby | MP4 faststart | transcode | 4.4 | 121 | 127 |
| Emby | MP4 moov at end | direct | 0.1 | 0 | 4 |
| Emby | MP4 moov at end | remux | 0.1 | 2 | 8 |
| Emby | MP4 moov at end | transcode | 3.6 | 47 | 52 |
| Emby | MKV H.264 | remux | 0.7 | 11 | 18 |
| Emby | MKV H.264 | transcode | 6.8 | 219 | 223 |
| Emby | AVI idx1 at end | transcode | 3.1 | 41 | 46 |

#448 changes only reads, so CPU on 0.5.93 matched within a few percent (MKV
transcode 218–242 %, MP4 720p transcode 120–145 %).

How to read the transcode figures:

- **The 20 s window includes FFmpeg's catch-up.** The conversion log puts its
  average pace at 2.2–2.9× real time: the 30 s initial burst, before the 1.5×
  read-rate brake. Over a whole film, a 1080p software transcode costs roughly a
  core, about half of the figure above.
- **The cost scales with picture size, not with source type.** 1080p takes about
  2.2 cores, 720p about 1.1, the 720×360 and 720×304 files about 0.4–0.5.
- **On a NAS it is worse.** An M4 Pro core is several times a NAS Celeron's, so a
  1080p software transcode there cannot keep real time without QuickSync.

### Addon behind a host that answers 100 ms late

| Container | Path | first frame 0.5.91 | first frame 0.5.93 | to 50 % 0.5.91 | to 50 % 0.5.93 | back 0.5.91 | back 0.5.93 | media reads 0.5.91 | media reads 0.5.93 | MB 0.5.91 | MB 0.5.93 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MP4 faststart | direct | 1.2 s | 1.5 s | 183 | 199 | 57 | 114 | 13 | 23 | 147 | 143 |
| MP4 faststart | remux | 1.1 s | 1.5 s | 628 | 634 | 626 | 823 | 16 | 26 | 262 | 211 |
| MP4 faststart | transcode | 1.3 s | 1.5 s | 922 | 755 | 869 | 1.0 s | 16 | 26 | 239 | 191 |
| MP4 moov at end | direct | 1.0 s | 1.1 s | 149 | 213 | 177 | 185 | 13 | 21 | 128 | 89 |
| MP4 moov at end | remux | 1.0 s | 1.2 s | 596 | 569 | 650 | 512 | 16 | 24 | 186 | 111 |
| MP4 moov at end | transcode | 1.2 s | 1.3 s | 720 | 654 | 705 | 599 | 16 | 24 | 183 | 104 |
| MKV H.264 | remux | 1.1 s | 949 | 7.9 s | 856 | 885 | 7.7 s | 19 | 19 | 269 | 153 |
| MKV H.264 | transcode | 1.3 s | 1.0 s | 1.2 s | 1.0 s | 1.0 s | 987 | 19 | 19 | 232 | 126 |
| AVI idx1 at end | transcode | 29.6 s | 1.1 s | 14.3 s | 595 | 14.3 s | 652 | 634 | 23 | 4661 | 92 |

This is the closest stand-in here for a debrid or CDN source over the internet. Bandwidth was not limited, so
0.5.91's 4.6 GB for the AVI would, on a real connection, also have cost
transfer time on top of the 634 round trips.

### 0.5.93 release, spot check

Twelve cells on `ca4608fb`, the release with #448 and its last two range commits:

| Source | Container | Path | first frame 0.5.91 | first frame 0.5.93 | first frame 0.5.93 release | to 50 % 0.5.93 release | back 0.5.93 release | media reads 0.5.93 release | metadata 0.5.93 release | MB 0.5.93 release |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Addon HTTP | MP4 faststart | direct | 262 | 654 | 646 | 112 | 106 | 23 | 1 | 129 |
| Addon HTTP | MKV H.264 | remux | 446 | 406 | 376 | 459 | 453 | 16 | 1 | 137 |
| Addon HTTP | AVI idx1 at end | transcode | 2.1 s | 769 | 640 | 506 | 489 | 21 | 1 | 88 |
| Jellyfin | MP4 faststart | direct | 2.0 s | 609 | 619 | 180 | 92 | 16 | 9 | 106 |
| Jellyfin | MKV H.264 | remux | 1.8 s | 609 | 731 | 415 | 409 | 12 | 9 | 145 |
| Jellyfin | AVI idx1 at end | transcode | 5.4 s | 801 | 751 | 499 | 550 | 13 | 9 | 81 |
| Emby | MP4 faststart | direct | 2.0 s | 1.2 s | 435 | 126 | 75 | 16 | 9 | 95 |
| Emby | MKV H.264 | remux | 1.6 s | 484 | 450 | 531 | 417 | 11 | 9 | 137 |
| Emby | AVI idx1 at end | transcode | 6.0 s | 807 | 758 | 695 | 1.4 s | 13 | 9 | 84 |
| Addon HTTP, 100 ms | MP4 faststart | direct | 1.2 s | 1.5 s | 1.2 s | 173 | 87 | 23 | 1 | 140 |
| Addon HTTP, 100 ms | MKV H.264 | remux | 1.1 s | 949 | 860 | 784 | 732 | 19 | 1 | 145 |
| Addon HTTP, 100 ms | AVI idx1 at end | transcode | 29.6 s | 1.1 s | 1.2 s | 489 | 634 | 23 | 1 | 90 |

The release behaves like #448's head, within the noise of single runs.

- **Slow-host MP4:** the first frame is back to 0.5.91's 1.2 s, but its probe still
  takes 0.89 s against 0.5.91's 0.65 s.
- **Fast-host addon MP4 direct:** 0.65 s on both #448's head and the release, against
  0.26 s on 0.5.91. Two runs agree; finding 7 explains it.
- **Emby AVI back-seek:** 1.4 s is a single outlier; its 50 % seek took 0.7 s.

## Findings

### 1. A cold Play probes the same file twice

**Where:** `PlaybackManager.inspect` (`server/src/playback.ts`).

**What happens:** the detail's `/api/inspect` and the player's `/api/playback` arrive
together when Play is pressed right after a source is chosen. Each request has its
own `AbortSignal`, and a caller with a signal gets its own in-flight map
(`cancelableMap(signal)`). The second call therefore never joins the first, and a
second ffprobe runs.

**Evidence:**

- The proxy log shows each probe range twice, a few milliseconds apart. Main Jellyfin
  MP4: `bytes=0-`, the tail and `bytes=3771143-`, each twice.
- On 0.5.93 the same pairs appear as 1 MiB block reads, so the duplicate survives the
  block cache: the two requests hold different media resources.

**Cost:** twice the probe's reads and ffprobe work on every cold Play; on the slow
addon host, twice its round trips. Its latency cost was not isolated here. The
cold-minus-warm gap (130–400 ms on fast sources) is mostly the probe itself, which
a cold Play waits for in any case.

### 2. Media-server reads are paced at 125 ms on the interactive path

**Where:** every media-server request waits for `NETWORK_START_INTERVAL_MS`
(`server/src/media-server-manager.ts`).

**On 0.5.91:** a Play made 18 such reads (inspect and start each authorized twice:
Detail, then Ancestors, then PlaybackInfo). The log shows them 125–130 ms apart
while each one took only 3–30 ms. So 0.75 s of a *warm* direct start was waiting,
which is why 0.5.91 took 737–784 ms to answer a warm media-server start and local took
4–6 ms. #448 removed this from the start: its warm start answers in 8 ms.

**What remains:** listing an item's sources still reads Info, User, Views, Detail,
Ancestors and PlaybackInfo in sequence, about 0.6 s at the pacing. In the cold 0.5.93
runs these reads all happen before Play (the detail's work). A Continue-watching card
that plays straight away pays them as part of the start.

### 3. Every converted seek restarts FFmpeg, even back into what was already converted

**Measured:** remux seeks took 0.3–0.6 s and transcode seeks 0.4–1.0 s, on every
source (0.5.93).

**Why the seek back also restarts:** the seek to 0:30 lands inside what the first
generation produced, yet it restarts too. The client only knows the current
generation, and the server purges a replaced generation 15 s after the switch.

**Also:** each restart re-opens the source and re-reads its header and index: 2–6
reads per seek for MKV and MP4. #448's blocks keep these cheap but not free.

**What it would take:** keeping finished generations as reusable stretches would
make the back-seek a native one (~50–100 ms). It touches the same retention and
eviction rules as the proposed [bounded playback buffer](playback-buffer-spec.md).

### 4. A chosen quality transcodes even when the file already fits it

`plan()` copies video only when `quality === null`.

**Example:** with 1080 chosen, the 720p MP4 is re-encoded at 100–145 % of a core, and
the 720×360 one at 36–56 %. Both are H.264 that would remux at 2 %.

**When a copy is enough:** the source is no taller than the chosen quality, its bitrate
is under the quality's cap (`QUALITY_BITRATE`), and the codecs can be copied. A
copy then satisfies what the viewer asked for. The player's automatic "lower
quality" offer after stalls is a separate case: it asks for a smaller picture and
must still transcode.

### 5. Software transcode CPU scales with picture size

libx264 `veryfast`, CRF 23:

| Source | Cores during the start burst | Cores at the 1.5× brake (estimate) |
| --- | --- | --- |
| 1080p | 2.2–2.4 | ≈ 1.2 |
| 720p | 1.0–1.45 | – |
| SD | 0.35–0.55 | – |

The start burst runs at 2.2–2.9× real time. Measured on an M4 Pro, with no hardware
encoder in the container.

**Stalls:** see [Transcode stalls](#transcode-stalls). They come from the handover,
not from CPU: the conversion log reports "keeping up" for every run.

### 6. Rare long seeks come from the player, not the server

Two of ~170 restart seeks took 7.7 s and 7.9 s. Both were MKV remuxes behind the
100 ms host, one on each build.

| Step | When |
| --- | --- |
| Server answered the seek | 0.55 s and 0.85 s |
| hls.js parsed the new manifest | 6 ms after that |
| hls.js loaded the first fragment | ~7 s later |

The segment existed when the server answered. This looks like hls.js holding back
its start position on a live (EVENT) playlist with a single segment
(`liveSyncDurationCount: 3`). Not reproduced on a fast host.

### 7. 0.5.93's blocks slow an addon MP4 down

**Why:** since #448 an addon or media-server read first takes cached or fresh 1 MiB
blocks, then waits `READ_AHEAD_GRACE_MS` (50 ms) before it opens the host for the rest
(`server/src/routes/playback.ts`). That is right for FFmpeg's index jumps: they hang up
inside the grace, and the jumps of an AVI cost no new transfer. Two kinds of read do
not jump, and they now pay for it.

**The browser's own direct-play reads.** On 0.5.91, the `<video>` element read
`bytes=0-` once and painted 70 ms after the start answer. On 0.5.93 the same
start makes three reads before the first frame, each served from blocks, then the
grace, then a fresh upstream transfer: `bytes=2097152-`, the tail, `bytes=5868295-`.
The first frame came 400 ms after the start answer.

| Addon MP4 direct, fast host | 0.5.91 | #448 head | 0.5.93 release |
| --- | --- | --- | --- |
| Play → first frame | 0.26 s | 0.65 s | 0.65 s |

**A faststart MP4's moov behind a slow host.** The 3.7 MB moov is now fetched as
sequential 1 MiB blocks, where the old open-ended read took one round trip.

| Addon MP4 behind the 100 ms host | 0.5.91 | #448 head | 0.5.93 release |
| --- | --- | --- | --- |
| Probe | 0.63–0.82 s | 0.79–0.98 s | 0.89 s |
| Play → first frame | 1.0–1.3 s | 1.1–1.5 s | 1.2 s |

**Where the blocks pay off:** MKV and AVI behind the same slow host are faster on
#448, by 0.15 s and 28 s.

### 8. Remote byte latency now dominates the remaining remote start

On 0.5.93 a cold remote probe takes 0.2–1.0 s, against 0.15–0.4 s locally.

**Biggest single cost:** the Synology Emby answers a tail read or an open-ended range
in 0.4–0.5 s, against 10–30 ms for its other reads.

**How the probe reads:** head block, second block, tail, then the rest, one after
another. The probe could ask for the head and tail blocks in parallel from the start.

### Not a problem

- **Direct play on any source:** 0.1–0.3 s warm on 0.5.93, seeks 35–250 ms.
- **MP4 remux:** costs 2 % of a core.
- **MKV remux:** 11–15 %, all of it AC-3 → AAC; the picture is copied.
- **Local library:** starts in 0.23–0.76 s on every path with no upstream at all.

## Ranked fixes

Benefit is measured on 0.5.93 on this setup unless it says *estimate*. Effort: S = a day or less, M = a few days,
L = a project.

| # | Fix | Benefit | Effort | Risk and notes |
| --- | --- | --- | --- | --- |
| 1 | **Hand over a transcode at two segments** ([Transcode stalls](#transcode-stalls), option A). Keep one segment for remux. | Removes the 1–3 stalls of every software transcode (8 → 0 in four cells), including the rare ~1 s ones. | S | A start or seek takes up to 0.3 s longer (median +0.08 s). A server change, so the TV client benefits too. |
| 2 | **Keep post-start and post-seek stalls out of the player's stall count** (option B). | The lower-quality offer is kept for real network trouble, not for a handover race. | S | Web player only. Worth doing even after item 1. |
| 3 | **Keep #448's block-and-grace reading for FFmpeg only** (#448 follow-up). Give the browser's and a native client's direct-play reads the plain ranged transfer they had before. For FFmpeg, fetch the next 4 MiB or the open-ended rest in one request once a reader continues past a block. | Gives back ~0.4 s on addon MP4 direct play (measured), likely the same on media-server direct play (same read path, not isolated), and ~0.25 s of a slow host's MP4 probe. Keeps #448's AVI gains. | S | Keep the per-read bound that #448 introduced so a host cannot push a whole film. |
| 4 | **Share one probe between `/api/inspect` and `/api/playback`.** Key the in-flight probe by source identity, not by request signal. Count subscribers so one request's abort never stops another's, and stop ffprobe when the last subscriber leaves. | Half the probe reads and ffprobe CPU on every cold Play. The latency gain is unmeasured: expected small on a fast host, up to a probe's round trips on a slow one. | S | The abort semantics are the whole job and already have tests to extend. Applies to every source type. |
| 5 | **Fix the hls.js first-fragment wait after a restart seek.** Attach the new generation with an explicit `startPosition: 0`, or load the first fragment without waiting for the live edge. | Removes the rare 7–8 s seeks. | S | Reproduce first. Run the D-pad/UI seek tests that already cover the player. |
| 6 | **Copy instead of transcode when the file already fits the chosen quality** (height, bitrate cap, copyable codecs). | Removes a software transcode, 0.4–2.4 cores, for those sessions. 2 % CPU instead. | S | The quality menu must still say what is happening. A source over the bitrate cap must still transcode. |
| 7 | **Let interactive single-item media-server reads go out without the 125 ms spacing.** A burst of about four for one Detail + Ancestors + PlaybackInfo, with Ancestors and PlaybackInfo in parallel once Detail answers. Keep bulk directory work paced. | *Estimate:* ~0.4–0.5 s off opening a media-server detail, and off a Continue-watching card that plays at once. Six reads now wait 125 ms each. | S–M | Pacing protects small servers. Bound the burst per connection and keep the queue limits. |
| 8 | **Read the head and tail blocks of a remote original in parallel when a probe starts.** | *Estimate:* 0.1–0.4 s off a remote probe, the measured tail-read latency (most on Emby/Synology). | S–M | Only for remote originals with a known size. Wasted if the probe never reads the tail (rare). |
| 9 | **Keep finished conversion generations and seek into them natively.** Bounded by disk or RAM, designed together with [bounded playback storage](playback-buffer-spec.md). | *Estimate:* back-seeks and rewinds at the measured native-seek speed (~0.05–0.1 s) instead of 0.3–1.0 s. Fewer source re-opens on hosts that count connections. | M–L | Retention and eviction, and the client needs to know more than one generation. |
| 10 | **Size the software transcode for a NAS.** For example `superfast` for ≥1080p when no hardware encoder is found, or a smaller initial burst for transcodes. Measure on the DS920+ first. | *Not measured:* less CPU for 1080p software transcodes on hardware that has no encoder. | S | Picture quality at the same CRF drops. Only worth it where hardware is missing. |

Items 1 and 2 answer the owner's priority and ship together. Items 3–6 are small,
independent and each ship on their own. Item 3 corrects a side effect of #448 and
belongs with its read-ahead code. Item 9 is the only large one and should wait for
the playback-buffer decision.

## Reproducing

```bash
# Image of the build to measure
git archive --format=tar <commit> | docker build -q -t stremio-offline:perf -

# Upstream logging: proxies in front of the media servers, the addon file server and its slow twin
node scripts/perf/range-proxy.mjs --log <work>/logs/upstream.jsonl \
  --proxy 18196=http://127.0.0.1:8096 --proxy 18197=http://<emby>:8096 \
  --files 18190=<work>/media --files "18191=<work>/media@100"

# Isolated copy of the app on :8092 with its media-server connections rewritten to the proxies
PERF_REWRITE="<jellyfin url>=http://host.docker.internal:18196 <emby url>=http://host.docker.internal:18197" \
PERF_HLS=<repo>/node_modules/hls.js/dist/hls.min.js scripts/perf/perf-instance.sh stremio-offline:perf <work>

# Measurement account (stop the copy first), cells, run, tables
docker stop stremio-offline-perf
docker run --rm -v <work>/data:/data -v <work>/test-user.json:/user.json:ro -v $PWD/scripts/perf:/perf:ro \
  --entrypoint node stremio-offline:perf /perf/add-runner.mjs
docker start stremio-offline-perf
node scripts/perf/cells.mjs <work>/sources.json > <work>/cells.json
node scripts/perf/run-matrix.mjs <work> <work>/cells.json <work>/results.jsonl
node scripts/perf/analyze.mjs <results.json> <work>/logs/upstream.jsonl <cpu.jsonl> <work>/logs/provider-snapshots.jsonl

# Stall timeline: segment publication beside the run; each result carries a `timeline`
node scripts/perf/segment-watch.mjs <work>/data/playback <work>/logs/segments.jsonl &
node scripts/perf/run-matrix.mjs <work> <cells with "attachAfterSegments": 2 or without> <results.jsonl>
```

`<work>/test-user.json` holds a generated username and password for the copy only
(`{"username": "perf-runner", "password": "…"}`). It is never committed.
`sources.json` names the library, addon keys and media-server item IDs of the setup
(see `cells.mjs`). Each instance needs the measurement library added
(`/libraries/perf`) and the two addons installed (`http://host.docker.internal:18190/manifest.json`,
`…:18191/manifest.json`).

## Not covered

- **Android TV client.** Its MP4 remux path was reached with the same capabilities,
  but not on a device.
- **Hardware encoding.** The container has none on a Mac, so all transcodes are
  software.
- **Subtitles.** All runs played with subtitles off; a sidecar reader adds its own
  source connection.
- **Network limits.** Bandwidth-limited links were not simulated, only latency.
- **Media-server transcoding.** Having Jellyfin or Emby transcode is out of scope:
  all conversion stays in the app's own FFmpeg.
