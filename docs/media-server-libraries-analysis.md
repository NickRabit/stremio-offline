# Read-only media-server libraries: implementation analysis

Status: design and repository analysis, not shipped support. Initially analysed on
2026-10-12 against `origin/main` at `f396a27` (version 0.5.50).
The product contract is [Jellyfin and Emby libraries](media-server-libraries-spec.md).
The executable delivery plan is [implementation tasks](media-server-libraries-tasks.md).

## Scope decision

Jellyfin and Emby are native, read-only content providers. Administrators manage
connections, local names, ordering and local grants. These configuration changes
must not change remote libraries. Local users may browse, search, play, resume,
mark watched and favourite; the last three modify only our per-user data.
Remote rename, move, deletion, Identify/metadata changes, artwork writes and
remote-source downloads are unavailable, including through crafted API requests.
Remote libraries are never download destinations.

Read-only does not mean forbidding authentication POST requests. The production
adapter has a provider/version-specific request allowlist: authentication and
logout are exceptions; any playback preparation exception must first pass the
history-isolation spike. No `Sessions/Playing*`, remote user-data updates,
favourites, watched flags, library refresh or metadata editing belong on it.
Administrative setup of disposable test servers is a separate fixture tool,
never part of the production adapter or its allowlist.

## Existing architecture and decisions

| Verified boundary | Current behaviour | Implementation decision |
| --- | --- | --- |
| `server/src/libraries.ts`: `LibraryRecord` | Requires `root`, `writeArtwork`; optional `readOnly` describes a filesystem mount | Keep it filesystem-only. Add separate remote records and a shared public projection; do not use `readOnly` as a provider discriminator |
| `server/src/store.ts`: `State`, `Store.libraries()` | Optional `libraries` array; schema version 3; users and personal maps in the same state file | Add optional connection and remote-library arrays. Keep `libraries()` returning only filesystem records so every existing scanner/path consumer retains its contract |
| `server/src/index.ts`: `refreshLibraryHealth`, `walkableLibraries`, `videoCache`, `libraryCache`, `libraryRootBrowse` | Health checks, directory walks and root projections use local paths | Leave scanner inputs local. Merge authorized provider projections only at public listing/browse boundaries |
| `server/src/libraries.ts`: `resolveLibraryPath`, `carveOuts`, `defaultLibrary` | Path containment, symlinks, root ordering, local download defaults | Remote IDs must miss these functions. No URL or invented filesystem path in `root` |
| `server/src/local-sources.ts`: `parseLocalRequest`, `localCopies` | Exact catalogue ID and verified episode numbers; `LOCAL_COPY_LIMIT = 20` | Keep local matching unchanged. Remote ID index and matching are a separate module |
| `server/src/types.ts`: `StreamItem`, `PublicStream` | Internal streams have extensible fields; public `kind` describes transport/playability | Add server-owned remote provenance and public capabilities; keep transport separate from provider identity |
| `server/src/media-resources.ts`: `normalizedStream`, `MediaResources.add`, `mediaStream`, `materialize` | Normalization discards unlisted fields; structured cloning happens before playback; subtitles minted separately | Explicitly preserve trusted content references through normalization/cloning/children. An addon or request body cannot create a trusted reference |
| `server/src/revocation.ts`: `contentOf`, `accessLost`, `Revocations.stopContent`, `stopUnreachable` | Library ownership comes from `file://`; access source exposes local libraries only | Introduce a content-aware access resolver with connection/library state and generation checks; extend sweeps to remote resources and upstream abort controllers |
| `server/src/roles.ts`: `USER_ALLOWED` | Ordinary users reach only explicitly allowlisted routes after `/api` stripping | Add each remote member route and method explicitly; keep connection administration admin-only; test against `roles.test.ts` |
| `server/src/routes/playback.ts`: `registerPlaybackRoutes` | Inspect, preparation, seek, preview, tracks, sidecars, generation files and media proxy share resource/session wiring | Every path must recheck current remote access. Inspect currently returns after awaited probing without a final `requireAccess`; the new path must add it |
| `server/src/security.ts`: `validateRemoteUrl`, `safeFetch`, `checkedLookup` | Global addon LAN exceptions; DNS checked again by an undici agent | Create a separate connection-scoped transport; do not broaden or reuse addon LAN bypasses |
| `server/src/images.ts`: `ImageProxy.proxied`, `fetch`, `rewriteMeta` | URL-derived shared image registry; secure-mode-dependent URL rewriting | Use a dedicated content-authorized artwork route/cache for remote media in every mode |
| `server/src/store.ts`: `StoredProgress`, `WatchedMarker`; `server/src/users.ts`: `UserData` | Progress can carry a filesystem path or addon key; personal maps are per local user | Add explicit remote identities, selected version/duration and visibility filtering; no fabricated file/catalogue IDs |
| `server/src/home.ts`: `HomeCard`, `ResumeSources`, `mergeResume`; `server/src/favorites.ts`: `FavoriteEntry` | File and catalogue variants only | Add native remote variants; deduplicate remote entry points by canonical item identity, preserving account isolation |
| `server/src/backup.ts`: `createSettingsBackup`, `remapBackupLibraries`; `routes/settings.ts` | Exports settings/addons/filesystem libraries | Export remote metadata separately without tokens; restore disabled and administrator-only until reauthenticated |
| `web/src/streams.ts`: `canQueue`, `catalogSourceRows`, `repickStream` | Playable HTTP generally implies downloadable; sources combine local then addons | Consult capabilities; add a separate remote group; preserve explicit and playing selections |
| TV `catalog/Streams.kt`, `data/CatalogDtos.kt`, `playback/Progress.kt` | Mirrors source eligibility and progress logic in Kotlin | Change the same contract and fixtures on TV; web-only enforcement is insufficient |

The separate-storage decision avoids changing the meaning of dozens of
`Store.libraries()` consumers at once. Local IDs, paths, progress keys, directory
watchers and backups remain valid. It does require explicitly updating shared
surfaces: list/root browse, Home, personal visibility, user grant counts and
connection management. An implicit array concatenation is forbidden.

## Exhaustive boundary audit required during implementation

The following is a candidate inventory, not a claim these changes have shipped.
Re-run the commands on the implementation base: other work is merging into main.

```sh
rg -n 'libraries\(\)|LibraryRecord' server/src --glob '!*.test.ts'
rg -n 'app\.(get|post|patch|put|delete)' server/src/routes
rg -n 'sourceOf|httpSourceOf|contentOf|requireAccess|safeFetch' server/src
rg -n 'canQueue|downloadToDevice|localPath|kind.*remote' web/src android-tv/app/src/main/java
rg -n 'new (Store|MediaResources|Revocations)|AccessSource|RouteContext' server/src
```

| Candidate family | Disposition and reason |
| --- | --- |
| Local discovery/health/walking: `index.ts`, `library-watch.ts`, `library-autoscan.ts`, `library-probe.ts`, `library.ts`, `library-seen.ts` | Keep filesystem inputs; remote indexing is separate, with no `stat`, `realpath`, watcher or `freeSpace` on remote records |
| Filesystem helpers and admin: `libraries.ts`, `library-admin.ts`, `library-actions.ts`, `routes/libraries.ts` | Existing root grant, preview, reroot and path operations remain local. New remote configuration gets explicit routes; remote grant/order/enable changes invoke the same access cancellation guarantees |
| `routes/content.ts`: item DELETE, folder POST, rename POST, move POST, folders GET | All path mutations/destination pickers reject remote IDs before any syscall. Browse merges providers through the shared projection; gallery/thumb use authorized provider paths |
| `routes/curate.ts`: match, ops, suggestions, scan, source, next/previous | Matching/scan/artwork operations stay filesystem-only; remote source and episode navigation get dedicated provider methods |
| `routes/downloads.ts`: single/bulk admission, resume, retry; `downloads.ts`: queue resolution, target selection and restart | Deny remote source provenance and remote targets, even for administrators. Check again after async source resolution and when persisted jobs resume |
| `routes/device.ts`: ticket creation/redemption; `media-resources.ts`: `DeviceDownloadTicket` | Deny remote media-server sources at both boundaries; a stale ticket cannot bypass the policy |
| `routes/follows.ts`, addon download settings in `routes/addons.ts`, `naming.ts` | Lazy selections remain addon-only; library target resolution remains filesystem-only; remote sources never enter automatic follow/download selection |
| `routes/catalog.ts`: local/remote source groups, subtitles, image | Preserve existing local/addon requests; new remote group and content-bound image/subtitle paths filter grants after awaits |
| `routes/playback.ts`, `media-resources.ts`, `media-playlist.ts`, `range-cache.ts`, `playback.ts`, `player-sidecars.ts` | Trace actual original-media, probe, FFmpeg, range cache, subtitle and seek readers. Partition caches by verified identity and credential generation; cancel upstream work on revocation |
| `routes/personal.ts`, `routes/home.ts`, `home.ts`, `favorites.ts`, `progress-series.ts` | A single remote visibility predicate protects personal reads/writes, counts, resume, watched/favourites and all Home projections |
| `routes/users.ts` | Include permitted remote libraries in grant counts without leaking inaccessible library metadata |
| `routes/settings.ts`, `backup.ts`, `routes/diagnostics.ts`, `stats.ts`, `logger.ts` | Explicit public metadata projection; secrets never enter ordinary exports, diagnostics, stats, errors or logs |
| Web `App.tsx`, `LibraryManager.tsx`, `api.ts`, `types.ts`, `streams.ts`, `home-cards.ts`, `player-progress.ts` | Provider-aware management/navigation, capabilities, source groups and canonical playback identity. Verify actual component names before each task |
| TV `data`, `catalog`, `playback`, `ui/library`, `ui/detail`, `ui/catalog`, `ui/home`, `ui/player` | Mirror DTOs, source order, capability gating, native remote navigation, per-user progress and recoverable errors |
| Desktop | Shares web UI and backend; additionally document key/storage recovery and test bundled-backend access to LAN origins |

Review must enumerate the actual candidates reached by each PR and explain any
unchanged candidates. Passing compilation alone does not establish read-only
behaviour or effective revocation.

## Identity, trust and consistency

Canonical item identity is `(provider, verifiedServerId, remoteAccountId,
remoteItemId)`. Hash an unambiguous JSON tuple into a `remote:` progress key;
connection IDs and URLs are not identities. Versions retain the same item key
and store `mediaSourceId` and duration in progress. Switching to an incompatible
version starts at zero; same-version resume remains available through every
entry point. Reattachment can recover identity-bound history within 30 days,
but starts administrator-only and never restores grants automatically.

Use connection and library generation counters captured before asynchronous
work and checked before publishing results. Replacing credentials, disabling,
removing or detecting a different server invalidates the generation, source
resources and transfers. A final grant recheck prevents a pending list/probe
from publishing after a revocation sweep. Local revocation aborts body readers
and stops FFmpeg; deleting only source IDs is insufficient.

Remote 401 invalidates the connection's active resources and requires login;
403/404 denies only the affected content unless an account check proves a wider
failure. Timeouts, 429 and 5xx preserve metadata and retry with bounded backoff.
Cached metadata is labelled stale; failed scans never commit an empty snapshot.
Active playback must revalidate remote permission on a bounded schedule defined
by measured provider behaviour. Offline metadata is not permission to stream.

Persist configuration atomically. Secrets need AES-GCM with a deployment-managed
key outside ordinary exports, owner-only file permissions and authenticated
binding to the connection/verified account. Missing, changed or corrupt keys
fail closed without silently generating replacement keys. Desktop needs its own
persistent key lifecycle; never depend on a temporary session token as the key.

## Provider feasibility gates

API documentation establishes candidates, not real-server test results.
[Emby authentication](https://dev.emby.media/doc/restapi/User-Authentication.html)
describes user tokens and 401 reauthentication. Its
[PlaybackInfo API](https://dev.emby.media/reference/RestAPI/MediaInfoService/postItemsByIdPlaybackinfo.html)
exposes explicit direct-play, direct-stream, transcoding and playback flags.
Those flags do not prove streaming has no history side effects.

Record exact server image digests and reported versions. Test movie, episode,
multiple versions and external subtitles through a reverse-proxy base path.
Snapshot remote user data before authentication/preparation, after direct bytes,
after Range seek and after stop. Check active sessions/transcode output and audit
the complete request trace. Production must not call playback reporting merely
to clean up a test session. Test authenticated HEAD/206, cancellation, malformed
ranges, denied originals and changed credentials; never fall back to transcoding.

Real-server findings are recorded in [the spike report](media-server-libraries-spike.md).
Both tested static endpoints can continue serving known IDs after remote policy
changes. A successful media GET is therefore not an authorization check.
Adapters must independently revalidate current account playback policy,
account-visible library membership and item ancestry before issuing bytes.

The Nuvio comparison is recorded in [implementation reference](media-server-libraries-nuvio.md).

The result for each provider is one of: verified original-media path, explicitly
unsupported server/version, or not tested. Do not advertise compatibility based
on ancestry or the other provider's successful result. A mock HTTP suite can
prove our allowlist and failure handling, not provider history isolation.

## Delivery and concurrent main updates

Use sequential tasks in the linked plan: feasibility, backend foundation,
content authorization/playback, web integration, TV integration and release
verification. The central route/state files overlap; parallel implementation
would add conflicts without reducing the dependency chain. DeepSeek implements
coherent tasks in isolated worktrees; the coordinator owns architecture, code
review, commits, rebases and delivery.

PR #392 is the product proposal, not a prerequisite runtime implementation.
The first planning PR carries that proposal forward plus this analysis and the
task plan, and does not mark the roadmap shipped. No patch bump is needed for
planning. Each subsequent shipping PR takes the next patch on the freshly
fetched main and synchronizes all workspace versions.

At every worker start and before push, fetch `origin/main`, rebase and resolve
conflicts; rerun affected checks after rebasing. Record the base SHA in the
report. A merge by another agent may move the base during the task. Never reset
another checkout, edit another agent's tree, merge to main or overwrite the
running application's Docker container as part of analysis.
