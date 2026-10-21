# Bug hunt and optimisation plan

A working checklist for a systematic pass over the whole repository: find
defects, prove them, fix them, and remove measured waste. It is split into
**units** (one area of the code) and **parts** (one reviewable slice of a
unit). Tick a part only when its pull request has merged.

This plan builds on the hardening backlog in
[roadmap.md](roadmap.md#p1--recoverable-filesystem-and-cross-store-operations);
it does not reopen what that section records as shipped (H1–H4, the store
write contract from #304, the follow-service shutdown from #311/#318).

## How to run it with the AI team

Each part has an ID (`BH-<unit>.<part>`) that doubles as the `ai-team` task ID,
so its brief, worker log and review live under `.ai-team/tasks/BH-x.y/` and the
gates run as `.claude/skills/ai-team/scripts/gates.sh BH-x.y`. See
[android-tv-development.md](android-tv-development.md#6-the-ai-team-workflow-optional)
for the setup; the worker sandbox has no Node or Java, so the reviewer runs the
gates and `./gradlew` on the host.

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
   `/api/status`, `./gradlew assembleDebug testDebugUnitTest lintDebug` for
   Android), and the adversarial checklist below for any change touching
   state, files, auth or processes.
5. One branch and one PR per part (or one per confirmed defect when a part
   yields several unrelated ones). Patch version bump when the fix is
   user-facing, per [AGENTS.md](../AGENTS.md).
6. Findings that are real but out of scope for the part go to the
   **Found along the way** list at the bottom, not into the PR.

Adversarial checklist (from the roadmap): actor/resource authorization, two
concurrent callers, failure before/after each side effect, repeated request,
restart/replay, secrets in logs or responses, abort/cleanup ownership.

## Unit 0 — Baseline and instruments

Do this first; every later "optimisation" is judged against these numbers.

- [ ] **BH-0.1 Green baseline.** `npm test`, `npm run build`, e2e in Docker,
      Android gates. Record counts, durations and the existing large-chunk
      warning. List every skipped and every flaky test with its file.
- [ ] **BH-0.2 Runtime baseline.** On a seeded instance (e2e seed or a fixed
      synthetic library of ~5k files): cold start time, RSS after start and
      after a full scan, full-scan and rescan latency, `/api/home` and
      `/api/library/browse` p50/p95, search-everywhere time to first and last
      result. Script it under `scripts/` so later parts can re-run it.
- [ ] **BH-0.3 Client baseline.** Web bundle size per chunk, Lighthouse/
      Playwright trace of Home, Library and Player first paint; React Profiler
      commit counts for typing in search and for an idle Home with polling.
      Android: cold start and Home first frame on the emulator.
- [ ] **BH-0.4 Error-swallowing inventory.** List every `.catch(() => {})` /
      `.catch(() => undefined)` in production code (~130, densest in
      `web/src/App.tsx`, `server/src/media-server-security.ts`,
      `media-server-manager.ts`, `downloads.ts`, `Player.tsx`,
      `remote-image-cache.ts`, `index.ts`). Classify each as *intended
      best-effort* (leave, maybe log at debug) or *hides a failure the user
      or a store needs to know* (becomes a part in its unit).

## Unit 1 — Server: persistent state and lifecycle

Files: `store.ts`, `state-file.ts`, `fs-retry.ts`, `library-meta-store.ts`,
`library-ops.ts`, `library-seen.ts`, `stats.ts`, `activity.ts`,
`provider-stats.ts`, `image-stats.ts`, `external-ids.ts`, `server-start.ts`,
`server-shutdown.ts`, `index.ts` (lifecycle parts only).

- [ ] **BH-1.1 One write contract everywhere.** Check every JSON store against
      the contract `Store.update` follows (apply, write, roll back on failure;
      preserve unreadable files as `.damaged-*`). Stores not yet audited:
      `stats`, `activity`, `provider-stats`, `image-stats`, `external-ids`,
      `library-seen`, `library/episodes.json`.
- [ ] **BH-1.2 Shutdown completeness.** `server-shutdown.ts` flushes stores
      and stops the follow service, but does not stop the download queue,
      settle scan persistence or kill FFmpeg children explicitly. Test SIGTERM
      during a download, a scan and a conversion; nothing written half, no
      orphan process, exit within the bounded time.
- [ ] **BH-1.3 Timers and intervals.** 42 `setInterval` calls across
      server/web/desktop. Each one: is it cleared on stop, `unref()`'d on the
      server, and is its period justified? Coalesce intervals that poll the
      same thing.
- [ ] **BH-1.4 Write amplification.** Measure how often each store writes
      under load (progress ticks, stats, activity). Pretty-printed
      (`JSON.stringify(…, null, 2)`) large files rewritten per tick are a
      candidate; coalesce, do not lose durability of commits.
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
- [ ] **BH-4.2 Scan performance.** Profile a full scan of the baseline set:
      directory walk concurrency, probe calls per file, repeated `stat`,
      work done on unchanged files during a rescan.
- [ ] **BH-4.3 Parser and matcher.** `library-parse.ts` / `library-match.ts`
      against a table of real-world names (years, multi-episode, anime
      absolute numbering, editions, foreign titles). Look for quadratic
      matching over candidates.
- [ ] **BH-4.4 Destructive actions.** Rename, move, copy, delete, bulk and
      cross-library: explicit preconditions, no swallowed errors (roadmap
      P1.4).
- [ ] **BH-4.5 Images and artwork.** Cache bounds and eviction, sweep only on
      a provably readable library, concurrent generation of the same mosaic,
      remote image fetch timeouts and size limits.

## Unit 5 — Server: catalogue, addons and search

Files: `search-*.ts`, `addons.ts`, `addon-refresh.ts`, `tmdb.ts`,
`trailers.ts`, `home.ts`, `home-catalogs.ts`, `outbound.ts`, `in-flight.ts`,
`ranking.ts`, `routes/catalog.ts`, `routes/content.ts`, `routes/home.ts`,
`routes/search-everywhere.ts`, `routes/addons.ts`.

- [ ] **BH-5.1 Outbound robustness.** Every addon/TMDB call has a timeout, a
      size limit and a cancellation path tied to the client request; one slow
      addon cannot stall Home or search.
- [ ] **BH-5.2 Search session lifecycle.** Stale results after a new query,
      sessions that never end, scheduler fairness between sources, memory per
      abandoned session.
- [ ] **BH-5.3 Request de-duplication and caching.** `in-flight.ts` coverage,
      cache keys that include the account where results are per-user, TTLs.
      Count outbound requests for one Home load before and after.
- [ ] **BH-5.4 Home assembly.** `/api/home` latency breakdown per shelf;
      `mergeResume`/`boundCards` correctness with mixed file and catalogue
      progress.

## Unit 6 — Server: media-server integration (Jellyfin/Emby)

Files: `media-server-*.ts` (~10k lines, `manager` 3.6k and `security` 2k the
largest), `routes/media-servers.ts`.

- [ ] **BH-6.1 Secrets.** Tokens never in logs, responses, error messages or
      exported settings; rotation and removal leave nothing behind.
- [ ] **BH-6.2 Swallowed errors.** The ~40 silent catches in
      `media-server-security.ts` and `media-server-manager.ts` from BH-0.4.
- [ ] **BH-6.3 Index and sync.** Incremental vs full sync, server
      unreachable mid-sync, deleted items, quota and retention edge cases.
- [ ] **BH-6.4 Playback and progress bridging.** `media-server-playing.ts`,
      `-personal.ts`: progress reported back once, not per tick; behaviour
      when the remote server rejects it.

## Unit 7 — Server: auth, roles and the HTTP boundary

Files: `auth.ts`, `roles.ts`, `secure.ts`, `security.ts`, `host-check.ts`,
`restricted.ts`, `revocation.ts`, `users.ts`, `library-grants.ts`,
`airplay-access.ts`, `logger.ts`, `access-log.ts`, `routes/*.ts`.

- [ ] **BH-7.1 Route inventory.** Generate the list of all 189 route
      registrations with their role requirement and ownership check; flag
      read routes that serve private data without an owner check, and
      routes where a foreign ID is distinguishable from a missing one.
- [ ] **BH-7.2 SSRF and DNS rebinding.** Address changes between validation
      and connection, redirects, allowed-private-host config (roadmap P1).
- [ ] **BH-7.3 Revocation during work.** Account deletion or grant removal
      while a download, scan, transfer or playback runs.
- [ ] **BH-7.4 Input validation.** Path traversal on every route that takes
      a path, request body size limits, malformed JSON handling.
- [ ] **BH-7.5 Log redaction.** Addon URLs with embedded keys, debrid tokens,
      media-server tokens in `app.log` and client logs.

## Unit 8 — Server: `index.ts` composition

- [ ] **BH-8.1 Map responsibilities** still living in `index.ts` (2.8k
      lines): library mutation, artwork coordination, source resolution,
      lifecycle. Pick extractions only where a defect from units 1–7 needs a
      testable seam (roadmap P2), not for size alone.
- [ ] **BH-8.2 Unhandled rejections.** Process-level handlers, async route
      handlers whose rejection escapes Express error handling.

## Unit 9 — Web: application shell

Files: `web/src/App.tsx` (3.9k lines, 63 `useEffect`, 118 `useState`),
`api.ts`, `useHome.ts`, `home-state.ts`, `start-view.ts`, `views.ts`.

- [ ] **BH-9.1 Effect hygiene.** Every effect in `App.tsx`: cleanup present,
      dependencies correct, no fetch whose late response overwrites newer
      state (AbortController or request token). React StrictMode double-run
      safe.
- [ ] **BH-9.2 Polling.** Which effects poll, how often, and whether they
      stop when the tab is hidden or the view is not shown.
- [ ] **BH-9.3 Re-render cost.** Profiler on typing in search, scrolling
      Home and the library; memoise only what the profiler shows.
- [ ] **BH-9.4 API error surface.** `api.ts` silent catches: does the user
      ever see "nothing" where an error happened? Every server `AppError`
      key reaches a translated message.
- [ ] **BH-9.5 Extractions with a reason.** Settings/diagnostics and
      catalogue/search orchestration out of `App.tsx` (roadmap P2), only
      after 9.1–9.4 so the moves carry their tests.

## Unit 10 — Web: player

Files: `Player.tsx`, `player-hls.ts`, `TrailerPlayer.tsx`,
`playback-identity.ts`, `SourceChooser.tsx`, `streams.ts`.

- [ ] **BH-10.1 Teardown.** hls.js and `<video>` listeners released on close,
      source switch and navigation; no growing listener count after ten
      open/close cycles (heap snapshot).
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
- [ ] **BH-11.2 Dialogs and focus.** Conformance with
      [ui-conventions.md](ui-conventions.md); focus trap, Escape, TV/remote
      navigation.
- [ ] **BH-11.3 i18n completeness.** `cs.ts` is type-checked against `en.ts`;
      the other eight catalogues are not. Report missing and stale keys
      per language; decide whether to type them the same way.
- [ ] **BH-11.4 Bundle.** No `React.lazy` split exists today and the build
      warns about chunk size. Split rarely used views (settings, admin,
      stats, media-server manager, player) and measure first-load bytes.
- [ ] **BH-11.5 CSS.** Dead selectors, duplicated rules; split by
      responsibility only with the visual matrix run once at the end
      (roadmap P2).

## Unit 12 — Desktop (Electron)

Files: `desktop/src/main.ts` (1.8k), `local-backend.ts`, `download-dir.ts`,
`window-state.ts`, `login-item.ts`, `connection-file.ts`, `shell-api.ts`,
`local-media-key.ts`.

- [ ] **BH-12.1 Local backend lifecycle.** Start failure, port in use, crash
      and restart, quit during a download or conversion, switch between
      local and remote server.
- [ ] **BH-12.2 IPC surface.** Every `ipcMain` handler validates its input
      and the sender; nothing exposes arbitrary file paths.
- [ ] **BH-12.3 Settings files.** `connection.json`, `local-settings.json`,
      `window-state.json`: corrupt-file handling, off-screen window recovery.

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
- [ ] **BH-13.5 Server contract.** DTOs in `data/*Dtos.kt` vs the server's
      responses: missing or renamed fields, nullable assumptions.

## Unit 14 — Cross-cutting

- [ ] **BH-14.1 Contract drift.** Compare `web/src/types.ts` and the Android
      DTOs with what the server serialises (`api-types.ts`, `publicJob` and
      friends). Start with download pause reasons (roadmap P2).
- [ ] **BH-14.2 Test suite health.** Flaky and slow tests from BH-0.1: fix
      the cause, never skip. Server and web suite wall time.
- [ ] **BH-14.3 Docker image and CI.** Image size, layer caching, CI
      duration per workflow; Synology/ARM64 build.
- [ ] **BH-14.4 Re-run the baseline** (BH-0.2, BH-0.3) and record the
      before/after table below.

## Results

| Metric | Baseline (BH-0) | After (BH-14.4) |
| --- | --- | --- |
| Server tests (passed / skipped / s) | | |
| Web tests (passed / s) | | |
| Cold start / RSS | | |
| Full scan / rescan (5k files) | | |
| `/api/home` p95 | | |
| Web first-load JS (gzip) | | |
| Android cold start | | |

## Found along the way

Real issues outside the part that found them. Each becomes its own part or
issue; do not fix them inside an unrelated PR.

- *(empty)*
