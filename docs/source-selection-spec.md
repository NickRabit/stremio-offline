# Unified source selection and administrator-managed profiles

Status: proposed implementation contract; this PR changes documentation only.
Read [the delivery plan](source-selection-tasks.md) for test-first PR boundaries and gates.

## Outcome and scope

A title has the same eligible sources, provider identities and selection rules in catalogue,
details and player. Continue watching prefers its remembered version; late results never replace
an explicit choice or interrupt playback. Series downloads and follows use the same discovery
and ranking foundations, with download-specific eligibility and verification.

**Only administrators create, edit, duplicate, delete or configure profiles.** Profiles belong
to the instance, not an account. Ordinary users choose an available profile and may remember their
preferred profile IDs. A profile never grants access to a provider, source or destination.

Deliver web/desktop and Android TV consumers, editable profiles, safe migration of existing
rules, and eventually remote-library candidates for future downloads. Deliver these separately;
profile CRUD must not depend on remote automatic downloads being ready.

This work does not migrate favourites, title bindings or progress stores, add household/account
profiles, change native remote history, add arbitrary rule scripts, or redesign playback and
FFmpeg. Coordinate with existing title/progress identity work instead of creating another identity
or migration. The local-only `SOURCE_PARITY_TASK.md` was consulted; do not add it to git.

## Current implementation and demonstrated differences

Baseline inspected: `cebf6fa6` on `main`. Recheck these seams on the implementation branch.

| Responsibility | Existing seam | Difference to protect or deliberately fix |
| --- | --- | --- |
| Provider discovery | `server/src/addons.ts`: `streamCandidates`; `routes/catalog.ts` | Shared addon eligibility, viewer permissions and ordering; no common local/remote provider plan |
| Addon requests | `addons.ts`: `streams` | Upstream failures are logged and flattened to empty arrays |
| Catalogue loading | `web/src/App.tsx`: `fetchSources`, `fetchEpisodeSources` | Independent fan-out; catalogue results arrive incrementally; subtitle lookup can delay addon fan-out |
| Title loading | `web/src/CatalogueTitleDetail.tsx` | Separate fan-out, waits for all; can reuse handed-over rows |
| Other-source panels | `web/src/library-sources.ts`: `useLibrarySources` | Bounded concurrency and group retry, but state is per hook instance |
| Ranking | `web/src/streams.ts`, `server/src/ranking.ts`, `download-selection.ts` | Duplicated language/size parsing; UI priority often uses display names, downloads use addon keys |
| Resume | `CatalogueTitleDetail.tsx`, `LibraryTitleDetail.tsx`, `source-progress.ts` | Remembered source has different precedence across entry points; App catalogue default ignores it |
| Bulk/follow setup | `SeriesDownloadDialog.tsx`, `routes/downloads.ts`, `routes/follows.ts` | Shared dialog and parser; first-episode addon discovery; stored `addonKeys` |
| Automatic resolution | `server/src/index.ts`: `cachedStreams`, `queue.setResolver` | Five-minute cache; requests all allowed suitable addons before applying selected keys |
| Remote copy | `media-server-sources.ts`, `media-server-quota.ts`, `downloads.ts` | Exact-source durable references and guarded original transfers already exist |
| TV | `catalog/Streams.kt`, `ui/catalog/NativeSources.kt`, `CatalogDetailScreen.kt`, `ui/player/LibraryPlaySources.kt` | Independent implementations, ranking port, inconsistent request deadlines |

Existing differences are characterization targets, not all desired behavior. Keep a test ledger
that labels each difference as preserved, deliberately corrected, or deferred. In particular,
local-first ordering depends on sort mode today; do not assert that it is universally fixed.

## Architecture: four small boundaries

### 1. Provider adapters and an acquisition service

A provider is an origin, not a media version. Use typed stable keys:
`addon:<addonKey>`, `remote:<libraryId>`, and `local`. Display names never identify or rank providers.
`local` groups owned copies for ordering; each candidate still carries its real library identity.

The server builds an authorized provider plan for a catalogue subject (type, title/video ID and
resolved episode identity) and operation (`play`, `downloadToLibrary`, `downloadToDevice`).
Adapters discover candidates; they do not choose a winner. Preserve the existing local and remote
matching services, outbound guard, media-resource projection and grant checks.

The plan includes providers with no results and their states: idle, loading, ready (possibly
empty), failed, timed out, cancelled or unavailable. Errors have existing catalogue keys and retry
dispositions. An upstream failure must never become a successful empty response in the new contract.
Do not reveal a forbidden provider, its error, credential, address or stored private name.

Use an additive versioned API contract for provider plans and per-provider outcomes. Keep existing
array endpoints for old clients during migration. A result envelope contains authorized candidate
projections, provider status, safe error information and a plan/configuration revision. Do not add
a long-lived server session or streaming protocol merely to orchestrate a few requests.

Web uses one shared query owner above detail/player components, keyed by account/server epoch,
subject and eligible provider plan. Detail and player subscribe to the same groups. Closing one
subscriber does not cancel another; the last subscriber leaving aborts pending work. Changing
account, server, subject or access/configuration revision drops obsolete answers immediately.
TV uses one equivalent repository, not three independently evolving loaders.

Start with two addon and two remote discovery requests concurrently, retaining separate budgets
so a slow class cannot starve another. Define request budgets in the contract: interactive addon
attempts initially 30 seconds end-to-end with a smaller upstream deadline to leave transport
margin, remote discovery 3 seconds and matching 8 seconds; background addon work may use the
existing configurable 60-second budget. Cancellation reaches the upstream transport. Tests prove
these deliberate differences; a deadline is not hidden inside each screen. Subtitles load
independently and do not block the first source result.

Share in-flight raw results only inside their authorization/configuration scope. Cache per provider
and subject, not a merged list of every addon. Local-library scan revisions invalidate copy listings;
profile edits invalidate ranked views only when the acquisition scope has not changed. Bound both entry count and memory; start with at
most five minutes for successful background addon listings and short-lived interactive reuse.
Do not cache transport failures as empty results. Retry bypasses failed/negative entries. Include
provider configuration generation, relevant metadata language and authorization scope in keys;
invalidate on enable/disable, URL/manifest/credential changes, grant changes and connection
replacement. Recheck rights before and after I/O and before projection/use even on cache hits.
Never cache public session-bound `sourceId` across sessions or persist it in profiles/jobs.

### 2. Normalized facts and pure ranking

Create a small TypeScript workspace (proposed `packages/source-selection`) for public contracts,
normalization and deterministic pure ranking. It must have no DOM, networking, filesystem, store,
secret URL or playback dependencies. Wire NodeNext/server build, Vite, Docker, desktop packaging
and the version consistency script explicitly; adding a workspace must not break release builds.

Keep provider identity, catalogue identity, stable source identity and session resource handles
separate. Preserve the current `stableKey` contract during extraction. A filename-based key can
change with name/size, and a URL-based key can change with a signed address; a missing match is a
normal fallback, not proof that a source was revoked or that two variants are identical.

Normalized candidates contain provider key, opaque stable identity, source kind, capabilities and
facts (languages, bytes, duration, resolution when known), including evidence (`listed`, provider
metadata or verified inspection). Unknown is distinct from zero. Normalize units and language
aliases once; notices and unsupported rows are not playable candidates. Keep authorization and
capability checks in trusted services, not in this pure package.

Ranking is lexicographic over a bounded ordered list of typed criteria, not weighted scores or
executable expressions. Ties use stable provider/source order, never network completion order.
Do not deduplicate across versions just because filenames or display names match. A separate
selector applies resume/current-choice precedence and a separate download verifier performs
inspection. The package returns ordered identities and machine-readable exclusion/ranking reasons;
clients translate them and may show a short explanation without leaking source addresses.

Android cannot import TypeScript. Prefer normalized server facts, and use the same versioned JSON
conformance vectors in TypeScript and Kotlin for the small remaining local rank/selection logic.
Do not introduce a second heuristic parser if the server already supplies the fact.

### 3. Selection intent, independent of ranking

| Intent | Required decision |
| --- | --- |
| Already playing | Keep the actual source; incoming results/profile edits never switch it. Revocation uses existing termination rules. |
| Explicit manual choice or an explicitly supplied initial version | Keep it while authorized; no late automatic replacement. If missing, show unavailable rather than silently launch a different version. |
| Continue watching | After eligible discovery completes or reaches its deadline, use a playable exact saved `stableKey`; otherwise choose the profile winner. Show that a different version was selected. |
| Ordinary detail/default play | Prefer an eligible remembered version when present; otherwise use the profile winner. A preview may update until the user commits a choice. |
| Next episode | Never reuse the previous episode's source ID. Apply the selected profile and episode identity; optional same-provider/nearest-size preference is a named selection policy, subordinate to hard eligibility. |
| Automatic download | Resolve the stored policy, verify candidates and persist one authorized source; no resume preference unless an explicit future product requirement adds it. |

Manual choice may bypass soft ranking only, never rights, capabilities or hard constraints. A
remembered source outside a hard filter is reported as excluded; do not silently relax that filter.
Do not wait indefinitely for the preferred version: the acquisition deadline closes the attempt.
While waiting, rows remain usable for an explicit choice. An empty or failed plan starts no playback.

Progress position continues through the existing title/file/remote ownership helpers. Choosing
another version must not create another title's progress key or reset its position. Protect current
playback, manually selected rows, next-episode identity and late responses with dedicated tests.

### 4. Operation-specific verification and execution

Interactive ranking uses available facts without speculative probes of every source. Background
selection retains audio modes, fallback languages, subtitle requirements, bounded inspection,
tried-source tracking, direct-before-torrent rules and follow grace-window behavior. Share fact
parsing and comparisons, not an assumption that interactive and download winners always match.
A list explains preference; downloading may reject an unverified candidate after inspection.

Exact-source saves continue to save the selected source; applying a profile must not replace it.
Automatic resolution requests only selected, currently authorized providers. Capability filtering
is operation-specific and candidate-specific: playable does not imply downloadable. Local copies
may prevent a redundant download through existing ownership/destination checks, but are not
network download candidates; copying/moving local files remains the library operation workflow.

## Administrator-managed profile contract

Profiles are instance-wide source-selection recipes, distinct from account/household profiles.
Persist them with the existing serialized settings-store transaction model, with a schema version,
opaque ID, revision, name, supported operations and validated policy. Server owns IDs/revisions.
Set initial limits of 50 profiles, 80-character names and eight non-duplicated ordered criteria.
Reject unknown fields, invalid ranges, duplicate keys and unsupported schema/criterion versions.

Destinations, retention and scheduling remain separate action/follow fields, never profile criteria.
Provider/probe budgets are server-owned; profile fields cannot increase them. Cap provider references
at 64 and include schema limits in request validation before allocating work.

A profile contains:

- Provider scope: membership only, `allAvailable` or an explicit selected-key set. Only the
  provider-order criterion defines priority. New providers participate only in `allAvailable`.
  Removed provider references stay dormant for admin repair, never broaden scope.
- Hard constraints: allowed source kinds, audio mode and preferred/fallback languages, subtitle
  policy, optional byte/duration/resolution bounds. A language can explicitly mean the executing
  viewer's preference; resolve that value into each admitted job. No hidden locale dependence.
- Ordered soft criteria: preferred audio tier, provider order, size ascending/descending,
  resolution ascending/descending, and subtitle preference where applicable. Each criterion has
  specified evidence and missing-value handling. Ascending and descending unknown sizes sort last.
- Explicit selection options, such as next-episode continuity; these are not fabricated ranking
  weights and cannot override a running or manual selection.

A bounded fact needed by a hard constraint must be known before automatic acceptance. Downloads
may inspect it within their budget; unknown after verification is ineligible. Interactive UI can
show an unverified/excluded row with its reason, but cannot silently autoplay it. Existing rules
without that constraint keep their old unknown-value behavior.

Seed editable Recommended, Provider priority and Travel templates for new installations. Travel
prefers the chosen audio language and then smaller verified eligible files. Do not invent a
universal minimum file size: shorts, low-bitrate media and feature films differ. Expose optional
minimum duration/bytes, retain existing anti-sample checks, and test sample/trailer rejection and
legitimate short media separately. Show estimated/unknown sizes honestly.

Built-in names use i18n keys until renamed; administrator-authored names are plain data. Every
seeded profile can be renamed, edited, duplicated and deleted. Templates can be restored as new
profiles without overwriting changes. An administrator may delete a referenced/default profile
only after choosing an operation-compatible replacement; a sole usable profile can be replaced
in the same transaction. This maintains at least one usable default per supported operation.

### Normative v1 policy shape

The operation enum is `play | downloadToLibrary | downloadToDevice`; bulk and follows use
`downloadToLibrary`. A provider's eligibility is the intersection of scope, current rights and
operation capabilities. Provider kind and stream kind are different: normalize stream kinds to
`localFile | http | torrent | mediaServerOriginal`, even when legacy DTOs call HTTP streams remote.

```ts
type LanguageRef = { code: string } | { preference: "audio" | "subtitle" };
type SourcePolicyV1 = {
  schemaVersion: 1;
  scope: { mode: "allAvailable" } | { mode: "selected"; providerKeys: string[] };
  constraints: {
    sourceKinds: Array<"localFile" | "http" | "torrent" | "mediaServerOriginal">;
    audio: { mode: "strict" | "listed" | "preferred";
      preferred: LanguageRef; fallback?: LanguageRef };
    subtitles: { mode: "off" | "optional" | "required";
      preferred?: LanguageRef; fallback?: LanguageRef };
    bytes?: { min?: number; max?: number };
    durationSeconds?: { min?: number; max?: number };
    heightPixels?: { min?: number; max?: number };
  };
  criteria: Array<
    | { kind: "audioTier" }
    | { kind: "providerOrder"; keys: string[] }
    | { kind: "size"; direction: "asc" | "desc" }
    | { kind: "resolution"; direction: "asc" | "desc" }
    | { kind: "subtitleTier" }
  >;
  nextEpisode: "profile" | "sameProviderThenNearestSize";
};
```

Each criterion kind occurs at most once. Provider-order keys occur once and are intersected with
scope; absent providers sort after listed ones in stable provider-key order. Selected scope is
nonempty at validation (it may become unavailable later). Source kinds and operations are nonempty
sets. Numeric bounds are finite, nonnegative safe integers with at least one endpoint and min <=
max; duration/height bounds, when supplied, must be positive. Normalize explicit language codes
using the existing language catalogue, reject unsupported preference contexts, require subtitle
language when subtitles are not off, and reject duplicate preferred/fallback languages after
resolution. Missing criteria mean no preference, not a hidden size/provider rule.

Facts carry `listed | providerMetadata | inspected` evidence. `audioTier` and `subtitleTier` compare
preferred, fallback, known-other, unknown, in that order; a higher evidence level does not by itself
outweigh a language tier. Size/resolution compare numeric values in the requested direction, with
unknown last in both directions. Final ties use provider key then stable source identity and stable
provider response index for otherwise indistinguishable rows. No locale-sensitive name sort.

Hard audio/subtitle eligibility and download verification retain the existing mode semantics through
the compatibility evaluator. Strict audio requires inspected tracks or equivalent authoritative
track metadata, not a language inferred from a title; listed/preferred use the existing tested
fallback tiers. v1 conformance vectors must exhaust these tiers before enabling profile submissions.
A hard numeric bound accepts inspected or authoritative provider metadata; text estimates remain
unverified. Unknown facts are excluded from automatic acceptance when the bound applies. Interactive
and download evidence can legitimately differ, but identical facts/policy/context must rank equally.

### Authorization, APIs and user experience

Proposed additive routes: `GET /api/source-profiles`, administrator-only `POST`, `PATCH /:id`,
`DELETE /:id`, plus ordinary preference updates that accept only selected profile IDs.
There is no draft/publish state in v1: saved profiles are available for selection. A public read
returns ID, public profile name, revision, supported operations and an authorized policy projection:
intersect selected membership and provider-order keys with the caller's visible providers, omit
provider-derived labels/counts/errors outside that set, and omit profiles with no authorized
provider path. Offline permitted providers still have a path and remain visible as unavailable.
Profile names are administrator-authored public labels; the editor must state this and must never
autogenerate names from private provider configuration. Use a neutral deleted-profile label,
not an old provider-derived name. Admin editor reads the full configuration. Cache public profile
responses by authorization epoch as well as catalogue revision; test raw JSON/errors after revocation.
Perform admin authorization server-side on every mutation, including duplicate/restore and bulk
updates. Restricted/read-only mode still applies. Never accept a caller-supplied owner/admin flag.

Use expected revisions (If-Match or equivalent) for edits/deletion/default replacement. A stale
write returns a localized conflict and requires reload; it cannot silently overwrite another edit.
Delete, instance-default reassignment and catalogue revision publication are one settings-store
transaction. Personal defaults live in a different store: retain a minimal deleted-ID replacement
map in the profile catalogue so those preferences resolve to the explicitly chosen compatible
replacement without a cross-store rewrite. Validate/flatten replacement chains, forbid cycles, and
clear stale personal IDs on their next preference write. Report the replacement on the next
selection; an explicit submission of a deleted ID fails instead of silently running another policy.
Historical follow/job snapshots never follow that map. Reads of another user's personal defaults
remain forbidden. Export/import validates revisions/schema,
remaps IDs/references, and never restores grants or secrets from profile data.

Admin Settings has a profile list with Add, Edit, Duplicate, Delete and default assignment.
The editor separates mandatory constraints from ordered preferences and shows a safe preview using
fixture/already acquired authorized candidates; editing never triggers unbounded provider probes.
It states the effect on existing follows/jobs before Save or Delete. Use existing dialog shells,
keyboard ordering controls, accessible labels and translations per [UI conventions](ui-conventions.md).

Catalogue/details/player offer the same profile selector. Bulk download and Follow offer only
operation-compatible profiles plus existing destination/scheduling controls. Ordinary users cannot
edit profile criteria or save personal variants; they may choose another profile and manually
choose an eligible source. Allow separate remembered playback/download profile IDs per user, with
instance defaults when unset. Resolve a remembered default (including a deleted-ID replacement)
only if it is operation-compatible and has an authorized provider path, otherwise try the instance
default. If neither qualifies, show a neutral no-usable-profile state and start no lookup/job;
never broaden provider scope to make a default work. A per-view profile change does not silently
overwrite the user's default. TV supports profile selection and the same semantics; the first editor is web/desktop
admin Settings, not a duplicate TV rule editor.

### Profile revisions, follows and queued work

Profiles are templates, not live mutable dependencies of background jobs. A new submission carries
only a profile ID/revision and legitimate operation fields; the server resolves a fresh authorized
policy. For a submitted job it persists a versioned admission snapshot with profile provenance,
effective language preferences and the concrete resolved provider allowlist. A follow instead
stores a policy snapshot retaining its membership mode; provider materialization happens at each
episode admission, as specified below. Ordinary callers cannot forge a snapshot or override criteria.
A stale submission returns a revision conflict rather than running unseen rules.

A follow stores the profile snapshot when configured. Editing/deleting a profile does not silently
rewrite that follow. The owner can explicitly select the latest/another profile in Follow setup;
this updates future admission under the existing follow revision guard. Existing queued/running
jobs retain their admission snapshot. Persist the admission snapshot on each reserved episode
intent/generation before enqueueing, including effective languages, concrete providers and the
grace parameters needed for retries. Waiting/reserved episodes without an active job recover that
snapshot, never the follow's newly configured policy. A digest is sufficient only if its immutable
payload is durably retained. The existing reservation/reconciliation protocol must recover a crash
between intent persistence and queue insertion; do not require a cross-file atomic transaction.
Deletion preserves snapshots and shows a deleted-profile label; it changes defaults for new selections, not historical work. No cross-store cascade is
needed to delete a profile safely.

For `allAvailable`, the follow snapshot retains that scope policy; each future admission resolves
current eligible providers and stores a concrete list in the job. Selected-only follows never
pick up new providers implicitly. Current rights are always intersected at admission, resolution
and transfer; a snapshot never preserves a revoked grant. Grace-window transformations are derived
from the follow/job snapshot and episode dates, not from the current profile catalogue. Retries
retain the admitted policy and existing grace semantics; choosing new rules requires an explicit
reconfigure/requeue action. A profile rename is cosmetic and cannot alter a job's rule digest.

## Remote libraries in future downloads (separate delivery stage)

Discover by the episode's catalogue identity through existing remote matching. No speculative
fallback to another episode, title or fuzzy match below the existing confidence threshold. Selected
providers with no released item remain empty/unavailable; the follow scheduler owns retry timing.

The current `downloadReference()` starts from a session-bound resource. Background resolution
needs a narrowly scoped owner-based entry point that derives `RemoteDownloadReference` from a
fresh manager-authorized original, without a browser session or request-provided reference.
Reuse canonical reference validation, provider account/generation binding and native permission
checks. Persist no expiring source ID or credentials. Never accept raw remote URLs/references
from client input to make this work.

Return a discriminated queue resolution: existing addon source or authorized remote reference.
Feed the latter into existing remote-copy execution, destination ownership, reservation, retry and
cleanup paths. Inspection and transfer both use the guarded provider transport and `OriginalQuota`;
metadata-only discovery does not hold an original-transfer slot. Do not bypass the quota with a
raw ffprobe URL. Reuse trusted track metadata only at the evidence level it proves; missing facts
need bounded guarded inspection or explicit rejection. A busy quota is retryable, not an empty
provider response or permission failure. Abort, denial, failed probe and shutdown release every
slot/body; never hold a probe slot while waiting to acquire a transfer slot.

## Migration and rollout

1. Characterize existing flows before extracting production logic. Preserve `sourceId`, `stableKey`,
   authorization, exact-source saves and progress ownership contracts.
2. Extract compatibility adapters and the pure package, keeping existing behavior per entry point.
   Intentional differences are corrected in separately reviewed commits with regression tests.
3. Introduce versioned provider outcomes and the shared acquisition owners. Old array APIs remain
   compatible; unsupported new capabilities are negotiated, never silently downgraded.
4. Add admin profiles. Existing queued selections/follows remain immutable legacy policy snapshots;
   do not map all users' `largest` or `priority` selections to a new profile that changes filters.
   Preserve exact addon order, language/subtitle modes, target settings, grace and retention.
   Migrate `addonKeys` to selected provider keys idempotently, retaining a legacy-policy version
   until equivalent behavior is proven. Never infer provider identity from a display name.
5. Keep old clients usable through an explicit legacy submission adapter during a documented
   compatibility window. Legacy ad-hoc job settings are not profile CRUD and cannot mutate shared
   profiles. New clients submit profile references. Unsupported rules on older clients produce an
   upgrade-required response, not a weaker rule. Reject unknown future persisted schemas safely.
6. Existing users retain a server-side legacy compatibility mode until they explicitly choose
   a profile. It preserves their stream sort, language and addon order; it is not a user-editable
   shared profile. New installations use instance defaults. New templates are optional explicit
   choices for existing users. Default profile selection and deliberate resume-policy corrections
   are not hidden inside an extraction. Persist migration version/backup and prove restart/idempotency.
7. Deleted IDs are never reused. Retain and flatten replacement mappings while personal/default
   references can exist; no time-based pruning. Settings import publishes remapped profiles and
   old-ID mappings in one catalogue transaction, preserving unaffected account preferences and all
   historical snapshots. Test import failure/restart and rollback; an older binary must refuse an
   unsupported new schema rather than overwrite it. Retain the pre-migration backup for rollback.
8. Add remote automatic candidates after the addon/profile pipeline and its tests are stable.

## Acceptance

- Only an admin can mutate a profile through UI or direct API; users can select it without gaining
  access to hidden providers. Concurrent edits and import cannot bypass this boundary.
- Equal facts/context/policy give equal order on web/server/TV, regardless of response order.
- Detail/player reuse pending or complete groups; errors, empty results and partial success remain
  distinct; retry asks only what failed and never resurrects another account's rows.
- Explicit/current choices survive late results; remembered-source matching and fallback are
  consistent; switching versions preserves the correct title/episode position.
- Background work contacts only its authorized selected providers, retains its policy across
  profile edits/deletion/restart, and observes current permission revocation.
- Remote automatic copies use durable server-created references and existing bounded transfer
  machinery; quota and cancellation tests pass before enabling this provider kind in profiles.
- Every stage satisfies the test and rollout gates in the delivery plan. Runtime-changing PRs
  follow repository build, version, Docker health and final visual-verification requirements.
