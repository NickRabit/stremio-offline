# Jellyfin and Emby libraries

Status: proposed; not implemented. Product decisions agreed on 2026-10-12.
This document specifies native media-server libraries for the web, desktop and
Android TV clients. It does not announce shipped support.

## Product contract

An administrator connects a Jellyfin or Emby account and selects its libraries.
Each selected library becomes a library in Stremio Offline with independently
assigned access for local users. Users do not sign in to the remote server.
An accessible remote item can be opened from its library, search or Home and
also appears as a source for a confidently matched catalogue title or episode.

All media goes through our backend proxy. The remote server supplies the
original media; our existing playback planner and FFmpeg handle direct play,
remux, audio conversion and video transcoding as required by the client.
Remote transcoding and client-to-remote-server playback are outside v1.

Watch position, watched state and favourites belong to each local user. Do not
import the shared remote account's history or write local history back to it.
Opening the same remote item through different entry points must address the
same local progress record.

No Stremio addon or companion plugin is required. Implement internal provider
adapters; do not introduce an externally installable plugin framework.

## Scope and interaction

- Add a Jellyfin or Emby connection from library management; connection editing
  and credentials are administrator-only. Show address, connection status and
  selected libraries without exposing tokens.
- Authenticate with a remote username/password, retain the resulting token,
  and discard the password. Allow multiple connections, including different
  accounts on the same server. Quick Connect and Emby Connect are deferred.
- Discover only libraries accessible to the connected remote account. Support
  movies, series and mixed movie/series libraries. Exclude music, live TV,
  recordings, books and other unsupported media types explicitly.
- Select remote libraries, give them local display names and assign each to
  local users using the existing library permission convention. Newly attached
  libraries are administrator-only until granted.
- Reuse library cards, details, pagination, search and applicable Home settings.
  Preserve remote metadata/artwork and season/episode structure. Browsing and
  playing an unmatched item must not depend on an external metadata service.
- List local copies first, then accessible media-server copies, then addon
  sources. Within media servers, use configured library order and stable
  version order. Label entries with Jellyfin/Emby, server, library and version;
  reserve the Local badge for files on our backend's disk.
- Fetch provider groups independently with bounded timeouts. A slow server must
  not block local/addon playback. Preserve an explicit source selection and
  never switch an active player because another group arrives.
- Remote libraries are read-only for media management. Hide filesystem rename,
  move, delete, Identify writes and artwork writes. They cannot be download
  destinations. Remote-source downloads to a local library/device are deferred;
  generic remote-stream eligibility must not accidentally enable them.
- Disconnected libraries remain visible to authorized users with an unavailable
  state and cached metadata; distinguish unavailable from an empty library.
  Turning a connection off prevents playback. Removal does not delete remote
  media; make the local-history retention choice explicit.

Dialogs and controls follow [UI conventions](ui-conventions.md). All visible
strings use the translation catalogues and Android string generation. Reuse the
existing web UI for desktop; TV implements the same backend contracts.

## Data and provider boundaries

Keep content type (`movie`, `series`, `mixed`) separate from provider kind
(`filesystem`, `jellyfin`, `emby`). The current `LibraryRecord.root` and path
operations are filesystem-specific: do not put an HTTP URL in that field or
pass remote items through the filesystem scanner.

Introduce typed records for:

- Connection: stable local ID, provider, normalized base URL, verified remote
  server ID, remote account ID, credential reference, enabled state and status.
- Remote library: stable local library ID, connection ID, remote library ID,
  content type, display order, Home settings and local-user grants.
- Remote item: connection ID plus opaque remote item ID, parent library/show,
  metadata and external identifiers. Versions add a media-source ID; expiring
  stream URLs are not persistent identifiers.
- Playback target/session: item and selected media source, local owner/session,
  authorization context, original-media transport and local playback state.
  Keep transport kind separate from provider identity and allowed actions.

Use a discriminated library representation or an explicit shared projection
with separate filesystem/remote storage. Every filesystem-only consumer must
receive an explicitly filtered filesystem collection. Remote health, counts,
browse and pagination use provider paths. Path-based routes reject remote
library IDs, including crafted requests. Migrate existing records as filesystem
libraries without changing their IDs, paths, grants or progress keys. Do not
require a wholesale rewrite of the local scanner to add this boundary.

The provider interface covers connection validation, authentication, library
listing, paginated items, details, search, episodes, versions and original-media
preparation. Share MediaBrowser request/mapping code where appropriate while
keeping Jellyfin/Emby endpoint and authentication differences in their adapters.
Do not assume compatible ancestry means identical current APIs.

Implementation must extend the existing boundaries explicitly:

- `server/src/media-resources.ts`: normalization currently whitelists stream
  fields. Preserve validated remote provenance through minting and cloning;
  attaching arbitrary fields before normalization is insufficient.
- `server/src/revocation.ts`: `contentOf` currently derives library access from
  `file://` URLs. HTTP media-server sources need explicit trusted library and
  connection identity for both final authorization checks and active sweeps.
- `server/src/security.ts` and outbound callers: thread the connection-specific
  network authorization through API, media, artwork and subtitle requests,
  including DNS resolution at socket connection time.
- Client stream/download eligibility and backend download routes must consult
  provider capabilities, not infer download permission from `kind: remote`.
- Home/progress projections need remote item identities without fake file paths
  or duplicated catalogue progress records.

Define a trusted server-owned content reference with provider, connection ID,
verified server ID, remote account ID, local library ID, remote item ID and
optional media-source ID. Preserve it in normalized resources and propagate it
to access checks, playback ownership, active transfers and revocation sweeps.
Clients cannot manufacture this reference by submitting stream fields. Recheck
access after awaited preparation/probing and before handing over results,
including inspect, previews, tracks, subtitles and every playback subroute.
Revocation aborts upstream reads, not just the public resource registry.

Remote artwork must always use a content-authorized proxy/cache path, even with
secure mode off. A generic shared catalogue image ID is insufficient. Bind
subtitle resources to the same content/owner and preserve that binding after
conversion. Return private cache policies and recheck grants before serving
cached bytes; already delivered bytes cannot be recalled.

Reject media-server sources server-side in download admission, device-save,
source replacement and resume. Public capabilities describe eligible actions;
client button visibility alone is not enforcement.

## Matching and local state

Maintain a bounded, paginated external-ID index for selected libraries. Scope
cached remote results to the connection/account; filter by local grants before
returning any item, artwork, count, source or Home card. Index updates run in the
background, with cancellation, retry backoff and explicit freshness. An outage
must never be interpreted as a successful empty scan or remove cached items.

Match by namespaced provider IDs (IMDb, TMDB, TVDB where available), including
media type. Cross-ID conversion may use existing metadata facilities but must
be cached, bounded and independent of browsing. Do not use fuzzy title matching
as an automatic playback decision. Cross-ID conversion applies only to remote
matching in this proposal; shipped local-source exact-ID behavior is unchanged.
Reject conflicting IDs; ambiguous results
remain browsable without being offered against the wrong catalogue title.
For episodes, verify the series and season/episode numbering; alternate orders,
anime absolute numbering and multi-episode files require explicit handling or
no match, never a guess. Preserve multiple legitimate versions as separate
sources rather than confusing them with ambiguous title matches.

Use a canonical identity of provider + verified server ID + remote account ID +
remote item ID. Connection IDs are handles, not content identities. Refuse a
duplicate connection for the same verified provider/server/account; different
accounts remain distinct, even if they expose the same film. A version adds its
media-source ID without changing the parent item's identity.

Return a server-derived playback identity/progress key to both clients. Store
explicit remote provenance with progress, watched markers and favourites; do
not parse a remote key as a catalogue ID or accept it as an unqualified file
path. One content-visibility check protects personal-state reads/writes, Home,
favourites, counts and search. Include native remote Home/card types so even
unmatched items remain usable without fabricated catalogue IDs.

Use one local-user progress key for the remote item regardless of whether Play
started in the library or catalogue. Keep that identity stable across token
renewal and address changes to the same verified server. An unrelated server or
account must not inherit cached content/progress by reusing an address.
Versions with different cuts/durations must not blindly share a resume offset;
record the selected media-source ID and duration. Resume the same version;
for a different version, start at zero unless compatibility is explicitly
established. Use filename and media-source ID as stable ordering tie-breakers. Cross-provider
history merging (remote vs filesystem vs addon) is deferred. Continue watching
must at least avoid duplicate cards for the same remote item/episode opened
through different entry points.

## Proxy and playback

Extend the existing opaque `sourceId`/media-resource ownership model with remote
connection/library provenance. Prepare fresh original-media access at Play,
rechecking grants and the remote account's current ability to read the item.
The listing must not create a playback session or start a remote transcode.

Original media means the provider's authenticated static/original-file endpoint
for the selected media source, not a remote transcode, remux or HLS URL. The spike
must establish the exact endpoint per provider/version. Keep the content
reference authoritative and resolved URLs short-lived. Re-resolve an expired
transport with bounded retries only after current access checks; never retry an
authentication failure indefinitely or use another account as fallback. Probe
Range behavior through the same authorized transport. If seeking cannot be
supported safely by our pipeline, report unsupported playback.

The proxy forwards required authentication server-side, supports HEAD/Range and
206 responses, and preserves cancellation/backpressure. Our playback planner
uses real client capabilities: compatible files pass through; supported video
may be remuxed with audio conversion; unsupported video or subtitle burn-in uses
our FFmpeg. Obtain media information from remote metadata when reliable, with
bounded probing when necessary. Include external/embedded subtitles, audio
selection, duration, seek and cleanup in the same playback contract. Define
provider-to-player track mapping explicitly: provider stream indices are not
necessarily ffprobe indices. Convert external subtitles into content-bound
sidecar resources. Use a bounded probe when metadata cannot safely establish
codec/track identity; unsupported subtitle formats get an explicit limitation
rather than a promise of new subtitle-engine capabilities.

Do not silently fall back to a remote transcode when original access is denied.
Show a meaningful unsupported/access error. Reuse existing local transcode
capacity limits and cleanup; the integration adds network inputs, not another
unbounded pool of FFmpeg processes. The remote server must be reachable from
our backend, including when desktop runs its bundled backend.

History isolation is a release gate. Avoid remote played/unplayed, favourite and
playback-report writes (`Sessions/Playing*`) for the shared remote account.
Verify on both servers whether original-media preparation/streaming creates a
session, affects user data or requires cleanup even without those reports.
Before implementation, record a provider/version-specific API allowlist:
read operations, authentication/logout and any required original-playback
preparation/cleanup. Playback preparation must disable remote transcoding.
Adding another mutation requires evidence that it preserves history isolation;
ordinary session reporting is not an allowed cleanup mechanism. If an original
stream path cannot preserve this contract, report the incompatibility rather
than introducing hidden shared watch-state writes. No automatic remote history
synchronization belongs in v1.

## Authorization, credentials and lifecycle

Effective access is the intersection of the local library grant, an enabled
connection/library and the remote account's permissions. Local administrator
access never bypasses a remote restriction. All backend surfaces enforce this,
including posters, subtitles, source preparation and subsequent media requests.
Revoking a local grant, disabling/removing a connection or rotating its account
invalidates outstanding sources/media resources and stops affected playback.
A remote 401 marks the connection as requiring reauthentication and revokes its
active resources. A 403/404 denies the affected item/session, without forcing
connection-wide reauthentication unless an account-level check establishes that
failure. Rate limits and 5xx errors are transient: back off and preserve cached
state, but never serve a previously buffered stream to bypass denied access.
Remote permission changes are detected on requests/revalidation, not assumed to
arrive instantly; define bounded revalidation for active sessions during the
spike. Local grant revocation remains immediate for undelivered data.

Store tokens server-side using a protected secret store; encrypt persisted
credentials with a deployment-managed key separate from exported configuration.
Never include credentials or authenticated upstream URLs in public DTOs, logs,
analytics, artwork URLs or ordinary configuration exports. Keep credentials out of `Settings` and `createSettingsBackup`. Ordinary exports
contain connection metadata only and require reauthentication after restore.
A missing/changed encryption key leaves connections unavailable and requiring
reauthentication; never regenerate a key and silently accept unreadable secrets.
Document separate recovery of the deployment key and encrypted secret store for
full data backups, including bundled desktop backend storage.

Administrators explicitly authorize the remote origin. LAN HTTP is needed for
home servers; this must be a narrow connection-specific network grant, not a
global weakening of outbound URL checks. Validate resolved addresses, ports,
redirects and every media/artwork/subtitle destination; do not forward a token
to another origin; reject authenticated cross-origin redirects, including URLs
with query credentials. Do not reuse the global addon LAN bypass. Block cloud
metadata, unspecified and multicast destinations; any required loopback access
must be a separate explicit administrative decision. Restrict requests to the
configured origin/base path, with socket-time DNS checks. Support reverse-proxy
base paths. Unexpected server identity
changes require administrator reconnection and cache/resource invalidation.
Bound request time, response size, concurrency and cache growth.

Cache and history cleanup must separate disable, temporary outage and explicit
removal. Credential replacement cancels work under the old identity. Persist
configuration atomically and ensure restart does not revive revoked sources.
Disable preserves local state and grants but stops access. Remove revokes access,
deletes credentials when the connection is removed, and retains local history
for 30 days under the verified identity; retained data is not visible without a
current grant. Reattaching the same verified identity may recover retained item
history, but starts administrator-only and never silently restores user grants.
Remove and forget purges the corresponding cache/personal references immediately.
A different account/server cannot recover that history.

Explain in connection management that all local users share the remote account's
stream/device limits and account restrictions. Local history isolation does not
promise an invisible network footprint or absence of remote access/activity logs.
Recommend a dedicated remote account with only the required libraries.

## Delivery and verification

1. Provider feasibility spike: use real Jellyfin and Emby servers to verify
   authentication, selected libraries, original-media Range access, subtitles,
   reverse-proxy base paths and absence of remote watch-state mutations. Record
   exact tested versions; do not advertise Nuvio's minimum versions as ours.
2. Backend records/adapters and authorization: preserve filesystem contracts,
   support multiple connections, credential lifecycle, bounded index and caches.
3. Library integration: management, grants, browsing/details, search and Home
   on web/desktop and TV, with read-only capabilities and unavailable states.
4. Catalogue sources and playback: matching, versions, proxy/FFmpeg integration,
   local progress and revocation. Finish the full cross-client journey before
   marking the roadmap feature shipped.

Acceptance checks:

- An admin attaches two libraries from one account and grants only one to a
  user. The other is absent from browsing, search, counts, Home and sources;
  guessed item, artwork, subtitle and source IDs cannot retrieve it.
- An allowed film and episode play from library and catalogue through our proxy
  on web, desktop and TV. Their local resume state agrees across entry points.
- Two local users share a connection but retain independent watch state and
  favourites; the remote account's history is unchanged after playback/seek/stop.
- Direct, remux/audio conversion and real transcode paths work with representative
  codecs/subtitles; no remote transcode or duplicate local conversion is started.
- Version choice is honored; incompatible cuts do not receive a wrong resume
  offset. Missing/conflicting IDs and alternate episode orders do not misplay.
- Grant revocation during listing/preparation and during playback removes access,
  stops media delivery/FFmpeg and does not leak cached artwork or subtitles.
- Token expiry, remote 403, disconnect, restart, changed server identity and
  credential replacement produce recoverable states without stale authorization.
- A slow/offline server does not delay other source groups or erase libraries.
  Large libraries paginate/index within bounded memory and request concurrency.
- Existing local libraries, addon playback and downloads remain unchanged;
  remote libraries cannot become write/download targets through crafted requests.

Follow [Testing](testing.md): domain/adapter tests for identity, matching and
permissions; HTTP fixtures for API/Range behavior; focused end-to-end journeys
for grants, sources and resume; real-server checks for history and codec claims.
Implementation requires builds, applicable tests, version synchronization,
local Docker startup and `/api/status`. Perform visual verification once the
functional implementation is stable. This documentation-only proposal needs
link/diff checks, no release bump or runtime deployment.

## References and consultation

Research checked on 2026-10-12:

- [NuvioMobile implementation PR](https://github.com/NuvioMedia/NuvioMobile/pull/2081):
  native server libraries and source matching; experimental, merged 2026-10-08.
- [Nuvio provider boundary](https://github.com/NuvioMedia/NuvioMobile/blob/416d97d/composeApp/src/commonMain/kotlin/com/nuvio/app/features/servers/ServerProvider.kt)
  and [matcher](https://github.com/NuvioMedia/NuvioMobile/blob/416d97d/composeApp/src/commonMain/kotlin/com/nuvio/app/features/servers/ServerMatcher.kt).
- [Emby authentication](https://dev.emby.media/doc/restapi/User-Authentication.html),
  [PlaybackInfo](https://dev.emby.media/reference/RestAPI/MediaInfoService/postItemsByIdPlaybackinfo.html)
  and [playback reporting](https://dev.emby.media/doc/restapi/Playback-Check-ins.html).
- [Jellyfin transcoding](https://jellyfin.org/docs/general/post-install/transcoding/).
- Existing [local sources](local-sources-spec.md), [accounts](users.md) and
  [playback](playback.md) remain the baseline contracts.

Design consulted with DeepSeek through `codex --profile deepseek exec` on
2026-10-12 against this repository. Incorporated findings: explicit filesystem
boundaries, trusted resource provenance/revocation, personal-state filtering,
content-bound artwork/subtitles, server-side download denial, credential recovery,
per-connection network grants, stable identity, provider error handling and
track/transport lifecycle. This was a design review, not a real-server test.

Recommendations not adopted verbatim:

- Restoring grants on reattachment would violate the administrator-only default;
  only identity-bound history can be recovered automatically.
- Remote ID conversion can differ from the existing local exact-ID contract;
  this feature does not silently change local-source matching.
- Provider DirectStream/remux output is not an original-file input for v1.
- Do not exclude unmatched items from Home/favourites or defer all versions:
  native remote identities and explicit version selection are part of the scope.
- Delivery may use several PRs/experimental gates, but label partial support
  honestly and retain the complete library-plus-sources acceptance target.

Nuvio informs the provider/matching boundaries. Its remote playback reporting
and remote transcoding are deliberately not adopted for our shared-account v1.
