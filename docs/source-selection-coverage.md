# Source selection Stage 0 coverage: background lane

This is the Stage 0 baseline for the background download and follow lane of
[PR 547](https://github.com/NickRabit/stremio-offline/pull/547). It characterizes current
production behavior; it does not claim that the complete Stage 0 suite, the unified source-selection
refactor or profiles are complete.

The cases come from the PR's
[specification](https://github.com/NickRabit/stremio-offline/blob/docs/source-selection-profiles-plan/docs/source-selection-spec.md)
and [delivery plan](https://github.com/NickRabit/stremio-offline/blob/docs/source-selection-profiles-plan/docs/source-selection-tasks.md).
Those links should become `main` links after the documentation lands there.

## Status vocabulary

- **Baseline contract**: a passing assertion about behavior the current lane must preserve.
- **Characterization**: a passing assertion about today's behavior that is not automatically the
  final contract. A related defect or planned correction is identified below.
- **Known defect**: a reproducer exists. A passing characterization may assert the incorrect
  result to pin down the starting point; its future fix PR must replace that assertion with a
  failing-before/passing-after regression for the desired result.
- **Uncovered**: no honest baseline test exists yet. The stage that must add it is named.
- **Out of lane**: owned by another Stage 0 lane and not claimed here.

## Baseline and verification

Baseline commit: `cebf6fa67633fbe0dff21ecb6e52b35b46f4f9e6` on branch `SRCSEL-0`.

Focused commands run before editing the tests:

```text
npx tsx --test server/src/download-selection.test.ts  # 30 passed
npx tsx --test server/src/follows.test.ts            # 92 passed
npx tsx --test server/src/routes/downloads.test.ts   # 61 passed
npx tsx --test server/src/backup.test.ts             # 8 passed
```

The same focused commands after adding the tests passed:

```text
server/src/download-selection.test.ts  32 passed
server/src/follows.test.ts             93 passed
server/src/routes/downloads.test.ts    62 passed
server/src/backup.test.ts               9 passed
```

Full command:

```text
npm test
server:       2,977 tests, 2,971 passed, 6 skipped, 0 failed
web:          1,185 passed, 0 failed
desktop:        304 passed, 0 failed
media-client:    30 tests, 29 passed, 1 skipped, 0 failed
total:        4,496 tests, 4,489 passed, 7 skipped, 0 failed
```

The seven skips are the repository's existing environment/build-dependent cases. No new test is
skipped. `npm run build` also passes; Vite reports the repository's existing large-chunk warning.

### Round 2: real-resolver fixture evidence

Commands:

```text
npm run build
# passed; only the existing Vite large-chunk warning

npx tsc --noEmit -p e2e
# passed

docker run --rm -v "$PWD":/work -w /work -e CI=1 stremio-offline-e2e \
  npx playwright test source-selection-baseline.spec.ts --project=chromium
# 3 passed: setup plus the two source-selection baseline tests

npm test
# 4,496 tests, 4,490 passed, 6 skipped, 0 failed
# server 2,977 (2,971 passed, 6 skipped)
# web 1,185 passed
# desktop 304 passed
# media-client 30 passed (the build removed its environment-dependent skip)
```

The fixture counts at the addon HTTP boundary, not in the browser. Each row contains the provider
manifest identity, media type and episode ID; request headers and credentials are never returned or
logged. The second provider has manifest ID `e2e.secondary.source` and a distinct
`/secondary/manifest.json` URL, but deliberately uses the primary fixture's display name.

## Background source selection

| Required case | Evidence | Status | Later stage |
| --- | --- | --- | --- |
| Largest versus priority strategy | `largest strategy ignores addon priority`, `addon priority decides between equally suitable sources` in `download-selection.test.ts` | Baseline contract | Preserve |
| Provider order and direct-source priority | `addon priority decides between equally suitable sources`; `HTTP 404 fails a direct job and moves a lazy job to the next source` in `downloads.test.ts` | Baseline contract | Preserve |
| Audio modes, primary/fallback order and missing-language behavior | `primary audio wins even when an earlier source contains the fallback`; `fallback audio is used only after every candidate was checked`; `preferred downloads a source that matches nothing when no better one is offered`; `strict rejects a source whose only evidence is the listing` | Baseline contract | Preserve |
| Subtitle requirements, candidates and tie-breaking | `required subtitles reject a source while optional subtitles do not`; `an addon subtitle can satisfy the required language`; `primary subtitles win over an earlier subtitle fallback` | Baseline contract | Preserve |
| Direct before torrent | `a lazy job falls back to a torrent and downloads it through Real-Debrid` in `downloads.test.ts` | Baseline contract | Preserve |
| Bounded inspection | `probing gives up after a bounded number of candidates instead of checking every source` | Baseline contract | Preserve |
| Tried direct URLs and torrent identity | **New:** `direct selection skips an already tried URL before inspection`; existing `a torrent that was already tried is skipped` | Baseline contract | Preserve |
| Selected-provider scope before probing | **New:** `a source from an addon outside the selected scope is never inspected` covers direct and torrent candidates | Baseline contract | Preserve |
| Selected-provider outbound scope | **New regression:** `a selected-provider job requests streams only from the selected provider`. With only `e2e.secondary.source` selected for a unique episode, the fixture receives zero primary-provider `stream` requests and exactly one secondary-provider request. | Baseline contract / fixed by this PR | Preserve |
| No usable source | `a lazy job that finds no source fails with the no-matching-source key` in `downloads.test.ts` | Baseline contract | Preserve |
| Explicit retry refreshes provider listings | **New regression:** `explicit retry refreshes the failed selected provider's stream listing`. The first attempt makes exactly one request to the selected provider. After its controlled failure, fixture recovery and control reset, the immediate public-route retry makes exactly one request to the recovered selected provider and none to the unselected primary provider. | Fixed by the retry slice | Preserve |
| Failed provider listing does not poison other jobs | **New regressions:** `a failed provider listing does not poison another job for the same video` asks the recovered selected addon from a second job without retrying the first. `successful empty listings are cached for five minutes while failures are retried` proves that a failed provider is retried while successful empty listings remain cached. `concurrent misses for one provider share one in-flight fetch` and `title invalidation starts a fresh request and an old completion cannot unshare it` cover the concurrent path; `mixed cache hits are reassembled in current provider order` preserves provider order. | Fixed by Stage 2 per-provider result caching | Preserve |
| Legacy strategy and provider-key normalization | **New characterization:** `characterization: a legacy bulk submission drops duplicate provider keys and coerces an unknown strategy`; existing `POST /api/downloads/bulk refuses addons the caller may not use and queues only from the allowed ones` | Characterization | Stage 3 |
| Bulk versus follow default strategy | The two clients/dialogs own their defaults; there is no route-level assertion for both defaults. | Uncovered | First slice / Stage 4 |

The delivery plan names `POST /api/downloads` for the legacy strategy case. In the current route,
`POST /api/downloads` saves an already resolved exact source; the shared selection parser is used by
`POST /api/downloads/bulk` and follow setup. The new characterization therefore uses the bulk route,
where `sourceStrategy` is actually accepted.

The resolver now intersects the owner's currently authorized addons with the stored
`addonKeys` by stable addon key before calling `streamCache.list`. `usable` order is preserved,
and a selection never falls back to every addon when a selected key is missing or currently
unusable. The selection's own ordering still controls source picking. Authorized subtitle
addons remain independently queried: stream-provider scope does not restrict subtitle search,
because an external subtitle addon may not also be a selected stream provider.

## Follow admission, retry and identity

| Required case | Evidence | Status | Later stage |
| --- | --- | --- | --- |
| New, from and ahead admission | `downloadEligibility follows the start rule, the clock and the episode's facts`; `aheadWindow is the next N regular episodes after the marker, or the first N`; `an ahead rule admits only its window, older seasons included, and slides with the marker` | Baseline contract | Preserve |
| Unreleased and ambiguous episodes | `downloadEligibility follows the start rule, the clock and the episode's facts` covers upcoming, no date and ambiguous results | Baseline contract | Preserve |
| Episode sequencing and admission caps | `admission queues in season order and stops at the caps`; `a long season is admitted over several passes, never more than twenty at once`; `the outstanding budget is shared across every follow` | Baseline contract | Preserve |
| Active-job and hand-queued deduplication | `an episode already queued by hand is adopted and followed to completion`; `two owners get two follows of the same series` | Baseline contract | Preserve |
| Deleted or disabled owner and download permission | `a deleted or switched-off owner is never asked for metadata`; `an owner who may not download is blocked and unblocked`; `an owner that no longer exists is blocked` | Baseline contract | Preserve |
| Schedule revision race | `a rule that changes while a job is being queued is not admitted` | Baseline contract | Preserve |
| Grace window and closing boundary | `graceUntil opens for graceDays after release and never without one`; `effectiveSelection strips the fallback inside the window and restores it after`; `admission inside the window passes the stripped selection, and the close restores it` | Baseline contract | Preserve, then snapshot in Stage 3 |
| Retry after restart | `a job that failed while the server was down waits, then re-queues one job`; `two restarts in a row keep exactly one job for both crash windows` | Baseline contract | Preserve |
| Selection snapshot, target and retention | **New characterization:** `known defect: a retry after a follow edit uses the edited selection instead of the admitted one` also asserts that target and retention remain unchanged. Existing `jobCompleted and sync remember the library key a finished download wrote` covers target persistence. | Characterization / known defect | Stage 3 |
| Retry after a follow edit uses admitted rules | The new named defect test fails in the future fix when the retry still returns `["replacement"]`; it must instead use the admitted `["admitted"]` selection. Existing `changing the rules retries waiting episodes at once with the new selection` is current behavior, not the final queued-work contract. | Known defect | Stage 3 |
| Owned episode already in a visible local library suppresses automatic download | No follow admission collaborator checks local copies. `a file already on disk pushes a job of the same title to (2)` in `downloads.test.ts` demonstrates the downstream duplicate naming path. | Known defect | Early delivery: avoid redundant local-episode downloads |
| Matching versus inadequate local copy | No language, resolution or bounded-inspection policy exists yet. | Uncovered | Early delivery |
| Remote-only copy | Remote items are not wired into follow admission. | Uncovered | Stage 5 |
| Episode present only in a hidden library | No local-copy admission check exists. | Uncovered | Early delivery |

## Access and provider identity

| Required case | Evidence | Status | Later stage |
| --- | --- | --- | --- |
| Users, jobs and follows stay separated | `GET /api/downloads shows an administrator every job and a user only their own`; `acting on somebody else's job answers exactly like an id that is not there`; `two owners get two follows of the same series` | Baseline contract | Preserve |
| Session-bound source handles are not persisted or reused | `persisted remote state carries no seal, session or credential`; `assertCurrent binds the sealed source to the exact owner session`; `downloadReference captures a durable, session-free handle for the exact version` | Baseline contract for exact-source saves | Preserve |
| Current permission is checked during exact-source admission | `a withdrawal while the handle is minted queues nothing`; `a withdrawal during admission writes no metadata`; `a withdrawal while the native handle is minted leaves nothing queued` in `routes/downloads.test.ts` | Baseline contract | Preserve |
| Current permission is checked throughout background lookup/use | The follow admission guard is read before queueing; no fixture revokes a grant during resolver/probe/queue I/O. The stream cache has no authorization revision. | Uncovered / suspected defect | Stage 2 shared access prerequisite |
| Disabled provider | `a disabled addon is refused for an administrator too, where enabled is enforced` in `addons.test.ts` | Baseline contract | Preserve |
| Provider reconfigured under the same key | **New regression:** `provider manifest revisions do not reuse another definition's listing` changes both the manifest version and URL under one addon key. The cache identity includes type, title id, addon key, manifest URL and manifest version. Profile-aware identity remains outside this change. | Fixed for provider revisions | Preserve; profiles remain Stage 3/4 |
| Empty result versus transport failure | **New regressions:** `successful empty listings are cached for five minutes while failures are retried`; `stream listings reject a non-array field and non-object entries while accepting an absent field` proves that malformed payloads fail rather than become cacheable empties. | Fixed by Stage 2 per-provider result caching | Preserve |
| Remote generation change and revoked durable reference | Covered in existing media-server source tests, but not connected to follow resolution. | Uncovered for this lane | Stage 5 |
| Settings backup distinguishes same-name addons without local keys | **New:** `a backup distinguishes same-name providers by URL and omits installation-local addon keys` | Baseline contract for backup version 3 | Preserve through version 4 migration |
| Export/import into an empty instance | Export and parse round trips are covered in `backup.test.ts`; import mints new addon and remote-library IDs by design. No end-to-end empty-instance portable-reference baseline exists. | Uncovered | Stage 3 |
| Re-adding an addon | Addon installation mints a new random key. Existing import preserves a key only for the same manifest ID and URL; remove/re-add has no persistence test. | Uncovered current limitation | Stage 3 |
| Remote libraries reattached by import | `POST /api/settings/import replaces the remote configuration in the same write` in `routes/settings.test.ts` covers atomic replacement, but does not prove a portable provider reference reattaches to the new library ID. | Uncovered | Stage 3 |
| Backup versions 1 through 3 still import | `a version 1 backup still imports, with no libraries and no rules`; `a version 1 or 2 backup carries no media-server configuration at all`; `a version 3 backup has to carry a media-server configuration` | Baseline contract | Preserve through version 4 |

## Known defects to correct later

These are documented reproducers and desired outcomes. They are not passing final contracts.

| Defect | Current reproducer | Desired correction | Fix stage |
| --- | --- | --- | --- |
| Retry applies a later follow edit | Admit an episode, fail its job, edit the follow selection, then let the retry run. `known defect: a retry after a follow edit uses the edited selection instead of the admitted one` observes the replacement provider key. | Persist the pre-grace admission snapshot and grace parameters with the reserved intent/job. Every retry derives selection from that snapshot; a separate explicit reconfigure action changes work. The future regression expects `["admitted"]` after the edit. | Stage 3 |
| Owned episode is downloaded again | With `Film.mkv` already in a visible local library, save the same title again; `a file already on disk pushes a job of the same title to (2)` shows the collision. A follow has no owned-copy admission check. | Apply the explicit `any`/`meetsRequirements` local-copy policy before automatic admission and again before transfer; do not treat a remote-only copy as local. | Early delivery |
| Legacy unknown strategy is silently coerced | The new bulk characterization sends `smallest` and receives a queued `priority` rule. | Keep expressible legacy submissions working. Return a distinct upgrade-required response for a rule the final contract cannot express rather than silently weakening it. Unauthorized keys remain dropped. | Stage 3 |

## Controlled mutation evidence

Each mutation was applied locally to production code, exercised through the named test, and then
removed before the next mutation. `shasum -a 256` confirmed every source file returned to its
pre-mutation hash.

| Critical family | Temporary mutation | Test failure observed | Restored hash |
| --- | --- | --- | --- |
| Selected-provider scope | Changed `selected = available.filter(...)` to `selected = available` in `download-selection.ts` | `a source from an addon outside the selected scope is never inspected` failed: the unselected source was probed and selected instead of returning `undefined`. | `3e0e7dbd2ec70b583adaf6b6dd29bf4c653fe28da4fcec79021d659d732e2763` |
| Permission | Changed the route download guard to accept every existing owner without `ownerMayDownload` | `POST /api/downloads refuses an account without the library permission and queues nothing` failed with actual `201` versus expected `403`. | `2d87e5f8965ac213b9d7c81e0226527408a5bfc27d4e06ed926fbbf41124e6d5` |
| Provider identity | Replaced every exported addon manifest URL with one constant in `backup.ts` | `a backup distinguishes same-name providers by URL and omits installation-local addon keys` failed because both providers exported the same URL. | `4b96860d4b2af52c65bc2150510db1a3ac7bc941210c7c1b5266e24914329be3` |

Each named test passed again after restoration. `git diff` contains no production-source change.

## Separate lanes still uncovered

- **Active-source stability** belongs to the interactive Stage 0 lane. It is explicitly uncovered
  here: no assertion claims that playback remains on the current source while late candidates
  arrive.
- Interactive acquisition, shared lookup/cache ownership, catalogue and player fan-out, playback
  position across switches, and the web/TV conformance corpus are separate lanes.
- Remote automatic episode downloads and provider quota/cancellation recovery are Stage 5.
- Android TV parity is a separate consumer lane.

This ledger intentionally claims only the passing background, follow, access and provider-identity
baseline listed above.
