# Nuvio implementation reference

Reviewed on 2026-10-12 at the merged revision
[`416d97d8`](https://github.com/NuvioMedia/NuvioMobile/commit/416d97d8cdcc987ed223d21f8e941347602c26d8)
from [NuvioMobile PR #2081](https://github.com/NuvioMedia/NuvioMobile/pull/2081).
This is a source review of that revision, not a claim about all later Nuvio
releases. Its PR describes experimental support and reports small-library
Jellyfin tests on iOS/Android, so its version floor is not our compatibility proof.
Our measured versions and limitations are in the [spike report](media-server-libraries-spike.md).

## Patterns worth adapting

| Nuvio source and symbol | What it does | Decision for Stremio Offline |
| --- | --- | --- |
| [ServerProvider](https://github.com/NuvioMedia/NuvioMobile/blob/416d97d8cdcc987ed223d21f8e941347602c26d8/composeApp/src/commonMain/kotlin/com/nuvio/app/features/servers/ServerProvider.kt) | Explicit provider operations/capabilities for libraries, pages, details, candidates, matching and playback | Keep a typed internal provider boundary. Omit remote state-write/report operations from our interface altogether |
| [MediaBrowserProvider](https://github.com/NuvioMedia/NuvioMobile/blob/416d97d8cdcc987ed223d21f8e941347602c26d8/composeApp/src/commonMain/kotlin/com/nuvio/app/features/servers/mediabrowser/MediaBrowserProvider.kt): endpoint hooks, mapping and pagination | Shares MediaBrowser logic while concrete providers supply endpoint differences | Share request/mapping utilities, keep provider-specific authentication/endpoints tested separately |
| [MediaBrowserClient](https://github.com/NuvioMedia/NuvioMobile/blob/416d97d8cdcc987ed223d21f8e941347602c26d8/composeApp/src/commonMain/kotlin/com/nuvio/app/features/servers/mediabrowser/MediaBrowserClient.kt): `authorizationValue`, `buildUrl` | Builds client/device authorization with a token field and preserves base paths | Use authenticated backend headers and explicit base-path construction; reject malformed token values and constrain origin/redirect/DNS separately |
| [ServerMatcher](https://github.com/NuvioMedia/NuvioMobile/blob/416d97d8cdcc987ed223d21f8e941347602c26d8/composeApp/src/commonMain/kotlin/com/nuvio/app/features/servers/ServerMatcher.kt): `LibraryIndex.lookup`, `fetchEntries`, `findEpisode` use | Namespaces external IDs, filters conflicting IDs, indexes pages and resolves series episodes separately | Use exact typed IDs and conflict rejection. Keep local filesystem matching unchanged |
| [ServerStreams](https://github.com/NuvioMedia/NuvioMobile/blob/416d97d8cdcc987ed223d21f8e941347602c26d8/composeApp/src/commonMain/kotlin/com/nuvio/app/features/servers/ServerStreams.kt): `sources`, `ServerStreamSource.load`, `candidates` | Provides independently loading/error-reporting server groups and separate version candidates | Use independent backend/client groups and explicit versions; a slow provider must not delay local/addon sources |

Nuvio's matcher uses 500-item index pages, a ten-minute index lifetime, a
12-second wait and five-second cross-ID conversion timeouts. These are useful
examples of named limits. Its `fetchEntries` still accumulates the full index in
memory; page size is not a total memory bound. Our backend needs explicit total
cache/disk limits and a last-good snapshot on incomplete scans.

Its episode match also compares available air dates within two days. Missing
dates are treated as compatible, so this is a supplementary check, not proof of
an alternate episode ordering. Our adapter must reject unproven absolute,
multi-episode or alternate-order matches. The converted IMDb cache is keyed by
numeric TMDB ID at this revision; our key also includes media type because movie
and TV namespaces can share a number.

## Behaviour we must not inherit

[MediaBrowserProvider.preparePlayback/playbackSession/report](https://github.com/NuvioMedia/NuvioMobile/blob/416d97d8cdcc987ed223d21f8e941347602c26d8/composeApp/src/commonMain/kotlin/com/nuvio/app/features/servers/mediabrowser/MediaBrowserProvider.kt)
uses POST playback preparation, can select remote direct-stream/transcode
output, puts an API key in media/subtitle URLs and sends remote session reports.
Those are deliberate features of Nuvio's client architecture. Our shared-account
contract instead requires server-only credentials, original bytes through our
proxy, our FFmpeg and no remote history writes. Our tested static GET path does
not require Nuvio's session preparation/reporting chain.

Nuvio's [ServerPlayback](https://github.com/NuvioMedia/NuvioMobile/blob/416d97d8cdcc987ed223d21f8e941347602c26d8/composeApp/src/commonMain/kotlin/com/nuvio/app/features/servers/ServerPlayback.kt)
tracks active server playback, handles fallback/track restarts, and reconciles
newer remote resume state. Our player already owns conversion/seek lifecycle;
a second provider-specific player manager would duplicate it. Provider adapters
resolve authorized originals, then the existing manager owns playback.

[ServerUserStateProjection.apply](https://github.com/NuvioMedia/NuvioMobile/blob/416d97d8cdcc987ed223d21f8e941347602c26d8/composeApp/src/commonMain/kotlin/com/nuvio/app/features/servers/ServerUserStateProjection.kt)
can import the server's progress and watched state when connection settings allow
it. We omit this path entirely. Two local users sharing a remote account must
never import each other's activity or write it back. Remote identity belongs in
our local personal records, with a current visibility check on every projection.

Nuvio's server item references use a connection handle and upstream item ID. Our
persisted progress identity also includes verified server/account identity,
remaining stable through token renewal/address changes while preventing an
unrelated account from inheriting history after reconfiguration.

## Resulting implementation requirements

Carry forward typed providers, shared MediaBrowser mapping, exact external-ID
matching, library-scoped indexing, independent source groups and explicit
media-source versions. Add the boundaries specific to our server: per-library
local grants, trusted resource provenance, active revocation, protected secret
storage, per-connection LAN/DNS policy, content-bound private artwork/subtitles,
local per-user state and server-enforced download denial.

Nuvio source is architectural evidence, not a substitute for our own
read-only/authorization tests. The real-server finding that known static URLs
can remain readable after policy changes makes those additional backend checks
necessary even when a provider reports a playable candidate.
