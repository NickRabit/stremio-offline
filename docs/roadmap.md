# Roadmap

A living backlog, not a sprint commitment. Update this file when something ships
or when a new pain shows up in daily use.

The target platform remains a Synology NAS with an Intel Celeron (QuickSync on a
DS220+ or DS920+). Direct play and remux are the common path; a real transcode
needs VAAPI. See [Hardware acceleration](hardware-acceleration.md) for the setup.

## Direction and delivery order

The order was set against PR #260 (`11f1759`) on 2026-09-29. **Done** and
**Next** were last reconciled with `main` (`2686fc2`, 0.5.6) on 2026-10-04. This
is a proposed delivery sequence, not a statement that the work below has
shipped.

Make the NAS a dependable family media library: a useful home screen, a
restricted child account and predictable playback. Deliver household UX alongside
focused data-safety work, then reduce daily effort with show following and
guided library management. Extend into Sonarr/Radarr through the
existing queue only after its durability and staging boundaries are proven.
Keep desktop clients on the same server contracts; avoid a second downloader,
metadata store or scheduler for each platform.

| Order | Outcome | Scope / release gate |
| --- | --- | --- |
| P0a | Files and acknowledged work survive failure | Fix queue admission/write failures and journal loss; journal cross-store operations so a restart can replay them |
| P0b | Playback and mobile controls are dependable | Session lifecycle tests and physical iOS verification |
| P1a | Home is useful immediately | Permission-filtered personal rows from existing state; no scheduler dependency |
| P1b | Children can use the app safely | Restricted child account, server-enforced policy, parent-authenticated exit |
| P2a | New episodes are easy to discover | Follow show with opt-in downloads, durable deduplication and bounded polling |
| P2b | Library management is guided | Guided split, then live search; bulk rename only after P0 recovery works |
| P3 | External automation is usable | Opt-in HTTP Sonarr/Radarr bridge passing the real-application harness |

Home-screen work, small mobile fixes and backup inventory documentation can
ship alongside P0. Child mode requires its own server policy before release;
it does not depend on completing the entire engineering backlog.
The ordering is a dependency guide, not a reason to bundle unrelated changes.
Signing, unattended installers, remote-instance protocols, richer profiles and
additional debrid providers remain separate investments. Do not add them to a
release merely because a related screen is being edited.

The [delivery specification](roadmap-delivery-spec.md) defines contracts,
non-goals, acceptance scenarios and suggested PR boundaries. It also records
where the previous roadmap overstated missing functionality. Existing feature
documents describe shipped behavior; the delivery specification describes
proposed changes.

## Done

Shipped in `main`; implementation details live in the linked guides.

- **Libraries**: multiple roots, types, move/copy operations, optional content
  moves when changing a root, staged settings, mosaics and galleries.
  [Libraries](libraries.md).
- **Identification**: automatic scans, suggestions and manual matching, with
  TMDB/Cinemeta metadata and artwork. A series library is one show per
  top-level folder, with season and episode folders read the way people name
  them. [Library identification](library-metadata.md).
- **Library upkeep**: image caches and the orphaned-artwork sweep run on a
  schedule rather than on browsing; the sweep decides from a complete walk and
  deletes nothing under an unreadable folder. On Linux the folder watch skips
  the NAS's own system folders. [Libraries](libraries.md).
- **Accounts**: administrator and user roles, per-user libraries, addons,
  download permissions, preferences and session revocation. [Accounts](users.md).
- **Playback**: direct play, remux, hardware transcode (VAAPI, NVENC,
  VideoToolbox), timeline previews, subtitle timing, next-episode countdown,
  device volume memory and a Fill screen toggle. A seek that is slow or refused
  keeps the stream alive, an HLS source named `.mp4` is converted from its
  tallest rendition, and a conversion that falls behind playback says whether
  the source or FFmpeg is waiting. AirPlay is disabled.
  [Playback](playback.md), [Troubleshooting](troubleshooting.md).
- **Following**: follow a series or a film for its releases, on a Following
  page with an overview, a release calendar and download activity, with
  opt-in automatic downloads that queue each episode once, retry a missing
  source on a ladder and treat a removed job as a skip. Episode dates are
  corrected from TMDB, a private calendar feed, a wait for the preferred audio,
  episodes kept ahead of viewing and opt-in deletion after watching. Lazy jobs
  fall back to a torrent through Real-Debrid.
  [Downloads](downloads.md#following-series-and-films),
  [design](follow-show-analysis.md).
- **Continue watching**: series grouping, the next available catalogue episode
  and per-library/addon visibility. [Libraries](libraries.md#the-library-row).
- **Downloads**: restart recovery, Range resume, retries, disk-full pausing,
  segmented transfers, device saves shown in the Downloads view, Save to library
  into another library, folder and layout, smart season/show selection and
  Real-Debrid torrent hand-off. [Addons and downloads](downloads.md).
- **Addons**: scoped search, scheduled/manual manifest refresh, storage rules
  and downloaded-title language. [Addons and downloads](downloads.md).
- **Search**: search while typing, title-match order of loaded results,
  per-account history that can be cleared, trimmed one entry at a time or turned
  off, and suggestions from
  recent searches and titles already seen. [Enhanced search](enhanced-search-spec.md).
- **Trailers**: Cinemeta/TMDB, in-app with secure mode off and an external tab
  with it on. [Trailers](trailers.md).
- **Languages**: ten in both web and desktop clients, with per-account
  preferences. [Languages](languages.md).
- **Desktop apps**: macOS arm64, Windows x64 and Linux x64; bundled FFmpeg,
  local/remote servers, LAN sharing, login startup and update notices.
  [Desktop guide](../desktop/README.md).
- **Cloudflare Access**: desktop email-PIN sign-in.
  [Supported sign-in](../desktop/README.md#cloudflare-access).
- **Phones and tablets**: responsive layouts and Home Screen setup.
  [Mobile guide](mobile.md).
- **Home**: the queue, Continue watching, Ready to play and Favourites on one
  page, with a five-slot compact navigation and a More menu on phones and short
  landscape screens. [Home page](home-spec.md).
- **Statistics and diagnostics**: traffic by source, active streams, admin
  activity history, grouped errors and redacted logs.
  [Activity history](users.md#activity-history), [Diagnostics](troubleshooting.md).
- **Security and distribution**: secure-mode artwork proxying, restricted mode,
  configuration export/import, GHCR images and unsigned desktop releases.
  [README](../README.md), [Configuration backup](downloads.md#backing-up-the-configuration).

## Next (daily friction)

These are the highest-value improvements for daily use. The priority is not to
add surface area for its own sake, but to make the common household journeys
faster, safer and more automatic.

### Family home and kids mode

Add a deliberately simple child-facing mode on top of the existing account and
library permissions:

- large, obvious tiles and touch targets with very little text;
- **Continue watching**, favourite shows and recently added episodes first;
- hide administration, diagnostics, addon management and destructive library
  actions;
- allow a parent to choose which libraries and addons are visible and require a
  parent-authenticated account switch to leave the child-facing UI; a PIN is
  optional convenience only after its server-side policy is designed;
- make repeated taps harmless and always show immediate feedback for actions
  that take noticeable time.

The MVP uses a dedicated restricted child account, with enforcement on the
server as well as a simplified interface. Hiding buttons in an adult session is
not a parental boundary. See [Family home and kids mode](roadmap-delivery-spec.md#family-home-and-kids-mode).

The practical UX target is intentionally strict: a child who already knows the
app should be able to open it, find a favourite show and start the intended
episode without adult help, documentation or recovery through browser controls.

### Home screen

The adult Home page is built (see [Home page](home-spec.md)): a Downloads row,
Continue watching, Ready to play and Favourites beside the catalogue and the
library. What is left:

- **Recently added**, which needs a write-once first-seen time per file so that
  a re-copied file does not look new;
- new episodes from followed shows, as a row once Following can be reused there;
- row order, visibility and an opt-in landing view, per account;
- the much smaller child-facing variant, with server-side enforcement. See the
  [home contract](roadmap-delivery-spec.md#family-home-and-kids-mode).

### Player and mobile chrome

- Improve Safari landscape chrome behavior on a physical iPhone/iPad; WebKit
  automation cannot emulate browser chrome, so this needs a device. The same goes
  for the native iOS fullscreen with the Fill screen toggle.

### Library

- A guided split of the download directory from the library manager. The
  supported route — carve-outs plus **Change folder** — is written up in
  [Libraries](libraries.md#splitting-the-download-directory); what is missing is
  a wizard that offers it at the moment someone needs it.
- Bulk rename by pattern. Deliberately out of the first multi-library release;
  the operations queue is shaped to take it without a migration.

### Queue robustness

Optional later: a night-only window, a speed limit, and a notice when the queue
drains. The in-app notice is shared with the debrid waiting state; push out of
the browser is later.

### Desktop

The apps are distributed unsigned: the first launch needs a one-time approval on
macOS and a click through SmartScreen on Windows. Signing and notarization need
an Apple Developer account and a Windows code-signing certificate, which the
project does not have, so the manual **Desktop release** workflow stays unused
and the cookie-encryption fuse stays off. There is no Intel Mac build. Updates
are a notice pointing at the release, not an installer.

Open items: verify a clean install and an upgrade on both platforms before each
release, and keep the Windows checklist in
[testing-windows.md](testing-windows.md) current.

## Engineering health

Status (2026-10-07): the items below shipped in #304–#324 and this branch —
P0 H1–H3; P1 recoverable moves, copies and re-roots, the destructive-path,
security and playback audits with their fixes, DNS pinning, commit-aware
`state.json`, follow/queue crash tests and the backup guide; P2 the shared
download types, the library-operations and shutdown modules, the settings,
diagnostics and queue pages out of `App.tsx`, error categories with a
reference the interface shows, the complexity report and the review checklist.
Deliberately not done: moving the catalogue search out of `App.tsx` (search and
browsing share one loader, so a clean move would change request order) and
splitting `style.css` (its rules interleave by area). The text below is the
plan as it was written.

Reviewed on 2026-10-04 against `main` at `b4b4c2a` (0.5.7). This section
validates the proposed refactoring/hardening plan against that revision; it
does not claim that the work below has shipped. The old local development
checkout was substantially behind `main` and was not used as the audit baseline.
On 2026-10-05 the PR was rebased onto `3b613fc` (0.5.8), the other agent's
JSON-first revision was reviewed and retained, and H1–H3 were reproduced again.
The file sizes and inventory counts below remain the dated audit snapshot.

Keep the modular monolith, explicit dependencies and one-command deployment.
The immediate order is **data-safety fixes → journalled, recoverable
operations → bounded structural refactoring**. Small isolated extractions may proceed
alongside safety work. CSS splitting is useful, but does not outrank a confirmed
persistence or destination-collision defect. Each item below is a separate PR
unless its invariant requires an inseparable change.

### What the proposed plan gets right, and what needs correction

| Claim or proposal | Verdict and repository evidence |
| --- | --- |
| `App.tsx` carries too much feature logic | **Confirmed.** 2,880 lines, including catalogue/search state, library workflows, queue UI, settings and diagnostics. `Player.tsx` (1,202 lines) and feature dialogs already exist; this is an incremental extraction, not a missing component architecture. |
| `style.css` is monolithic | **Confirmed.** 1,605 lines with interleaved overrides, Safari/safe-area rules and reduced-motion handling. Preserve cascade order as well as selectors; moving rules by feature can change behavior even without editing them. |
| `index.ts` should become a composition root | **Confirmed, partially underway.** 2,449 lines. Routes already live in `server/src/routes/`, and `server-start.ts` already binds the listener. Library mutation, artwork coordination, source resolution and lifecycle logic remain in the entry point. Extract those responsibilities; do not merely move route registration into another file. |
| Shared API contracts are needed | **Confirmed by drift.** `server/src/downloads.ts:PauseReason` includes `permission`; `web/src/types.ts:Download.pauseReason` omits it. Public jobs already strip private source fields in `publicJob`; share that DTO, not the persisted `DownloadJob`. No shared contracts workspace exists. |
| Download mutations need ownership review | **Largely covered already.** `routes/downloads.ts:requireOwnJob` guards pause/resume/retry/move/delete, with cross-owner and nonexistent-ID tests. Administrators deliberately act across owners. `DELETE /api/downloads` clears global completed history and is admin-only through `roles.ts`; it does not delete media. |
| Existing route tests prove the whole authorization boundary | **Only partly.** Download route harnesses exercise handlers; ordinary-user reorder passes that harness, while the full `roles.ts` allowlist excludes `/downloads/:id/move`. Decide and test the intended product policy through the real middleware before opening that route. |
| Queue restart/retry and filesystem safety need to be added | **Already partly implemented.** Restart resets checking/downloading jobs to queued; Range resume, storage/permission pauses, retry policy, destination reservation and random copy staging exist. Missing durability at side-effect boundaries is the issue. See `downloads.ts`, `library-transfer.ts`, `library-ops.ts` and their tests. |
| Follow-show scheduling needs auditing | **Now shipped, audit its real implementation.** PR #297 landed during this review: `follows.ts` persists daily discovery, episode intent, automatic downloads and queue reconciliation. The personal watchlist is a separate existing feature. |
| Desktop and Sonarr/Radarr are API consumers | **Different maturity.** Desktop ships and has a local backend lifecycle. The *arr adapter is a feasibility probe and specification, not a production integration. Keep its existing [delivery gate](arr-integration-spec.md). |
| Network restrictions and redaction need review | **Existing protections, targeted gaps to investigate.** `security.ts` validates addresses and redirects, strips sensitive cross-origin headers, and has tests; logger redaction and resource ownership exist too. DNS validation and fetch connection resolution are separate, so rebinding deserves a focused test; this audit did not demonstrate an exploit. |
| Defer SQLite migration for now | **Agree.** Cross-library relocation is a real cross-store invariant, but it also moves files, so it needs a journal and replay that no SQL transaction replaces. The confirmed defects are fixable in the existing stores; sample state sizes do not establish performance pressure. Runtime probes are encouraging but do not certify packaged desktop support. The migration's benefit has not been shown to outweigh its cost. See the [decision and its revisit triggers](roadmap-delivery-spec.md#local-sqlite-migration). |
| Formalize adversarial review and retain layered tests | **Useful, partly documented already.** Layered tests and an adversarial recovery campaign exist. Add missing failure cases and a focused high-risk review checklist to the existing workflow. |

File sizes measure physical lines, not complexity or performance. This audit
found no evidence requiring a DI framework, Redux, a CSS framework, services,
a broker or an external database.

### Confirmed failures and reproducibility

The following probes ran against the real queue/store classes in disposable
local directories. Download scheduling was stopped after `load()` to isolate
admission and persistence from network transfers. No real media or live instance
state was touched. These are observed behaviors, not hypothetical vulnerabilities.

| ID | Reproduction and observed result | Consequence / priority |
| --- | --- | --- |
| H1 | Run two `DownloadQueue.add` calls with the same owner/title/source via `Promise.all`, with an empty library. Both return distinct jobs with exactly the same target (`lib_d10ad10a/Race/Race.mp4`). | **P0:** admission checks span awaits without reserving the target. This proves duplicate destination allocation, not an end-to-end overwrite; add the transfer-level regression before claiming its exact damage. |
| H2 | Make `downloads.json.tmp` a directory, then call `addPending` for a new episode. The method returns a job, but `downloads.json` lacks it. Remove the obstacle and enqueue again: subsequent writes succeed. | **P0:** `save()` logs and swallows a failed write, so an acknowledged job can disappear after restart. The save chain is **not** permanently poisoned. |
| H3 | Write malformed JSON to the operations journal, then call `LibraryOps.load()`. The same file becomes `{ "version": 1, "jobs": [] }`. | **P0:** startup destroys recovery evidence. The existing corrupt-state test explicitly accepts continuing with an empty queue; it must change with the intended contract. |

The initial audit at `47f3f41` also reproduced cross-account deduplication (H4).
**Resolved in the final baseline:** PR #297 introduced owner-scoped direct, lazy
and torrent checks. Repeated direct/lazy probes now admit Bob's job independently;
the merged unit tests cover torrents, visibility and legacy ownership. Do not
reopen H4 as an outstanding fix. H1–H3 were reproduced again after the rebase.

Further **code-supported risks, not reproduced crash outcomes**: metadata
relocation is debounced across files, transfer publication precedes metadata
commit, and the operations journal does not record the staging path/publication
phase. `Store.update` now applies a change and writes it in one turn, taking it
back when the write fails, the way the download queue does since #304.
The shutdown path flushes several stores but does not call `queue.stop()` or
explicitly settle scan persistence; `followService.stop()` now waits for its
running pass and the writes it queued (#311, #318). These need defined failure
semantics and injection tests, not a claim that all current recovery is broken.

### P0 — Stop false success and ambiguous recovery

Status update (2026-10-05): H1–H3 shipped in PR #304 (0.5.10). Queue admissions
are serialized and reserve their target; `add`, `addPending`, `adopt`, removal
and clearing history resolve only after their own write and change nothing when
it fails (`err.queueNotSaved`); the queue, library operations, scan and
match-history loaders copy unparsable bytes to `<name>.damaged-*` and never
write over a file they could not read or preserve. `pause`, `resume`, `retry`
and `move` stay best-effort because the next start re-derives them. The text
below is the original contract, kept for reference.

1. **H1: reserve download admission and publication.** Serialize or atomically
   reserve the owner-scoped intent and library/target before asynchronous work.
   Keep physical destination exclusion global even when logical deduplication
   becomes per-user. Cover same-source double clicks, different sources with the
   same name, simultaneous library moves/downloads and pre-existing media/parts.
   Done when concurrent calls cannot share an unintended target and final
   publication cannot overwrite a different owner's file. Preserve the existing
   `library-transfer.ts` reservation rather than introducing a competing one.
2. **H2: acknowledge only durable mutations.** Separate admission/cancel/retry
   commits from best-effort progress snapshots. A failed commit must reach the
   caller; define whether uncommitted memory is rolled back or blocks execution.
   Cover failed write and rename, later recovery, response loss/repeated request,
   restart and shutdown with a pending write. Do not require an fsync per progress
   tick. Atomic rename alone is not a power-loss durability contract.
3. **H3: preserve unreadable journals.** Distinguish absent, malformed,
   unsupported-version and unreadable state. Preserve original bytes, block
   affected mutations and surface an actionable diagnostic. Test repeated starts
   without overwriting evidence. Audit download/scan/metadata loaders next;
   downloads currently attempt a `.bak` rename but ignore its failure. Reuse the
   fail-closed behavior already present in `FollowStore.load` rather than
   inventing another corruption policy.

Each fix lands with a store-level contract test: a failed commit reaches the
caller, an unreadable file is preserved, and concurrent admissions cannot
share an unintended target (duplicate intents may resolve to one job). Those tests stay valid whatever storage sits underneath.

### P1 — Recoverable filesystem and cross-store operations

The rule: when the app cannot tell **"the library is empty"** from **"the
library could not be read"**, it must not clean anything up. Uncertainty stops.
The cross-library artwork loss had exactly this shape; the library lifecycle
paths and the orphan sweep have been through it, the rest of the destructive
surface has not.

Keep the JSON stores. A [local SQLite migration](roadmap-delivery-spec.md#local-sqlite-migration)
was evaluated and deferred; its revisit triggers are recorded there. Cross-store
consistency comes from recording intent before effects and replaying it, which
filesystem work needs anyway.

Deliver in these boundaries:

1. **Commit-aware store updates.** Give `Store`, `DownloadQueue`, `FollowStore`
   and `LibraryMetaStore` one explicit contract: a mutation is acknowledged
   only after its write succeeds, and memory never runs ahead of a failed
   write unnoticed. Keep high-frequency progress coalesced and best-effort.
2. **Durable transfer phases.** Record operation ownership, staging identity,
   publication and source-cleanup phases in `library-ops.json` before each
   effect. Follow the existing
   [recovery contract](roadmap-delivery-spec.md#filesystem-safety-and-restart-recovery),
   including same-filesystem renames, cross-mount copies, partial failures and
   replay twice. Never delete an unproven destination or an unknown `.part` file.
3. **Journalled relocation.** A library relocation writes one intent record
   naming the source and destination keys, then updates both metadata files
   and every affected account's favourites and progress. Startup replays an
   unfinished record idempotently instead of leaving half the references moved.
4. **Remaining destructive paths.** File rename, move, copy, delete, bulk and
   cross-library operations across filesystems; artwork generation,
   replacement and cleanup; metadata binding after an external rename or a
   vanished file. Explicit preconditions, no swallowed errors, no success shown
   for a failure, and a domain-layer regression test for each case found.
5. **Backup scope, written down.** *(Instance backup guide shipped as [backup.md](backup.md); the settings import preview below is still open.)* `backup.ts` exports settings and addons and
   remaps library roots; it deliberately carries neither accounts nor media.
   Document which state must be preserved (favourites, resume state, metadata
   bindings, download settings), which is verified rebuildable cache, and how
   addon URL secrets are handled. The target is a restore preview that
   validates before mutation. A full-instance restore remains a separate,
   undesigned operation.

**Follow/queue reconciliation:** preserve the newly shipped owner-aware policy,
reserved episode intents, adoption of manual jobs and completion/removal guards.
The follow intent and its queue job commit to separate files. Preserve the
existing stable intent key and reconcile its job linkage on startup; extend
that mechanism where fault injection proves a gap. Test a crash after reserving, enqueueing, adopting,
completing and clearing history, plus revocation during discovery. Reuse the
existing follow tests; do not rebuild a scheduler or reopen the fixed H4.

Document the queue's actual states (`queued`, `waiting`, `checking`,
`downloading`, `paused`, `completed`, `failed`) and its transition/side-effect
table alongside these tests. Removing a download is not a persisted `cancelled`
state; library operations have their own different status model. Cancellation,
clear-history and deleting media must remain distinct.

### Persistent-state inventory and consistency boundaries

Paths below are relative to server `DATA_DIR`. Eleven JSON path families currently
exist in these stores, including two cache indexes; `library/<id>.json` expands
per library. This is not a count of all files on disk.

| Path / implementation | Meaning and recovery treatment |
| --- | --- |
| `state.json` / `Store` | Accounts, secrets, grants, libraries, settings, per-account favourites/progress/watchlist/search. Authoritative; never replaced by an empty state on a read failure. |
| `downloads.json` / `DownloadQueue` | Owned jobs, sources, destinations and recovery state; contains private URLs. Admission and status changes must be acknowledged only once written. |
| `follows.json` / `FollowStore` | Series subscriptions, discovered episodes and durable automatic-download intents. Reconcile with the queue on startup, including skip/retry state. |
| `library-ops.json` / `LibraryOps` | Mutating operation intent and results. Add per-item recovery phases; preserve on a malformed read. |
| `library-scan.json` / `LibraryScan` | Scan progress and remaining work. Explicitly reconcile interrupted work; do not silently declare it complete. |
| `library/<id>.json` / `LibraryMetaStore` | Manual/automatic matches and suggestions. Preserve manual decisions and library-relative keys. |
| `library/episodes.json` / `LibraryMetaStore` | Shared episode metadata. Establish which fields are rebuildable before treating any as cache. |
| `stats.json` / `Stats` | Historical traffic aggregates. Preserve; coalesce high-frequency updates. |
| `activity.json` / `ActivityLog` | Bounded per-user activity history. Preserve retention and access rules. |
| `images/index.json` / `ImageProxy` | Remote-image URL mapping/cache index. Separate from authoritative state; audit secret handling and rebuild behavior. |
| `artwork/index.json` / `ArtworkCache` | Artwork cache bookkeeping. Do not infer that user-provided or local artwork itself is disposable. |

Desktop also owns `connection.json`, `local-settings.json`, `shell-prefs.json`
and `window-state.json`, plus Electron-managed session storage. Those settings
are independent of server state. Remote desktop clients use the server API,
never shared state files.

Required reconciliation cases: a library relocation changes source
and destination bindings plus all affected users' favourites/progress; account
or grant changes invalidate sessions and queued work; a completed download
publishes a file and triggers metadata/statistics; reroot/disable/remove changes
library state while workers may still hold paths; follow intent and queue jobs
currently commit separately. Define the journal record and the replay for each
before changing its store.

### P1 — Security, playback and lifecycle boundaries

Audit the full authentication/role/ownership chain, including read routes that
serve private data, not just mutation verbs. Preserve indistinguishable foreign
and missing IDs, administrator policy and post-await permission checks. Cover
account deletion/revocation during work and library removal during transfers.
Use the existing `assertStillAdmin` and queue owner checks; do not reject the
state-reconciliation half of a filesystem operation after its files moved.

Network work should test address changes between validation and connection,
redirects, allowed-private-host configuration, timeouts and credential
redaction. Path work should test symlink changes and missing/unmounted roots at
the actual mutation boundary. This is a focused audit backlog, not a security
certification or an assertion that every route is vulnerable.

Playback already has serialized operations, orphan cleanup and seek recovery.
Extend tests around owner revocation, disconnect, hardware fallback and shutdown.
FFmpeg belongs to a session or a bounded cleanup period; closing one HLS segment
request must not kill a healthy conversion. Test desktop switch/quit with the
local backend as well as server shutdown. Keep physical iOS/Synology checks for
behavior that browser mocks and the local test machine cannot prove.

### P2 — Bounded refactoring

| Separate PR | Boundary and acceptance gate |
| --- | --- |
| Extract settings/diagnostics from `App.tsx` | Start with existing named subcomponents; move their state and polling with them. Preserve refresh/cancel behavior and translated wording. No large prop bag exposing unrelated app state. |
| Extract catalogue/search orchestration | Reuse `live-search.ts`, `search-suggestions.ts` and `search-scope.ts`; move feature state/effects next. Test stale responses, cancellation on navigation and per-account history before moving the next feature. |
| Split CSS by responsibility | Move one coherent block at a time with explicit import order. Preserve overriding rules, feature media queries, Safari comments, safe areas and reduced motion. Run the existing visual matrix once after functional checks; no framework or redesign. |
| Extract library application operations from `index.ts` | Give move/delete/artwork/reconciliation explicit dependencies and domain tests. Reuse route modules. Then extract lifecycle/configuration composition with startup/shutdown tests; avoid import-time environment surprises in the desktop backend. |
| Pilot shared download API contracts | Share public request/response DTOs and runtime input validation for this boundary. Resolve the `permission` pause reason drift. Prove private URLs/tokens cannot serialize and update container/desktop staging to include the workspace. No blanket move of domain models or mandatory validation framework. |
| Extend error classification | Reuse `AppError.messageKey` and existing `ResourceError.code`; add compatible categories/retry disposition per the [error contract](roadmap-delivery-spec.md#errors). Do not change HTTP behavior silently in an extraction. |

Desktop `main.ts` (1,802 lines), `playback.ts` (1,329), `downloads.ts` (1,600)
and `library-match.ts` (1,443) also deserve boundary reviews when touched.
Do not turn file size into a requirement to split working code arbitrarily.

### Verification and maintenance gates

Rebase verification on 2026-10-05 (`3b613fc`): `npm test` passed (server 1,414
passed / 3 skipped, web 431, desktop 270); `npm run build`, H1–H3 probes and
relative documentation links also passed.

Baseline verification on the original audit checkout: `npm test` passed (server 1,385
passed / 3 skipped, web 418 passed, desktop 270 passed); `npm run build` passed
with the existing large-chunk warning. Node was 26.8.1 on this machine, not the
Node 22 container runtime. The isolated probes above also passed their
assertions about current failure behavior. E2E, Docker deployment, power-loss,
physical NAS/iOS and packaged Electron validation were not run for this docs-only
audit; passing unit tests does not prove those environments.

For implementation, keep the [existing test layers](testing.md). Add a failing
regression at the lowest useful layer, then verify the fixed invariant. Use
controlled barriers/fault injection, with only a few real process-restart
journeys for boundaries unit tests cannot establish. Runtime changes still
require build, applicable tests, local Docker startup and `/api/status`; UI
changes get visual verification at the end. Follow repository version/PR rules.

A high-risk change needs a recorded adversarial review after implementation:
actor/resource authorization, two concurrent callers, failure before/after each
side effect, repeat request, restart/replay, secrets and abort/cleanup ownership.
Add this focused checklist to the existing contribution/review workflow in a
separate rules PR. It need not require five agents or five reviews.

Add a lightweight, report-only complexity script after the safety work. Baseline:
131 `app.get/post/put/patch/delete/head/options` registrations across production
server source (including the SPA fallback, so **not 131 API endpoints**);
92 server, 43 web and 23 desktop unit-test files; 48 web/desktop E2E spec files;
1/4/0 direct runtime dependencies in server/web/desktop manifests respectively
(Electron is a packaged runtime listed under dev dependencies). Report largest
production TS/TSX/CSS files and persistent-state families, then compare trends;
exclude generated output and translation catalogues from complexity alarms.
Do not fail CI on arbitrary LOC/test-count thresholds. Measure scan latency,
FFmpeg concurrency and render cost before proposing performance changes.

Keep the existing [maintenance measurement contract](roadmap-delivery-spec.md#maintenance-measurement):
track invalid/duplicate issues, independently caught defects, human decisions,
regressions and flaky tests. Green CI and model agreement are evidence, not proof.

## Later

### Access and multi-instance

- Richer profiles beyond the initial kids mode: several profiles under one
  account, optional age-aware filtering where trustworthy metadata exists, and
  fast profile switching without weakening the account boundary.
- Configurable LAN IP/host for the running container. The web client should try
  that address first so playback on the home network does not hairpin through a
  reverse proxy or Cloudflare Tunnel. Fail closed: never treat an unauthenticated
  LAN probe as an open door.
- Remote client mode: another instance (Docker or native) can use this one as the
  download/playback server, including an instance published behind a Cloudflare
  Tunnel with explicit auth.

Do not expose the app directly to the internet. An HTTPS reverse proxy or a VPN
remains the rule; the cookie is only `Secure` when the server sees HTTPS.

### External automation

- *arr integration can expose installed Stremio addons as a source of results
  and hand matching jobs back to Stremio Offline as a download client,
  especially for HTTP sources that the existing *arr ecosystem does not handle
  well. Keep this behind the household UX and reliability work above: it is a
  useful power-user integration, not a prerequisite for the core product. The
  [bridge specification](arr-integration-spec.md) and
  [execution plan](arr-integration-agent-task.md) own its contract. The protocol
  probe proves feasibility, not production readiness; automatic search is not
  continuous release discovery, and RSS remains a separate milestone.

### Packaging

- One-compose install path for people who will not read the Synology chapter.

### Tests

Stream sorting and filtering is still checked by hand against real addon
payloads. The screenshot matrix and the viewport projects are described in
[Testing](testing.md).

The suite is strong and should stay cheap to keep. When it starts costing more
than it catches, the things to look for are an end-to-end test proving something
a domain test already proves, a screenshot baseline that breaks on unrelated
changes, and a wait on a sleep where an observable condition exists. A flaky test
is a defect, not weather.

## Out of scope unless revisited

- A local torrent engine on the NAS.
- Playing an uncached torrent in the player while Real-Debrid is still leeching.
- AllDebrid, Premiumize, or a second debrid provider before Real-Debrid is in
  daily use.
- Parsing the API token out of a Torrentio (or other addon) manifest URL.
- Building the image on every push. Revisit after features land through pull
  requests instead of bursts on `main`.
