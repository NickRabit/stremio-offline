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
profile CRUD must not depend on remote automatic downloads being ready. The delivery plan separates
a first usable background-preset slice from interactive acquisition and the full admin editor.

This work does not migrate favourites, title bindings or progress stores, add household/account
profiles, change native remote history, add arbitrary rule scripts, or redesign playback and
FFmpeg. Coordinate with existing title/progress identity work instead of creating another identity
or migration. `SOURCE_PARITY_TASK.md` (one title, one favourite, one position, one "next") was
consulted. It describes itself as an untracked working note but was committed in #438
and is missing from `.gitignore`; removing it is separate housekeeping, not part of this work.

## Current implementation and demonstrated differences

Baseline inspected: `cebf6fa6` on `main`. Recheck these seams on the implementation branch.

| Responsibility | Existing seam | Difference to protect or deliberately fix |
| --- | --- | --- |
| Provider discovery | `server/src/addons.ts`: `streamCandidates`; `routes/catalog.ts` | Shared addon eligibility, viewer permissions and ordering; no common local/remote provider plan |
| Addon requests | `addons.ts`: `streams` | Upstream failures are logged and flattened to empty arrays. Interactive `GET /api/streams` has no cache: every client lookup reaches the addon |
| Catalogue loading | `web/src/App.tsx`: `fetchSources`, `fetchEpisodeSources` | Independent fan-out asking every addon at once; results arrive incrementally; the addon fan-out starts only after `api.subtitles` answers (`Promise.all`); addon and local-copy requests carry no abort signal, so a left title keeps its requests running until their deadline |
| Title loading | `web/src/CatalogueTitleDetail.tsx` | Separate fan-out, waits for all; can reuse handed-over rows; always ranks `recommended`, ignoring the viewer's `streamSort` |
| Other-source panels | `web/src/library-sources.ts`: `useLibrarySources` | Bounded concurrency (two addon, two remote, one local) and group retry, but state is per hook instance. Five instances exist (catalogue detail, player, second player, local and remote library details); with the catalogue panel, one title can be asked of every addon up to four times, with no cache in between |
| Ranking | `web/src/streams.ts`, `server/src/ranking.ts`, `download-selection.ts` | Duplicated language/size parsing (identical copies today, so drift is the risk); UI priority uses display names, downloads use addon keys; the legacy no-selection resolver uses instance addon order, not the owner's `addonOrder`; web and TV feed size sorts in different input orders, so ties resolve differently |
| Resume | `CatalogueTitleDetail.tsx`, `LibraryTitleDetail.tsx`, `source-progress.ts` | Remembered source has different precedence across entry points; App catalogue default ignores it |
| Bulk/follow setup | `SeriesDownloadDialog.tsx`, `routes/downloads.ts`, `routes/follows.ts` | Shared dialog and parser; first-episode addon discovery; stored `addonKeys`; bulk defaults to `largest`, follow to `priority`; `POST /api/downloads` coerces an unknown `sourceStrategy` to `priority` and silently drops unknown or disallowed addon keys |
| Automatic resolution | `server/src/index.ts`: `cachedStreams`, `queue.setResolver` | Five-minute cache of the merged list, flattened failures included, so an addon that failed once stays absent for that episode for five minutes; requests all allowed suitable addons before applying selected keys; only addon candidates are considered |
| Local copies | `server/src/local-sources.ts`: `localCopies`; `GET /api/local-streams` | A binding lookup, not a provider query: files bound to the catalogue title, in library order then size descending, at most 20, visible libraries only, read from the last library walk. Rows carry `localPath` and `libraryName` but no `libraryId`. No audio, resolution or duration facts are stored, and download names carry no language, so most owned copies have unknown language |
| Next episode | `App.tsx`: `playNextCatalogEpisode`, `playNextDetailEpisode`, `playLocal` | Three disjoint rules: an owned copy continues with the next file in its folder; an addon source picks from addon rows only (the next episode's owned copy is loaded but never chosen); a remote source stays on the same library and version name or stops |
| Episode ownership | `downloads.ts`: `addPending`, `admitDirect` | Lazy episode jobs deduplicate only against active jobs and explicit saves only by source; nothing checks whether the episode already exists in a library, so a follow downloads it again under a `(2)` name |
| Follow retries | `follows.ts`: `effectiveSelection`, `queue.retry` | Admission stores the grace-adjusted selection in the job; a reserved episode stores none; every retry recomputes the selection from the follow's current configuration and the current time |
| Settings backup | `backup.ts`, `media-server-store.ts`, `routes/settings.ts` | Version 3 carries addon manifest URLs and the exporting admin's personal preferences, but no addon keys, other users' preferences or follows; import restores those preferences to the importing admin. Remote configuration restore always mints new connection and library IDs and installs disabled libraries without grants or credentials |
| Remote copy | `media-server-sources.ts`, `media-server-quota.ts`, `downloads.ts` | Exact-source durable references and guarded original transfers already exist |
| TV | `catalog/Streams.kt`, `ui/catalog/NativeSources.kt`, `CatalogDetailScreen.kt`, `ui/player/LibraryPlaySources.kt` | Independent implementations, ranking port, inconsistent request deadlines: 8 seconds per addon on TV against 30 seconds on the web client and 60 on the server, so a slow addon appears on the web but not on TV |

Existing differences are characterization targets, not all desired behavior. Keep a test ledger
that labels each difference as preserved, deliberately corrected, or deferred. In particular,
local-first ordering depends on sort mode today; do not assert that it is universally fixed.

## Architecture: four small boundaries

### 1. Provider adapters and an acquisition service

A provider is an origin, not a media version. Use typed stable keys:
`addon:<addonKey>`, `remote:<libraryId>`, and `local`. Display names never identify or rank providers.
`local` groups files in this application's local libraries for ordering; each candidate still
carries its real library identity. Jellyfin and Emby libraries are always `remote:` providers, never
local copies, even on the same machine or LAN. No source class has unconditional priority: a
profile may put remote/local libraries after addons, move class/order criteria later, or omit them.
Local-first is a template/compatibility choice, not an invariant of the acquisition service.

Provider keys are installation-local. Addon keys are `randomUUID()` values, re-adding an addon
mints a new one, and backup version 3 carries manifest URLs but no addon keys. Import into an
existing instance preserves a key when manifest ID and URL both match (`routes/settings.ts`);
empty-instance imports and remove/re-add cannot rely on that. Remote import always mints new
connection and library IDs (`prepareMediaServerConfiguration`), with disabled libraries, no grants
and no restored credentials. Do not promise that a key or addon-derived `stableKey`
survives these operations unchanged.

Backup version 4 introduces an opaque portable provider reference and an admin-only provider
mapping section. Profiles and follow/job policy snapshots store only that opaque reference beside
the installation key, never a manifest URL, credential or expiring source handle. The protected
provider configuration/mapping resolves it to manifest identity/configuration for addons, or
connection/upstream-library identity for remote libraries. Credential-bearing restore descriptors
belong only to protected provider configuration and the explicit admin backup, not to profiles,
policy snapshots, normal reads, errors or logs. Public DTOs omit private mapping records entirely.
Test raw persisted profile/follow/admission policies as well as public DTOs for token/URL leakage.

Version 4 import must build and expose an old-to-new remote connection/library ID map while
installing the new disabled records; the current `prepareMediaServerConfiguration` keeps only a
connection map internally and returns no mapping. Profile references use that map and the portable
provider mapping, never display names. Imported remote references remain dormant until an admin
restores credentials, grants and enabled state; ambiguous or unresolved references are reported
safely. Backups 1 to 3 still import. The
admin repair flow can explicitly rebind a portable reference after reinstall; nothing rebinds
silently, changes historical job policy or preserves a revoked grant. An admitted job whose old
binding is unusable requires revalidation/requeue under current permissions. Historical snapshots
are immutable; a remapped live profile or future follow configuration is a distinct operation.

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

Concurrency has a shared request owner and explicit consumer priorities. Characterize today's
all-at-once primary fan-out separately from the two-addon/two-remote/one-local other-source limits.
Do not multiply those budgets for subscribers to the same query. A primary subscriber may raise
that query's scheduling priority within a server-owned cap, but cannot bypass the cap or duplicate
in-flight requests. Deadlines bound duration, not concurrency. Start with a bounded interactive cap
of eight addon and two remote requests per account, with fair scheduling across subjects and a
separate background budget; keep a lower two-addon budget for supplementary-only queries.
Fixture tests with eight and more addons measure first-row latency and peak concurrency before
choosing the final cap. Record an intentional latency tradeoff rather than promising unrestricted
fan-out and bounded concurrency simultaneously. Separate class budgets prevent starvation. Define request budgets in the contract:
interactive addon attempts initially 30 seconds end-to-end with a smaller upstream deadline to leave
transport margin, remote discovery 3 seconds and matching 8 seconds; background addon work may use
the existing configurable 60-second budget. TV cuts each addon at 8 seconds today; adopting the
contract budget there is a deliberate, tested behavior change. Cancellation reaches the upstream
transport; today the web catalogue sends addon and local-copy requests without an abort signal.
Tests prove these deliberate differences; a deadline is not hidden inside each screen. Subtitles
load independently and do not block the first source result.

Share in-flight raw results only inside their authorization/configuration scope. Cache per provider
and subject, not a merged list of every addon. Local-library scan revisions invalidate copy listings;
profile edits invalidate ranked views only when the acquisition scope has not changed. Bound both entry count and memory; start with at
most five minutes for successful background addon listings and short-lived interactive reuse.
Do not cache transport failures as empty results; today the background cache stores the
flattened merged list, failures included. Retry bypasses failed/negative entries. Include
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
metadata or verified inspection). Nothing parses resolution from listings today, and media-server
versions report size, duration, bitrate and container but neither audio languages nor resolution, so
in v1 resolution is known only after inspection. Unknown is distinct from zero. Normalize units and
language aliases once; notices and unsupported rows are not playable candidates. Keep authorization
and capability checks in trusted services, not in this pure package.

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
| Next episode | Never reuse the previous episode's source ID. Apply the selected profile and episode identity; optional same-provider/nearest-size preference is a named selection policy, subordinate to hard eligibility. One rule spans provider classes: owned copies, addon rows and remote versions of the next episode are all candidates. Coordinate the file-versus-title "next" with the title identity work. |
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
Automatic resolution requests only selected, currently authorized providers. Capability filtering is
operation-specific and candidate-specific: playable does not imply downloadable. Local copies are
not network download candidates; copying/moving local files remains the library operation workflow.
No existing check prevents a redundant episode download: see [Local libraries](#local-libraries).

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
  provider-class and provider-order criteria define priority. New providers participate only in
  `allAvailable`. Removed provider references stay dormant for admin repair, never broaden scope.
- Hard constraints: allowed source kinds, audio mode and preferred/fallback languages, subtitle
  policy, optional byte/duration/resolution bounds. A language can explicitly mean the executing
  viewer's preference; resolve that value into each admitted job. No hidden locale dependence.
- Ordered soft criteria: provider class (owned copy, remote library, addon), preferred audio tier,
  provider order, size ascending/descending, resolution ascending/descending, and subtitle
  preference where applicable. Each criterion has specified evidence and missing-value handling.
  Ascending and descending unknown sizes sort last.
- Explicit selection options, such as next-episode continuity; these are not fabricated ranking
  weights and cannot override a running or manual selection.

A bounded fact needed by a hard constraint must be known before automatic acceptance. Downloads
may inspect it within their budget; unknown after verification is ineligible. Interactive UI can
show an unverified/excluded row with its reason, but cannot silently autoplay it. Existing rules
without that constraint keep their old unknown-value behavior. Owned copies carry no stored audio
or resolution facts, so a hard audio or resolution bound would stop them from autoplaying. Before a
play profile ships with such a bound, inspect owned files into a bounded cache keyed by library
generation, path, size and modification time (without remote quota), and leave an unverified
candidate ineligible for automatic choice. v1 has no exemption field;
do not silently relax a hard bound for a local copy.

Seed editable Recommended, Provider priority and Travel templates for new installations. Recommended
reproduces today's unfiltered order: `providerClass` (`local`, `remote`, `addon`), then `audioTier`,
then `providerOrder` from the viewer, then size descending. Class comes first because today language
and provider priority rank addon rows only; a language-first template would put an owned copy, whose
language is usually unknown, below every addon row in the preferred language. Conformance vectors
pin today's order and label any remaining difference in the ledger, for example an owned copy whose
filename names a language. Provider priority is `providerClass`, `providerOrder`, `audioTier`, size
descending. These are editable template choices, not compulsory class priorities. Travel prefers
the chosen audio language and then smaller verified eligible files, with `heightPixels.min = 480`
as an explicit initial template value. Admins can change/remove it or clone a 720p variant once
CRUD ships. A high-resolution sample still needs duration/content checks; resolution alone cannot
identify it. Do not invent a universal
minimum file size: shorts, low-bitrate media and feature films differ. Expose
optional minimum duration/bytes, retain existing anti-sample checks, and test sample/trailer
rejection and legitimate short media separately. Show estimated/unknown sizes honestly.

Built-in names use i18n keys until renamed; administrator-authored names are plain data. Every
seeded profile can be renamed, edited, duplicated and deleted. Templates can be restored as new
profiles without overwriting changes. An administrator may delete a referenced/default profile
only after choosing an operation-compatible replacement; a sole usable profile can be replaced
in the same transaction. This maintains at least one usable default per supported operation.

### Travel and bounded candidate verification

Apply already proven hard exclusions before spending a probe, including authoritative duration,
sample/trailer flags and configured minimum bytes when available. Provider metadata must be
authoritative for that fact; a title containing `720p` is only a hint, never proof that a hard height
bound passes. Unknown quality/duration needs bounded guarded inspection, not an implicit pass or
unlimited scanning. Use byte estimates to choose a probe order, and verified facts for final hard
acceptance. Preserve the existing anti-sample checks; the height floor complements them. Order
unknown candidates by estimated bytes only after those exclusions. Do not infer a universal size
floor from duration; low-bitrate episodes and legitimate shorts must remain eligible.

Keep a server-owned attempt budget, initially the existing 15 actual candidate probes, plus
existing time/transfer limits. Every probe counts, including failed requests, samples and rejected
quality. Metadata-only rejection does not count as a probe. In new resolution outcomes distinguish
`noMatch` (eligible search exhausted), `budgetExhausted` (unexamined candidates remain), temporary
provider failure and access denial. Never promise that the smallest file in the entire provider
catalogue was examined; Travel returns the best verified eligible choice found within its budget.
If budget exhaustion leaves a valid verified candidate, it can be selected with an incomplete-search
diagnostic. Without one, keep the job/follow in a retryable waiting/attention state, not a false
permanent no-source state. Existing scheduler backoff/attempt ceilings govern automatic retry; do
not start another immediate batch to evade the budget. Remember rejected source evidence briefly
under source/configuration identity and carry a bounded continuation cursor across scheduled retries.
Use an info hash plus file index for torrent identity, or a provider-scoped filename, size and
name when those are present. A URL-only row has no durable identity: continue by its provider
response position and unchanged non-address facts, but do not persist its rejection as a reusable
blacklist. Wrap and recheck such rows on later attempts. A changed signed URL alone must not reset
the cursor; changed provider facts or scope must reset it. This positional fallback can delay a
new row at the same position by one bounded pass, so it must never mark that row permanently tried.
After 15 verified samples, the next scheduled attempt must reach later candidates rather than probe
the same 15 again. Reset the cursor on changed provider facts/configuration; explicit retry bypasses
cached failures but may keep the cursor over still-valid verified rejections. Never let a transient
transport error become a durable blacklist or skip an unexamined candidate indefinitely.

Required fixtures include: 15 verified samples followed by a valid episode, including changed
signed URLs between attempts; 15 failed/unknown sources; low-resolution rows rejected from
authoritative metadata without probing; a high-resolution
short sample; a false `720p` title; valid 480p and sub-480p content; and a successful match within the
budget. Assert bounded calls, honest outcomes, no weakening of audio/subtitle constraints, retry
backoff and no starvation of interactive work. A resolution floor alone does not solve probe-budget
exhaustion, and no test should claim otherwise.

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
    | { kind: "providerClass"; order: Array<"local" | "remote" | "addon"> }
    | { kind: "audioTier" }
    | { kind: "providerOrder"; keys: string[] }
    | { kind: "providerOrder"; from: "viewer" }
    | { kind: "size"; direction: "asc" | "desc" }
    | { kind: "resolution"; direction: "asc" | "desc" }
    | { kind: "subtitleTier" }
  >;
  nextEpisode: "profile" | "sameProviderThenNearestSize";
  existingLocalCopy: "any" | "meetsRequirements";
};
```

Each criterion kind occurs at most once. `providerClass` lists each class once. Provider-order keys
occur once and are intersected with scope; absent providers sort after listed ones in the
instance's configured provider order, as today's `addonOrder` does ("missing ones sort after, in
the global order"), never by key string, which is a random identifier. `from: "viewer"` uses the
executing viewer's own provider order, today's per-user `addonOrder` extended with `local` and
`remote:` keys, so an instance-wide profile can still respect personal order. Selected scope is
nonempty at validation (it may become unavailable later). Source kinds and operations are nonempty
sets. Numeric bounds are finite, nonnegative safe integers with at least one endpoint and min <=
max; duration/height bounds, when supplied, must be positive. Normalize explicit language codes
using the existing language catalogue, reject unsupported preference contexts, require subtitle
language when subtitles are not off, and reject duplicate preferred/fallback languages after
resolution. Missing criteria mean no preference, not a hidden size/provider rule.

Facts carry `listed | providerMetadata | inspected` evidence. `audioTier` and `subtitleTier` compare
preferred, fallback, known-other, unknown, in that order; a higher evidence level does not by itself
outweigh a language tier. Size/resolution compare numeric values in the requested direction, with
unknown last in both directions. Final ties use the configured provider order, then stable source
identity and the stable provider response index for otherwise indistinguishable rows. Within
`local`, the stable source order is the one `localCopies` returns (library order, then size). No
locale-sensitive name sort.

Hard audio/subtitle eligibility and download verification retain the existing mode semantics through
the compatibility evaluator. Strict audio requires inspected tracks or equivalent authoritative
track metadata, not a language inferred from a title; listed/preferred use the existing tested
fallback tiers. v1 conformance vectors must exhaust these tiers before enabling profile submissions.
A hard numeric bound accepts inspected or authoritative provider metadata; text estimates remain
unverified. Unknown facts are excluded from automatic acceptance when the bound applies. Interactive
and download evidence can legitimately differ, but identical facts/policy/context must rank equally.

### Authorization, APIs and user experience

Proposed additive routes: `GET /api/source-profiles`, administrator-only `POST`, `PATCH /:id`,
`DELETE /:id`. Remembered profile IDs are personal settings, described below.
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
updates. Admin checks are written per route today (`role === "admin"`, no shared helper), so every
new mutation route gets its own check and its own test. Restricted mode is deny-by-default
(`ALLOWED_MUTATIONS` in `server/src/restricted.ts`): new admin routes stay denied there, remembering
a profile goes through `PATCH /api/settings`, which restricted mode already refuses, and choosing
a profile for one view writes nothing. Never accept a caller-supplied owner/admin flag.

Use expected revisions (If-Match or equivalent) for edits/deletion/default replacement. A stale
write returns a localized conflict and requires reload; it cannot silently overwrite another edit.
Delete, instance-default reassignment and catalogue revision publication are one settings-store
transaction. Personal defaults are `UserData.prefs` in the same state file, written by the same
serialized `store.update`, so that transaction also rewrites every personal default that named the
deleted profile to the explicitly chosen compatible replacement; no deleted-ID replacement map is
needed. Store remembered profile IDs as `PERSONAL_SETTINGS` keys and add them to the explicit
`splitSettings` mapping in `routes/settings.ts`. This gives them the existing `PATCH /api/settings`
validation and restricted-mode rule. Settings export carries only the exporting admin's personal
defaults; import restores that one set to the importing admin. Other users' preferences remain in
the instance and must be reconciled in the import transaction. Report a deletion replacement on
the next selection; an explicit submission of a deleted ID fails instead of silently running
another policy.
Historical follow/job snapshots are never rewritten. Reads of another user's personal defaults
remain forbidden. Export/import validates revisions/schema,
remaps provider references through their portable identity, and never restores grants or secrets
from profile data.

Admin Settings has a profile list with Add, Edit, Duplicate, Delete and default assignment.
The editor separates mandatory constraints from ordered preferences and shows a safe preview using
fixture/already acquired authorized candidates; editing never triggers unbounded provider probes.
It states the effect on existing follows/jobs before Save or Delete. Use existing dialog shells,
keyboard ordering controls, accessible labels and translations per [UI conventions](ui-conventions.md).

Catalogue/details/player offer the same profile selector. Bulk download and Follow offer only
operation-compatible profiles plus existing destination/scheduling controls. Ordinary users cannot
edit profile criteria or save personal variants; they may choose another profile and manually choose
an eligible source. Allow separate remembered playback/download profile IDs per user, with instance
defaults when unset. Resolve a remembered default (including one rewritten after a deletion) only if
it is operation-compatible and has an authorized provider path, otherwise try the instance default.
If neither qualifies, show a neutral no-usable-profile state and start no lookup/job; never broaden
provider scope to make a default work. A per-view profile change does not silently overwrite the
user's default. TV supports profile selection and the same semantics; the first editor is
web/desktop admin Settings, not a duplicate TV rule editor.

### Profile revisions, follows and queued work

Profiles are templates, not live mutable dependencies of background jobs. A new submission carries
only a profile ID/revision and legitimate operation fields; the server resolves a fresh authorized
policy. For a submitted job it persists a versioned admission snapshot with profile provenance,
effective language preferences, the concrete resolved provider allowlist and all provider-order
criteria/tie-break order materialized from the viewer and instance configuration. No admitted
snapshot retains `from: "viewer"` or an implicit mutable instance-order dependency. A follow instead
stores a policy snapshot retaining its membership mode; provider materialization happens at each
episode admission, as specified below. A profile/follow may retain symbolic viewer preferences
until admission; each reserved episode/job freezes them, including fallback provider order.
Current access checks can remove a provider later, but cannot reorder the remaining frozen list.
Ordinary callers cannot forge a snapshot or override criteria.
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
current eligible providers and stores a concrete list in the job. Selected-only follows never pick
up new providers implicitly. Current rights are always intersected at admission, resolution and
transfer; a snapshot never preserves a revoked grant. Grace-window transformations are derived from
the follow/job snapshot and episode dates, not from the current profile catalogue. Today every retry
recomputes the selection from the follow's current configuration and the current time
(`effectiveSelection` in `follows.ts`). That restores the saved rules once the grace window closes,
but it also applies later follow edits to jobs already queued. Keep the first and correct the
second: store the pre-grace base snapshot and the grace parameters with the job and the reserved
intent, and recompute the effective selection from that snapshot and the current time on every
retry. Choosing new rules requires an explicit reconfigure/requeue action. A profile rename is
cosmetic and cannot alter a job's rule digest.

## Download rules (what administrators edit)

Administrators edit one rule type, `DownloadRules` in `server/src/download-rules.ts`, which
`rulesPolicy` turns into a `SourcePolicyV1` per media kind. The editor groups it as Sources
(addons, addon order, torrents), Quality and size (resolution range, size range, skip cinema
copies), Language (audio, subtitles) and an ordered preference list.

- **Audio** is `any`, `prefer` or `only`, for the viewer's own language (`"mine"`, resolved at
  admission) or a chosen language code. `any` is encoded as a preferred audio constraint with no
  `audioTier` criterion, so language neither filters nor ranks; `rulesAudioMode(policy)` reads the
  mode back. A fallback language and the Follow wait for audio exist only for `prefer`.
- **Size** is a range per episode and per film, judged on the listed size only: a known size
  outside the range excludes the offer, an unknown size passes.
- **Resolution** compares classes, not raw pixel height. A probed video is classed by
  `videoResolutionClass` (`server/src/video-resolution.ts`), which also looks at width, so a
  1920x800 film is 1080p. Listing tags such as `1080p` are already classes.
- Stored v1 rules (`maxSizeGb`, audio without a language) still parse and are normalised to v2,
  so saved profiles, backups and frozen follow and queue snapshots keep working.

## Local libraries

Owned local files are a provider class of their own, not an addon. They have no addon manifest,
role, addon grants or addon download settings; local-library visibility grants still apply. An addon
record would leak into `allowedAddons`, `streamCandidates`, the addon APIs and the settings backup. In v1 they are one provider key, `local`, shown as a virtual
row in the provider catalogue that cannot be deleted as an installed addon. An admin may exclude
it from a profile scope, move it after other providers, or omit provider/class priority criteria.
Keys per library (`local:<libraryId>`) are deferred until ranking one library above another is a real requirement; until then the order
inside `local` stays the library order, then size, exactly as `localCopies` returns it.

- **Discovery** stays the binding lookup in `localCopies`: the files bound to the catalogue title,
  in visible libraries only. A library scan revision invalidates the listing. The listing gains an
  additive `libraryId` field beside `localPath` and `libraryName`, so a candidate carries its real
  library identity as the provider contract requires.
- **Default position** is first, then remote libraries, then addons. That is today's order for the
  unfiltered recommended and by-addon lists; size sorts mix classes today, and a template keeps or
  changes that explicitly.
- **Facts** are size and file name only. Language comes from the name, and app-downloaded names
  carry none. See the hard-constraint rule above before a play profile uses audio or resolution
  bounds.
- **Next episode** follows the one cross-class rule of the selection intent table. An owned copy of
  the next episode is a candidate even when an addon row is playing, and continuing from an owned
  copy can reach an addon row when no copy of the next episode exists.
- **Local ownership before download.** `existingLocalCopy` applies only to automatic
  `downloadToLibrary` admission/execution. It never removes playback candidates or redirects an
  exact-source save. Only accessible files in this application's local libraries
  count. A Jellyfin/Emby copy does not suppress a download; it remains a remote source candidate.
  This check answers whether the requested local result already exists, not which transport to
  download from. `scope` and `constraints.sourceKinds` govern acquisition/selection candidates;
  `existingLocalCopy` independently governs reuse of an already downloaded file. Neither can
  waive visibility or content requirements. The administrator configures `existingLocalCopy`:
  - `any`: any accessible, present bound local copy of that exact episode satisfies ownership.
  - `meetsRequirements`: the local copy must meet the policy's content requirements (audio,
    subtitles and numeric quality/size bounds) with sufficient evidence. Provider membership,
    source kind and download capability do not apply to this check: an addon-only acquisition
    scope can still avoid downloading an adequate local copy. Soft ranking does not require an
    upgrade merely because another candidate would rank better. In particular, an `http`/`torrent`
  source-kind filter still permits an adequate local file to satisfy ownership: it constrains the
  acquisition transport, not the resulting file. Test that case explicitly; excluding `localFile`
  from playback selection and finding an existing adequate download are different operations.
  New profile-based recipes default to `meetsRequirements`. Legacy rules retain their current
  behavior until explicitly migrated, rather than gaining a silent skip. Unknown required facts
  trigger bounded local inspection; if unresolved, defer with an actionable reason, without falsely
  marking the episode present or automatically creating a duplicate. Inspection is authorized and
  bounded like other work; it is not free merely because the path is local. An explicit manual save
  remains independent of this automatic policy.
- **Presence lifecycle and races.** Record a distinct `presentLocally` outcome with private local
  identity and the evidence/scan revision used, not a fabricated completed download. Recheck visible
  presence before admission and immediately before transfer; serialize same-owner/episode admission
  through the queue's reservation discipline. A bound copy appearing while a job waits can satisfy
  it. A stale scan alone cannot prove that a file still exists: verify current file identity/access.
  On a relevant scan, binding or permission change, re-evaluate the marker and normal follow
  eligibility. If an unwatched eligible episode loses its qualifying copy, it may be admitted again.
  Preserve watched/retention and explicit skip decisions: intentional retention cleanup must not
  trigger a redownload loop. An externally owned file is never deleted by follow retention simply
  because it satisfied presence. Do not expose hidden paths, libraries or markers in public DTOs.

## Remote libraries in future downloads (separate delivery stage)

Discover by the episode's catalogue identity through existing remote matching. That matching is
exact today (`remoteIdsMatch`: every IMDb, TMDB or TVDB ID present on both sides must agree,
with at least one shared ID, plus season and episode; files spanning several episodes are excluded).
Keep it exact and add no fuzzy fallback to another episode or title. Catalogue IDs in other
schemes never match. Selected providers with no released item remain
empty/unavailable; the follow scheduler owns retry timing.

The current `downloadReference()` starts from a session-bound resource. Background resolution
needs a narrowly scoped owner-based entry point that derives `RemoteDownloadReference` from a
fresh manager-authorized original, without a browser session or request-provided reference.
Reuse canonical reference validation, provider account/generation binding and native permission
checks. Persist no expiring source ID or credentials. Never accept raw remote URLs/references
from client input to make this work.

Return a discriminated queue resolution: existing addon source or authorized remote reference. Feed
the latter into existing remote-copy execution, destination ownership, reservation, retry and
cleanup paths. Inspection and transfer both use the guarded provider transport and `OriginalQuota`;
metadata-only discovery does not hold an original-transfer slot. Do not bypass the quota with a raw
ffprobe URL. Reuse trusted track metadata only at the evidence level it proves (media-server
versions report size, duration, bitrate and container, not audio languages or resolution); missing
facts need bounded guarded inspection or explicit rejection. A busy quota is retryable, not an empty
provider response or permission failure. Abort, denial, failed probe and shutdown release every
slot/body; never hold a probe slot while waiting to acquire a transfer slot. `OriginalQuota` counts
holds per source and checks the stream limit only on a source's first hold, so this applies across
different sources; a probe and a transfer of the same source share one slot count.

## Migration and rollout

These are compatibility steps, not one serial UI release train. The [delivery dependencies](source-selection-tasks.md#delivery-dependencies-and-the-first-usable-slice) allow fixed background
presets before the interactive rewrite and editor, and remote automation after background
authorization/snapshots are stable. Administrator CRUD remains a required later deliverable.

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
   This changes today's behavior: `POST /api/downloads` coerces an unknown `sourceStrategy` to
   `priority`. A legacy payload the contract can express keeps working; one it cannot express gets
   a distinct upgrade-required error with a message key. Dropping addon keys the caller may not use
   stays (it is an access rule), and an empty result keeps `err.missingDownloadSources`.
6. Existing users retain a server-side legacy compatibility mode until they explicitly choose
   a profile. It preserves their stream sort, language and addon order; it is not a user-editable
   shared profile. New installations use instance defaults. New templates are optional explicit
   choices for existing users. Default profile selection and deliberate resume-policy corrections
   are not hidden inside an extraction. Persist migration version/backup and prove restart/idempotency.
7. Deleted IDs are never reused. Persist deleted profile IDs as tombstones across restarts and
   settings import. Settings backup moves to version 4 with portable provider identities (see
   Provider adapters). Preserve an imported profile ID only if it is absent from both active
   profiles and tombstones on the importing instance. Treat a tombstoned ID as a collision and
   mint a new ID for the imported profile; an older backup must not revive a deleted ID.
   An identical definition has the same revision, operations, canonical policy and stored display
   metadata. If an ID collides with that exact definition, reuse the local profile; if revision or
   definition differs, keep the local profile and mint a new ID for the imported one, including
   collisions between seeded templates. Build an old-to-new profile ID map. If imported and local
   profiles have the same display name, distinguish them with a localized presentation-only
   "imported" suffix and identify both in the import summary; keep stored names unchanged.
   Historical admission snapshots retain their original ID, revision and rules. In the same
   serialized settings-store transaction that publishes profiles, rewrite every affected
   `UserData.prefs` default through that map. Clear a reference to a removed or unresolved
   profile so resolution falls back to the operation-compatible instance default; never leave a
   dangling ID. The backup restores only the exporting admin's personal defaults to the importing
   admin; existing users retain their own defaults, subject to this remap. Preserve historical
   snapshots and list dormant provider references that could not map. Test import failure, restart
   and rollback; an older binary must refuse an unsupported new schema rather than overwrite it.
   Retain the pre-migration backup for rollback.
8. Add remote automatic candidates after the background policy/admission pipeline and relevant
   remote tests are stable. Interactive fan-out, Kotlin migration and the complete editor are not
   prerequisites; shared server access/cache guarantees are.

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
- Owned copies keep their place under Recommended, are candidates for the next episode from any
  class, and a follow applies its explicit local-copy policy before downloading. A remote-only copy
  never counts as local ownership; a copy failing required content constraints does not satisfy
  `meetsRequirements`.
- Profiles and the exporting admin's personal defaults survive settings import. Existing users'
  defaults remain valid or fall back through the transactional profile-ID remap. Profiles,
  applicable personal defaults and follows survive an addon reinstall through portable provider
  identity; otherwise report the exact dormant references. No public read, DTO or log exposes a
  manifest URL. Remote libraries imported with new IDs remain disabled and ungranted until an
  administrator restores credentials, grants and enabled state.
- Every stage satisfies the test and rollout gates in the delivery plan. Runtime-changing PRs
  follow repository build, version, Docker health and final visual-verification requirements.
