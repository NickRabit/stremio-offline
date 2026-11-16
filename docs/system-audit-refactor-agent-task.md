# Agent task: system audit and bounded refactoring

Use this brief for a strong reasoning agent, whether GPT-6 Astra or Fable 5.2.
It is a sequence of reviewable tasks, not permission to rewrite the application
in one pull request. Read [AGENTS.md](../AGENTS.md),
[testing.md](testing.md), [bug-hunt-plan.md](bug-hunt-plan.md), and the current
[roadmap.md](roadmap.md) first. Follow the repository's branch, version, test,
Docker, and pull-request rules for every implementation slice.

Baseline for this brief: `main` at `a0bb6ce7` (0.7.108), 2026-11-15. Fetch
`origin/main` and recheck every status and file size before starting. An open
checkbox in an older audit is an investigation lead, not proof of a present
defect. If the local untracked `docs/player-reliability-agent-task.md` exists,
its five defects have since been addressed on `main`; do not reopen or
reimplement them without a new reproduction.

## Outcome

Produce an evidence-based inventory of remaining reliability and security
risks, then fix confirmed defects in small, separate pull requests. Follow
with bounded refactoring where it removes a demonstrated maintenance or test
obstacle. Record which cases were inspected, which failed, which passed, and
what could not be proved without a physical NAS, television, or iPhone.

For each confirmed defect, state the invariant, a reproducible failure, the
smallest fix, and a regression test that fails before the fix and passes after
it. For performance work, record comparable measurements before and after.
Do not turn file length, a speculative race, or a green test suite alone into
a claim about correctness.

## 1. Durable work across queues, follows, and files

Start here because a false success or a broken replay can lose or overwrite
household media. Read the current implementations and the open BH-2.1–2.4,
BH-1.5, and BH-4.1/4.4 notes in [bug-hunt-plan.md](bug-hunt-plan.md).

- Map the download queue's states and allowed transitions, including what is
  persisted before a response or a file publication. Check two concurrent
  admissions, cancellation, retry, history clearing, source failover, and a
  restart after each side effect.
- Trace a followed episode from reserved intent through queue admission,
  adoption, completion, removal, and replay. Check revocation during discovery
  and a process stop between the follow and queue writes.
- Check library move, rename, copy, delete, and re-root recovery across mounted
  filesystems and unavailable roots. The move journal covers the video but not
  every subtitle sidecar; determine the actual post-crash behavior before
  proposing a change. Never treat an unreadable or unmounted library as empty.
- Reproduce the recorded `.part` cleanup/failover finding only if it still
  exists. Prove that a failed cleanup cannot silently consume a new destination
  name or overwrite someone else's file.

Use disposable synthetic libraries and local HTTP sources. Inject failures at
the write, rename, publish, cleanup, and restart boundaries. Never run fault
injection against configured user media or mounted production libraries.
Deliver a transition/replay table and one pull request per independently
confirmed fix.

## 2. Authorization and lifecycle boundaries

Inspect BH-7.1–7.4 and the current account, library, addon, download, playback,
remote-library, and child-account routes. This is a whole-application review,
not a review limited to kids mode.

- Build a route inventory with method, role gate, resource ownership/grant
  check, and response for a foreign versus missing identifier. Exercise the
  real middleware as well as route handlers; do not infer authorization from a
  hidden client control.
- Check account deletion, demotion, grant revocation, and library removal while
  a download, scan, media transfer, or playback request is awaiting I/O.
  Verify the authorization decision again at the side-effect boundary while
  preserving the reconciliation needed after an already completed file move.
- Check outbound host validation and redirects at connection time, allowed
  private hosts, DNS changes, timeouts, and redaction. Use local test servers;
  do not probe third-party or household endpoints.
- Check path inputs at the final filesystem boundary, including links that
  change between validation and use. Report only reproducible gaps.

## 3. Playback under interruption and resource pressure

Inspect BH-3.1–3.3, BH-10.1–10.3, the current
[playback guide](playback.md), and the proposed
[bounded-buffer brief](playback-buffer-spec.md). Reconfirm what is already
implemented before designing anything new.

- Trace ownership and cleanup of FFmpeg, ffprobe, subtitle readers, segment
  requests, and conversion directories after seek, source switch, disconnect,
  permission loss, shutdown, and hardware fallback. One segment request ending
  must not kill a healthy conversion.
- Exercise rapid seeks, a source disappearing, a server restart, and two
  clients watching the same title. Check that position, selected tracks,
  subtitles, and final progress remain truthful on web and Android TV.
- Measure cache growth, concurrent conversion count, temporary bytes written,
  CPU, and time to first segment on the supported NAS path before changing
  buffering or transcoding. A RAM mount or segment deletion alone is not a
  bounded-buffer design; preserve the documented compatibility gates.

The already shipped short-conversion, failed-seek fallback, expired-session,
track rollback, and AC-3 descriptor fixes are regression constraints, not the
initial implementation backlog.

## 4. Large-file refactoring after behavior is pinned

Physical line counts on the baseline, excluding tests and translations:

| File | Lines | First boundary to examine |
| --- | ---: | --- |
| `web/src/App.tsx` | 4,748 | Catalogue/search orchestration and its shared loader |
| `server/src/downloads.ts` | 4,309 | Queue state transitions and durable side effects |
| `server/src/media-server-manager.ts` | 3,725 | Remote request, sync, and access boundaries |
| `server/src/index.ts` | 3,185 | Composition versus remaining library/lifecycle work |
| `web/src/style.css` | 2,562 | One coherent style area, preserving cascade order |
| `android-tv/.../catalog/CatalogDetailScreen.kt` | 2,248 | Detail state and D-pad focus when touched |
| `desktop/src/main.ts` | 1,852 | Local backend and shell lifecycle when touched |
| `web/src/Player.tsx` | 1,815 | Session lifecycle when touched |

Prioritize `App.tsx` as the first structural task. Settings, diagnostics, and
queue pages have already been extracted; do not repeat that work. Map the
state, effects, request ownership, and navigation dependencies of catalogue
and search. Add characterization coverage for stale responses, cancellation
on navigation, account switching, search history, and request ordering before
moving a coherent slice into a feature module or hook. Reuse `live-search.ts`,
`search-suggestions.ts`, and `search-scope.ts`. Do not pass a large bag of
unrelated application state through a new component.

Refactor the large server files only at a boundary exposed by a confirmed
defect or a test that cannot otherwise express an invariant. Keep one server
contract for web, desktop, and TV. Split CSS only after functional behavior is
stable; preserve import and override order, safe areas, reduced motion, and
the existing viewport matrix. No new framework or wholesale redesign is
required by these line counts.

For `media-server-manager.ts`, use BH-6.3/6.4 to examine interrupted sync,
stale remote items, playback/progress bridging, and grant checks before
choosing a seam. For the clients, check the recorded missing React error
boundary before adding more lazy chunks; inspect desktop local-backend
lifecycle and Android TV player/focus behavior when a confirmed defect touches
those paths. Do not fold these separate investigations into the `App.tsx`
refactor merely because the files are large.

## Delivery and gates

1. Publish a concise audit report with a status for each item: confirmed,
   disproved, already fixed, or not verified, with a file/line or test for the
   evidence. Rank confirmed findings by data loss, unauthorized access,
   playback failure, and measured performance cost.
2. Make separate branches and pull requests for unrelated defects and for each
   refactoring slice. Do not bundle a broad audit with a broad code movement.
   Keep the branch rebased on current `main`; do not merge without the owner's
   authorization and green required checks.
3. For code changes, run the smallest meaningful regression first, then the
   applicable unit/build/e2e checks and the Docker health check from
   `AGENTS.md`. Run Android unit/lint checks for TV changes. Do UX and visual
   verification once, after functional checks are stable. A failing CI test
   that passes on rerun is a defect to diagnose, not a reason to rerun blindly.
4. Bump the patch version in each pull request that ships a user-facing fix.
   Documentation-only audit and plan changes do not need a version bump.
