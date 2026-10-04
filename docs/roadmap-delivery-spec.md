# Roadmap delivery specification

Status: proposed implementation contracts; no feature in this document is
claimed as delivered solely by being specified here; implementation updates are
marked where noted. Reviewed on 2026-09-29 against PR #260 (`11f1759`) and `main` (`14f7beb`).
The [roadmap](roadmap.md) owns prioritization. Existing feature documentation
owns current behavior. The [bridge specification](arr-integration-spec.md)
remains authoritative for Sonarr/Radarr.

## Review findings and architecture

| Observed baseline | Consequence for the plan |
| --- | --- |
| `library-transfer.ts` already reserves destinations, stages copies with random suffixes and flushes files | Extend crash recovery and ownership tracking; do not replace these protections with a shared deterministic `.part` path |
| `library-ops.ts` persists jobs, retries interrupted items and includes artwork/match operations | Journal replay alone does not prove that an item can safely repeat after a filesystem side effect |
| `playback.ts` has serialized session operations and unclaimed/orphan timeouts | Test and tighten session ownership; ending a segment request must not terminate healthy HLS playback |
| `backup.ts` exports settings/addons/library references, normalizes inputs and remaps missing libraries to defaults | Describe the current export honestly and add a preview before promising strict restore |
| `downloads.ts:addPending` suppresses active duplicates by video ID | Add durable, permission-aware episode intent; completed jobs and cleared history cannot be the watch list's memory |
| The *arr probe uses a disposable adapter | Keep protocol feasibility distinct from production queue/authentication/import evidence |

Keep the existing TypeScript services and deployment model. The 2026-10-04
audit recommends a staged local SQLite migration for demonstrated cross-store
invariants; see [Local SQLite migration](#local-sqlite-migration). No microservice
split or whole-application rewrite is required. Extract narrow service
boundaries when a feature needs them. Test invariants at the domain layer and
use a small number of end-to-end scenarios for wiring and user interaction.

## Family home and kids mode

### Home screen first

Ship a home route using current account/library state before building the show
scheduler. Adult row order: Continue watching, favourites / My shows, recently
added local media, completed downloads ready to play. Add followed-show episodes
when discovery exists. A followed show and a favourite are distinct choices;
neither action silently starts downloading.

Every row is filtered by current grants on the server. A hidden library/addon
must not leak through posters, titles, counts, suggestions or cached responses.
A completed queue record is not proof of a playable file: resolve a currently
accessible library item and suppress or explain unavailable media. Recently
added means first observed in the local library, not filesystem modification
time or the last scan; persist that time if unavailable today and do not claim
historical order for migrated entries.

Use a home aggregation boundary that reuses progress, favourites and library
services. Do not scan disks or fan out to all addons on each page load. Return
bounded rows (initially 20 cards each) with continuation where useful and
independent loading/error states. Deduplicate within rows using stable media
identity; the same title may reasonably appear in Continue watching and
favourites. Invalidate on playback progress, completed downloads, library
changes and permission revocation. Never share personal cache entries across
accounts. Preserve the existing catalogue/library navigation and deep links.

Resume cards start the saved episode/position. Series cards show the next
eligible episode and an explicit alternative picker; never guess across
ambiguous episode numbering. A missing source offers a clear retry/back path.
Empty accounts get a concise path to allowed content; only administrators see
setup actions. Measure time to usable local rows on the target NAS without
waiting for external addon responses.

### Restricted child account

MVP reuses one dedicated ordinary account per child, with an administrator-set
child policy. Do not add profiles under an adult account yet. Policy includes
allowed libraries/addons, whether catalogue playback is allowed, and disabled
administrative/destructive capabilities. Disable downloads, addon installation,
external trailers/links, data export, file mutations and self-service policy
changes in the initial child mode. Read access and playback still use current
account grants; ordinary user role restrictions alone are insufficient because
ordinary users currently have download endpoints.

A parent chooses curated libraries first. Granting a broad addon is an explicit
parent decision and does not promise age filtering. If age metadata is missing,
do not infer suitability. Age-rating rules, purchases and several profiles
under one account are outside MVP.

Enforce the child policy at server boundaries for search, metadata, artwork,
stream resolution, playback, downloads and mutations, including direct requests
and deep links. Apply it to next-episode/autoplay paths too. Permission changes
invalidate cached rows and affected playback/session access. Child credentials
must never authorize an adult action even if someone opens the adult route.

Exit uses authentication into a permitted parent account; never keep a reusable
adult token in child-accessible client state. Child logout is allowed but does
not grant another account's authority. A later PIN flow needs hashed secret
storage, rate limiting, bounded unlock scope/lifetime and parent-authenticated
reset; a client-side PIN overlay is not a security boundary. Persist child
policy through reload, desktop restart and remote-server profile reconnect.

Child home contains at most three rows: Continue watching, favourite shows,
recently added approved episodes. Start with touch targets of at least 48 CSS
pixels, labelled icons, visible focus and a short path back home. Disable
repeated play actions while a start is pending and use a request identity so
rapid taps cannot create multiple sessions. Show immediate progress, a useful
failure message and a retry without requiring browser Back. Support keyboard
and screen-reader navigation as well as touch.

### Acceptance and PR boundaries

First PR: personal home aggregation and adult home UI. Second: child policy and
server authorization tests. Third: child presentation and parent switch flow,
released only with the policy enforcement. Keep migration defaults equivalent
to existing adult behavior; no account becomes restricted automatically.

Prove two accounts cannot see each other's rows; revoked content disappears;
missing media and empty rows are handled; repeated play taps produce one active
start; reload/back/deep links cannot escape child policy; direct forbidden API
requests fail; parent authentication cannot be bypassed; autoplay respects
current grants. Verify touch layouts and focus once functional tests stabilize.
Use a supervised household walkthrough: open app, find a known favourite,
start the intended episode and return home without adult recovery. Record task
completion and wrong-episode starts, not recordings or identifying child data.

## Filesystem safety and restart recovery

### Contract

A destructive operation must know its actor, current permissions, library
identity, source, destination and allowed effect. Validate again before the
side effect; grants, mounts and paths can change while work is queued. Distinguish
an absent item inside a verified readable root from an unavailable root. An
I/O or permission failure must never become an empty-library cleanup signal.
Re-resolve containment at mutation boundaries and reject symlink escapes.

Preserve destination reservation, cross-filesystem staging and no-overwrite
behavior. Record a versioned operation ID, item ID, source identity, target,
owned staging path and phase before beginning the corresponding side effect.
Use the existing operations journal where appropriate. Each replay reconciles
both disk and journal; it must not assume that an unrecorded result never ran.

| Phase | Restart decision |
| --- | --- |
| Planned | Recheck roots, grants, source identity and collisions before starting |
| Copying | Retry from intact source using only owned staging; resume bytes only if explicitly verified |
| Ready to publish | Verify complete staged output and destination reservation before publication |
| Published | Recognize the owned destination; finish metadata reconciliation instead of copying again |
| Source cleanup pending | For a move, remove only the unchanged original after verifying the published copy |
| Completed / failed / cancelled | Preserve the recorded result; retry cleanup only for proven owned temporary data |

These are logical phases, not a requirement to expose each as a public queue
status. If publication or identity cannot be established after a crash, retain
both files and show a recoverable conflict. Byte count alone is insufficient
proof that an unrelated destination is ours. Write the implementation's identity
strategy and supported filesystem limitations before enabling automatic source
removal. No automatic rollback may delete a successfully published destination.

A batch may finish with failed items: show successful and failed counts, offer
retry for failed items only, and never label the entire batch successful.
Cancellation stops new items and reports whether the current item completed;
it is not an implicit undo of previous items.

Malformed, unsupported or unreadable journals must be preserved. Block affected
mutations and surface a diagnostic; do not overwrite them with an empty queue.
Cleanup may remove only artifacts whose ownership is recorded and whose job
cannot still be active. Unknown old `.part` files are not garbage by extension.

### Recovery by operation

- Downloads retain their existing resume/retry semantics; never let library
  cleanup claim their `.part` files.
- Library copy/move uses the phases above. Same-filesystem rename also needs
  reconciliation if the process dies after rename and before metadata commit.
- Metadata updates must retain the last valid file, publish replacements
  atomically and replay idempotently after a filesystem move. Manual matches,
  unmatches, favourites and resume state are preserved across path changes.
- Artwork generation writes an owned temporary file, validates it and publishes
  atomically. Failed replacement keeps prior artwork. An unavailable source is
  not proof that its stored artwork is orphaned.
- Playback sessions do not resume automatically after a server restart. Expire
  their handles, clean only proven session output, and let the client restart
  from persisted progress. Define child-process shutdown for each runtime.

### Acceptance and delivery

Inject failure before and after copy, publication, metadata commit and source
removal. Test `EXDEV`, `ENOSPC`, denied access, unplugged roots, simultaneous
same-target operations, source replacement, symlink changes and journal
corruption. Assert file contents and preserved metadata, not just job status.
Test interrupted replay twice to prove idempotency. Never report completion
with partial media visible to a scan.

Suggested PRs: destructive-path audit and focused fixes; durable transfer
phases and replay; metadata/artwork reconciliation. Each includes its own
regression tests. This gate precedes bulk rename and external staging.

## Local SQLite migration

Status: preferred candidate for the transactional core after the 2026-10-04
audit of `b4b4c2a`, conditional on the decision gate below. No migration or
driver selection has been implemented. This decision note
supersedes the earlier default of retaining JSON until the consistency
requirements justify a migration.
The [engineering roadmap](roadmap.md#engineering-health) owns delivery order and
records reproduced defects and the source-store inventory.

### Decision and limits

If the decision gate passes, use one embedded SQLite database for the
authoritative transactional server state. Cross-library
relocation already coordinates two metadata files and personal state, with a
separate operations journal. That meets the proposed cross-store consistency
trigger today. Keep a single backend writer per data directory, the same HTTP
contracts and the same Docker/desktop deployment shape; no database service,
ORM or network protocol is required.

A transaction can commit related database records together; it cannot include
moving or deleting media on the filesystem. Keep the operation phases above,
record intent before external effects, and reconcile their outcome afterward.
Do not keep a transaction open while copying a film or fetching addon metadata.
SQLite's commit guarantees also depend on the operating system and storage
honoring locking and flush requests. [Atomic commit](https://www.sqlite.org/atomiccommit.html).

Store relational identity, ownership, grants, statuses and uniqueness keys as
queryable constrained fields, not one opaque JSON snapshot per old file. Bounded
provider metadata/settings payloads may remain JSON values where relations do
not need them. Enable foreign keys on every connection and define account and
library removal policies deliberately; cascading a database row must never
implicitly delete a media file. Use parameterized statements and schema versions.

Migrate accounts, libraries, personal state, bindings, downloads, follows and
operation/scan journals into the same transactional boundary. Preserve statistics and
activity history, but migrate those only if their access/retention requirements
justify joining the core; their existence alone is not a transaction requirement. Keep caches and independent desktop preferences separate unless
an actual invariant requires them. Media, sidecars and artwork remain files;
configuration export/import stays human-readable JSON. A secret stored in SQLite
is still a secret: restrictive file permissions and existing redaction apply.

### Alternatives and the reason to choose

The format alone is not a defect. Eleven JSON path families are not eleven
independent arguments for a database: two are cache indexes, some hold history,
and desktop settings need no shared transaction. No production dataset sizes,
write-latency measurements or memory profiles were collected in this audit.
A performance improvement from SQLite is therefore **unproven**.

| Option | Concrete advantage here | Cost / remaining problem | Recommendation |
| --- | --- | --- | --- |
| Harden existing JSON stores | Smallest immediate change; readable files; no runtime/packaging addition. Can fix H1–H3 with serialization, explicit errors and preserved journals. | Multi-file relocation and follow/job linkage still need a durable journal and replay. A single combined JSON snapshot could make state atomic, but would couple updates and rewrite unrelated state. | Do the urgent fixes regardless. Retain JSON if measured requirements remain simple or the SQLite experiment fails. |
| SQLite for the transactional core | One commit can link an episode intent to a job, or update related metadata and personal references. Unique constraints can enforce selected logical identities. | Requires repository boundaries, migrations, restore tooling and commit-aware memory updates. It still needs filesystem recovery and application authorization. Partial migration only helps invariants whose records actually moved together. | Preferred direction, validated by a bounded experiment before production migration. |
| Move every JSON/cache/preference into SQLite | A uniform storage API and central querying. | Largest change surface; little demonstrated value for independent caches, counters or desktop window preferences. Binary backup becomes the default even for simple standalone settings. | Not justified. Do not make eliminating JSON the goal. |

The best-supported gain is **consistency and simpler state commits**, followed
by enforceable uniqueness. Indexed lookup and smaller incremental writes may
help larger libraries, but need comparison against the existing in-memory maps
and batched writes. A database query on every progress tick could be worse than
today; keep high-frequency observations coalesced.

SQLite fits a single-process, local-storage application and permits concurrent
readers, but only one writer at a time. The current server already serializes
several save chains, so this is not automatically a new bottleneck; long SQL
transactions or synchronous busy waits would be. [Appropriate uses](https://www.sqlite.org/whentouse.html).

There are real migration costs in this code: `Store.update` accepts a callback
mutating a live `State`, its getters expose in-memory records, and
`LibraryMetaStore.update` schedules a later write. Replacing `writeFile` with an
SQL call would retain the old false-success and stale-memory problems. Define
command-level commits and publish new in-memory state only after success, or
invalidate/reload affected views on failure. The migration must actually remove
manual cross-store commit logic; adding SQL underneath unchanged mutable JSON
snapshots does not deliver the main benefit.

H1 needs both a database reservation and safe filesystem publication; H2 needs
commit failures propagated to the caller; H3 needs refusal to overwrite invalid
state. SQLite alone fixes none of those application policies. It also does not
replace backups, protect against a broken disk, authorize an account, or roll
back an already moved video. One central database reduces torn cross-store
updates but increases the scope of a bad migration or accidental deletion.
Keep tested backups and bounded schema changes.

**Decision gate:** proceed with SQLite only after the experiment proves all of
these, and record results rather than relying on the format's reputation:

- A representative follow-intent/job operation commits atomically, including
  uniqueness and failed-commit behavior, with less bespoke reconciliation code.
- The replacement library-state transaction includes all its related records;
  media publication still has explicit, replayable external-effect phases.
- Docker and packaged desktop load the selected driver without new user setup.
- Cold start, p95 mutation latency, event-loop delay during playback, memory,
  disk writes and checkpoint growth are compared with hardened JSON using the
  same small/large synthetic libraries and documented representative fixtures.
  Agree acceptable regression limits before the experiment; no faster-playback
  or lower-memory promise is made by this document.
- Import, interrupted cutover, backup, restore and the supported rollback path
  preserve the logical data and pending operations under failure injection.

A disposable experiment may cover only queue/follow tables. That does not
authorize a partial production cutover with dangling account/library references.
If its complexity exceeds the cross-store code it eliminates, keep the JSON
repairs and revisit the decision when there is stronger evidence. Do not let the
migration become a prerequisite for all unrelated product work.

### Runtime and NAS gate

Evaluate built-in `node:sqlite` first, without assuming availability from the
current `node >=22` declaration. The API was added in 22.5 and lost its flag
requirement in 22.13; the versioned Node 22.17 documentation still marks it
experimental and describes synchronous APIs. Record the actual supported minimum
and API surface, then test the shipped Docker runtime and Electron utility
process. The host's Node version is not evidence for either. [Node documentation](https://nodejs.org/download/release/v22.17.0/docs/api/sqlite.html).

If that experiment fails a required runtime, compare one maintained embedded
driver and record native-build/ABI consequences before selecting it. Desktop
currently uses `utilityProcess` and `npmRebuild: false`; verify packaged macOS
arm64, Windows x64 and Linux x64 plus Docker amd64/arm64. Measure database work
and busy waits during playback. Keep transactions short; put blocking work in a
dedicated worker if the latency experiment requires it. No thread pool or ORM
is prescribed in advance.

The database belongs on storage local to the machine running the backend:
a local Synology volume mounted into its container qualifies; a remote SMB/NFS
share does not meet the proposed deployment contract. Remote desktop connects
through HTTP. Reject/document unsupported data-directory configurations instead
of promising safety based only on a pathname. WAL depends on same-host shared
memory and does not work over network filesystems. [WAL constraints](https://www.sqlite.org/wal.html).

Start the experiment with explicit WAL, `synchronous=FULL`, foreign keys and a
bounded busy timeout; measure checkpoint size, lock contention and latency on
NAS-class storage. Do not silently switch to relaxed durability to make the
benchmark pass: NORMAL in WAL can lose committed transactions after power loss,
whereas FULL synchronizes the WAL at each commit. Select the final settings with
the documented storage assumptions. [Durability settings](https://www.sqlite.org/pragma.html#pragma_synchronous).

### Migration and cutover

1. Introduce narrow persistence interfaces and contract tests while JSON remains
   authoritative. Fix acknowledged-write failures and destination races first;
   the database project must not postpone those repairs.
2. Implement versioned schema migrations and an offline importer into a temporary
   database. Do not switch individual sides of a cross-store invariant in live
   production while the other side still writes JSON. A shadow comparison may
   read both; there is only one authority for writes.
3. Enter maintenance mode before taking the input snapshot. Stop new mutations,
   settle or explicitly interrupt workers, flush state and preserve a timestamped,
   immutable source backup plus a manifest of hashes, schema and app version.
   Malformed/unreadable input blocks migration; it never imports as empty state.
4. Import in a transaction, preserving account/library/job IDs, password hashes,
   grants, timestamps, manual matches, favourites, progress, follow intentions
   and unfinished work.
   Validate record counts, key mappings, referential integrity and logical
   equivalence. Report legacy duplicate jobs as conflicts to reconcile; do not
   discard rows just to satisfy a new unique index.
5. Validate the temporary database, checkpoint/close it before publication, then
   activate through a crash-safe migration marker. Startup must distinguish
   prepared, verified and activated states and deterministically finish or abort
   an interrupted cutover. Test crashes around each marker/publication boundary.
   A future schema is an explicit refusal, never an empty database fallback.
6. Leave source JSON read-only as rollback evidence after activation; new code
   never falls back to stale JSON on a database error. Resume jobs only after
   reconciling the journal with current mounts and actual media. Remove obsolete
   writers in a later cleanup PR after the supported rollback window.

Idempotency tests cover repeated import, interrupted import, disk full, damaged
input, startup twice after cutover, mixed legacy owners and changing paths.
Database tests cover rejected duplicate intents, distinct owners, physical target
reservations, revoked grants, failed commits and replayed completion hooks.
Keep the existing API and recovery tests running against the replacement adapter.

### Backup and rollback

Before any post-cutover mutations, rollback can restore the original JSON snapshot
and compatible application version while preserving the database for diagnosis.
After writes or file moves have occurred, simply reinstalling the old app would
silently resurrect stale state. A lossless downgrade then requires a tested
reverse exporter for the supported schema and filesystem reconciliation; otherwise
support roll-forward repair or an explicit restore of a consistent older
state/media snapshot, with its data-loss window stated. Do not promise an
unconditional one-click downgrade or automatic fallback to JSON.

Implement a consistent live backup using SQLite's backup API or another verified
snapshot mechanism; do not copy just the main `.db` file while it is active.
Test restore on a fresh data directory, validate integrity, then reconcile pending
operations against separately backed-up media. The online backup API can produce
a consistent snapshot while other work continues. [Backup API](https://www.sqlite.org/backup.html).

Before release, exercise power/process interruption and concurrent reads on the
supported local volumes, test backup/restore with pending moves and downloads,
and update the Synology/configuration guides: their current advice to copy the
data folder is insufficient as a live-database backup procedure. Keep operational
setup at `docker compose up -d`; the migration reports progress and actionable
failures through the existing application rather than requiring a DBA.

## Playback and mobile usability

Keep direct play, then remux, then transcode as the selection order. Record the
capability evidence and reason for the chosen mode. A client decode failure can
invalidate that evidence and trigger a bounded fallback; deterministic planning
does not mean ignoring actual device failures. Preserve audio-only conversion
when video can be copied.

Every FFmpeg process and output directory has a session owner. Stop explicitly
on session end/revocation and bound cleanup after abandonment. The current
45-second unclaimed and 90-second orphan thresholds are a baseline to test,
not new proposed tuning. A healthy player fetching separate HLS segments keeps
its session alive. Serialize seek/track changes and prevent an old generation
from publishing into the new one. On hardware failure, attempt a bounded
software fallback and report resource exhaustion honestly on a small NAS.

Acceptance: direct range requests (including invalid ranges and seek), remux
with incompatible audio, repeated seek/track changes, start cancelled before
first segment, tab abandonment, two simultaneous sessions, revoked access and
hardware initialization failure. Assert process/output cleanup and sanitized
source kind, mode, backend and failure stage in diagnostics. Measure time to
first frame and CPU on the target NAS against the baseline; record the fixture
and environment instead of inventing an unsupported performance promise.

Fix clipped catalog actions in the shared sheet layout. Check safe-area insets,
scrolling, focus visibility, large text and the on-screen keyboard. Both
**To library** and **To device** must remain reachable in small portrait and
landscape viewports. Safari chrome behavior needs a physical iPhone/iPad test
with browser controls expanded/collapsed and rotation during playback. Record
device/OS and result; automated WebKit evidence cannot close that item alone.
Read [UI conventions](ui-conventions.md) before implementation.

## Backup and error contracts

### Backup scope

| Data | Current settings export | Required preservation policy |
| --- | --- | --- |
| Settings, addons and download rules | Included | Preserve; preview normalization and mapping |
| Library names, roots and types | Included as references | Map explicitly; do not imply media is copied |
| Real-Debrid token, TMDB key, addon URL credentials | Included | Treat export as a secret; never log its contents |
| Accounts, grants, favourites and progress | Not included | Inventory for a separate instance-backup design |
| Manual metadata bindings and library identity | Not included as a library backup | Preserve in instance recovery; never classify as disposable cache |
| Queue, scan and operation journals | Not included | Restore consistently with files and operation phases |
| Media and sidecars | Not included | Separate storage backup, documented with recovery order |
| Generated artwork and fetched metadata | Not included | Mark rebuildable only after checking for unique local/user-provided content |

First document an inventory of actual state paths, ownership, secrecy and
rebuildability. A stopped-instance copy of `DATA_PATH` plus media is an
operational starting point, not evidence that a live multi-file snapshot is
consistent. Prove recovery in an isolated directory before advertising it.

Next add a settings import preview: validate version and structure before
mutation, show changed fields and library mappings, distinguish legacy defaults
from malformed values, and block unresolved destinations until the user maps
them or explicitly selects the default. Preserve supported v1/v2 imports;
reject unknown versions. Use a plan bound to the current settings/library
revision so a stale preview cannot apply silently. Apply local changes as one
recoverable unit and report addon refresh failures separately. A settings
import must not create or move media. Full-instance restore, account conflicts,
session invalidation and backup encryption require a separate design.

Acceptance: malformed file leaves state untouched; v1/v2 compatibility; missing
and ambiguous roots; duplicate library names; revoked grants; interrupted apply;
secrets absent from preview/logs; restore into an isolated installation.

### Errors

Extend `AppError` compatibly with a stable `code`, `category`, retry disposition
and optional operation ID. Keep `messageKey`, English fallback and variables.
Categories follow the roadmap; define their boundaries centrally. Codes identify
actionable causes (for example `storage.root_unavailable`), not translated text.
Retry disposition distinguishes automatic retry, manual retry, required user
action and permanent failure. Job state remains authoritative: an error alone
must not turn a paused operation into a terminal failure.

Migrate storage, download and playback boundaries first. Unknown exceptions
become a sanitized internal error with a correlation ID. Preserve compatibility
with older clients and keep logs useful without provider URLs, headers, tokens
or private backup payloads. Test serialization, redaction and retry guidance.
This is incremental work, not a prerequisite for fixing a concrete data-loss bug.

## Follow show

### Scope and user experience

Implementation status update (2026-10-04): following, daily discovery and opt-in
automatic downloads shipped in PR #297. The [feature guide](downloads.md#following-a-series)
owns current behavior; this section retains the proposed acceptance contract
for comparison, not a claim that the entire feature remains unimplemented.

A user follows a series from its detail view. Discovery-only is the default;
automatic downloading is a separate opt-in requiring download rights and an
explicit library/selection policy. Discovered episodes appear on Home without
creating queue jobs. For automatic downloads the user chooses where to begin. Default
to future episodes; preview any existing-episode catch-up and require explicit
selection. MVP covers standard numbered episodes, not season packs, absolute
anime numbering or date-based episodes. Missing/ambiguous identity or release
date is shown as unresolved rather than guessed. Specials are opt-in later.

The watch list shows enabled/paused state, destination, last successful check,
next check, pending episodes and actionable failure. Users can pause, unfollow
and check now. Unfollowing stops future discovery; existing jobs and files stay
unless separately cancelled/deleted. Deleting watched media does not trigger
an automatic re-download; provide an explicit episode retry/reset action.

### Persistent model and scheduling

A follow record needs ID, owner, addon/catalog identity, canonical series ID,
start boundary, enabled state, auto-download flag, selected library when needed,
source-selection preferences,
created/updated timestamps, last successful check and next scheduled check.
Track discovered episodes independently of download intent. Maintain per-episode intent keyed by owner + canonical series + episode/video
identity, with status and accepted queue job ID. Record completion independently
of queue history so clearing completed downloads cannot recreate them.

Persist the episode identity in the accepted queue job and recover the watch
ledger from it when enqueue succeeds but acknowledgement crashes. Serialize
concurrent manual/scheduled checks. Never mark an episode queued before durable
acceptance. The existing global active-video deduplication is insufficient:
define owner-aware results without exposing another user's private jobs. A
shared-library file may satisfy the intent only if the user can access it and
its episode identity is verified. Distinct owners targeting separate permitted
libraries must not suppress each other's downloads.

Proposed MVP defaults: one server-side check per enabled show per 24 hours,
staggered across the day; one overdue check after restart rather than replaying
every missed day; at most two concurrent metadata checks, further constrained
by existing per-host limits; at most 20 new episode intents per show per pass.
Retain a cursor for remaining eligible episodes. These are starting bounds to
measure on the NAS, not performance guarantees. Manual check coalesces with an
in-flight check and observes a one-minute cooldown. Store UTC timestamps;
display local time. Missing or future release dates do not enqueue work.

For metadata outages, retain the last successful state and back off (initially
15 minutes, one hour, then six hours; respect a longer provider Retry-After).
No usable source returns the episode to waiting with a next attempt time;
sustained failure is visible without adding a new queue job each day. Distinguish
that condition from authentication failure or a missing destination. Re-check
current account/addon/library permissions before checks, enqueue and execution.
Revoked download rights pause automatic downloads while permitted discovery
can continue; revoked content rights stop both. Child accounts cannot enable
automatic downloads. For automatic downloads, never silently redirect a followed show to another
library, including through the queue's existing missing-library fallback.

Resolve sources lazily using existing language/subtitle preferences and HTTP
or Real-Debrid handling. The scheduler discovers episodes; it does not eagerly
probe every source or create a second download engine. Desktop sleep/offline
periods use the same overdue-check behavior as server downtime. No OS cron or
always-on desktop promise is required.

Acceptance: repeated checks, concurrent checks, restart between enqueue and
ledger update, queue history cleared, metadata failure, missing dates, no
sources, removed media, permissions revoked, unavailable library, catch-up cap,
account deletion and two owners following the same show. Use a fake clock and
addon; assert durable intent count and final queue state without timed sleeps.
Deliver persistence/scheduler first, then translated UI and end-to-end wiring.

## Guided libraries, search and queue controls

### Guided split

Reuse [carve-outs and moves](libraries.md#splitting-the-download-directory).
Preview new roots, explicit item assignments, unmatched items, grants and
per-kind/addon download destinations. Never guess a title's type silently.
Explain which steps only change ownership and which actually move files.
Avoid claiming a rename leaves a pathname unchanged.

Apply through existing services and operations queue. Recheck paths, collisions,
free space and grants; coordinate scans and active downloads. Leave the parent
library until the user explicitly removes it. Show per-step partial success and
retry; do not promise a cross-filesystem transaction or automatic rollback.
Cancellation preserves completed moves. Acceptance includes an existing child
library, type ambiguity, interruption, active downloads, and unchanged matches,
artwork, favourites and progress after recovery.

### Bulk rename

Start only after replay-safe file operations exist. MVP pattern fields: title,
year, season and episode, with zero-padding for episode numbers; no expressions
or arbitrary scripts. Preview every source/destination including media sidecars,
reject missing required fields, traversal, invalid platform names and collisions
(including case-only names on insensitive filesystems). No overwrite option.
Freeze and revalidate the plan before execution. Persist an item journal and
update library keys, metadata, artwork, progress and favourites consistently.
Explicitly handle rename cycles and interrupted case-only renames with owned
staging, or reject them in MVP. Test these cases before enabling the action.

### Search

Debounce input by approximately 400 ms; Enter submits immediately. Ignore stale
responses using a query generation scoped to account, addon/catalog and filters;
cancel superseded requests where supported. Do not search during IME composition.
Preserve explicit search scope and show partial addon failures separately from
zero results. Suggestions use already loaded, currently permitted catalogues.
Store at most 20 recent queries per account/server on the device, offer clear
history, and prevent another account from seeing them. Optional title-match
ranking must be stable, preserve ties and remain reversible. Test rapid typing,
response inversion, scope change, logout and keyboard navigation.

### Queue controls

Keep these after the Follow show MVP. A download window needs an explicit time
zone, overnight ranges, DST rules and a decision for running transfers. Proposed
behavior: gracefully pause active downloads at the window boundary while
preserving resume data; manual pause is never undone by the next window.
A speed limit applies to aggregate download bytes across segments/jobs and
excludes playback. A queue-drained notice fires once per nonempty-to-terminal
transition; paused, source-waiting and debrid-waiting work is not drained.
Begin with in-app notices. Browser push is a separate scope.

## Maintenance measurement

Use a small versioned report from issue/PR events before building a dashboard.
Per accepted issue record issue ID, acceptance time, linked PRs, first reviewable
time, final disposition, implementation iterations and human interventions.
An iteration means a substantive implement/test/review cycle, not each tool call
or commit. Human technical intervention means a decision or code change needed
to reach reviewable state; routine merge approval is recorded separately.

Report weekly cohorts with counts and denominators: rejected/triaged issues by
reason; accepted issues with a reviewable agent-produced PR / accepted issues;
PRs needing human technical intervention / agent-produced PRs; independently
confirmed defects found before merge; post-merge regressions attributed to a fix;
new versus exposed flaky tests; median and range of iterations and elapsed time.
Keep open/unresolved issues in the cohort and report sample size rather than
presenting incomplete work as success. One issue may have several PRs; count
issue outcomes once. Deduplicate repeated review comments about one defect.

Label a regression only with a reproducible link to the introducing change;
allow attribution to remain unknown. Rejecting a duplicate is useful triage,
not an implemented fix. Review findings require reproducer/test or concrete
code evidence; model agreement is not a severity score. Automated review can
recommend changes but does not merge, loosen tests or close issues on its own.
Exclude private tokens, media names and provider URLs from collected evidence.
This specifies measurement only; it does not start an autonomous maintenance
workflow or authorize issue comments/messages.

## Delivery gates and deferred decisions

Each implementation PR states the changed contract, migrations, failure path
and acceptance evidence. Run affected domain/API tests and repository-required
build/deployment checks for shipping code. Use physical/device and real-*arr
checks only where they establish facts unit tests cannot. Documentation-only
changes require link/diff review, no version bump, and no runtime deployment.

Keep these unresolved items visible instead of hiding assumptions in code:

- Recovery: demonstrate destination identity and directory durability on Linux,
  Windows and macOS before enabling automatic destructive replay.
- Backup: decide the complete instance format only after the state inventory
  and isolated restore drill; settings export retains its limited name/scope.
- Follow show: validate addon identity/date coverage with representative series;
  unsupported numbering remains explicit rather than fuzzy-matched.
- Desktop: signing credentials and clean-install/upgrade evidence are external
  release prerequisites; automatic installation remains separately designed.
- Sonarr/Radarr: use its existing compatibility harness and source-fingerprint
  contract. Share low-level durability work with Follow show, not scheduling
  semantics: following episodes is not a feed of newly available releases.

After each delivered slice update the roadmap with the actual evidence and
remaining limitations. Do not mark an entire milestone done from a happy-path
demo or a passing build.
