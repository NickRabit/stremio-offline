# System audit progress

Baseline: `origin/main` at `a0bb6ce7`, version 0.7.108, checked 2026-11-15.
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
- [ ] Complete the queue fault-injection matrix, including profile cleanup and range fallback.
- [x] Ship the legacy source-failover cleanup fix: #834 (merged).
- [x] Design and ship a separate subtitle-journal fix: #835.
- [ ] Decide whether the unjournaled rename route needs the same sidecar recovery (SA-3).
- [ ] Decide whether a manual retry should keep the sources already tried (SA-4).
- [ ] Complete every-route role/ownership/foreign-ID matrix through real middleware.
- [ ] Complete account/grant/library revocation and final filesystem boundary campaign.
- [ ] Complete playback interruption/resource measurements on supported hardware.
- [ ] Characterize catalogue/search orchestration before extraction.
- [ ] Perform bounded App.tsx extraction; CSS, desktop and TV remain separate work.

## Findings and evidence

| ID / priority | Status | Evidence and outcome |
| --- | --- | --- |
| SA-1 / P2 | Confirmed, reproduced | `downloads.ts:download`, legacy lazy source-failover branch. A 404 after a partial was written into a directory changed to mode 0555 causes unlink to fail. The catch discards target/source state anyway. Restoring permission before source B resolves produces `Film (2).mp4` and leaves `Film.mp4.part`. B's bytes are correct; no foreign-file overwrite was demonstrated. Fix in #834: strict cleanup before the source is abandoned, otherwise the job fails with its target and source retained. |
| SA-2 / P2 | Confirmed, reproduced | `library-actions.ts:TransferStep`, `transferLibraryItem`, `resumeTransfer`. Seed the exact post-video/pre-subtitle crash state: video at New/movie.mkv, subtitle at Old/movie.en.srt, a moving journal record. Replay returns the destination twice, but the subtitle stays at Old and is absent at New. No subtitle deletion was observed; destination playback loses its sidecar. Fix in #835: the journal record names the sidecars and a replay carries them. |
| SA-3 / P3 | Inspected, not reproduced | `routes/content.ts`, the library rename route. The video is renamed, then each subtitle sidecar, with no journal. A stop between the two leaves the subtitles under the old stem, and nothing replays the rename. Same-filesystem renames keep the window short; no crash was injected. `rerootItem` has a similar window for a loose video, because `RerootStep` records only the two ends. |
| SA-4 / P3 | Inspected, not reproduced | `DownloadQueue.retry` clears `source.tried` before a lazy job resumes. After #834 a job that failed on cleanup keeps its selected stream, but a later failover may pick a source that had already been abandoned. Raised by the review of #834; no data loss is implied. |
| Historical H1/H2/H3 | Already fixed in source; not all rerun here | Admissions use the admission/persist machinery; `remove` writes before deleting its partial; unreadable queue/journal tests exist. Do not repeat the October JSON-store findings as current defects. Current queues also support SQLite. A new power-loss/fsync claim was not tested. |
| Follow reserve/enqueue/adopt replay | Existing implementation verified within harness limits | `follows.test.ts`: reserved-before-queue, queued-before-link, adoption, completion, history removal and repeated restart scenarios. 21 selected tests passed. The queue collaborator is fake in several replay cases: this is not a spawned-process, two-real-store crash campaign. |
| Missing library root | Existing protection inspected, full campaign not verified | `library.test.ts` contains an incomplete-walk test for a missing root; no evidence here establishes behavior for every unmount/scan/artwork interleaving. Never equate missing with empty. |
| Network rebinding and redirects | Existing regressions passed | `security.test.ts` exercises connection-time DNS changes, redirect revalidation, allowlists, response cancellation and cross-origin credential stripping against local fixtures. This disproves the blanket historical claim that DNS is checked only before connecting. It does not certify all outbound consumers. |
| Role allowlists | Existing gate verified; application-wide ownership review not verified | `roles.ts` defaults unlisted user routes to administrator-only; `index.ts` mounts authentication then role/password/restricted gates. Role tests passed. Handler tests and a role allowlist separately do not prove the full middleware/resource composition. |
| Playback interruption | Selected existing fixes verified | 11 selected playback tests passed, covering serialization, failed operations, AC-3 descriptor/seek behavior, short conversion, fallback retirement and closing during seek. No physical NAS/TV/iPhone or measured concurrency/storage claim. |
| Bounded storage | Not verified / not implemented as a full byte bound | Current playback has configurable storage, lead suspension and lifecycle tests. The older proposed buffer brief is not a statement of today's entire implementation. Lead control is not a byte-bounded eviction/regeneration contract. |
| React error boundary | Absence confirmed by source inspection, failure not reproduced | No ErrorBoundary in App.tsx/main.tsx. Do not add more lazy chunks before characterization and a deliberate recovery boundary. |

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

Audit-only work does not change runtime and has no version bump. Build, complete
unit/e2e and Docker deployment belong to each implementation PR. No production
media, household endpoint, or live-library fault injection was used.
