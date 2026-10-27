# Source selection: test-first delivery plan

This is the implementation brief for [the architecture and profile contract](source-selection-spec.md).
The current PR is documentation only. Do not start a broad refactor from this document without
first landing the baseline tests below. Each stage is a separate reviewable PR based on current
`main`; rebase and rerun affected checks after intervening merges.

## Delivery dependencies and the first usable slice

Stage numbers name work packages, not one six-stage release train. Keep a shared test/contract
foundation, then deliver the background and interactive paths independently. Parallel delivery
means separate PRs with explicit dependencies, not concurrent unreviewed edits to the same code.

| Deliverable | Hard dependencies | Not a prerequisite |
| --- | --- | --- |
| Fixed download/follow presets (first usable slice) | Stage 0 background/identity/access baseline; Stage 1 server policy contracts and vectors; admission snapshots, selected-provider requests and local-copy policy | Web query owner, new interactive API, Kotlin integration, CRUD editor |
| Admin profile CRUD and download/follow editor | First slice; Stage 3 storage/revision/migration/API tests | Interactive fan-out rewrite, remote automatic downloads |
| Interactive source consistency and profile selection | Stage 0 interactive baseline; Stage 1 shared contracts; Stage 2 acquisition/selection; profile read contract | Remote automatic downloads |
| Remote automatic episode downloads | Stage 0 remote baseline; Stage 1 server contracts; first slice snapshots; owner-based remote resolver/cache/quota work in Stage 5 | Stage 2 web fan-out, playback editor, Kotlin migration, complete profile CRUD UI |
| TV profile parity | Shared conformance corpus; profile API/version negotiation; relevant TV baseline | Remote automatic downloads |

The first slice is a complete web/desktop journey: choose a fixed server-defined Travel or Provider
priority recipe in bulk download/Follow, submit a profile ID/version, persist the admission snapshot,
and download the correct episode through the existing queue. Travel uses the selected/preferred
language, a 480-pixel minimum height and ascending size, with the bounded verification behavior in
the specification. Keep existing legacy selections available without changing their winners.
These are shipped definitions, not ordinary-user-editable presets. Implementing code-defined
presets is an intermediate release, not completion of the requested administrator editor.

Use the final policy schema and profile-reference submission contract from the start; do not add
a temporary `smallest` value to the legacy strategy enum. Fixed IDs/revisions resolve on the server,
not from a client-supplied rule object. On introducing Stage 3 storage, seed those definitions with
the same identities/revisions, preserving explicit choices and snapshots. Only then enable admin
CRUD. Until that transition, a preset change ships as a new definition revision and leaves existing
work unchanged. Do not advertise create/edit/delete before they exist. Preserve these interim
choices in settings export/import before shipping them; a complete CRUD editor is not required.

Test the first slice before wiring it in: request counts for selected providers, forged policy
rejection, fresh authorization, profile/version conflict, old client compatibility, retry/restart,
follow admission/reconfiguration race, local-copy policy (including a remote-only episode), and
Travel's quality/probe-budget cases, including authoritative sample prefiltering and a scheduled
retry that advances past 15 verified samples to a later valid episode. Server-side cache
isolation/invalidation and safe snapshot persistence are required even if Stage 2 has not shipped.
No unrelated interactive or Kotlin rewrite blocks this gate. Each later lane must land its own
applicable Stage 0 coverage before changing production code; no lane may waive relevant tests.

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
| Facts/ranking | Language aliases/flags, bytes and text sizes, unknown vs zero, ties, duplicate provider names, local/remote/addon groups, all sort modes, deterministic arrival permutations, owned copies before addon rows under recommended and by-addon whatever their language, web versus TV tie order under size sorts | L0/L1: `server/src/ranking.test.ts`, `download-selection.test.ts`, `web/src/streams.test.ts`, `library-sources.test.tsx`; Kotlin `StreamsTest` |
| Discovery | Disabled/catalog-only addons, manifest type/ID prefixes, no eligible providers, first episode vs later episode IDs, account order and grants | L0: `addons.test.ts`, `routes/catalog.test.ts`, `routes/addons.test.ts` |
| Acquisition | Slow/fast providers, independent subtitle failure, a slow subtitle addon delaying the first source row, timeout vs empty, partial success, retry only failed group, rapid subject change (addon and local-copy requests of the old title aborted), close/reopen, unmount, two subscribers and last-subscriber cancellation, the number of lookups one title causes across catalogue panel, detail, chooser and player | L1 network mocks and L2 counting fixture; `library-sources.test.tsx`, `CatalogueTitleDetail.test.tsx`, local/remote detail tests |
| Resume/current source | Exact saved match, disappeared/changed key, disallowed saved source, explicit choice vs late better row, current playback not switched, account change, position after source switch, same next-episode identity from each entry point; next episode from an owned copy, an addon row and a remote version, including an owned copy of the next episode while an addon row plays | L1 source/progress helpers, L2 real player; Kotlin catalogue/player tests |
| Automatic jobs | Largest/priority, provider order, audio modes/fallbacks, subtitles, direct vs torrent, inspection cap, tried candidates, selected-provider request counts, no source, retry cache bypass, an addon failure kept out of the five-minute cache, legacy strategy coercion and dropped addon keys on `POST /api/downloads`, bulk versus follow default strategy | L0 `download-selection.test.ts`, queue/resolver fixture integration |
| Follows | New/from/ahead admission, unreleased/ambiguous episode, grace boundary, deleted/disabled owner, schedule revision race, deduplication, retry after restart, selection snapshot and unchanged retention/target; a retry after the grace window and after a follow edit (today both recompute from the current follow); an episode already present in a visible local library (today downloaded again as `(2)`), matching versus inadequate local copies, a remote-only copy, and one present only in a library the owner cannot see | L0 `follows.test.ts`, routes/follows and downloads tests; L2 follow setup |
| Access/cache | Two users and sessions, grant revoked during lookup/inspection/use, provider reconfigured under same key, disabled provider, empty vs error caching, generation change, session source handles never reused | L0 production routes/cache/transport, L2 accounts |
| Remote originals | Canonical match, native download denied, connection replacement, forged reference rejected, probe/transfer quota, busy/cancel/shutdown releasing slots | L0 media-server source/quota/download tests with owned fixtures |
| Exact-source saves | Selected version preserved without re-ranking, download-to-library vs device rights, no local self-download | L0 routes/downloads and L2 source chooser |
| Provider identity | Settings export and import into an empty instance, exporting admin's personal preferences restored to importing admin, other users' preferences absent from backup, re-adding an addon, remote libraries restored under new IDs but disabled without grants or credentials, two addons with the same name, backup versions 1 to 3 still importing | L0 `backup` and settings route tests, media-server store tests |

Use a counting addon/remote fixture with controllable completion barriers, fake clocks and explicit
abort observation. This is new test infrastructure: `e2e/fixtures/addon-server.mjs` returns static
streams and counts only media requests today. Do not use arbitrary sleeps or real configured
providers. Have it return two providers with the same name, changed signed addresses, missing/false
metadata and distinct episode versions. Do not log credentials in request-count evidence.

**Gate:** critical baseline cases applicable to a delivery lane pass on its unrefactored production
path. The ledger identifies defects and approved behavior differences, and an independent review
verifies assertions reach the real boundary. Each extraction needs this gate first; a background
slice need not wait for unrelated UI tests. The overall ledger stays open until every family is covered.

## Early delivery: avoid redundant local-episode downloads

This can land independently after its applicable Stage 0 coverage. Add the explicit local-copy
policy from the specification: `any` or `meetsRequirements`. Only files in this application's local
libraries qualify; Jellyfin/Emby items are remote candidates, never proof of local ownership.
Do not classify every repeat as a bug: replacing a wrong-language or inadequate copy is intentional.
Explicit manual saves remain unchanged; legacy automatic rules retain their old behavior until
explicitly migrated to the new policy. Start new profile-based recipes with `meetsRequirements`.

Test wrong-language/low-quality copies, matching copies, unknown facts and bounded local inspection,
an adequate local file under an HTTP/torrent-only acquisition filter, a file deleted or access
revoked after the initial check, presence in a hidden library, a remote-only
episode, concurrent admissions and a copy appearing while a job waits. Distinguish externally
missing copies from intentional retention cleanup so watched episodes are not downloaded again.

## Stage 1: stable contracts and pure extraction

- Add provider/candidate identity types and normalized facts in a small shared workspace.
- Extract existing parsing/comparators with compatibility adapters; include HTTP/torrent download
  ordering without flattening audio/subtitle verification into a simplistic global score.
- Add portable JSON vectors consumed by TypeScript and Kotlin. Cover a changed display name,
  same-name providers, unknown evidence, deterministic ties, legacy largest/priority policies,
  provider class order with owned copies of unknown language, and the order inside `local`.
- Keep source/progress identity and default selection behavior unchanged in this extraction.
- Wire actual package builds, container copies, desktop packaging and version checks.

**Gate:** baseline tests, policy vectors, workspace build and packaged-runtime smoke checks pass
for consumers changed by this PR. Land the portable corpus with the server implementation; Kotlin
consumers pass it before their own cutover, not before the first background slice. Expectations
are hand-asserted, not generated from the new ranker itself.

## Stage 2: acquisition and selection consistency

This interactive lane is not a prerequisite for background presets or remote jobs. Required shared
server access/cache fixes land as separate prerequisites rather than waiting for every UI consumer.

- Add versioned authorized provider-plan/outcome endpoints; retain legacy array routes.
- Move UI orchestration into one query owner/repository, keeping adapters small.
- Introduce bounded per-provider caches/in-flight sharing and revision invalidation; split subtitle
  work from source discovery; propagate cancellation through the server and from the web catalogue.
- Apply shared query/account concurrency caps with primary versus supplementary priority, not
  multiplied fan-out per subscriber. Compare first-row latency and peak calls against the baseline
  using eight and more addons. Change the TV addon deadline deliberately.
- Add `libraryId` to owned-copy rows and one next-episode rule across provider classes.
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
- Add per-user default profile selection with no criteria editing; include new personal keys in
  `PERSONAL_SETTINGS` and the explicit settings-import `splitSettings` map. Project only authorized
  provider details on reads. Validate compatible profile IDs and server-owned provenance on submissions.
- Seed editable templates; implement replacement on default/last-profile deletion.
- Extend the immutable follow/intent/job snapshot implementation already delivered by the first
  slice to editable profiles and legacy migration; retain the final schema and admission semantics.
  Add editable-profile settings export/import and preserve old clients through the legacy adapter.
- Store the pre-grace base snapshot with jobs and reserved intents; retries recompute from it.
- Materialize viewer/instance provider order and language references at admission; test that later
  preference/order changes do not alter reserved, waiting or queued work.
- Move settings backup to version 4 with opaque portable provider references and a separate
  protected admin mapping section; keep versions 1 to 3. Inspect raw persisted policies for secrets,
  not only their public projections. Build an old-to-new remote connection/library ID map during
  import; it is not returned by the current `prepareMediaServerConfiguration`. Imported remote
  connections and libraries remain disabled. They have no grants or credentials until an admin
  reconnects them.

Add tests **before implementation** for ordinary-user raw POST/PATCH/DELETE/duplicate attempts,
restricted mode, spoofed owner, hidden providers, stale revisions, concurrent delete/edit,
transaction failure/restart, last-profile replacement, import reference collisions and unknown
schemas. Test editing/deleting a profile while jobs run; existing jobs and follow snapshots must
keep their rules. Test explicit follow reconfiguration versus concurrent episode admission, plus
waiting and reserved intents with no job: retries must recover the original admitted snapshot.
Verify export includes only the acting admin's personal defaults, import assigns them to the
importing admin, and profile ID collisions/removal remap or clear every existing user's affected
default in the same transaction.
Cover equal seeded IDs with differing revisions or definitions: retain the local definition,
mint an ID for the imported one, remap live defaults and leave historical snapshots unchanged.
Persist deleted profile IDs as tombstones. Import a backup containing a previously deleted ID:
mint a new ID, preserve the tombstone and historical snapshots, and remap live defaults through
the old-to-new map. Test restart and repeated import. When two definitions share a display name,
verify that the UI distinguishes the imported one without changing either stored name and that
the import summary identifies both.
Inspect raw JSON, errors and rendered labels after revocation for hidden provider keys/names/counts.
Cover empty authorized profile scope, operation changes, a deletion rewriting every affected
personal default in the same transaction, per-user legacy mode and settings import/restart without
dangling defaults or rewriting historical snapshots.

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

Depends on durable admission snapshots, server provider contracts and the relevant remote tests,
not Stage 2 or a complete CRUD editor. Initially a versioned server-defined recipe can select remote
providers; the later admin editor uses the same scope contract without rewriting accepted jobs.

- Extend automatic provider adapters to remote libraries using canonical episode matching.
- Add owner-based authorized durable-reference creation and discriminated resolver results.
- Integrate existing remote-copy execution, native download rights and original-transfer quotas.
- Admit remote providers in download profiles only once this path is implemented end-to-end.

Write fixture integration tests first: mixed addon/remote order, an episode appearing later,
provider temporarily offline, wrong episode/no exact match, Travel probe-budget exhaustion,
scheduled continuation after 15 verified samples and false metadata, source permission removed after
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

All stages are independently reviewable and passing. There is one provider identity contract, one
authoritative fact/ranking definition with TV parity, consistent source choice semantics, shared
acquisition per client, admin-managed profile CRUD, durable snapshots, selected-provider background
resolution, owned copies as a first-class provider and portable provider identity. Old data remains
readable, forbidden sources remain forbidden, and the test ledger demonstrates the invariants rather
than merely counting tests.
