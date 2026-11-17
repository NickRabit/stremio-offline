# Handover: continue the system audit and bounded refactoring

For the next agent picking up [system-audit-refactor-agent-task.md](system-audit-refactor-agent-task.md).
Read that brief, [AGENTS.md](../AGENTS.md) and [system-audit-progress.md](system-audit-progress.md)
first; this file adds what the first four deliveries learned and what is left, in the order to do it.

State at handover: `main` at `037e1304`, version 0.7.114 (not yet released; 0.7.113 is the
latest tag), no open pull request from this work. Recheck all of it before starting: other agents
merge and release in parallel.

## Decisions the owner has already made

Do not reopen these without a new reason.

- **Access re-checks during a running transfer or playback stay relaxed.** Checking again per chunk,
  segment or poll multiplied request counts, so it was loosened on purpose. A revoked account
  finishing an in-flight download or playback is the accepted trade-off. A new re-check is welcome
  only if it is in memory and adds no request (the pattern of #842); anything that adds a request
  needs the owner first, with its request cost stated.
- **SA-7 stays open.** `GET /api/local-streams` may ask a granted addon for an IMDb id for a child
  account with catalogue browsing off; closing it would hide that child's own local copies.
- **Merging and releasing.** Merge only with explicit authorization, every check green and the branch
  containing current `main`. The repository has no required checks, so `gh pr merge --auto` merges
  at once: never use it. A release is a pushed tag `v<version>` on the merge commit, and also needs
  explicit authorization. Bump the patch in each pull request that ships a user-facing fix; a
  documentation- or test-only change takes none.

## How the work was done, and what to keep

- **Delegation.** Implementation went to DeepSeek and independent review to Grok through the local
  `ai-team` scripts (`.claude/skills/ai-team/scripts/worker.sh <ID>` and the Grok worker). Every
  delegated result was then read in full and re-verified by the primary agent. The `.claude/` and
  `.ai-team/` folders are excluded from git on the owner's machine, so an agent elsewhere will not
  have these scripts; the practice (a written specification, a separate implementer, an independent
  reviewer, then your own verification) matters more than the tooling. In practice the
  reviews caught real defects every time, and twice the specification itself was wrong (a rule that
  hid legitimate use, a test that synchronised on the wrong event). Keep both readers.
- **Prove each test against the unfixed code.** For a fix: run the new regression against the
  unmodified file and record that it fails. For a refactor or characterization: temporarily break
  one guard in the code and record which test fails, then restore it. Every pull request so far
  states this in its body.
- **Synchronise on events.** No sleeps, longer timeouts or retries in tests. Useful tools that
  already exist: deferred promises released by hand, a held addon response (`heldJson` in
  `catalog.test.ts`), `fs/promises.watch` on a folder (#843), and a named pipe (`mkfifo`) to hold a
  handler inside `readFile` (#842; skipped on Windows).
- **Docker check without disturbing others.** The container on port 8090 is shared with other agents
  and holds real data. Verify on a side port with a compose override that renames the container,
  empty `DATA_PATH`/`DOWNLOAD_PATH` folders and a separate compose project, then take it down.
- **Local environment traps.** The machine runs Node 22 while the project needs 24.15 (an `npm ci`
  warning, harmless for the tests). There is no FFmpeg on the host, so real-FFmpeg tests are
  skipped there; `node:26-trixie-slim` plus `apt-get install ffmpeg` reproduces the CI setup, and
  `docker run --cpus=0.2` provokes timing races. Node 26 prints `ℹ pass 1`, not the TAP `# pass 1`.

## CI behaviour to expect

- The macOS `package` job sometimes gets no runner and is cancelled after 15 minutes with
  "The job was not acquired by Runner". No step ran; rerun only that job.
- The `windows` job once hung for 19 minutes in `server/src/downloads.test.ts` (SA-13, below). A
  rerun passed. That is a defect to find, not a pattern to rerun.
- Any other failure that passes on rerun is a bug to fix the same day (`scripts/test-stress.mjs`).

## Remaining work, in priority order

### 1. Split `server/src/downloads.test.ts` (SA-11, SA-13) — done in #846

5,218 lines and about a minute on its own. Under load it crosses the 120-second per-file limit
(reproduced locally: `node scripts/test-stress.mjs server/src/downloads.test.ts --runs 12 --parallel 4
--load 2`, one of 12 failed), and once on Windows CI it hung for 19 minutes with
`Promise resolution is still pending but the event loop has already resolved` and no per-test output.

Split it by subject into files that stay well under the limit (for example admission and naming,
transfer and resume, source failover and cleanup, publication and subtitles, restart and replay,
remote and debrid). Move tests and their helpers only; do not change a test's body or the 120-second
limit. Shared helpers (`tempQueue`, `listen`, `deferred`, `waitFor`, the range servers) go to one
helper module. Done means: every test that passed before passes, the count is unchanged, no file
takes more than about 20 seconds alone, and the stress command above passes 12 of 12. Smaller files
also make the Windows hang attributable: if it recurs, CI names the file.

### 2. A crash boundary for the main views — done in #847

`LazyScreenBoundary` (`web/src/lazy-screen.tsx`) wraps three lazily loaded screens in `App.tsx`
(the remote-library browser, statistics and settings), but only to recover from a failed chunk
import, and its message says the server is unreachable. The
catalogue, library, title detail and player have no boundary: a render error there blanks the whole
application. Design one recovery boundary for those views (what it shows, whether it keeps the
navigation, how to leave it, that it resets when the view changes), with translated strings in all
ten catalogues, and tests that throw inside each wrapped view. Correct the "React error boundary"
row in `system-audit-progress.md` at the same time.

### 3. The next `App.tsx` slice

`web/src/App.tsx` is 4,619 lines with 68 effects after #844 moved catalogue and search loading into
`web/src/use-catalog-loader.ts`. Repeat the same two steps for each further slice: first
characterization tests through the rendered `App` (the pattern of `web/src/catalog-search-app.test.tsx`,
#840), proven against a temporarily broken guard; then a pull request that moves only that slice and
leaves those tests untouched. Candidates, in order: the selected title's sources and local copies
(the `sourcesRequestRef` / `streams` / `localStreams` state and the next-episode prefetch), library
browsing (`loadBrowse` and its refs), and scroll and view-anchor restoration. Do not pass a bag of
unrelated `App` state into a hook; a slice that needs it is not a slice yet.

The characterization tests for the first candidate are in `web/src/title-sources-app.test.tsx`:
late local and addon answers of a previous title, a failure that answers after the detail closed,
rows appearing per addon, local copies beside a failed addon lookup, and the next episode taking
the prefetched sources and staying with the playing addon. #850 moved that slice into
`web/src/use-title-sources.ts`. The library browsing slice is pinned by
`web/src/library-browse-app.test.tsx` and lives in `web/src/use-library-browse.ts`. Scroll and
view-anchor restoration is pinned by the Playwright specs `rotation.spec.ts`, `safari-scroll.spec.ts`,
`layout/catalog-header.spec.ts`, `layout/catalogue-detail.spec.ts` and `scroll-return.spec.ts`: it
depends on real layout, so jsdom tests through `App` cannot hold it. Its move is next.

### 4. Inject the remaining queue faults — done

The table "Partial-file removals in the queue" in the progress file marks three branches as read but
not injected: HTTP 416, a source that ignores byte ranges after promising them, and a remote job
restored with a segment plan. Write fault-injection tests with local HTTP fixtures for each. If one
loses or corrupts bytes, fix it in its own pull request.

### 5. Small findings

- **SA-3.** The library rename route (`routes/content.ts`) renames the video, then its subtitles,
  with no journal; `rerootItem` has a similar window for a loose video. Reproduce the stop between
  the two before proposing a journal: a same-volume rename makes the window short.
- **SA-4.** `DownloadQueue.retry` clears `source.tried`, so a later failover may choose a source
  that already failed. Decide with the owner whether a manual retry should start over.
- **Residue of #838.** `GET /api/library/identity` and `/gallery` answer a parent-spelled key inside
  a hidden nested library differently from an absent folder, which confirms a guessed folder name
  without returning content. A symlink planted inside the parent that points into the nested root is
  not detected.

### 6. Remote media-server sync (BH-6.3, BH-6.4)

Not yet examined: an interrupted sync, stale remote items after deletion upstream, and the
playback/progress bridge. Do not test against a third-party server with quota limits; use a local
test server.

### Not possible without hardware

Playback interruption, cache growth, concurrent conversions and time to first segment on the
supported NAS, an Android TV and an iPhone. Record these as not verified rather than inferring them.
