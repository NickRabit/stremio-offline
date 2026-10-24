# Source selection: test-first delivery plan

This is the implementation brief for [the architecture and profile contract](source-selection-spec.md).
The current PR is documentation only. Do not start a broad refactor from this document without
first landing the baseline tests below. Each stage is a separate reviewable PR based on current
`main`; rebase and rerun affected checks after intervening merges.

## Stage 0: characterize and close test gaps before refactoring

First produce a coverage ledger linking each case below to an existing test or a new named test.
Run the baseline and record the commit, commands and failures. Do not claim coverage from file
names alone. Use fixture-backed observable assertions, not snapshots of internal implementation.
Keep production behavior unchanged in this PR; small test seams require explicit review.

Separate current-behavior characterization from desired regressions. A known defect must not be
enshrined as the permanent contract. Record its reproducer and desired outcome, then activate a
failing-before/passing-after regression in the fix PR. No skipped tests count toward the gate.
At least one controlled local mutation per critical family (permission, identity, selected-provider
scope, active-source stability) must make its test fail; remove all mutations before committing.

| Family | Required cases | Layer and existing starting points |
| --- | --- | --- |
| Facts/ranking | Language aliases/flags, bytes and text sizes, unknown vs zero, ties, duplicate provider names, local/remote/addon groups, all sort modes, deterministic arrival permutations | L0/L1: `server/src/ranking.test.ts`, `download-selection.test.ts`, `web/src/streams.test.ts`, `library-sources.test.tsx`; Kotlin `StreamsTest` |
| Discovery | Disabled/catalog-only addons, manifest type/ID prefixes, no eligible providers, first episode vs later episode IDs, account order and grants | L0: `addons.test.ts`, `routes/catalog.test.ts`, `routes/addons.test.ts` |
| Acquisition | Slow/fast providers, independent subtitle failure, timeout vs empty, partial success, retry only failed group, rapid subject change, close/reopen, unmount, two subscribers and last-subscriber cancellation | L1 network mocks and L2 counting fixture; `library-sources.test.tsx`, `CatalogueTitleDetail.test.tsx`, local/remote detail tests |
| Resume/current source | Exact saved match, disappeared/changed key, disallowed saved source, explicit choice vs late better row, current playback not switched, account change, position after source switch, same next-episode identity from each entry point | L1 source/progress helpers, L2 real player; Kotlin catalogue/player tests |
| Automatic jobs | Largest/priority, provider order, audio modes/fallbacks, subtitles, direct vs torrent, inspection cap, tried candidates, selected-provider request counts, no source, retry cache bypass | L0 `download-selection.test.ts`, queue/resolver fixture integration |
| Follows | New/from/ahead admission, unreleased/ambiguous episode, grace boundary, deleted/disabled owner, schedule revision race, deduplication, retry after restart, selection snapshot and unchanged retention/target | L0 `follows.test.ts`, routes/follows and downloads tests; L2 follow setup |
| Access/cache | Two users and sessions, grant revoked during lookup/inspection/use, provider reconfigured under same key, disabled provider, empty vs error caching, generation change, session source handles never reused | L0 production routes/cache/transport, L2 accounts |
| Remote originals | Canonical match, native download denied, connection replacement, forged reference rejected, probe/transfer quota, busy/cancel/shutdown releasing slots | L0 media-server source/quota/download tests with owned fixtures |
| Exact-source saves | Selected version preserved without re-ranking, download-to-library vs device rights, no local self-download | L0 routes/downloads and L2 source chooser |

Use a counting addon/remote fixture with controllable completion barriers, fake clocks and explicit
abort observation. Do not use arbitrary sleeps or real configured providers. Have it return two
providers with the same name, changed signed addresses, missing/false metadata and distinct episode
versions. Do not log credentials in request-count evidence.

**Gate:** critical baseline cases above pass on unrefactored `main`, the ledger identifies defects
and approved behavior differences, and an independent review verifies that assertions reach the
real production boundary. No implementation extraction before this gate.

## Stage 1: stable contracts and pure extraction

- Add provider/candidate identity types and normalized facts in a small shared workspace.
- Extract existing parsing/comparators with compatibility adapters; include HTTP/torrent download
  ordering without flattening audio/subtitle verification into a simplistic global score.
- Add portable JSON vectors consumed by TypeScript and Kotlin. Cover a changed display name,
  same-name providers, unknown evidence, deterministic ties and legacy largest/priority policies.
- Keep source/progress identity and default selection behavior unchanged in this extraction.
- Wire actual package builds, container copies, desktop packaging and version checks.

**Gate:** baseline tests plus cross-runtime vectors, workspace build and packaged-runtime smoke
checks pass. Golden expectations are hand-asserted, not generated from the new ranker itself.

## Stage 2: acquisition and selection consistency

- Add versioned authorized provider-plan/outcome endpoints; retain legacy array routes.
- Move UI orchestration into one query owner/repository, keeping adapters small.
- Introduce bounded per-provider caches/in-flight sharing and revision invalidation; split subtitle
  work from source discovery; propagate cancellation through the server.
- Correct provider identity to keys and selected-provider filtering before outbound requests.
- Apply the specification's explicit/current/resume/default/next policy with clear fallback.
- Migrate catalogue, details and both player panels on web/desktop, then equivalent TV consumers.

**Gate:** counting fixtures prove no duplicate lookup across concurrent detail/player subscriptions,
no call to an excluded provider, bounded concurrency, successful empty vs failed outcomes, and
fresh authorization on cache hits. Player E2E proves advancing time on the original stream while
late candidates arrive, then position preservation after an explicit switch. Keep comparison
requests local/pure; do not double live provider traffic for a shadow rollout.

## Stage 3: administrator profile storage and lifecycle

- Implement schema validation, serialized storage, revisions and admin-only CRUD/duplicate/restore.
- Add per-user default profile selection with no criteria editing; project only authorized provider
  details on reads. Validate compatible profile IDs and server-owned provenance on submissions.
- Seed editable templates; implement replacement on default/last-profile deletion.
- Add immutable policy snapshots for follows/jobs and idempotent legacy migration, including
  settings export/import. Preserve old client payloads through an explicit legacy adapter.

Add tests **before implementation** for ordinary-user raw POST/PATCH/DELETE/duplicate attempts,
restricted mode, spoofed owner, hidden providers, stale revisions, concurrent delete/edit,
transaction failure/restart, last-profile replacement, import reference collisions and unknown
schemas. Test editing/deleting a profile while jobs run; existing jobs and follow snapshots must
keep their rules. Test explicit follow reconfiguration versus concurrent episode admission, plus waiting/reserved
intents with no job: retries must recover the original admitted snapshot. Inspect raw JSON, errors
and rendered labels after revocation for hidden provider keys/names/counts. Cover empty authorized
profile scope, operation changes, deleted-ID replacement chains, per-user legacy mode and settings
import/restart without dangling defaults or rewriting historical snapshots.

**Gate:** API/serialization tests prove only admins mutate profiles, no cross-user leak, no orphaned
default, no retroactive job mutation, no duplicate episode and no migration loss. Profiles are
preferences, not a new authorization mechanism.

## Stage 4: profile editor and consumers

- Add web/desktop admin Settings editor, including Add, Edit, Duplicate, Delete and template restore.
- Provide ordered criteria, hard constraints, missing-value explanations and fixture-backed preview.
- Add a shared selector to catalogue/details/player and bulk/follow setup; TV selects the same
  profiles, with no ordinary-user editor. Preserve scheduling/destination controls.
- Show revision conflict, excluded remembered source, unavailable provider and deleted-profile
  provenance without exposing implementation details in normal controls.

Test admin CRUD and reload, ordinary-user selection and absence of editing controls, profile default
persistence, editing while playback runs, follow update only affecting future admissions, and
keyboard/D-pad selection. Then run functional E2E. Only after it is stable run final viewport,
accessibility and screenshot verification once, per [testing.md](testing.md) and [UI conventions](ui-conventions.md).

**Gate:** admin can add/edit/delete every profile (replacement when required); users can select but
cannot mutate; desktop and TV match web decisions on the conformance corpus. No raw UI strings.

## Stage 5: remote providers for series/future downloads

- Extend automatic provider adapters to remote libraries using canonical episode matching.
- Add owner-based authorized durable-reference creation and discriminated resolver results.
- Integrate existing remote-copy execution, native download rights and original-transfer quotas.
- Admit remote providers in download profiles only once this path is implemented end-to-end.

Write fixture integration tests first: mixed addon/remote order, an episode appearing later,
provider temporarily offline, wrong episode/no confident match, source permission removed after
admission, account/generation replaced, full quota, cancellation during inspection, restart after
reference persistence and target conflict. Verify no raw/session reference accepted from a client,
no transfer before authorization, no leaked quota slot or partial-file publication. Metadata that
cannot prove a hard filter must lead to bounded inspection or rejection, never silent acceptance.

**Gate:** a follow downloads the correct newly available remote episode, preserves its policy,
retries temporary failure, obeys permissions/quota and survives restart without duplicate output.
Local self-download remains excluded; exact-source remote copy still works.

## Verification and review checklist for every implementation PR

- Record changed contracts and deliberate behavior differences in the coverage ledger; run the
  relevant L0/L1/Kotlin tests, `npm test`, `npm run build` and version consistency check.
- Run affected fixture-backed L2 journeys; runtime stages finish with the repository's Docker E2E
  gate, local `docker compose up -d --build`, `docker compose ps`, recent logs and healthy
  `/api/status`. Keep real-provider results separate from fixture evidence.
- Run final visual checks only after functional stabilization, in the required viewport/image
  environment. Use no screenshot changes to hide unexplained behavior differences.
- For state, network and authorization changes, require an independent adversarial review covering
  actor/resource, concurrency, crash boundaries, replay, stale reads, secrets and cleanup per
  [CONTRIBUTING.md](../CONTRIBUTING.md). Resolve findings with regressions.
- Use patch bumps only for shipping changes, synchronized across all release workspaces. This
  documentation PR needs no bump or runtime deployment.
- Fetch/rebase on current main before opening/merging and rerun affected gates. Leave PRs unmerged
  until explicitly authorized; no stage bypasses pending/failing required checks.

## Definition of complete delivery

All stages are independently reviewable and passing. There is one provider identity contract,
one authoritative fact/ranking definition with TV parity, consistent source choice semantics,
shared acquisition per client, admin-managed profile CRUD, durable snapshots and selected-provider
background resolution. Old data remains readable, forbidden sources remain forbidden, and the
test ledger demonstrates the invariants rather than merely counting tests.
