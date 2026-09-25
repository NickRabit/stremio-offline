# Sonarr/Radarr bridge: research and agent assignment

Status: proposed, not implemented. Research date: 2026-09-24.
Related: [issue #220](https://github.com/NickRabit/stremio-offline/issues/220).
Repository baseline: `e875b15c3d27622b24bfff25c21298faaf209a5d`.

## Objective and recommendation

Allow an unmodified Sonarr or Radarr installation to find a release supplied by
an installed Stremio addon, request its download, track it, and import the
finished file. Ordinary torrent and Usenet indexers must keep using their own
download clients.

Start with a compatibility experiment using **Newznab plus a narrowly scoped
SABnzbd API adapter**. This is a proposed HTTP-to-*arr bridge, not an actual
Usenet service. Its NZB document is a private transfer envelope understood only
by this adapter. Do not claim general NZB support or production compatibility
until real Sonarr and Radarr installations pass the experiment.

This document assigns the experiment first and describes the subsequent MVP.
It does not authorize treating an unverified protocol sketch as a finished
feature. No Sonarr/Radarr containers were run during this research.

## Findings

### Protocol choice

Both applications select download clients by protocol before applying the
indexer's explicit client binding. Binding an indexer to a client therefore
does not remove protocol constraints. See the inspected
[Sonarr selection code][sonarr-provider] and [Radarr selection code][radarr-provider].

| Option | Benefit | Cost / decision |
| --- | --- | --- |
| Newznab + SABnzbd adapter | Existing clients accept a file upload and expose queue/history/import paths | Recommended experiment; requires a private NZB envelope and real compatibility tests |
| Torznab + qBittorrent/Transmission adapter | Familiar to torrent bridge users | HTTP sources have no real torrent metadata or info hash; introduces synthetic torrent semantics and seeding expectations |
| Native upstream HTTP indexer/client | Honest native protocol model | Requires upstream acceptance and releases in both applications; outside this repository's MVP |
| Blackhole/watch folder | Small prototype | Does not prove the requested client lifecycle and reliable failure tracking |

[Newznab in Sonarr][newznab] uses the Usenet protocol. Its
[Usenet client base][usenet-base] retrieves the download payload and validates
it before uploading it to the selected client. Consequently an arbitrary JSON
response or a redirect to the media file is insufficient.

The inspected [Sonarr][sonarr-nzb] and [Radarr][radarr-nzb] validators require an
XML `nzb` root and at least one `file` child. This is evidence that an envelope
may work, not a stable promise that a minimal fake NZB will always be accepted.
Use a well-formed, explicitly versioned envelope with an opaque server-issued
release reference, then prove the complete path in real applications. Reject
ordinary NZBs at the adapter; never interpret arbitrary segment IDs as URLs.

### Existing application seams

These findings are from the repository baseline above, not assumptions about
future code. Re-check them before implementation.

| File | Reuse / constraint |
| --- | --- |
| `server/src/addons.ts` | `allowedAddons`, `streamCandidates`, `streams`, `searchAll`, metadata lookup and per-addon capability filtering |
| `server/src/types.ts` | Streams can carry HTTP URLs, torrent hashes, external URLs, filenames, sizes and request headers; fields are optional |
| `server/src/tmdb.ts` | `tmdbExternalId` already resolves a TMDB movie/series ID to IMDb; requires configured TMDB access |
| `server/src/external-ids.ts` | IMDb-to-TMDB/CSFD link cache via Wikidata; not a general TVDB-to-IMDb resolver |
| `server/src/downloads.ts` | Durable queue, HTTP resume/retry, disk-space handling, owner checks and Real-Debrid handoff; targets currently follow library rules |
| `server/src/download-selection.ts` | Lazy source selection can choose alternatives; that behavior must not silently replace an *arr-selected release |
| `server/src/routes/downloads.ts` | Existing downloads require an authenticated owner and allowed source/library; browser `sourceOf` is not a machine integration contract |
| `server/src/media-resources.ts` | Browser media resources are session-bound and expire; unsuitable as durable release identities |
| `server/src/security.ts`, `outbound.ts` | Existing guarded outbound requests and provider limits must remain in use |
| `server/src/index.ts`, `auth.ts`, `restricted.ts` | Audit route order, authentication exceptions and restricted-mode policy before exposing new endpoints |
| `server/src/logger.ts` | Existing secret redaction; extend tests for integration keys and envelopes |

`DownloadQueue.remove()` preserves completed library media, while
`clearCompleted()` removes completed queue records. Neither operation is a
complete implementation of external-client history retention and deletion.
The current library destination model also needs an explicit staging seam.
Avoid constructing a second HTTP downloader just to bypass those constraints.

### Search is not a release feed

Stremio [stream responses][stremio-stream] are associated with a media/video ID;
they do not establish a universal feed of newly available releases. A catalogue
update is not proof that a new downloadable source appeared.

The first milestone supports interactive searches and *arr-initiated automatic
search commands. It does **not** promise unattended discovery of every newly
available episode. Recent-feed requests exist separately in the
[Sonarr request generator][sonarr-search]. An empty recent response must not be
marketed as working RSS automation. Leave RSS disabled in setup instructions.

A later release-discovery milestone needs its own decision: supported addon
feeds, or a bounded refresh of explicitly tracked titles. Define where that
watch list comes from, polling cost, stable first-seen dates and release
deduplication before promising ongoing automation. Do not close issue #220
merely because the manual search demonstration succeeds.

## Assignment to the implementing agent

### Phase 0: prove compatibility before product work

1. Read `AGENTS.md` and this document. Use an isolated branch from current
   `main`; preserve other worktrees and local changes. Record the tested app
   versions and container image digests. Upstream `develop` inspection is not
   evidence about an installed stable release.
2. Build a disposable integration harness with unmodified Sonarr and Radarr,
   a fake Stremio addon, and a valid local video fixture. Use separate ports,
   state directories and Docker project name from the user's live installation.
   The video must be long/large enough to pass their import checks; the tiny
   existing web-test fixture may be insufficient.
3. Offer one movie and one standard numbered episode through a minimal Newznab
   endpoint. Configure one SABnzbd-compatible client per application and bind
   the bridge indexer explicitly to that client. Use separate categories
   `stremio-movies` and `stremio-tv`.
4. Capture a sanitized request/response transcript of indexer test, client
   test, search, grab, queue polling, completion, import and history removal.
   Confirm both applications preserve the opaque reference inside the upload.
   A successful settings “Test” button alone is not sufficient.
5. Add an unrelated fake indexer/client pair and demonstrate that normal
   releases are not sent to this adapter. Reject a foreign NZB explicitly.
6. Produce a go/no-go report and a concrete protocol contract. If the envelope
   fails validation or import cannot work reliably, stop product implementation
   and report the actual failure plus the smallest alternative. If it passes,
   proceed to the MVP below without asking about routine implementation choices.

Expected compatibility surface to investigate (not a claim of completeness):

| Interface | Required experiment |
| --- | --- |
| Newznab `t=caps` | Advertise only working search parameters and categories |
| `t=movie`, `t=tvsearch`, `t=search` | Verify ID and text requests, category filtering, pagination and empty results |
| Download link / `t=get` | Return the private NZB envelope, never provider credentials |
| SAB `mode=version`, `get_config` | Pass real client validation; expose only adapter configuration |
| SAB `mode=fullstatus` | Implement if the tested client's configuration/path checks require it |
| SAB `mode=addfile` | Multipart `name` upload, `cat`, priority, persistent returned job ID |
| SAB `mode=queue`, `history` | Real response wrappers, field types, units, paging and category filtering |
| Queue/history `name=delete` | Respect `del_files`, history `archive` semantics and ownership |
| SAB `mode=retry` | Demonstrate stable job tracking through an explicit retry |

The [Sonarr][sonarr-sab-proxy] and [Radarr][radarr-sab-proxy] proxies supply the
initial wire contract. Derive DTO fields from the pinned versions used in the
harness, not from illustrative JSON. Consult the [SAB API reference][sab-api]
for parameter semantics. Do not implement unrelated SAB administration APIs.

### Phase 1: first usable HTTP bridge

**Scope.** Movies and single standard `SxxExx` episodes from installed HTTP(S)
stream addons. Exclude torrent-only streams, `externalUrl`, DRM, live streams,
archives, season packs, anime absolute numbering and daily/date episodes.
Start with direct downloadable media files; defer HLS/DASH unless the harness
explicitly proves finite media, reliable completion and import. HTTP URLs
already served by a debrid addon can work; resolving `infoHash` through the
application's own Real-Debrid integration is a subsequent milestone.

**Identity and matching.** Use IMDb IDs where available; normalize the wire
format and build the correct addon video ID. Reuse TMDB-to-IMDb resolution.
Only advertise TVDB lookup if a tested resolver exists. Support bounded title
and year lookup with deterministic ambiguity handling; never select the first
same-name result. Respect each addon's ID prefixes instead of assuming every
addon uses `tt...:season:episode`. Do not substitute episode numbering schemes.
Keep failed ID resolution distinct from zero matching releases. Cross-check
requests actually emitted by [Sonarr][sonarr-search] and [Radarr][radarr-search].

**Release metadata.** Create one result per selectable source. Preserve a
reliable release filename when present; otherwise construct a parseable title
from verified identity and known attributes. XML-escape all fields. Never
invent resolution, codec, language, source, size, seeders or release date.
Unknown quality remains unknown; the user controls acceptance through *arr's
profile. Prove how missing size behaves; if clients require a size, omit that
candidate until a bounded metadata lookup supplies one. Do not download or
ffprobe every result on each search. Limit fan-out, execution time and pages;
deduplicate concurrent requests and cache by principal and normalized query.

**Durable release records.** Persist random opaque release IDs with integration
owner, addon identity, media/video IDs, source fingerprint, known metadata,
first-seen time and expiry. Keep provider URLs and headers server-side. Do not
use a browser resource ID or hash of an expiring URL as the release identity.
Re-resolve short-lived links at grab time only when the same source can be
identified. If it cannot, report an unavailable release and let *arr search
again. Never silently download a different quality/language. Define retention
and bounds; accepted jobs must survive record expiry and restart.

**Idempotency.** Persist the release-to-job association atomically enough to
recover after a crash between enqueue and response. Concurrent/repeated grabs
for the same integration, category and release return the existing job ID.
Document an explicit re-download policy after history removal; do not make
network retries create extra downloads. Ordinary browser downloads must retain
their existing behavior.

**Machine authentication.** Add administrator-managed, revocable integration
credentials, bound to an existing user and an explicit addon allow-list. Store
key hashes and show newly generated secrets once. The integration can access
only the intersection of its allow-list and that user's current rights. Use
existing owner checks on enqueue/resume and handle disable/delete/revocation.
Restrict its credentials to bridge endpoints and its own jobs; they must not
authenticate ordinary settings or library routes. Reuse the application's
restricted-mode policy, request limits and outbound protection. Integration
setup must remain disabled by default.

**Staging and import.** Introduce an explicit external destination for queue
jobs: a configured staging root with separate incomplete and completed job
directories, outside normal browsable library roots. Reuse download mechanics
through a destination abstraction; preserve ordinary library rules. No fallback
into the default library if staging is unavailable. Publish “Completed” only
after successful finalization. Report the absolute path visible inside the
server container, not a library key or HTTP URL. Document shared mounts and
Remote Path Mapping. *arr owns final rename and library organization.

Keep the completion record until acknowledged removal; clearing the web queue
must not hide an unimported external job. A moved file is not automatically a
failed transfer. History removal without data deletion preserves staged files;
explicit data deletion can remove only files within that job's staging
directory. Reject traversal and symlink escapes and make cleanup retry-safe.
No action may delete files already imported into an *arr library.

**State mapping.** Resolve queue `queued`, `checking`, retry waits and pauses to
appropriate nonterminal SAB states; never report a storage/permission pause as
completion. Terminal errors go to failed history with sanitized reasons.
Report bytes, remaining size and speed in the units the client expects. Prove
restart, cancellation, disk-full recovery and retry behavior against real
client polling. Keep the bridge's history scoped by integration and category.

**Setup UX.** Add an administrator integration form with enable/disable, user,
addon selection, staging path, credential creation/rotation and connection
details. Provide copyable indexer URL, client host/port/base path and category,
plus concise binding/shared-volume instructions. Name the compatibility mode
honestly and explain that regular NZBs and torrent files are unsupported. Put
all UI strings in `web/src/i18n/en.ts` and `cs.ts`; use `AppError` catalogue keys
for interface errors. Credentials and provider URLs must not enter feeds,
unrelated API responses, logs, screenshots or test transcripts.

### Acceptance and delivery

| Scenario | Evidence required |
| --- | --- |
| One movie in Radarr; one numbered episode in Sonarr | Search → grab → real HTTP download → completed import, verified final file |
| Automatic search command | Works with the same result contract; no claim of RSS discovery |
| Expired HTTP link | Refreshes the identical source or reports unavailable; never substitutes another release |
| Duplicate grab and restart | One durable job, stable ID, resumed transfer and retained history |
| Failed source / disk full / revoked rights | Accurate nonterminal or failed state; no false completion |
| Cleanup | Record-only removal preserves data; deletion stays inside the owned staging directory |
| Isolation | Foreign key, category/job ID and ordinary NZB cannot access or mutate another job |
| Coexistence | Normal browser downloads and existing torrent/Usenet clients still work |
| Missing or ambiguous metadata | Honest unknown/empty/error response, no manufactured quality or identity |

Add focused unit and HTTP contract tests for parsing, matching, authentication,
idempotency, state conversion and filesystem containment. Keep the real-*arr
harness reproducible and separate from routine lightweight tests. Publish exact
tested versions and sanitized evidence, including limitations.

Follow `AGENTS.md`: run build and unit tests, the relevant end-to-end checks,
then deploy the implementation to local Docker and verify `/api/status` and
logs. Run visual checks once after functional stability. Bump the patch version
only for the shipping implementation, keep all package versions synchronized,
rebase onto current `origin/main`, push a task branch and open a PR. Do not
merge. A research-only PR needs neither a version bump nor runtime deployment.

Suggested delivery sequence: compatibility harness/report; authenticated
bridge with durable records and staging; setup UX and operational docs;
separate Real-Debrid and release-discovery follow-ups. Each shipped slice must
be independently testable. Use “Related to #220” until the promised automation
scope is actually delivered.

## Sources and limits of the research

Upstream code links below are pinned to commits inspected on the research date.
The recommendation is an engineering inference from those contracts. It is not
a completed compatibility certification. The experimental agent must resolve
the exact response schema, missing-size behavior, source fingerprint policy,
retention limits and stable-release support through the harness.

[sonarr-provider]: https://github.com/Sonarr/Sonarr/blob/cab419ade8ac7fcab5bf80394ee492abd35d5f5a/src/NzbDrone.Core/Download/DownloadClientProvider.cs
[radarr-provider]: https://github.com/Radarr/Radarr/blob/c90668a520664ad0c91812cfee57c41928ad2148/src/NzbDrone.Core/Download/DownloadClientProvider.cs
[newznab]: https://github.com/Sonarr/Sonarr/blob/cab419ade8ac7fcab5bf80394ee492abd35d5f5a/src/NzbDrone.Core/Indexers/Newznab/Newznab.cs
[usenet-base]: https://github.com/Sonarr/Sonarr/blob/cab419ade8ac7fcab5bf80394ee492abd35d5f5a/src/NzbDrone.Core/Download/UsenetClientBase.cs
[sonarr-nzb]: https://github.com/Sonarr/Sonarr/blob/cab419ade8ac7fcab5bf80394ee492abd35d5f5a/src/NzbDrone.Core/Download/NzbValidationService.cs
[radarr-nzb]: https://github.com/Radarr/Radarr/blob/c90668a520664ad0c91812cfee57c41928ad2148/src/NzbDrone.Core/Download/NzbValidationService.cs
[sonarr-sab-proxy]: https://github.com/Sonarr/Sonarr/blob/cab419ade8ac7fcab5bf80394ee492abd35d5f5a/src/NzbDrone.Core/Download/Clients/Sabnzbd/SabnzbdProxy.cs
[radarr-sab-proxy]: https://github.com/Radarr/Radarr/blob/c90668a520664ad0c91812cfee57c41928ad2148/src/NzbDrone.Core/Download/Clients/Sabnzbd/SabnzbdProxy.cs
[sonarr-search]: https://github.com/Sonarr/Sonarr/blob/cab419ade8ac7fcab5bf80394ee492abd35d5f5a/src/NzbDrone.Core/Indexers/Newznab/NewznabRequestGenerator.cs
[radarr-search]: https://github.com/Radarr/Radarr/blob/c90668a520664ad0c91812cfee57c41928ad2148/src/NzbDrone.Core/Indexers/Newznab/NewznabRequestGenerator.cs
[stremio-stream]: https://github.com/Stremio/stremio-addon-sdk/blob/ec4e0a49e61bac4f2285891d39414dfbafe93f58/docs/api/responses/stream.md
[sab-api]: https://sabnzbd.org/wiki/configuration/4.5/api
