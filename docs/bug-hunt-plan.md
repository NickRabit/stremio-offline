# Bug hunt and optimisation plan

A working checklist for a systematic pass over the whole repository: find
defects, prove them, fix them, and remove measured waste. It is split into
**units** (one area of the code) and **parts** (one reviewable slice of a
unit). Record merged parts in periodic documentation pull requests; the part's
own pull request is the source of truth until then.

This plan builds on the hardening backlog in
[roadmap.md](roadmap.md#p1--recoverable-filesystem-and-cross-store-operations);
it does not reopen what that section records as shipped (H1–H4, the store
write contract from #304, the follow-service shutdown from #311/#318).

## How to run it with the AI team

Each part has an ID (`BH-<unit>.<part>`) that doubles as the `ai-team` task ID,
so its brief, worker log and review live under `.ai-team/tasks/BH-x.y/`. Invoke
`.claude/skills/ai-team/scripts/gates.sh BH-x.y` from the main checkout; the
script runs its checks in the task worktree. See
[android-tv-development.md](android-tv-development.md#6-the-ai-team-workflow-optional)
for the local setup. The worker may run its specified tests, but the reviewer
confirms their results and runs Android checks from `android-tv/` when relevant.

Fault injection, destructive operations, interrupted scans and shutdown tests
must use disposable data and download roots with synthetic libraries. Check
resolved paths before a test runs so it cannot touch configured user data or a
mounted library. A physical NAS run requires a separate, explicit test plan.

Per part:

1. **Architect (Claude)** reads the files listed for the part, writes the brief
   in `.ai-team/tasks/BH-x.y/`: suspected defects with file:line, the invariant
   each one breaks, and the measurement for each optimisation candidate.
2. **Reproduce first.** Every defect gets a failing test at the lowest useful
   layer ([testing.md](testing.md)) before any fix. Every optimisation gets a
   before/after number (time, allocations, requests, bundle bytes, renders).
   No number, no optimisation.
3. **Worker (DeepSeek via Codex)** implements the smallest fix that turns the
   test green. No drive-by refactors.
4. **Reviewer (Claude)** runs the gates (`npm test`, `npm run build`, Docker
   `/api/status`, and `cd android-tv && ./gradlew assembleDebug
   testDebugUnitTest lintDebug` for Android), and the adversarial checklist
   below for any change touching
   state, files, auth or processes.
5. One branch and one PR per part (or one per confirmed defect when a part
   yields several unrelated ones). Patch version bump when the fix is
   user-facing, per [AGENTS.md](../AGENTS.md).
6. Record real out-of-scope findings in the part PR description or a linked
   issue, then copy them into **Found along the way** in a documentation PR.
   Do not implement them in an unrelated part.

Adversarial checklist (from the roadmap): actor/resource authorization, two
concurrent callers, failure before/after each side effect, repeated request,
restart/replay, secrets in logs or responses, abort/cleanup ownership.

## Unit 0 — Baseline and instruments

Do this first; every later "optimisation" is judged against these numbers.

- [x] **BH-0.1 Green baseline.** `npm test`, `npm run build`, e2e in Docker,
      Android gates. Record counts, durations and build warnings. List observed
      skips and flakes with their files and run or CI evidence; a single pass
      cannot establish that no flaky tests exist.
      Done in #489: [bug-hunt-baseline.md](bug-hunt-baseline.md).
- [x] **BH-0.2 Runtime baseline.** On a seeded instance (e2e seed or a fixed
      synthetic library of ~5k files): cold start time, RSS after start and
      after a full scan, full-scan and rescan latency, `/api/home` and
      `/api/library/browse` p50/p95, search-everywhere time to first and last
      result. Script it under `scripts/` so later parts can re-run it.
      Done in #490: [bug-hunt-runtime-baseline.md](bug-hunt-runtime-baseline.md), `scripts/benchmark-runtime.mjs`.
- [ ] **BH-0.3 Client baseline.** Web bundle size per chunk, Lighthouse/
      Playwright trace of Home, Library and Player first paint; React Profiler
      commit counts for typing in search and for an idle Home with polling.
      Android: cold start and Home first frame on the emulator.
- [x] **BH-0.4 Error-swallowing inventory.** List every `.catch(() => {})` /
      `.catch(() => undefined)` in production code (currently over 300 matching
      lines, densest in `desktop/src/main.ts`, `web/src/App.tsx`,
      `server/src/media-server-security.ts`,
      `media-server-manager.ts`, `downloads.ts`, `Player.tsx`,
      `remote-image-cache.ts`, `index.ts`). Classify each as *intended
      best-effort* (leave, maybe log at debug) or *hides a failure the user
      or a store needs to know* (becomes a part in its unit).
      Done in #491: [bug-hunt-error-swallowing-inventory.md](bug-hunt-error-swallowing-inventory.md), 129 candidates.

## Unit 1 — Server: persistent state and lifecycle

Files: `store.ts`, `state-file.ts`, `fs-retry.ts`, `library-meta-store.ts`,
`library-ops.ts`, `library-seen.ts`, `stats.ts`, `activity.ts`,
`provider-stats.ts`, `image-stats.ts`, `external-ids.ts`, `server-start.ts`,
`server-shutdown.ts`, `index.ts` (lifecycle parts only).

- [x] **BH-1.1 State write and recovery contracts.** Check every JSON store
      against the `Store.update` write contract (apply, write, roll back on
      failure). Audit read-side handling separately: stores using
      `preserveDamaged` keep a `.damaged-*` copy, while `Store.load` currently
      rejects malformed `state.json`. Stores not yet audited:
      `stats`, `activity`, `provider-stats`, `image-stats`, `external-ids`,
      `library-seen`, `library/episodes.json`.
      Progress: #505 keeps traffic, image and provider statistics saving after a failed write; #506 serialises the image and artwork cache index writes and retries a failed one. `activity` and `follows` were already serialised; `library-meta-store` already protects an unreadable file. #512 does the same for the per-library match history and `episodes.json` (one write per file at a time, a failed write owed again, a forget that waits for a write under way), for the first-seen index and for the external id cache.
- [x] **BH-1.2 Shutdown completeness.** `server-shutdown.ts` flushes stores,
      stops the follow service and explicitly kills tracked media processes.
      It deliberately leaves the download queue to resume after restart.
      Test SIGTERM during a download, a scan and a conversion: verify queue
      recovery, scan persistence, child coverage and bounded exit.
      Progress: #505 adds the traffic log to the shutdown flushes (up to a minute of transfer bytes was lost on restart). The three cases are covered by unit tests rather than a spawned-server run (which would need the outbound guard opened to a local source): `downloads.test.ts` requeues a downloading job from its `.part` after load; `library-scan.test.ts` resumes an interrupted scan and recheck; `playback.test.ts` stops media and subtitle readers and a preserved fallback conversion; `server-shutdown.test.ts` covers step order, a failing flush, the one-second follow bound and exit on the first signal.
- [x] **BH-1.3 Timers and intervals.** Every `setInterval` across
      server/web/desktop. Each one: is it cleared on stop, `unref()`'d on the
      server, and is its period justified? Coalesce intervals that poll the
      same thing.
      Progress: every server `setInterval` is `unref()`'d or cleared on stop (download watchers clear themselves when the halt lifts); web polls stop in a hidden tab (#497, #508); the player's intervals stay on purpose, playback continues in a background tab.
- [ ] **BH-1.4 Write amplification.** Measure how often each store writes
      under load (progress ticks, stats, activity). Pretty-printed
      (`JSON.stringify(…, null, 2)`) large files rewritten per tick are a
      candidate; coalesce, do not lose durability of commits.
      Progress: a playing client posts its position every 10 s, and each post rewrites the whole state file (clone, pretty JSON, temporary file and rename). For a state of a few hundred kB that is tens of MB an hour per player: acceptable, and coalescing would change what an awaited `update` promises. Not changed.
- [ ] **BH-1.5 Journalled relocation** (roadmap P1.3) — only if not already
      shipped when this part starts.

## Unit 2 — Server: downloads, transfers, follows

Files: `downloads.ts`, `download-segments.ts`, `download-selection.ts`,
`download-policy.ts`, `library-transfer.ts`, `device-transfers.ts`,
`follows.ts`, `debrid.ts`, `throughput.ts`, `routes/downloads.ts`,
`routes/follows.ts`, `routes/device.ts`.

- [ ] **BH-2.1 Queue state machine.** Write the transition table (queued,
      waiting, checking, downloading, paused, completed, failed) from the
      code, then test every transition's side effects, including retry
      back-off and `notBefore`.
- [ ] **BH-2.2 Transfer failure paths.** Disk full, permission lost, target
      unmounted, source 4xx/5xx mid-stream, Range unsupported, segment
      reassembly after restart. No `.part` left that blocks a retry; no
      success shown for a failure.
- [ ] **BH-2.3 Follow ↔ queue reconciliation.** Crash after reserve, enqueue,
      adopt, complete and clear-history (roadmap list); revocation during
      discovery.
- [ ] **BH-2.4 Device transfers.** Ownership, cancellation, concurrent
      transfers of the same title, cleanup of staged files.
- [ ] **BH-2.5 Throughput.** Buffer sizes, backpressure (`pipeline` vs
      manual `write`), concurrent segment count, CPU per MB/s. Measure on a
      local fast source before changing anything.

## Unit 3 — Server: playback and FFmpeg

Files: `playback.ts`, `routes/playback.ts`, `media-playlist.ts`,
`player-sidecars.ts`, `player-previews.ts`, `conversion-pace.ts`,
`range-cache.ts`, `byte-cache.ts`, `remote-read-ahead.ts`, `probe.ts`,
`media-tools.ts`, `vtt.ts`, `next-episode.ts`, `next-file.ts`.

- [ ] **BH-3.1 Process ownership.** Every spawned FFmpeg/ffprobe has one
      owner and one kill path: session end, owner revocation, client
      disconnect, server shutdown, hardware-accel fallback. Closing one HLS
      segment request must not kill a healthy conversion.
      Progress: #515 tracks the thumbnail, mosaic, image-resize and ffprobe children with `trackMedia`, so the shutdown takes them down too (they outlived the server and kept writing into its data folder; found as the benchmark's occasional ENOTEMPTY). The hardware-encoder probes in `playback.ts` stay untracked: 0.1 s of `nullsrc`, nothing written.
- [ ] **BH-3.2 Seek and restart races.** Rapid seeks, two tabs on one
      session, switching source mid-play; serialized operations hold.
- [ ] **BH-3.3 Caches.** `range-cache`, `byte-cache`, `remote-read-ahead`:
      bounded size, eviction under memory pressure, no unbounded `Map`
      growth per session.
- [ ] **BH-3.4 Sidecars and subtitles.** Encoding detection, malformed VTT/SRT,
      very large subtitle files, timing offsets.
- [ ] **BH-3.5 Conversion cost.** FFmpeg concurrency limit, preset choice,
      remux-instead-of-transcode coverage. Measure CPU and time to first
      segment on the baseline media set.

## Unit 4 — Server: library scan, match and artwork

Files: `library*.ts` (scan, parse, match, walk-cache, watch, autoscan, probe,
candidates, episodes, migrate, actions, admin, grants, runtime), `naming.ts`,
`artwork*.ts`, `mosaic.ts`, `images.ts`, `remote-image-cache.ts`,
`walk-cache.ts`, `local-sources.ts`.

- [ ] **BH-4.1 Scan correctness.** Interrupted scan resume, files renamed or
      vanished during scan, symlinks and loops, unmounted root (must never be
      read as "library is empty"), case-only renames, Unicode normalization
      (NFC/NFD on macOS/Synology shares).
- [x] **BH-4.2 Scan performance.** Profile a full scan of the baseline set:
      directory walk concurrency, probe calls per file, repeated `stat`,
      work done on unchanged files during a rescan.
      Progress: #500 makes a scan linear (4,000 files: 34.8 s → 3.5 s; browse p50 55 → 35 ms), #501 builds parse patterns once, #502 names a folder's artwork once per sweep, #503 finds a finished scan's stale rows by key (~3.6 s blocking → ~30 ms), #504 reads a library key without splitting it. Full scan of 4,000 files on main: ~2.1 s (Linux); the rest is disk I/O and artwork hashes.
- [ ] **BH-4.3 Parser and matcher.** `library-parse.ts` / `library-match.ts`
      against a table of real-world names (years, multi-episode, anime
      absolute numbering, editions, foreign titles). Look for quadratic
      matching over candidates.
      Progress: #498 fixes the year and multi-episode tags; the shared parser brief (#499) is set aside.
- [ ] **BH-4.4 Destructive actions.** Rename, move, copy, delete, bulk and
      cross-library: explicit preconditions, no swallowed errors (roadmap
      P1.4).
      Progress: rename, move, copy and delete keep their preconditions (resolved path, busy check, nested library, name clash, admin re-check just before the disk changes). Gap, awaiting a decision: subtitle sidecars (`<stem>.srt`, `<stem>.<lang>.vtt`, matched by the video's stem) are not carried by a file rename or a single-file move or copy, nor removed with a deleted video, so the player stops offering them.
- [ ] **BH-4.5 Images and artwork.** Cache bounds and eviction, sweep only on
      a provably readable library, concurrent generation of the same mosaic,
      remote image fetch timeouts and size limits.
      Progress: #502 (sweep cost) and #506 (cache index writes). `ArtworkCache.copyKey` writes its target directly rather than through a temporary file; a cache-only file, so left as is.

## Unit 5 — Server: catalogue, addons and search

Files: `search-*.ts`, `addons.ts`, `addon-refresh.ts`, `tmdb.ts`,
`trailers.ts`, `home.ts`, `home-catalogs.ts`, `outbound.ts`, `in-flight.ts`,
`ranking.ts`, `routes/catalog.ts`, `routes/content.ts`, `routes/home.ts`,
`routes/search-everywhere.ts`, `routes/addons.ts`.

- [ ] **BH-5.1 Outbound robustness.** Every addon/TMDB call has a timeout, a
      size limit and a cancellation path tied to the client request; one slow
      addon cannot stall Home or search.
      Progress: #517 gives Real-Debrid a 30-second deadline and retry; #521 classifies body-read timeouts for that retry. #518 limits addon JSON to 16 MiB, and #521 stops image reads at 8 MiB. #522 holds host slots through non-search addon JSON bodies; #523 holds them through image reads. #524 caps Real-Debrid JSON at 16 MiB; #525 caps TMDB and Wikidata JSON. This branch cancels abandoned catalogue, search, and stream addon requests. Redirected image bodies remain accounted to the original URL host. Metadata, subtitle, and image routes still need client-disconnect cancellation, with shared image downloads retaining other callers.
- [x] **BH-5.2 Search session lifecycle.** Stale results after a new query,
      sessions that never end, scheduler fairness between sources, memory per
      abandoned session.
      Progress: verified. Catalogue search sessions are capped per owner and server-wide, destroyed on replacement and on stop, and covered by the session, scheduler and contract suites.
- [x] **BH-5.3 Request de-duplication and caching.** `in-flight.ts` coverage,
      cache keys that include the account where results are per-user, TTLs.
      Count outbound requests for one Home load before and after.
      Progress: verified. Playback inspection shares one probe per source and lets each caller leave on its own abort without cancelling the others; Home shelves, external ids, images, mosaics and library health each run once per key, and only the entry a call created is removed. The outbound count per Home load is not measured.
- [ ] **BH-5.4 Home assembly.** `/api/home` latency breakdown per shelf;
      `mergeResume`/`boundCards` correctness with mixed file and catalogue
      progress.

## Unit 6 — Server: media-server integration (Jellyfin/Emby)

Files: `media-server-*.ts` (~10k lines, `manager` 3.6k and `security` 2k the
largest), `routes/media-servers.ts`.

- [x] **BH-6.1 Secrets.** Tokens never in logs, responses, error messages or
      exported settings; rotation and removal leave nothing behind.
      Progress: verified. The one log line about a media-server token carries the connection id and an error code; the secrets and security suites (110 tests) cover tokens in logs, errors and responses.
- [ ] **BH-6.2 Swallowed errors.** The silent catches in
      `media-server-security.ts` and `media-server-manager.ts` from BH-0.4.
- [ ] **BH-6.3 Index and sync.** Incremental vs full sync, server
      unreachable mid-sync, deleted items, quota and retention edge cases.
- [ ] **BH-6.4 Playback and progress bridging.** `media-server-playing.ts`,
      `-personal.ts`: expected progress cadence and duplicate suppression,
      session cleanup, and behaviour when the remote server rejects an update.

## Unit 7 — Server: auth, roles and the HTTP boundary

Files: `auth.ts`, `roles.ts`, `secure.ts`, `security.ts`, `host-check.ts`,
`restricted.ts`, `revocation.ts`, `users.ts`, `library-grants.ts`,
`airplay-access.ts`, `logger.ts`, `access-log.ts`, `routes/*.ts`.

- [ ] **BH-7.1 Route inventory.** Generate the list of all route
      registrations with their role requirement and ownership check; flag
      read routes that serve private data without an owner check, and
      routes where a foreign ID is distinguishable from a missing one.
- [ ] **BH-7.2 SSRF and DNS rebinding.** Address changes between validation
      and connection, redirects, allowed-private-host config (roadmap P1).
- [ ] **BH-7.3 Revocation during work.** Account deletion or grant removal
      while a download, scan, transfer or playback runs.
- [ ] **BH-7.4 Input validation.** Path traversal on every route that takes
      a path, request body size limits, malformed JSON handling.
      Progress: #493 tells a refused folder from a missing one (browse, grants, preview, library root, create folder, rename).
      Progress: `mediaPath` rejects absolute, drive-letter and `.`/`..` paths before joining onto the library root, as the last line behind every route; a per-route audit is still to do.
- [x] **BH-7.5 Log redaction.** Addon URLs with embedded keys, debrid tokens,
      media-server tokens in `app.log` and client logs.
      Progress: verified. `logger.ts` redacts centrally: every http(s) address in a message or a context value is cut to scheme and host (query and path, where tokens and addon keys live, never reach the log), keys named like token, password, secret, authorization, cookie or api key are masked, and a newline cannot forge a second record.

## Unit 8 — Server: `index.ts` composition

- [ ] **BH-8.1 Map responsibilities** still living in `index.ts` (2.8k
      lines): library mutation, artwork coordination, source resolution,
      lifecycle. Pick extractions only where a defect from units 1–7 needs a
      testable seam (roadmap P2), not for size alone.
- [x] **BH-8.2 Unhandled rejections.** Process-level handlers, async route
      handlers whose rejection escapes Express error handling.
      Progress: verified. `unhandledRejection` and `uncaughtException` are logged and survived; Express 5 forwards async route rejections; every streaming route handles a failure after its headers itself (destroying the response), so the error handler never answers a response already under way. A drain awaited without a signal does not hang: Node emits `drain` when the socket is destroyed.

## Unit 9 — Web: application shell

Files: `web/src/App.tsx` (about 3.9k lines, many effects and state hooks),
`api.ts`, `useHome.ts`, `home-state.ts`, `start-view.ts`, `views.ts`.

- [x] **BH-9.1 Effect hygiene.** Every effect in `App.tsx`: cleanup present,
      dependencies correct, no fetch whose late response overwrites newer
      state (AbortController or request token). React StrictMode double-run
      safe.
      Progress: every effect that reruns on changed input drops a late answer (`live`/`cancelled` flags); every `addEventListener` in `App.tsx` and the player has its removal.
- [x] **BH-9.2 Polling.** Which effects poll, how often, and whether they
      stop when the tab is hidden or the view is not shown.
      Progress: #497 (library scan and operations polls) and #508 (statistics live streams) skip a repeat in a hidden tab.
- [ ] **BH-9.3 Re-render cost.** Profiler on typing in search, scrolling
      Home and the library; memoise only what the profiler shows.
- [x] **BH-9.4 API error surface.** `api.ts` silent catches: does the user
      ever see "nothing" where an error happened? Every server `AppError`
      key reaches a translated message.
      Progress: the silent catches in `api.ts` are the unload beacons, which have nobody to tell; the i18n test already checks every server message key against the catalogue.
- [ ] **BH-9.5 Extractions with a reason.** Settings/diagnostics and
      catalogue/search orchestration out of `App.tsx` (roadmap P2), only
      after 9.1–9.4 so the moves carry their tests.

## Unit 10 — Web: player

Files: `Player.tsx`, `player-hls.ts`, `TrailerPlayer.tsx`,
`playback-identity.ts`, `SourceChooser.tsx`, `streams.ts`.

- [ ] **BH-10.1 Teardown.** hls.js and `<video>` listeners released on close,
      source switch and navigation; no growing listener count after ten
      open/close cycles (heap snapshot).
      Progress: read through. Closing destroys hls.js, empties the source and removes every listener the player adds. To check on a device (BH-3.2): after a track switch or a recovery that falls back to direct play, the move to the kept position waits for `loadedmetadata` with a `once` listener that no attach sequence guards; a seek or a second switch made before the metadata arrives could be overridden by it.
- [ ] **BH-10.2 Progress reporting.** Frequency, final position on close/tab
      hide (`pagehide`/`sendBeacon`), no duplicate writes, correct identity
      for library vs catalogue plays.
- [ ] **BH-10.3 Error recovery.** Network drop, server restart mid-play,
      unsupported codec fallback, Safari/iOS native HLS path.

## Unit 11 — Web: features, i18n, CSS and bundle

Files: `RemoteLibraryBrowser.tsx` (1.8k), `MediaServerManager.tsx`,
`LibraryManager.tsx`, `SearchEverywhere.tsx`/`useSearchEverywhere.ts`,
dialogs, `style.css` (2.3k), `i18n/*`, `vite.config.ts`.

- [ ] **BH-11.1 Large lists.** Library and remote browser with thousands of
      items: render time, virtualisation need (measure first), image lazy
      loading.
- [x] **BH-11.2 Dialogs and focus.** Conformance with
      [ui-conventions.md](ui-conventions.md); focus trap, Escape, TV/remote
      navigation.
      Progress: #510 puts the ten modal dialogs that lacked it on `useDialogFocus`, with a source guard for new ones; the player and the trailer keep their own handling.
- [x] **BH-11.3 i18n completeness.** All nine translated catalogues are
      type-checked against `en.ts`. Check placeholder names and plural forms,
      untranslated values and meaning in context; report verified gaps per
      language.
      Progress: #507 removes zero-width characters from it, pl and ru (and Android ru) and fixes the pt-BR and es 'skipped' wording; a catalogue test keeps invisible characters out. Keys, placeholders and plural forms were already complete.
- [x] **BH-11.4 Bundle.** No `React.lazy` split exists today and the build
      warns about chunk size. Split rarely used views (settings, admin,
      stats, media-server manager, player) and measure first-load bytes.
      Progress: #494 loads non-English catalogues on demand (first load 713 → 412 kB gzip). hls.js (~160 kB gzip) is the next candidate.
      Progress: #496 loads hls.js on demand. Splitting settings, statistics and addons would save about 25 kB gzip, but the app has no error boundary, so a failed chunk (a tab kept open across an upgrade) would blank the page: not done, see Found along the way.
- [ ] **BH-11.5 CSS.** Dead selectors, duplicated rules; split by
      responsibility only with the visual matrix run once at the end
      (roadmap P2).
      Progress: #509 removes 64 selectors of 22 classes no element uses (−4 kB). Duplicated rules measured: one repeated block (`.follow-actions`, 52 bytes) and about 60 declarations a later rule with the same selector and context overrides, about 1 kB raw and 0.2 kB gzip; not worth a layout risk, left.

## Unit 12 — Desktop (Electron)

Files: `desktop/src/main.ts` (1.8k), `local-backend.ts`, `download-dir.ts`,
`window-state.ts`, `login-item.ts`, `connection-file.ts`, `shell-api.ts`,
`local-media-key.ts`.

- [ ] **BH-12.1 Local backend lifecycle.** Start failure, port in use, crash
      and restart, quit during a download or conversion, switch between
      local and remote server.
- [x] **BH-12.2 IPC surface.** Every `ipcMain` handler validates its input
      and the sender; nothing exposes arbitrary file paths.
      Progress: every handler checks its sender (`assertShellSender` or `localPageSent`) and validates its input; folder paths come only from the native picker.
- [x] **BH-12.3 Settings files.** `connection.json`, `local-settings.json`,
      `window-state.json`: corrupt-file handling, off-screen window recovery.
      Progress: #492 reports sign-ins, settings or servers a reset could not remove.
      Progress: verified. Every settings file (connection, local settings, window state, shell prefs, remembered port, download-folder ownership) reads a malformed file as its defaults and is written through a uniquely named temporary file and a rename; a saved window is fitted back onto a display's work area. A malformed `connection.json` reads as no servers, so the next save replaces it; with atomic writes that needs damage from outside.

## Unit 13 — Android TV

Files: `android-tv/app/src/main/java/cz/stremiooffline/tv/` — `playback/`
(`PlaybackController.kt` 1.1k), `data/ApiClient.kt`, `ui/` (62 files,
`CatalogDetailScreen.kt` 1.7k, `RemoteLibraryScreen.kt`, `PlayerScreen.kt`,
`DetailScreen.kt`, `RemoteDetailScreen.kt`, `Shell.kt`).

- [ ] **BH-13.1 Player lifecycle.** ExoPlayer released on stop/back/home,
      progress saved on pause and on process death, track and subtitle
      choice survives source switch.
- [ ] **BH-13.2 Coroutines and network.** Scopes cancelled with their screen,
      timeouts on every call, behaviour when the server is unreachable or the
      session expired (sign-in, not a blank screen).
- [ ] **BH-13.3 Compose performance.** Recomposition counts on Home and
      Catalog detail rows, stable keys in lazy lists, image sizes requested
      at tile size.
- [ ] **BH-13.4 D-pad focus.** Lost focus after data refresh, focus restore on
      back, long rows.
- [x] **BH-13.5 Server contract.** DTOs in `data/*Dtos.kt` vs the server's
      responses: missing or renamed fields, nullable assumptions.
      Progress: every list (Home, browse, favourites, resume, media servers) decodes item by item and drops an unknown `kind`; unknown fields are ignored, and every Home kind the server sends is known to the app.

## Unit 14 — Cross-cutting

- [x] **BH-14.1 Contract drift.** Compare `web/src/types.ts` and the Android
      DTOs with what the server serialises (`api-types.ts`, `publicJob` and
      friends). Start with download pause reasons (roadmap P2).
      Progress: the Android side is covered by BH-13.5; web and server share `api-types.ts`. Pause reasons match on all three sides (downloads: user, storage, library, permission; scans and library operations as the server sends them), and every paused download tells the person why: a library line, or the error the storage and permission pauses set.
- [ ] **BH-14.2 Test suite health.** Flaky and slow tests from BH-0.1: fix
      the cause, never skip. Server and web suite wall time.
      Progress: measured per file (Linux, four at a time): the server suite's wall time (~100 s) is `downloads.test.ts` alone (~103 s; its slowest tests move 32 MB over a local range server and wait out retries, 5–13 s each), then `library-move-recovery.test.ts` (~67 s; two real server boots and a 2 s save debounce per test, ~5 s each). Every other file is under 12 s. Not changed: shrinking the transfers risks the segmentation thresholds the tests exercise.
- [ ] **BH-14.3 Docker image and CI.** Image size, layer caching, CI
      duration per workflow; Synology/ARM64 build.
- [ ] **BH-14.4 Re-run the baseline** (BH-0.2, BH-0.3) and record the
      before/after table below.
      Progress: the runtime baseline (BH-0.2) is re-run on one Linux machine for both commits, table below; the web bundle size is filled in. BH-0.3's Lighthouse and React Profiler traces and the Android cold start are still to do, so the part stays open.

## Results

| Metric | Baseline (BH-0) | After (BH-14.4) |
| --- | --- | --- |
| Server tests (passed / skipped / s) | 2,829 / 6 / 47.5 (Mac) | 2,848 passed (Linux, ~100 s: see BH-14.2) |
| Web tests (passed / s) | 1,167 / 8.9 (Mac) | 1,169 passed (Linux) |
| Desktop and media-client tests (passed / skipped / s) | 301 / 0 / 1.2; 29 / 1 / 1.7 (Mac) | |
| Cold start / RSS | 343 ms / 167 MiB (5k files, Mac) | |
| Full scan / rescan (5k files) | 24.3 s / 0.76 s (Mac) | |
| `/api/home` p95 | 5.6 ms (Mac) | |
| Web first-load JS (gzip) | 715 kB | 250 kB (Linux build; hls.js 162 kB and non-English catalogues load on demand) |
| Android cold start | | |

The Mac baseline cannot be repeated from a cloud session, so the runtime numbers were taken
again on one Linux machine for both ends: `node scripts/benchmark-runtime.mjs --files 5000 --samples 40`
on the baseline commit (`2d1d2b47`, #490) and on `main` after #513 (`b8760659`). Same machine,
same fixture, back to back; home and browse are the 40-sample runs.

| Metric (5,000 files, Linux) | Baseline `2d1d2b47` | After `b8760659` |
| --- | ---: | ---: |
| Cold start | 1,316 ms | 1,156 ms |
| RSS after start / after first scan | 148 / 325 MiB | 147 / 205 MiB |
| Full scan | 39.3 s | 2.8 s |
| Rescan | 1.96 s | 1.27 s |
| `/api/home` p50 / p95 | 6.2 / 11.7 ms | 4.3 / 8.6 ms |
| `/api/library/browse` p50 | 38.5 ms | 24.0 ms |

## Found along the way

Real issues outside the part that found them. Each becomes its own part or
issue; do not fix them inside an unrelated PR. Copy verified findings here in
a periodic documentation PR after recording them in the originating PR.

- Desktop reset (BH-12.3, #492): the wiring in `desktop/src/main.ts` has no unit
  test; `main.ts` has no harness. Covered by typecheck and desktop-e2e only.
- `scripts/check-error-swallowing-inventory.mjs` reads the recorded commit from
  git and fails in a shallow clone that lacks it (#491).
- A failed `.part` unlink after a source failover leaves an orphan `.part` and
  gives the next download a `(2)` name; no corruption (`downloads.ts`, BH-2.2).
- `LibraryOps.settled()` swallows failures but has no production caller (BH-1.1).
- `scripts/benchmark-runtime.mjs` serves `web/` rather than `web/dist` from a
  source checkout; it measures the API only, so its numbers are unaffected.
- The web app has no React error boundary, so a failed lazy chunk would blank the
  whole page. Any further `React.lazy` split needs a boundary (with a reload
  offer) first (BH-11.4).
- `TrailerPlayer` declares `aria-modal` but cannot use `useDialogFocus` as it is
  (always mounted, returns `null` until a trailer is chosen, YouTube iframe
  inside); exempted in the guard of #510 (BH-11.2).
