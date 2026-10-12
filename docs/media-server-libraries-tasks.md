# Read-only media-server libraries: delivery tasks

Status: implementation specification, 2026-10-12. No production support yet.
Read the [product contract](media-server-libraries-spec.md) and
[repository analysis](media-server-libraries-analysis.md) first.

The coordinator owns design and review; DeepSeek implements coherent tasks with
`codex --profile deepseek exec` inside an isolated worktree. Each task gets a
fresh specification with the verified symbols on its current base. Named symbols
win over stale offsets. Report contradictions as `ARCHITECTURE_QUESTION` rather
than guessing. Do not treat a proposed interface below as an existing helper.

## Shared decisions

- `Store.libraries(): LibraryRecord[]` stays filesystem-only. Add
  `mediaConnections()` and `remoteLibraries()` for separate records. Shared
  public projections explicitly combine authorized local and remote libraries.
- Remote libraries have a distinct ID prefix: `rlib_` plus random
  lowercase hex; connections use `mconn_` plus random lowercase hex. They cannot
  pass the existing `LIBRARY_ID` matcher. Remote item IDs are opaque strings,
  encoded as URL path components; never interpret their punctuation as paths.
- A source has transport `kind` and independent provider/capabilities. A
  media-server source remains HTTP transport but always has
  `downloadToLibrary: false` and `downloadToDevice: false`. No caller-provided
  capability or provenance field is authoritative.
- Local progress, watched markers and favourites are writable; the remote media
  server's equivalents are never written. All read/write projections enforce
  current local grants, enabled state and verified remote identity.
- Separate source-group requests have independent deadlines. Recommended order
  is filesystem, remote libraries by configured order, then addons. Explicit
  sorts may reorder within the documented UI contract; an explicit selection
  and an active player never change when a late group arrives.
- `remote:` progress keys are derived server-side from the canonical JSON tuple
  of provider, verified server ID, remote account ID and remote item ID. Selected
  version/duration are stored beside the key, not embedded into a catalogue ID.
- Expose remote artwork only through a content-authorized private route, even
  with secure mode off. External subtitles inherit the same content reference
  before and after conversion. A shared URL-only cache grants no access.

## MS-0: provider feasibility and reproducible fixture

Goal: establish actual original-media access and local-history isolation on one
explicitly recorded version of each provider before production playback work.
This task ships developer tooling and a measured report, not UI support.

Files: add `scripts/media-server-spike.mjs` and
`docs/media-server-libraries-spike.md`; keep local container configuration,
credentials and synthetic fixtures outside tracked files. The script uses Node
built-ins and existing repository tools, not new production dependencies.
Its matching `scripts/media-server-spike.test.mjs` suite uses `node:test`.

The runner accepts a provider, origin and environment-supplied credentials. It
performs no startup/library/user setup writes. Provisioning is a separate
coordinator-owned operation limited to explicitly disposable fixture servers. Production-like checks have a distinct allowlisted request
function that cannot call setup, remote metadata/user-data changes,
`Sessions/Playing*`, transcodes, refreshes or file mutation routes. Never print
authentication payloads, tokens, full response dumps or signed upstream URLs.
Support an optional reverse-proxy base path and record normalized safe request
method/path/status, without query credentials.

Check a film, episode, multiple media sources, SRT sidecar and original-file
transport. Obtain and report server identity/version. Discover account-visible
views and page items using the remote user ID. Compare remote `UserData` before
authentication/preparation, byte streaming, range seeking and cleanup; compare
position, played, play count, last played and favourite. Inspect active sessions
and remote transcode output. The measured candidate uses GET `PlaybackInfo` with `UserId`, not POST
preparation or live-stream opening. Consume only regular file media sources and
request authenticated original-file GET/HEAD with `Static=true` and an explicit
media-source ID. Ignore remote remux/transcode URLs. If a future provider needs
POST preparation, require explicit disabled transcoding/direct-stream flags and
a separate history-isolation experiment before allowlisting that exception.

Acceptance:

- Each provider has a tested version/image digest, methods/paths and result table.
- HEAD and nonzero Range return consistent lengths/206 and exact fixture bytes.
- Interrupted reads are cancelled; current token/account restrictions are honoured.
- External subtitle bytes match the synthetic fixture and preserve language.
- A reverse-proxy base path works without sending credentials to another origin.
- Shared remote history is unchanged and no remote transcode starts.
- Any untested case is explicitly marked untested, never converted to a pass.
- Fixture setup writes are separated from the production-like request trace.

Validation: `node --check scripts/media-server-spike.mjs`, run against both real
Docker servers and inspect their logs. No runtime feature/version bump.

## MS-1: provider model, storage and scoped transport

Goal: persist secure connection/library configuration without changing filesystem
behaviour or making remote sources publicly playable yet.

Files: add `server/src/media-server-types.ts`, `media-server-security.ts`,
`media-server-secrets.ts`, `media-server-provider.ts`, `media-server-store.ts` and
root-level matching `*.test.ts`. Update `store.ts`, `backup.ts`,
`routes/settings.ts`, `index.ts`, `.env.example` and `docs/configuration.md` only
for the wiring/configuration needed by this task. The provider module may split
Jellyfin/Emby adapters when differences warrant it. All new tests stay inside
the existing server test glob.

Proposed core contracts:

```ts
type MediaServerKind = "jellyfin" | "emby";
interface RemoteIdentity {
  provider: MediaServerKind;
  serverId: string;
  accountId: string;
  itemId: string;
}
interface RemoteContentRef extends RemoteIdentity {
  connectionId: string;
  libraryId: string;
  generation: number;
  mediaSourceId?: string;
}
interface RemoteCapabilities {
  rename: false; move: false; delete: false;
  identify: false; writeArtwork: false;
  downloadToLibrary: false; downloadToDevice: false;
}
```

Connection records carry local ID, provider, verified server/account identity,
base URL/base path, display name, enabled state, generation and secret reference.
Statuses distinguish disabled, connecting, available, unavailable,
reauthentication-required and identity-changed. Remote library records carry
local ID, connection ID, opaque upstream library ID, name, content type, enabled,
order, grants and Home switches. No filesystem root, upstream history or token
belongs in a public DTO.

Provider methods: authenticate, verify identity, current account policy, list libraries, page items,
detail, episodes, search, versions and prepare original media. Every network
method accepts an `AbortSignal`. Page results carry an opaque cursor and a
bounded item list. Keep transport information server-only. Exact provider
endpoint/headers are taken from MS-0 evidence, not guessed from API similarity.

Network policy is connection-scoped: normalized HTTP(S) origin/base path,
explicit LAN permission and separate explicit loopback permission. Reject URL
credentials, fragments, path traversal/encoded escapes and destination changes.
Validate IP literals and all DNS answers before requests and at socket lookup;
block metadata/link-local, unspecified, multicast and reserved addresses even
when LAN is enabled. Do not consult `ALLOW_PRIVATE_ADDONS`. Reject authenticated
cross-origin or base-path-escaping redirects; no token forwarding or URL query
authentication. Bound redirects, request/header/body deadlines, response bytes,
concurrency and cache size with named constants and tests.

Secrets use authenticated encryption bound to connection and remote identity,
an independently managed deployment key, atomic owner-only files and explicit
failure states. Ordinary configuration exports include metadata only. Restore
uses new local connection handles, disables access and grants nobody until
reauthentication. Document separately how full key/secret backups restore
verified identity and why a missing key cannot be silently replaced.

Tests: existing state loads with exactly the same filesystem IDs/paths/grants;
new records survive restart; duplicate verified account is refused; distinct
accounts remain separate; secrets cannot be found in settings/export/public
DTO/logs; corrupt/missing keys fail closed; DNS rebinding, literals, mapped IPv6,
LAN/loopback opt-in, metadata ranges, redirect and base-path escapes are denied;
provider fixtures cover 401, per-item 403/404, 429 and 5xx distinctly.

## MS-2: management, grants and bounded metadata index

Goal: administrators attach libraries; authorized users browse metadata without
mixing remote records into filesystem consumers. Playback stays unavailable
until MS-3 lands.

Files: new `server/src/routes/media-servers.ts`,
`server/src/media-server-index.ts` and root/route tests; update `store.ts`,
`routes/context.ts`, `roles.ts`, `roles.test.ts`, `routes/libraries.ts`, `routes/content.ts`,
`routes/users.ts`, `index.ts` and public DTO definitions. Do not bulk-rewrite
scanner/path modules; their unchanged inputs must be proved in review.

New admin routes under `/api/media-servers`: connection create/update/remove,
reauthenticate, remote library discovery and attachment. New member routes
under `/api/remote-libraries/:libraryId`: bounded browse, details, episodes,
search and authorized artwork. Define exact request/response schemas in the
worker spec, including exact method/path rules in `roles.ts` `USER_ALLOWED` (paths omit `/api`);
route path alone does not enforce role. Listing inaccessible/unknown resources
must yield the same 404. Validate library ancestry for every guessed item ID;
remote account access does not imply a local grant to all its libraries.

Allowlist local configuration edits only: name, order, enabled, Home switches
and grants. Newly attached/restored libraries are admin-only. Reject root,
writeArtwork, filesystem scan settings and every media write. Disable preserves
metadata/history/grants while stopping reads. Remove retains identity-bound
history for 30 days invisibly; remove-and-forget purges cache and personal
references. Removing the connection deletes its secret. Reattachment never
restores user grants silently.

Index paginated provider snapshots with bounded memory/concurrency/disk,
cancellation and retry backoff. Publish a new snapshot only after a complete
successful scan and generation check; failures preserve the last snapshot and
freshness. Filter grants before deriving sources, search, counts or Home rows.
Authorization is rechecked before cached artwork bytes are sent; ETag/304 must
not bypass it. Background work is cancelled on credential/identity changes.

Tests: two users/two libraries on one account; unauthorized guessed items,
ancestors/artwork/cursors/counts; interrupted/partial scans preserve data;
disabled/offline/empty are distinct; grant removal during fetch publishes no
results; local root/scanner/default-target behaviour is unchanged; restore and
reattach start admin-only; connection removal deletes the correct secret.

## MS-3: content-bound resources, matching and playback

Goal: allowed remote items play through our existing proxy/FFmpeg with stable
local progress, immediate local revocation and no downloads or remote history
writes. Do this before exposing client Play controls.

Files: new `server/src/media-server-sources.ts` and matching tests; update
`types.ts`, `media-resources.ts`, `revocation.ts`, `routes/playback.ts`,
`routes/catalog.ts`, `routes/downloads.ts`, `routes/device.ts`, `downloads.ts`,
`index.ts`, `player-sidecars.ts`, `range-cache.ts` and corresponding harnesses.
`playback.ts` changes only where the existing lifecycle requires them.

Trusted provenance must originate from the adapter/index, never a body, addon
payload or arbitrary `StreamItem` extension. Preserve it in normalization,
structured clones, subtitles and active transfers. Generic source admission
strips/rejects attempted provenance. Source listing creates no playback session.
The selected version is resolved freshly at Play and checked for library
ancestry/remote account access and current local generation after awaits.

`contentOf` must resolve HTTP provider provenance. `AccessSource` and
`AccessNeed` gain the remote resolver/generation data needed by `accessLost`.
Connection disable/removal/401 and local grant changes invalidate sources,
children, artwork/subtitles, cached ranges and active responses; abort upstream
reads and stop FFmpeg through the existing stop hook. Retained conversion
sessions cannot survive a provider generation change. Revalidate current account playback policy and visible-library membership
before each original-media request; the tested static endpoints do not enforce
all account policy changes. Active playback revalidation runs every 30 seconds
with a 5-second deadline, aborting the session on denial or an unconfirmed
permission result. This is a proposed local bound, not an upstream guarantee;
keep it configurable with a documented maximum. Local revocation remains immediate.

Sweep every playback path: inspect, start, preview, ping, seek, escalation,
track, stop, sidecar, generation files, media GET/HEAD, internal loopback reads
and any receiver grants. Recheck after preparation/probe/start/seek awaits and
before replying. Owner/internal-token checks remain enforced.

External IDs are namespaced and typed; conflicting IDs never auto-match.
Episode matching requires verified parent series and season/episode mapping;
alternate numbering/multi-episode files that cannot be proven stay unmatched.
Preserve real versions; sort by configured library order then filename and
media-source ID. Missing IDs never prevent native remote browsing/playback.
Cross-ID conversion is bounded/cached and cannot delay browsing or local groups.

Remote originals use the MS-0-verified static path with authenticated headers.
Reuse existing playback planning/capacity, backpressure/cancellation and local
FFmpeg. Never accept a provider HLS/remux/transcode URL as an original. Provider
track indices require an explicit mapping or bounded ffprobe through the same
authorized proxy. Content-bound subtitle conversions retain parent ownership.

Deny remote sources at single/bulk admission, device ticket issue/redemption,
queue source replacement, restart/resume/retry and lazy resolver boundaries.
Remote library targets always miss local destination resolution. Check these
rules again after awaits; client capabilities are descriptive only.

Harness inventory must be derived with `rg` before editing: every construction
of `AccessSource`, `Revocations`, `MediaResources`, route context and fake store
must support the new collaborator contract. Do not bypass authorization with an
optional no-op resolver simply to keep old tests green.

Tests: provenance spoofing/normalization/cloning; all subroutes and cached bytes
with denied grants; revoke during probe, seek, subtitle conversion and Range;
401 versus content 403; generation change/restart; bounded reconnection;
version/cut resume; exact ID/conflict/episode matching; every download boundary;
local/addon playback regression. HTTP fixtures prove transport; re-run real
server history checks after this integration.

## MS-4: web/desktop and local personal state

Goal: complete the journey on web and shared desktop UI, including unmatched
items, independently loading source groups and local-user history.

Files: backend `store.ts`, `users.ts`, `routes/personal.ts`, `routes/home.ts`,
`home.ts`, `favorites.ts`, `progress-series.ts` and tests; web `App.tsx`,
`LibraryManager.tsx`, `api.ts`, `types.ts`, `streams.ts`, `home-cards.ts`,
`player-progress.ts`, resume/favourites views and their actual detail/browse
components. Discover component ownership in `App.tsx` before assigning edits.
All visible text uses `web/src/i18n/en.ts` and `cs.ts`; inspect other language
catalogue fallback requirements before adding keys.

Library management follows `docs/ui-conventions.md`: connect provider/address,
explicit LAN/loopback choices, credentials, connection check, selected remote
libraries, local names and grants. Show shared remote account limitations,
read-only status and dedicated-account guidance. Do not expose credentials in
connection list/edit responses. Disabled/offline libraries retain an explicit
status and authorized metadata. Confirmation distinguishes remove from forget.

Browse/detail cards carry provider-aware navigation. Remote controls offer
Play, local favourite/watched state, local resume and episode navigation. Hide
rename/move/delete/Identify/artwork/download-destination actions. Public source
capabilities suppress queue/device-save and backend still rejects them.
Source labels show provider, connection, library and version, never Local.

Playback responses supply canonical progress identity and selected version.
Both native/library and catalogue entry points persist the same per-user row;
remote histories do not appear under catalogue IDs. Add native remote Home,
resume and favourite variants plus visibility filters for every personal
read/write/count. A different account/server cannot inherit rows. Incompatible
versions start at zero; watched/favourites stay item-scoped.

Tests: MSW component journeys for connection/grants/errors; pure source ordering,
capability defaults, explicit/playing selection with late responses; duplicate
entry-point progress and two-user isolation; forged progress identity rejection;
Home/favourites with unmatched items; browser journeys through Docker. Run
visual verification once functional checks are stable, using the established
viewport matrix; regenerate baselines through the CI workflow if required.

## MS-5: Android TV and release verification

Goal: the same native browsing, sources, playback identity, local history and
read-only behaviour on TV. Reuse the backend API, not a TV-only provider login.

Files under `android-tv/app/src/main/java/cz/stremiooffline/tv/`: `data/TvApi.kt`,
`data/ApiClient.kt`, `data/CatalogDtos.kt`, `data/HomeDtos.kt`, `catalog/Streams.kt`,
`playback/Progress.kt`, and affected library/detail/catalog/Home/player screens
and view models. Derive exact files from the final web/backend DTO contract.
Update `test/.../ui/FakeTvApi.kt` and related DTO/stream/navigation/progress tests;
regenerate Android strings via the existing script/key list, never hand-copy
web English into Kotlin.

Remote item routes and unmatched Home cards must navigate without fake file
paths. Remote sources load independently, retain explicit selection, use the
same provider/library/version order and cannot enter To library/device save.
Read-only detail actions retain usable remote focus order and return focus to
the opening card. Local favourite/watched actions remain available.

Release gates: backend/web/desktop suites and builds, server/e2e type checks,
version synchronization, Android checks from
[development instructions](android-tv-development.md), Docker browser journeys,
real-server history/Range/subtitle checks, and one final viewport/TV review.
Deploy the app with its existing env/data paths only after functional checks;
coordinate the fixed container name with concurrent work. Verify `/api/status`,
container status and logs. Fetch/rebase onto main again before push and re-run
checks on conflict resolutions. Open a mergeable PR; never merge it.

The roadmap is shipped only after both providers and the complete
web/desktop/TV library-plus-catalogue journey meet the product acceptance checks.
Partial support remains explicitly experimental; a passing mock or one server's
success does not satisfy the other provider's gate.
