# System audit progress

Baseline: `origin/main` at `a0bb6ce7`, version 0.7.108, checked 2026-11-15.
The next agent continues from [system-audit-handover.md](system-audit-handover.md).
This is the first bounded delivery from `system-audit-refactor-agent-task.md`,
not a completed whole-application audit. The primary agent performed the
analysis and reproductions. Initial delegated audits were stopped at the
owner's request; their output is not evidence in this report. Each fix is
implemented by DeepSeek from a written specification, reviewed by Grok and by
the primary agent, and shipped in its own pull request.

## Delivery checklist

- [x] Fetch main and recheck the baseline and production file sizes.
- [x] Inspect queue admission, removal, completion, source failover and restart paths.
- [x] Record the queue transition/replay table below.
- [x] Reproduce the old failed-part-cleanup finding with real filesystem permissions.
- [x] Reproduce subtitle loss from the destination after move replay, including replay twice.
- [x] Inspect and run existing follow reconciliation tests.
- [x] Run selected authorization, network, transfer, journal, shutdown and playback regressions.
- [x] Read every partial-file removal in the queue and classify it (table below); fix the profile failover twin of SA-1: #837.
- [x] Inject the remaining queue faults (range fallback, HTTP 416, remote restore) instead of reasoning about them: two new direct-download tests; the remote cases were already covered.
- [x] Ship the legacy source-failover cleanup fix: #834 (merged).
- [x] Design and ship a separate subtitle-journal fix: #835.
- [x] Decide whether the unjournaled rename route needs the same sidecar recovery (SA-3): no journal; the subtitles move before the bindings and the route holds both names until the bindings have moved.
- [x] Decide whether a manual retry should keep the sources already tried (SA-4): owner's decision 2026-11-18, it starts over.
- [x] First independent pass over the routes an ordinary user or a child can reach; fix the nested-library gap it found: #838.
- [x] Finish the route matrix: covered by the second independent pass below (SA-8 to SA-10).
- [x] Owner's decision on SA-7: kept open (2026-11-17).
- [x] Second independent pass over the routes the first one did not reach (remote libraries, playback and media ownership past the mint, device tickets, follows, watchlist, profiles and PIN, avatars, pairing, settings, images).
- [x] SA-8 to SA-10: the owner approved in-memory re-checks after the awaits; fixed in #842.
- [x] Account/grant/library revocation while a transfer or playback runs: not pursued. The owner relaxed these re-checks on purpose because they multiplied request counts; a revoked account finishing an in-flight transfer or playback is the accepted trade-off, not a defect.
- [ ] Complete playback interruption/resource measurements on supported hardware.
- [x] Characterize catalogue/search orchestration before extraction: #840.
- [x] Split `downloads.test.ts` by subject (SA-11, SA-13): #846.
- [x] A crash boundary for the main views: #847.
- [x] First bounded App.tsx extraction: catalogue and search loading moved to `use-catalog-loader.ts` (#844). Further slices, CSS, desktop and TV remain separate work.

## Findings and evidence

| ID / priority | Status | Evidence and outcome |
| --- | --- | --- |
| SA-1 / P2 | Confirmed, reproduced | `downloads.ts:download`, legacy lazy source-failover branch. A 404 after a partial was written into a directory changed to mode 0555 causes unlink to fail. The catch discards target/source state anyway. Restoring permission before source B resolves produces `Film (2).mp4` and leaves `Film.mp4.part`. B's bytes are correct; no foreign-file overwrite was demonstrated. Fix in #834: strict cleanup before the source is abandoned, otherwise the job fails with its target and source retained. |
| SA-2 / P2 | Confirmed, reproduced | `library-actions.ts:TransferStep`, `transferLibraryItem`, `resumeTransfer`. Seed the exact post-video/pre-subtitle crash state: video at New/movie.mkv, subtitle at Old/movie.en.srt, a moving journal record. Replay returns the destination twice, but the subtitle stays at Old and is absent at New. No subtitle deletion was observed; destination playback loses its sidecar. Fix in #835: the journal record names the sidecars and a replay carries them. |
| SA-3 / P3 | Reproduced, fixed | `routes/content.ts`, the library rename route. A failed binding write (`relocateLibraryPath`) after the video's rename answered an error and left the subtitle sidecars under the old stem and the listing stale; a regression with a rejecting binding write reproduced it. Fixed: the sidecars move right after the video and the listing is invalidated either way. A review then found that two overlapping renames (A to B, then B to C before the first wrote its bindings) could leave the bindings under B; the route now holds both names until the bindings have moved (`path-reservations.ts`, also read by `libraryPathBusy`), pinned by a held-write regression. A fresh-context review then found the reservation was taken after the queue check and was invisible to the queue, so a move queued inside that window still ran against the moving name; the rename now reserves first and asks the queue again, and the queue's pause check waits for a reservation on its item. Remaining risk, no journal: a crash after the video's rename leaves the not-yet-moved subtitles under the old stem with nothing to finish it after a restart; its length depends on the subtitle count and disk latency. `rerootItem` has no such window: each top-level name, a loose subtitle included, is its own journaled item, and the persisted job continues after a restart. |
| SA-4 / P3 | Decided, kept | `DownloadQueue.retry` clears `source.tried` before a lazy job resumes. Owner's decision (2026-11-18): a manual retry starts over. It follows a change (connection back, account fixed, new rules), failures are often temporary, and keeping them would refuse every source after an outage; within one attempt a failed source is still not tried twice. Commented at the line and pinned by a test in `downloads-failover.test.ts`. |
| SA-5 / P2 | Confirmed, reproduced | `DownloadQueue.download`, the `sourceAdmission` failover branch, and `discardProfileSelection`. The twin of SA-1 for a download chosen by a source profile: with the folder made unwritable after a partial was written, the selection was discarded, the next source finished as `Film (2).mp4` and `Film.mp4.part` stayed. Fix in #837: strict removal before the source is abandoned; the job fails with its selection kept, a retry is refused until the partial can go, and a restart keeps the name. The other callers stay best-effort and now log the leftover. |
| SA-6 / P1 | Confirmed, reproduced twice | Authorization. An account granted a parent library but not a library nested inside it could browse the nested folders (`GET /api/library/browse`, `/folders`), mint a playable source (`POST /api/library/source`) and queue a download into it, by naming the parent's id with the nested folder in the path. Reproduced by the independent reviewer through the real role middleware and handlers, and again by running the new regressions against the unmodified route modules. Fix in #838: such a key is refused when the account may not see the nested library; whoever may see it keeps the previous behaviour. Identity and gallery answered a hidden nested key differently from an absent folder, which confirmed a guessed name without returning content; since the follow-up both answer an absent path with the same error as a hidden key and a missing library. Residual: a symlink planted inside the parent that points into the nested root is not detected; planting it needs write access to the library folder itself. |
| SA-7 / P3 | Decided: kept open | `GET /api/local-streams/:type/:id` for a child account with catalogue browsing off: an id that is not an IMDb id makes the server ask a granted addon's metadata endpoint for the IMDb id (`subtitleTarget`), while `/api/streams` and `/api/meta` answer 403. Nothing about the title is returned. Closing it would also hide the child's own local copies of a title bound under an addon-specific id, The owner decided on 2026-11-17 to keep it open. |
| SA-8 / P3 | Confirmed; fixed in #842 | `GET /api/streams/:type/:id`: the addon grants are re-checked after the addon wait, but when a rules profile exists the handler then awaits the title metadata before `mediaResources.listing` mints the playable sources. The code comment says nothing is awaited between the check and the listing. A grant withdrawn, or a child's catalogue switched off, during that wait still receives sources. The fix is an in-memory re-check, no extra request. |
| SA-9 / P3 | Confirmed; fixed in #842 | `GET /api/subtitle/:subtitleId`, the library sidecar (`file://`) branch: after `libraryTarget` and `readFile` the cues are sent without the second `requireAccess` / `mediaResources.get` / destroyed-socket check that the addon branch of the same handler makes, and that its tests pin. |
| SA-10 / P4 | Confirmed; fixed in #842 | `GET /api/stream-sources/:type/:id` answers addon keys and names after `streamCandidates` without re-checking the grants. Names only, no playable resource. The same class of gap remains unchecked in `GET /api/catalog`, `/api/meta` and `/api/search`. |
| SA-11 / P4 | Fixed in #846 | `server/src/downloads.test.ts` ran for about a minute on its own; under the full local gate with another job loading the machine it crossed the 120-second per-file limit twice (2026-11-16 and 2026-11-17). #846 split its 146 tests unchanged into thirteen `downloads-*.test.ts` files (slowest about 15 s alone) with shared helpers in `downloads-test-support.ts`; the stress command that failed 1 of 12 on the old file passes 12 of 12 on the three slowest new ones. The 120-second limit is unchanged. |
| SA-12 / P3 | Reproduced, fixed in #843 | CI flake in `playback.test.ts`, "real FFmpeg stops writing while suspended…": the test reported segment 1 as fetched as soon as the remux was handed over, which happens once segment 0 is listed; on a slow runner the ledger could not count it yet. Reproduced in `node:26-trixie-slim` with Debian's FFmpeg at 0.2 CPU (1 of 6 runs failed); the test now waits for the playlist, woken by writes to the folder (10 of 10 passed under the same limit). A test race, not a playback defect. |
| SA-13 / P3 | Observed once on CI, not reproduced | The `windows` job hung for 19 minutes in `server/src/downloads.test.ts` (2026-11-17, on #841) and was cancelled by the job limit, reporting `Promise resolution is still pending but the event loop has already resolved` and no per-test output. One occurrence in the last 40 CI runs; the rerun passed. Since #846 the tests live in thirteen smaller files, so a recurrence names its file; the cause itself is still unknown. |
| SA-14 / P3 | Reproduced, fixed | Media-server personal state (`media-server-personal.ts:patch`). Removing a remote resume card (`{position:0,duration:0,final:true}`) or unstarring a remote item read the item from the media server first; for an item deleted upstream that answered `not-found`, so the card stayed on Home for good and could not be removed. Two regressions against the unmodified module fail with `not-found`. Fixed: a clear-only patch whose item read answers `not-found` clears the caller's own stored record after the same library, connection and write checks, with no extra provider request. The row must have been stored through the same remote library: the item key names the item on the connection, and the independent review showed a clear through another library of the same server would otherwise reach it. Accepted: a provider answers `not-found` also for an item the account may no longer read, so an explicit removal then clears that row too; the card could not be opened anyway. |
| BH-6.3 index and sync | Inspected, existing tests verified | `media-server-index.ts` keeps one in-memory snapshot per library and replaces it whole; there is no incremental sync. A scan that fails or is interrupted never publishes and never serves the previous snapshot (it stays reachable only by its exact cursor), opens a backoff, and an invalidation aborts a staged scan even when the provider ignores the signal. Items deleted upstream drop out with the next full scan (60-second TTL). `media-server-index.test.ts` covers each of these. Stored personal records of deleted items were the one gap: SA-14. |
| BH-6.4 playback and progress bridge | Inspected, existing tests verified | `media-server-playing.ts`: the web player reports start, every 10 s, on pause and seek, and stop, the cadence of the provider's own clients. Reports of one session are serialised; a late progress after a stop is dropped inside a 60-second tombstone; a refusal is remembered so progress stops until the next start; a rate limit quiets the session for its retry-after; an idle session is stopped after 60 s and every live one on shutdown (3-second cap). A stop that arrives before its start leaves a remote session open until the idle sweep, about a minute. Not run against a live server in this pass. |
| Historical H1/H2/H3 | Already fixed in source; not all rerun here | Admissions use the admission/persist machinery; `remove` writes before deleting its partial; unreadable queue/journal tests exist. Do not repeat the October JSON-store findings as current defects. Current queues also support SQLite. A new power-loss/fsync claim was not tested. |
| Follow reserve/enqueue/adopt replay | Existing implementation verified within harness limits | `follows.test.ts`: reserved-before-queue, queued-before-link, adoption, completion, history removal and repeated restart scenarios. 21 selected tests passed. The queue collaborator is fake in several replay cases: this is not a spawned-process, two-real-store crash campaign. |
| Missing library root | Existing protection inspected, full campaign not verified | `library.test.ts` contains an incomplete-walk test for a missing root; no evidence here establishes behavior for every unmount/scan/artwork interleaving. Never equate missing with empty. |
| Network rebinding and redirects | Existing regressions passed | `security.test.ts` exercises connection-time DNS changes, redirect revalidation, allowlists, response cancellation and cross-origin credential stripping against local fixtures. This disproves the blanket historical claim that DNS is checked only before connecting. It does not certify all outbound consumers. |
| Role allowlists | Existing gate verified; application-wide ownership review not verified | `roles.ts` defaults unlisted user routes to administrator-only; `index.ts` mounts authentication then role/password/restricted gates. Role tests passed. Handler tests and a role allowlist separately do not prove the full middleware/resource composition. |
| Playback interruption | Selected existing fixes verified | 11 selected playback tests passed, covering serialization, failed operations, AC-3 descriptor/seek behavior, short conversion, fallback retirement and closing during seek. No physical NAS/TV/iPhone or measured concurrency/storage claim. |
| Bounded storage | Not verified / not implemented as a full byte bound | Current playback has configurable storage, lead suspension and lifecycle tests. The older proposed buffer brief is not a statement of today's entire implementation. Lead control is not a byte-bounded eviction/regeneration contract. |
| React error boundary | Added in #847 | `ViewBoundary` (`view-boundary.tsx`) wraps the main views (Home, catalogue, search, library and the other sidebar views), the catalogue title detail, the person page and both players. A render error replaces only that view with a message, Try again and Reload; the sidebar stays, and a player's fallback covers the screen with Close. It resets when the view, title, person or playing stream changes. The inline catalogue is built inside the boundary through a function child. Still outside any boundary: values `App` computes before its `return`, which the `App.tsx` slicing will move. `LazyScreenBoundary` keeps its own job, a failed chunk import of three lazy screens. |

## Queue transitions and replay

These are source-derived transitions, not a claim that every edge was fault-injected.
`save()` is best-effort; `persist()` is the acknowledged mutation boundary.

| Trigger | From → to | Ordering / replay contract | Evidence |
| --- | --- | --- | --- |
| Direct admission | absent → queued | Target assigned and admission persisted before acknowledgement; admission exclusion prevents competing starts | `DownloadQueue.add`, admission helpers |
| Torrent admission | absent → waiting | Persisted job then debrid polling | `addDebrid`, `scheduleDebrid` |
| Lazy admission | absent → queued | Persist intent/snapshot before source work | `admitPendingInternal` |
| Scheduler starts | queued → checking or downloading | Register active controller; save state; resolve/recheck owner/library | `pump`, `download` |
| Torrent ready | waiting → queued | Resolve torrent result then schedule transfer | `pollDebrid` |
| Permission/library/storage/schedule/user stop | active/queued/waiting → paused | Abort active work; retain resume data according to policy; watchers may unpause | pause helpers, `applyWindow`, `resume` |
| Transient HTTP failure | downloading → queued | Retain bytes; increment retry count; apply notBefore/timer | `download` catch |
| Legacy source exhausted | downloading → queued | Delete old partials then clear source/target; currently ignores delete failures (SA-1) | `download` catch |
| Profile source exhausted | downloading/checking → queued or failed | Discard selection with fallback budget; cleanup behavior remains a separate audit item | `discardProfileSelection`, `failProfileSourceFallback` |
| Publication | downloading → completed | Reserve destination, publish subtitle/video, recheck gates, callback; final best-effort save | `commit`, `publicationGate`, `download` finally |
| Manual retry/resume | failed/paused → queued or waiting | Recheck permission/library; retry resets retry/source-selection state | `retry`, `resume` |
| Remove | any → absent | Follow guard before durable row removal; abort/unlink after write. Not a cancelled status | `remove` |
| Clear completed history | completed → absent | Follow completion guard precedes durable history removal; media is kept | `clearCompleted` |
| Restart | checking/downloading → queued | Reset speed and notBefore, reprove remote/profile state, resume waiting pollers and pause watchers | `load` |

## Partial-file removals in the queue

Every place `downloads.ts` removes a `.part`, and what a failed removal leads to.
Only the first three rows were fault-injected; the rest are read from the code.

| Site | Keeps the target? | A failed removal leads to | Status |
| --- | --- | --- | --- |
| Legacy lazy failover | No | Orphan partial and a `(2)` name | Fixed, #834 |
| Profile failover (`sourceAdmission`) | No | The same | Fixed, #837 |
| `discardProfileSelection` from pause, resume, load, storage halt; `remove` | No | Orphan partial; a later pick takes a `(2)` name | Best-effort by design, now logged (#837) |
| Fresh rule pick before the transfer | Yes | Could resume onto stale bytes, but target assignment never hands out a name whose partial exists | Not reachable as read; not injected |
| Source ignored byte ranges | Yes | A resume answered 200 with the whole file is rewritten from byte 0 with a truncating write | Injected: "a source that ignores the resume range is rewritten from byte 0, not appended to" (direct), "a source that ignores a resume range restarts safely from zero" (remote) |
| HTTP 416 | Yes | The part file is removed and the next attempt starts from byte 0 without a Range header; one retry is spent | Injected: "a 416 on a resumed transfer discards the part file and finishes from byte 0". Without the removal the job fails after three 416s |
| Segment plan no longer matches the file | Yes | The next write truncates | Safe as read |
| Remote job restored with a segment plan | Yes | `load` drops the plan before the job runs | Injected: "a legacy sealed address and a restored segment plan are refused, never run" (`download-remote.test.ts`) |
| Playlist assembly | Yes | FFmpeg overwrites | Safe as read |

## Follow and filesystem replay

| Boundary | Observed contract / remaining work |
| --- | --- |
| Reserve before queue | Stable intent permits one admission after restart; existing test passed. |
| Queue before follow link | Sync finds existing intent and links it; existing test passed. |
| Adopt before follow link | Manual queue job remains the one job; existing test passed. |
| Complete before follow sync | Completion is reconciled from the queue; test exists. Full queue-file publication crash not injected here. |
| History removed without completion record | Missing job becomes attention, not an automatic duplicate; selected test passed. |
| Removal guard succeeds, queue removal fails | Skip survives; no new follow job; existing test passed. |
| Video moved before subtitle | Replay completes video metadata but has no recorded sidecar list: SA-2. |
| Neither transfer endpoint exists | Replay refuses instead of guessing; existing library-actions test passed. |
| Target is only a reservation | Replay removes the known placeholder and restarts; existing test passed. |
| Real cross-mount power loss / unavailable NAS | Not verified. Synthetic tests do not prove physical filesystem durability. |

## First structural boundary

Rechecked physical line counts: App.tsx 4,748; downloads.ts 4,309;
media-server-manager.ts 3,725; index.ts 3,185; style.css 2,562;
desktop/main.ts 1,852; Player.tsx 1,815. No extraction is justified by count alone.

`App.tsx:loadPage` owns both ordinary catalogue paging and search. It shares
`requestRef`, loading/items refs, skip/cursor, busy/more flags, selected details,
search abort controller, server search session/revision/generation, suggestion
pool and history recording. It uses `runCatalogSearch` with a legacy API fallback.
Leaving catalogue aborts search and deletes its server session; ordinary
catalogue requests use request-generation checks. `loadSearchState` separately
updates account history. These are characterization targets, not established
stale-response defects. Account identity/remount behavior must be checked before
claiming account-switch safety. Keep the shared loader's ordering intact while
extracting a narrow feature owner; reuse existing search utilities.

## Verification record

Executed against the baseline source, with disposable fixtures:

- Follow selection (`crash|restart|adopt|revok|clear|remov|reserv`): 21 passed.
- Roles, security, library transfer, library operations, library actions and
  server shutdown suites: 102 passed.
- Playback selection (serialization, fallback, cleanup, short conversion,
  AC-3): 11 passed.
- Real chmod/HTTP failover probe: reproduced SA-1, completed file contained
  source B bytes and orphan remained.
- Synthetic post-crash sidecar replay probe: passed assertions describing SA-2,
  including a second replay. This is a failure-state probe, not a fixed regression.

Second delivery, 2026-11-16, against `main` at `2d988397` (0.7.109):

- #834 (SA-1): new regressions failed on the baseline and pass with the fix;
  `downloads.test.ts` 141 passed after merging current `main`.
- #835 (SA-2): replay regression failed on unmodified `main` and passes with
  the fix; library actions, move, transfer and content-route suites 102 passed;
  full unit gates and a side-port Docker health check passed. The independent
  review found one low-severity recovery hole (a backslash in a file name
  discarded the whole journal record), fixed in the same pull request.

Third delivery, 2026-11-16, against `main` at `c9cb4a90` (0.7.111):

- #837 (SA-5): the regression with real directory permissions fails on
  unmodified `main` and passes with the fix; `downloads.test.ts` 145 passed.
  The independent review found that a retry or a restart still discarded the
  selection; fixed in the same pull request.
- #838 (SA-6): three route regressions fail against the unmodified route
  modules and pass with the fix; the real-server visibility suite and the full
  unit gates pass. The independent review of the fix found a write through a
  title's own folder and a refusal that differed from an absent folder; both
  fixed in the same pull request.
- The reviewer's inventory found these sound: the role gate for unlisted
  routes, the library grant on browse, carve-outs in the index and shuffle,
  search everywhere and Home for a child without catalogue, ownership of
  download jobs, and the library list hiding filesystem roots.

Fourth delivery, 2026-11-17, against `main` at `22ef96c9` (0.7.113):

- #840: characterization tests for the catalogue and search loading in
  `App.tsx` (9 tests through the rendered app). A mutation check removed the
  stale-page guard and the abort on leaving the view; each made its test fail.
- The second independent route pass found no access to another account's
  rows, sessions, tickets or files. Areas it found sound: remote-library member
  routes, artwork, state and playback reports; source, playback, media and
  device-ticket ownership by session; follows, watchlist, profiles, PIN,
  avatars, pairing, the settings key split and the image route. Its three
  findings are SA-8 to SA-10.
- #842 (SA-8 to SA-10): in-memory re-checks after the last await in the
  streams, file-subtitle, stream-sources, catalogue, search, metadata and
  extras routes, with no added request. Each of the nine new tests fails
  against the unmodified handler. The independent review found that an addon
  switched off during a search dropped out of the list being checked; fixed
  by reading the list before the wait.
- #843 (SA-12): the intermittent real-FFmpeg test failure that hit this
  documentation pull request's own CI run.

Fifth delivery, 2026-11-17, `main` at `037e1304` (0.7.114):

- #844: catalogue and search loading moved from `App.tsx` into
  `use-catalog-loader.ts`. Reviewed by the primary agent: the nine
  characterization tests from #840 pass unchanged, and breaking the
  stale-page guard or the abort on leaving the view inside the new hook fails
  the matching test. Web suite 1,856 passed.
- SA-11 reproduced locally under load (1 of 12 stress runs); SA-13 recorded.
- The remaining work is ordered in [system-audit-handover.md](system-audit-handover.md).

Sixth delivery, 2026-11-17, `main` at `1c714739` (0.7.114):

- #846 (SA-11): the split of `downloads.test.ts`, implemented by DeepSeek. Two
  independent scripts compared every moved `test(...)` block with the original:
  146 of 146 identical. Pass and skip counts unchanged; an outside review found
  nothing.
- #847: `ViewBoundary`, implemented by Grok, version 0.7.115. Each App test
  fails with its wrapper removed. An outside review found two defects, both
  fixed in the same pull request: the inline catalogue was still built outside
  the boundary, and on the person page the fallback was hidden by
  `main.person-open > :not(.person-view)`.

Audit-only work does not change runtime and has no version bump. Build, complete
unit/e2e and Docker deployment belong to each implementation PR. No production
media, household endpoint, or live-library fault injection was used.
