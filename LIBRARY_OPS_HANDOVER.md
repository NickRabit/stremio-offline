# Library Operations PR 5 Handover

## Repository state

- Branch: `feat/library-operations`
- Base: `origin/main` at merge commit `2951654` (PRs 114, 115, 117 and 118 are merged).
- Scope source: `docs/multi-library.md`, section **PR 5 — Operations queue and bulk selection**.
- This branch is a tested backend foundation, not a complete PR 5. Do not open the final PR until the UI, E2E coverage, version bump and full verification below are finished.

## Implemented

- `server/src/library-ops.ts`
  - Durable serial queue stored in `data/library-ops.json`.
  - Restores running and paused work after restart.
  - Queues subsequent jobs, continues after item failures and retains the latest 20 jobs on disk.
  - Per-item results include destination and catalogue error key.
  - Supports cancellation after the current item and byte progress in memory while a transfer runs.
- `server/src/library-transfer.ts`
  - Same-filesystem moves use `rename`.
  - Copies and cross-filesystem moves stage into `<target>.part`, fsync each file, rename the completed tree and only then remove a move source.
  - Removes an incomplete staging tree after failure and refuses nested symbolic links.
- Server integration in `server/src/index.ts`
  - `GET /api/library/ops`
  - `POST /api/library/ops`
  - `DELETE /api/library/ops/:id`
  - `POST /api/library/folder`
  - 500-item cap and operation validation.
  - Queue operations: move, copy, delete, favorite, match, unmatch, skip lookup, regenerate artwork and forget watched progress.
  - Existing single favorite, delete, match and move routes now share the same internal implementations.
  - Existing single move gains the safe cross-filesystem fallback.
  - Playback and destination-download pause checks are wired into queued work.
- Metadata copy support in `LibraryMetaStore.copy()`.
- Restricted-mode allow-list entries for the new library mutations.
- Web API types and request methods are ready for the UI.
- English and Czech catalogue entries exist for the new API validation errors.

## Verification completed

- `npm run build` passes for web and server.
- Focused test set passes: 24 tests across:
  - `server/src/library-ops.test.ts`
  - `server/src/library-transfer.test.ts`
  - `server/src/library-meta-store.test.ts`
  - `server/src/restricted.test.ts`
- A production server build reached the listening state with fresh temporary data and download directories.
- `git diff --check` passes.

## Work still required for PR 5

1. Build the browse selection UI in `web/src/App.tsx`:
   - Select-mode toggle in the browse tools.
   - Per-file and per-folder selection controls; never select library-root rows.
   - Sticky bulk action bar with count, move, copy, delete, favorite, forget, match/unmatch, skip lookup and artwork actions where applicable.
   - Preserve or deliberately clear selection when browsing, filtering and completing a job.
2. Extend `MoveDialog` or add a destination-only picker for bulk move/copy. Submit `api.startLibraryOp()` instead of moving each item from the browser.
3. Poll `api.libraryOps()` on the existing library cadence while a job is active or paused. Show progress, pause reason, failed count, current item and cancel action. Refresh browse/resume/favorites once on terminal transition.
4. Add create-folder UI to the library tools and translations for every new visible string in both locale files.
5. Add unit coverage for selection helpers if they are extracted from `App.tsx`.
6. Add `e2e/tests/library-bulk.spec.ts`: select three items, move them, observe progress, and prove one failed item does not stop later items.
7. Review the backend integration details listed below and add route-level coverage.
8. Bump patch version from `0.4.2` to `0.4.3` in root, server and web `package.json` plus `package-lock.json` only when PR 5 is complete.
9. Mark PR 5 progress in `docs/multi-library.md`.
10. Run `npm test`, `npm run build`, the full Docker E2E suite once, then rebuild and verify the local Docker stack per `AGENTS.md`.
11. Fetch `origin/main`, rebase, rerun checks, push and open the PR against `main`.

## Backend review notes

- The queue represents waiting jobs as `status: "paused", pauseReason: "queue"`, because the specification's status union has no `queued` member. Keep this contract or change server and web types together.
- Transfer progress is durable between items; current-item byte updates are intentionally in memory only. After a crash, the current item restarts from zero and replaces a stale `.part` tree.
- Copy duplicates metadata but does not duplicate generated artwork. Browse schedules artwork at the copied path; decide whether immediate artwork copying is worth adding.
- The download pause check is destination-scoped when download job targets can be resolved. Add route tests for qualified and legacy single-library targets.
- An unavailable qualified library pauses a job when the health probe reports it unreachable. Verify restart and remount behaviour with an integration test.
- `libraryOpsWriting` prevents a new automatic scan from starting during a write. An already-running `LibraryScan` does not yet expose an `operation` pause reason; add it if strict scan/ops mutual exclusion is required.
- `artwork` completes after scheduling regeneration rather than waiting for ffmpeg/catalogue work. That matches the existing background artwork model but should be reflected in UI wording.
- Add an integration test for a cross-device move if CI exposes two devices. The unit tests currently cover the copy path and the same-device rename path independently.

## Recommended next edit order

1. Add route-level tests around the new endpoints and fix any backend findings.
2. Add selection state plus a small bulk action bar with delete/favorite/forget first.
3. Generalize the destination picker and add move/copy.
4. Add queue polling/progress/cancel chrome.
5. Add match and artwork actions, create folder, translations and E2E coverage.
6. Perform version bump and final verification only after the feature is complete.
