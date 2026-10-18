# Search everywhere: implementation proposal

Status: implementation design after two reviews. No application code ships
in this PR. The first review and the second pass, which adopted one shared
search engine, are in
[search-everywhere-implementation-review.md](search-everywhere-implementation-review.md).
The implementation brief in
[search-everywhere-agent-task.md](search-everywhere-agent-task.md) overrides
four points of this plan (Catalog migration, artwork, local index, delivery)
and splits the work into slices.

This document turns the decisions in
[search-everywhere-review.md](search-everywhere-review.md) into a concrete
implementation plan. The first release adds Search everywhere and puts Catalog
addon search on the same engine. Catalog browsing, controls, history, scopes,
sort and `mergeByName` stay. The one Catalog search change is arrival: a fast
catalog can paint before a slow one finishes. `GET /api/search` keeps its
JSON shape for IdentifyDialog, library identification and older clients.

Where this document and the earlier review disagree about Catalog migration,
this document wins. The original brief remains historical.

## Decisions

1. Search everywhere is a dedicated web view and a global mode of the existing
   Android TV Search rail entry.
2. One shared search engine serves both surfaces. Catalog browsing stays on
   `GET /api/catalog`. Catalog search keeps its controls, history, scopes, sort
   and `mergeByName`, and reads a catalog-only session so ready catalogs paint
   before the slowest addon. `GET /api/search` stays a one-shot compatibility
   response.
3. Search everywhere uses a server-owned, in-memory search session. Sources
   start in the background and the client receives bounded JSON snapshots by
   polling. SSE is not part of the first release.
4. Source pages are delivered independently. A slow addon, indexing library or
   media server never blocks a ready source.
5. Search everywhere merges by conservative strong identity, not by title and
   year. Catalog keeps today's `type:id` merge and does not use that clustering.
   Every original source record remains available in the cluster detail.
6. `globalSearch: false` is enforced for every all-addon scope on both
   surfaces, including retries, continuations and cache paths. An explicit
   addon or catalog scope exists only in Catalog in this release. Search
   everywhere has no per-addon picker, so those addons do not appear there.
7. Search queries for the new surface never use persisted Catalog history,
   browser storage, route URLs or disk-backed Android state.
8. The first release is not complete until web and TV can read the same server
   contract and both handle catalog, local and remote sources.

## Non-goals

- Do not change Catalog controls, Catalog history, Catalog sorting, `mergeByName`
  or catalog browsing.
- Do not change the `GET /api/search` JSON shape, query-string contract, or the
  `SearchResult` returned to IdentifyDialog and `LibraryCandidates`.
- Do not put local or remote library hits on `GET /api/search`.
- Do not apply Search everywhere clustering, append-only rank, or the stalled
  continuation rule to Catalog.
- Do not add a sixth item to the compact mobile bottom navigation.
- Do not merge by normalized title, release year or filename alone.
- Do not resolve missing external IDs through TMDB, Wikidata or addon metadata
  during search.
- Do not add fuzzy matching, semantic search, AI query expansion or query
  analytics.
- Do not persist search sessions or query-bearing cursors.

## Architecture

```text
Web Search view ─┐
Android TV ──────┼─ POST /api/search/everywhere
                 │        │
                 │        v
                 │  SearchSessionManager
                 │        │
                 │        ├─ bounded source scheduler
                 │        │    ├─ catalog adapters
                 │        │    ├─ local snapshot adapters
                 │        │    └─ remote library adapters
                 │        │
                 │        └─ source records -> identity clusters
                 │
                 └─ POST poll / page-all / retry / DELETE
```

The session owns the query, source targets, paging cursors, retained records,
cluster result and revision counter. Clients never receive an upstream URL,
provider credential, raw provider cursor or absolute local filesystem path.

### Shared engine, two projectors

Addon search has one transport. `catalog()` and `catalogWithExtras()` remain
the single-catalog browse helpers behind `GET /api/catalog`, including a
browse URL that happens to carry `search`. They are not the multi-catalog
search engine. `searchAll` stops being that engine.

The shared adapter discovers targets with `searchableCatalogs` and fetches one
raw catalog page. A raw page is the decoded metas, the target key, the target
order, and the next raw `skip`. It does not apply a 20-row acceptance cap, an
overflow buffer, a field allowlist, a merge, or a cursor encoding. Those belong
to the projector. The adapter does own host fairness, the abortable queue, the
12-second budget measured from outbound admission through the bounded body
read, and failure as a fixed code (`timeout`, `abort`, `network`, `http-503`,
`invalid-json`). A caller abort is `cancelled` and is not an addon outage.
Neither projector logs `reasonOf` or any upstream body.

Two projectors sit on that raw page:

| | Catalog projector | Everywhere projector |
| --- | --- | --- |
| Callers | Catalog web `loadPage`, TV `SearchViewModel.load`, and `searchAll` | Search everywhere session |
| Rows kept | Every meta on the raw page, same fields `searchAll` spreads today | At most 20 accepted rows; overflow stays in the session buffer |
| Merge | `type:id` across addons, folded in target order | Strong identity, plus a scoped opaque id only as defined below |
| Cursor | One base64url object of per-catalog offsets; `-1` means that catalog is exhausted | Server-side only; the client never sends it |
| Failure | That catalog's offset becomes `-1`, as `searchAll` does today | `failed` or `timedOut`, cursor unchanged, retryable |
| Empty page | Exhausted for that catalog | Three no-progress pages become `stalled`, not exhausted |
| History | Unchanged `recordSearch` path | Never |

`searchAll` becomes a waiter over the Catalog projector. It still returns
`SearchResult` `{ items, cursor, hasMore, sources }`, still folds settled
catalogs in target order rather than completion order, and still marks a
rejected catalog `-1`. `GET /api/search` stays that one-shot response.
`IdentifyDialog` and `LibraryCandidates.searchCinemetaOf` keep calling it.
`searchCinemetaOf` still passes the Cinemeta addon and
`respectGlobalSearch: false`.

The Catalog page and TV Catalog-origin search stop waiting on that one-shot
for their own grid. They open a catalog-only session (`sources: ["catalog"]`,
plus the existing scope of all addons, one addon, or one catalog) and paint
metas as each target completes. Insertion follows target order, so the first
target still wins `type:id` metadata when two catalogs share an id. Controls,
history, sort and `mergeByName` stay in the clients. A page that adds no new
`type:id` still ends Catalog continuation, which is the current
`gainedNothing` behavior in `App.tsx` and `SearchViewModel.load`. Search
everywhere must not copy that stop.

Local and remote adapters are Everywhere-only. They never feed `GET /api/search`.

### New server modules

| File | Responsibility |
| --- | --- |
| `server/src/search-contracts.ts` | Runtime request parsing, public DTOs, source and cluster types, limits and stable error codes. |
| `server/src/search-session.ts` | In-memory session store, owner binding, revision notifications, polling waiters, expiry and cleanup. |
| `server/src/search-sources.ts` | Source target discovery, adapter interface, catalog/local/remote adapters and fair scheduling. |
| `server/src/search-identity.ts` | Strong-ID normalization, conservative cluster construction, deterministic display metadata and cluster ranking. |
| `server/src/search-local-index.ts` | Per-library searchable snapshots built outside request handling. |
| `server/src/library-snapshot-store.ts` | Shared, per-library walk/build jobs with bounded concurrency and atomic generation publication. Existing browse caches compose from it instead of owning one serial all-library walk. |
| `server/src/search-artwork.ts` | Memory-only, session-bound artwork URL mapping and bounded image fetch. It never writes a URL to disk and never calls the general image cache. |
| `server/src/routes/search-everywhere.ts` | Authenticated route registration and thin HTTP mapping onto the session manager. |

The modules should stay independent of Express except for the route module. The
session manager and identity logic must be directly unit-testable with fake
source pages and a controllable clock.

### Module contracts

The first implementation slice should establish these boundaries before UI work:

```ts
interface SearchAuthority {
  userId: string;
  sid: string;
  expiresAt: number;
  secretStamp: string;
  permissionsVersion: number;
  assertCurrent(): void;
}

interface SearchSource {
  id: string;
  sourceClass: SearchSourceClass;
  label: string;
  targetKey: string;
  next(cursor: string | undefined, signal: AbortSignal): Promise<{
    records: RawSearchRecord[];
    nextCursor?: string;
    exhausted: boolean;
  }>;
  revalidate(authority: SearchAuthority): void;
}

interface SearchSessionManager {
  start(authority: SearchAuthority, request: SearchStartRequest): Promise<SearchStartResponse>;
  poll(authority: SearchAuthority, id: string, revision: number, signal: AbortSignal): Promise<SearchPollResponse>;
  pageAll(authority: SearchAuthority, id: string): Promise<{ revision: number }>;
  retry(authority: SearchAuthority, id: string, sourceId: string): Promise<{ revision: number }>;
  memberDetail(authority: SearchAuthority, id: string, memberKey: string): Promise<SearchMemberDetail>;
  delete(authority: SearchAuthority, id: string): Promise<void>;
}
```

`SearchAuthority` is created in the route layer from `currentUser(req)` and
`currentSession(req)`. Background work cannot use the request-scoped
`accessClaims`; it compares the account secret, revoked session, permission
version and expiry against the live store before every delivery and before
starting a page. The manager never accepts a user id from the request body.

### Existing files touched

| File | Additive change |
| --- | --- |
| `server/src/addons.ts` | Add the raw catalog adapter and make `searchAll` a Catalog-projector waiter. `catalog` / `catalogWithExtras` stay the browse helpers. `searchAll`'s `SearchResult` and target-order fold stay. Failures log a fixed code. |
| `server/src/library.ts` | Add optional abort/deadline checks to the single-library recursive walk used by the snapshot store. Existing callers that pass no signal keep their behavior. |
| `server/src/outbound.ts` | Remove an aborted waiter from a host queue and settle it once, add an optional session fairness key, and hold the host slot through a bounded JSON body read for search. Replace raw failure messages in breaker diagnostics with fixed categories so an addon URL carrying the query cannot reach the log. The legacy fetch path keeps its current behavior. |
| `server/src/media-server-manager.ts` | Add a root-scoped search method that reuses the existing authority, connection-generation and post-await checks. This is separate from the user's current browse folder. |
| `server/src/media-server-provider.ts` | Extend the internal directory options with a bounded include-type set for `Movie`, `Series` and `Episode` search. Existing public browse queries keep their current types. |
| `server/src/index.ts` | Construct the session manager and local index, warm the index outside startup readiness, invalidate it with the existing library epoch, register the route module, and connect logout/account/addon/library revocations to session cleanup. |
| `server/src/server-shutdown.ts` | Close search sessions and waiters before the request drain; background source jobs must not extend shutdown. |
| `server/src/routes/personal.ts` | Add a read-only preferences response without `recent`, so the new page can honor search-while-typing without reading Catalog history. |
| `server/src/routes/settings.ts`, `server/src/api-types.ts` | Project the default-off server feature flag to authenticated clients. |
| `server/src/roles.ts` | Add ordinary-account permissions for the new routes. |
| `server/src/restricted.ts` | Allow the session POST/DELETE operations needed by the new search in restricted mode. |
| `web/src/api.ts` | Add typed start/poll/page/retry/detail/delete calls. |
| `web/src/types.ts` | Add public search DTOs. |
| `web/src/App.tsx` | Add the Search view, top-bar entry and existing-detail callbacks. Do not change Catalog search or browsing code. |
| `web/src/Home.tsx` | Add an entry action that opens Search. Do not add live result rows. |
| `web/src/i18n/*.ts` | Add every label, status and fixed error message to all ten shipped web catalogues; `en.ts` and `cs.ts` are not sufficient on their own. |
| `web/src/style.css` | Add the responsive Search layout using the existing global controls and five-slot navigation. |
| `android-tv/.../ApiClient.kt`, `TvApi.kt`, `CatalogDtos.kt` | Add the new contract. |
| `android-tv/.../GlobalSearchViewModel.kt`, `GlobalSearchScreen.kt`, `Shell.kt` | Add the separate rail-owned screen without changing Catalog-origin search. |
| `android-tv/app/src/main/res/values*/strings.xml` | Add the global-screen labels and statuses to every shipped Android TV locale and keep `strings.keys` in sync. |
| `docs/configuration.md` | Document the default-off feature flag and its rollback behavior. |

## HTTP contract

All responses use `Cache-Control: private, no-store`. Query text travels in a
JSON body, never in a URL. The routes are authenticated and bound to the current
account and session. The header is set before the handler's first await so an
error response is not cacheable either.

The request carries no language field in the first release. Catalog results use
the addon manifest's own metadata language; remote and local search use the
viewer's current UI-language preference on the server. Changing that preference
starts a fresh search. Clients cannot choose another account's language by
putting it in the body.

### Start a search

`POST /api/search/everywhere`

```json
{
  "query": "matrix",
  "kind": "all",
  "sources": ["catalog", "local", "remote"],
  "slotId": "slot_...",
  "generation": 7
}
```

`query` is trimmed and accepted at 1 to 200 Unicode code points **and** at most
256 UTF-16 code units. The second limit exists because the existing
Jellyfin/Emby parser accepts at most 256 UTF-16 code units; a 200-character
emoji query must be refused at the boundary instead of becoming an invalid
remote request. `kind` is one of `all`, `movie`, `series`; `series` includes
series and verified episode hits. `sources` is a
non-empty, duplicate-free subset of `catalog`, `local`, `remote`. Unknown keys,
wrong types and oversized arrays are rejected. `slotId` is generated by the
client when the Search surface mounts and is bound to the account and browser
session. `generation` is a monotonically increasing integer within that slot.

The slot makes replacement work even when the first start response is lost.
Before creating a new session, the server atomically cancels the session
currently held by `(account, browser session, slotId)` when its generation is
lower. A duplicate request for the same slot and generation is idempotent and
returns the existing session; a different query under the same generation is a
conflict. If the request is aborted before its response, the server may still
finish creating the generation, and the next generation will replace it. Slot
ids and generations are memory-only and never persisted.
The new request's shape and source count are validated before the old slot
session is cancelled, so a malformed replacement leaves the existing result
session usable.

The response is a snapshot after the first of these two events:

- all first source jobs have reached a terminal state for the first page,
- 300 ms have elapsed.

```json
{
  "id": "ss_...",
  "snapshot": {
    "revision": 3,
    "state": "partial",
    "sources": [],
    "clusters": [],
    "unidentified": [],
    "aliases": [],
    "limitReached": false
  }
}
```

An empty result is a valid snapshot. Pending sources are not an error. The
session remains alive when every source is pending.

### Poll for changes

`POST /api/search/everywhere/:id/poll`

```json
{ "revision": 3 }
```

The server waits up to 500 ms for a newer revision. It returns either:

```json
{ "revision": 3, "changed": false }
```

or `{ "changed": true, "snapshot": { ... } }`.

The client serializes polls. While any source is loading it waits 250 ms after a
no-change answer; when every source is terminal it backs off to one second, and
after the page has been complete for a while to a ten-second visible-page
heartbeat. That keeps a live result session from expiring while it is being
read. A hidden page stops polling. Poll disconnection does not cancel the
search. Each session has at most one waiting poll; a second request returns the
current revision immediately rather than creating another pending response.

### Continue all ready sources

`POST /api/search/everywhere/:id/page`

The body is empty. The request schedules one next page for every source that is
ready and has more results. It returns `202` with the current revision;
progress is delivered by polling. A source already loading a page is skipped,
so repeated clicks do not stack jobs.

The web UI's single "Load more" action calls this route once, subject to the
bounded scheduler, then resumes polling. Keeping this aggregate avoids opening
one same-origin HTTP request per addon; the server can schedule the pages in the
same fair order used for their first pages.

### Retry one source

`POST /api/search/everywhere/:id/sources/:sourceId/retry`

Only a `stalled`, `failed`, `timedOut` or `unavailable` source is retryable.
Retrying keeps its last successful cursor, buffered rows and records, and resets
only the no-progress counter. A failed page is never cached as an empty
successful page.

### Member and cluster detail

`GET /api/search/everywhere/:id/members/:memberKey?from=0`

Resolves the current cluster containing `memberKey`, then returns one page of
member records and typed locators. `from` is a non-negative offset into the
cluster's `memberKeys`, which stay in full on the snapshot. One page holds at
most 100 members and must stay under 512 KiB. The response includes `nextFrom`
when further members remain, and `truncated: true` in that case. A single
response does not claim to hold every member of a large cluster. A member key
is stable while a cluster key may be retired by a merge or split, so it is the
correct focus anchor and detail address. The route revalidates the session, every visible source, addon
grant, library grant and connection generation at delivery time. It never
resolves a missing provider parent or makes a metadata request merely to build
the detail. For each local member it may use the existing
`describeLibraryPath` projection to return the `BrowseItem` the current library
detail needs; this is a click-time read, not a search-time walk, and a missing
path removes that member instead of opening a broken detail. Remote and catalog
members keep their own native locators so no member has to be rediscovered from
a different ID namespace.

### Session artwork

`GET /api/search/everywhere/:id/artwork/:artworkId`

Returns one bounded, authorized image for a catalog member. The artwork id maps
in memory to the source record and URL that produced it; the URL never reaches
the client. The route rechecks the session, source grant and addon configuration
on every read, accepts only an image content type under the existing image size
ceiling, and returns `Cache-Control: private, no-store`. Revoking the source or
deleting the session makes its artwork ids miss. The store evicts least-recently
used bytes to keep the per-session and server-wide limits; a miss can re-fetch
while the source is still visible.

### End a search

`DELETE /api/search/everywhere/:id`

Cancels queued and active work, removes records and releases waiters. The
response is `204` even when the session is already gone. Expiry, logout,
permission change and account change clean sessions up without waiting for this
call.

Expired, invalidated or deleted session use returns `410` with
`{ "code": "search-restart-required" }`. A session id that does not exist, or
belongs to another account or browser session, is answered as missing (`404`)
rather than revealing that it exists. Both outcomes tell the clients to start a
fresh session. Cleanup runs on a timer during startup, not only when another
request arrives.

To distinguish an owner's expired id from an unknown one without keeping the
query, deletion writes a bounded owner-bound tombstone (id, account, browser
session and expiry) for ten minutes. At most 256 tombstones are retained. A
tombstone never contains query text or source records and is answered `410` only
to the same owner; every other caller receives `404`.

## Public data model

Names are illustrative; the implementation module owns the final TypeScript
definitions and runtime parsers.

```ts
type SearchKind = "movie" | "series" | "episode" | "season" | "folder" | "file";
type SearchSourceClass = "catalog" | "local" | "remote";
type SearchKindFilter = "all" | "movie" | "series";

type SearchSourceView = {
  id: string;
  sourceClass: SearchSourceClass;
  label: string;
  state: "queued" | "loading" | "ready" | "exhausted"
       | "stalled" | "failed" | "timedOut" | "indexing" | "unavailable";
  loaded: number;
  hasMore: boolean;
  continuation: "supported" | "unsupported" | "blocked";
  stale?: boolean;
  retryable: boolean;
  errorCode?: string;
};

type SearchClusterView = {
  key: string;
  kind: SearchKind;
  title: string;
  originalTitle?: string;
  year?: number;
  poster?: string;
  background?: string;
  sourceLabels: string[];
  hasLocal: boolean;
  hasRemote: boolean;
  memberCount: number;
  primaryMemberKey: string;
  memberKeys: string[];
  rank: number;
};

type SearchClusterDetail = {
  key: string;
  members: SearchMember[];
  /** Optional extra action: open one existing catalogue title page. */
  canonical?: { type: "movie" | "series"; id: string; name: string; poster?: string };
};

type SearchMember = {
  memberKey: string;
  sourceId: string;
  sourceClass: SearchSourceClass;
  sourceLabel: string;
  kind: SearchKind;
  title: string;
  year?: number;
  poster?: string;
  /** Hydrated only when the member-detail route is opened for a local member. */
  localItem?: BrowseItem;
  parentMemberKey?: string;
  parentIds?: { imdb?: string; tmdb?: string; tvdb?: string };
  season?: number;
  episode?: number;
  /** Last episode in a provider-verified multi-episode file. */
  episodeEnd?: number;
  conflict?: boolean;
  locator:
    | { kind: "catalog"; addonKey: string; type: string; id: string; catalogId?: string }
    | { kind: "local"; key: string; libraryId: string; itemKind: "file" | "folder" }
    | { kind: "remote"; libraryId: string; itemId: string; itemType: string; provider?: "jellyfin" | "emby" };
};
```

`snapshot.unidentified` uses the same cluster view for files, folders, unbound
local entries and unsupported item kinds. A movie or series with conflicting
strong IDs is not unidentified: it stays in the main list as a separate card and
is marked as a conflict inside its member detail. An unbound path remains
unidentified. This is not a second search API.

`aliases` is an optional bounded list of `{ retired, current }` cluster keys for
the current session. `memberKeys` lets the UI find the cluster that still
contains its focused member after a merge or split. It must not move focus to an
unrelated title.

Public text is projected, never spread from the provider object. Initial limits
are 300 code points for a title or original title, 120 for a source label, 1,000
for a description kept only in member detail, and 2,048 for an id or locator.
The serialized snapshot has its own byte ceiling; one oversized provider row is
dropped and counted rather than failing the whole source.

`poster` and `background` in a cluster/member are always same-origin. Existing
local thumbnail and remote-artwork routes keep their own grant checks; catalog
artwork uses the session artwork route above. Search must not call
`images.proxied()`: in normal secure-mode-off behavior that helper can return
the upstream URL directly, and in secure mode it persists the URL in the image
cache index. Neither is acceptable for a query-derived search payload.

The aggregate snapshot state is `partial` while any source is queued, loading or
indexing; `complete` when every requested source is terminal and at least one
answered successfully (an empty successful page counts); and `failed` only when
every requested source failed and no cluster is visible. A mixed
success/failure snapshot is `complete` with failed source rows, never a
page-level failure.

No response contains:

- the original query except in the initial request body,
- an upstream addon or media-server URL,
- credentials, provider tokens or absolute local paths,
- a provider cursor that the client can submit directly,
- a server-side query cache key.

## Source discovery

Source discovery happens server-side after the current account's grants and
enablement are applied. A source is created only from an allowed target.

### Catalog sources

One source represents one searchable catalog, not an entire addon. This keeps a
slow catalog from blocking its siblings and makes pagination explicit.

Target discovery uses the existing helpers:

- `allowedAddons(store.addons(), viewer)`,
- `orderedForUser(...)`,
- `searchableCatalogs(..., { respectGlobalSearch: true })`.

Every source records its addon key, manifest configuration fingerprint, catalog
type, catalog id and target order. It is created only when the addon is enabled,
the user is granted access, the catalog declares a usable `search` extra and the
addon is not excluded by `globalSearch`.

The raw adapter calls the addon's catalog endpoint with:

- `search=query`,
- `skip=source cursor`,
- the same timeout and user agent as the existing helpers,
- an abort signal owned by the caller.

The response is read with a byte ceiling. The raw page keeps the metas the
addon returned. The Everywhere projector then projects an allowlist: type, id,
title, original title, year/release year, bounded description, artwork and
source order. Unknown provider fields never enter a Search everywhere session
record. The Catalog projector keeps the fields `searchAll` already returns.
Catalog artwork for Search everywhere is registered with the memory-only
session artwork store; a configured addon URL or token on an artwork address
must not reach that client. Catalog's own grid keeps using `images.proxied()`
as it does today.

`searchAll` is the one-shot Catalog waiter described above. Search everywhere
does not call it. `GET /api/catalog` does not call it either.

The abort path is end-to-end. `jsonFetch` combines the session signal with its
existing deadline (`AbortSignal.any` or the tested equivalent).
`OutboundGuard.acquire` accepts the same signal, removes an aborted waiter from
the queue and settles that waiter exactly once. A caller abort is reported as
`cancelled` and is not counted as an addon outage; only the addon's own timeout,
HTTP failure or malformed answer reaches the circuit breaker.

The 12-second source budget starts after outbound admission, not while the
request waits behind another addon on the same host. This needs an admission
callback or an equivalent `deadlineAfterAdmit` option in the outbound helper;
starting `AbortSignal.timeout` before the queue would make the last catalogs in
a host queue expire without ever being attempted. Queue waiting is bounded by
the session lifetime and per-class scheduling, not by the execution timeout.
The deadline covers reading the body, not only receiving response headers.
Cancellation of a queued request releases its host slot, start spacing and
half-open trial state exactly once, and an `AbortError` caused by the caller is
not counted as an addon outage.

The new catalog adapter uses a `guardedJson` helper rather than the current
`guardedFetch` plus a later `response.json()`. The host slot remains held until
the bounded body has been read and parsed, and malformed JSON is reported to the
breaker as a provider failure. Search requests carry a fairness key (`sessionId`)
so a session with many catalogs on one host cannot place all of its waiters
ahead of another session. Within a session, the catalog scheduler round-robins
targets by host before addon order, so a fast target on a different host starts
even when many targets share a slow one. Remote admission is likewise fair by
connection. `GET /api/search` uses this same adapter and the same admission
deadline. It still waits until every target has settled, then writes one JSON
response. Its fairness key is the authenticated session id, because that call
has no Search everywhere session. `GET /api/catalog` keeps the browse helper's
current timeout and does not take a search fairness key.

### Local sources

One source represents one visible local library. The source reads the
per-library searchable snapshot described below. A library with no ready
snapshot is reported as `indexing` and does not trigger a disk walk in the
request.

The result locator uses the existing wire key (`libraryId/relative`) and an
item kind. Absolute host paths remain server-only.

### Remote sources

One source represents one attached remote library visible to the account.
Discovery uses the same grant and connection checks as the existing remote
browser. The manager gains one internal, root-scoped search operation rather
than reusing the user's current browse state. It is called with:

- the attached library root,
- bounded `limit: 20`,
- `search: query`,
- the requested kind filter,
- the provider cursor stored only in the session.

The existing public `browseDirectory` cannot express the required search as-is:
titles mode includes only `Movie,Series,MusicVideo`, and `type: "series"`
returns series without their episodes. The new internal operation therefore
maps the kind filter to one recursive provider query:

| Kind filter | Provider include types |
| --- | --- |
| `movie` | `Movie` |
| `series` | `Series,Episode` |
| `all` | `Movie,Series,Episode` |

`MusicVideo` stays in ordinary title browse (`DIRECTORY_TITLE_TYPES`) and is
absent here. Search everywhere v1 does not search music videos. `All` does not
mean music-video coverage.

It always uses the library root, `Recursive=true`, the provider's search term and
the existing name ordering. It never inherits the selected folder, browse mode
or sort from the Library UI. The public browse routes keep their current
semantics and response shape.

Both provider and manager cursors bind a new search-operation version and the
effective include-type set, in addition to account, library, root, query,
connection generation and secret. Reusing a movie cursor for a series search,
or a cursor minted by ordinary browse, is refused rather than silently reading a
different page. The dedicated operation registers the same item proof used by
remote artwork and playback.

The existing media-server manager rechecks the acting account, grant,
connection generation, secret and returned content after every await. Episode
rows carry `seriesId`, season/episode and optional `episodeEnd`, but usually no
provider IDs of their own. An episode can be attached to a known parent only
when that parent and its validated strong ID are already in the session. No
parent-detail request is made during search. An episode whose parent identity
cannot be established remains a separate episode result; multi-episode files
retain their range.

Remote sources never use playback source discovery. Search is metadata search;
sources are resolved only after the user opens a cluster detail and chooses a
playback path.

## Source scheduler and lifecycle

Initial budgets:

| Limit | Value |
| --- | --- |
| Active catalog jobs per session | 8 |
| Active local jobs per session | 1 |
| Active remote jobs per session | 8 |
| Active jobs per remote connection | 2 |
| Active source jobs server-wide | 32 |
| Search targets per session | 60 |
| Retained source records per session | 1,200 |
| Records accepted from one source page | 20 |
| Serialized search data per session | 4 MiB |
| Search artwork bytes per session | 16 MiB |
| Search artwork bytes server-wide | 128 MiB |
| Sessions per authenticated session | 2 |
| Server-wide sessions | 50 |
| Idle session expiry | 5 min |
| Soft first snapshot budget | 300 ms |
| Poll wait | 500 ms |
| Source execution budget | 12 s |

These are implementation budgets, not product guarantees. They must be
centralized as named constants and covered by fake-source tests.

The record and byte ceilings are enforced while accepting records, not by
silently trimming the final cluster list. Reaching either ceiling stops further
pages, sets `limitReached: true` and leaves the source rows that did load
visible. The UI says the query is too broad and asks the user to narrow it; it
must not claim that the result set is complete. Member detail is paged, as
specified on that route. The 512 KiB ceiling is per page, not a promise that
one response lists every member.

A third session for the same authenticated session returns `429` with
`search-session-limit`. The 51st session on the server returns `503` with
`search-capacity-limit`. Replacing the caller's own slot does not take a new
seat: the old session is cancelled before the new one is counted. Neither
error includes the query. The client shows a fixed message and waits for the
next explicit submit. A retry sooner than one second after the previous retry
of that source returns `429` with `search-retry-limited` and does not change
the source.

The three classes have independent pools. A catalog backlog must not occupy the
only local slot or either remote slot. Catalog sources are seeded round-robin by
host and only then by the viewer's configured order; remote libraries likewise
round-robin by connection. The scheduler drains a source's first page before
starting another page for that source. The 12-second execution budget begins
when a job is admitted, not while it waits in a local queue or in the outbound
host queue. A queued source keeps state `queued`; it does not become `timedOut`
merely because another host request is slow.

The per-session pools are additionally capped by one server-wide scheduler
budget. No session may consume the whole instance: queued work is selected
round-robin across sessions, then by source class, host/connection and target
order. Logout, session replacement and shutdown release only that session's
global slots; a cancelled waiter must never leak a global token.

Remote adapters request at most 20 rows per page. An addon chooses its own page
size. Only the Everywhere projector keeps two server-only values for a catalog
source: the raw `skip` offset sent to the addon and a bounded buffer of raw
rows not yet accepted into the session. That projector accepts at most 20 rows;
the next Load more drains the buffer before another upstream request. The raw
offset advances by rows the addon actually returned, not by rows that survived
projection. Invalid rows therefore cannot make a page repeat forever, and valid
rows cannot be skipped merely to keep a page small. The Catalog projector does
not use this buffer. It accepts the whole raw page and advances the stateless
offset by that page's length, which is what `searchAll` does today.

Catalog `skip` support is read from the manifest's catalog extras. A catalog
that does not declare it contributes its first page with
`continuation: "unsupported"`; the UI does not imply completeness. If three
successive pages add no new member key, the source becomes `stalled` with
`continuation: "blocked"` and a fixed error code. It is not marked exhausted and
an explicit retry resumes from the unchanged raw offset and buffer.

If discovery finds more than 60 targets, start fails with a fixed
`search-too-broad` response containing the class counts. Silently searching only
an arbitrary subset and calling it "everywhere" would be worse than asking the
user to narrow the source class. A retry is rate-limited to one attempt per
source per second and does not change its successful cursor.

The lifecycle is:

```text
queued -> loading -> ready -> loading -> ... -> exhausted
                         \-> stalled
                         \-> failed
                         \-> timedOut
                         \-> unavailable

indexing -> ready
```

`ready` means one page is available and more may follow. `exhausted` means the
source returned a successful end-of-results page. A page with no new merged
cards is not immediately exhaustion; three no-progress pages become `stalled`
with `continuation: "blocked"`. A failed or timed-out page never advances its
cursor or discards its buffered rows.

On start, the manager creates all source rows and schedules the first page for
each. On the first snapshot deadline, it returns the records currently visible.
The remaining jobs continue unless the session is deleted, superseded, expired
or invalidated.

## Identity and clustering

Identity is computed on the server and is not delegated to the UI.

### Strong identifiers

Normalize only these identifier values, always scoped by `SearchKind`:

- IMDb: `tt` followed by digits, validated with the same bounded syntax used by
  the media-server provider reader,
- TMDB: `tmdb:` followed by a positive bounded numeric id,
- TVDB: `tvdb:` followed by a bounded numeric id.

The namespace and kind are part of the key. A movie TMDB id and a series TMDB id
with the same number are different identities. An episode's own external id is
never treated as a series id.
The existing web `groupByName`/`mergeByName` behavior is never reused for this
page.

The sources expose IDs differently:

- A media-server `ProviderItem` contributes its already validated
  `providerIds.imdb`, `providerIds.tmdb` and `providerIds.tvdb`.
- A local `LibraryMetaRecord` contributes an external ID only when its stored
  `id` exactly matches one of the three validated forms above. Any other binding
  is an opaque local binding.
- An addon `MetaItem` contributes an external ID only when its `id` exactly
  matches one of those forms. The implementation must not extract a trailing
  `tt…` from an arbitrary addon id during search. Prefixes are provider-local
  syntax, and treating a suffix as proof weakens the conflict rules. A missed
  merge is preferable.

An opaque addon id is not a cross-addon identity. It is scoped to
`(addonKey, type, id)`. The same id from two unrelated addons does not merge.
Opaque ids from different catalogs of the same addon may be merged only when the
type and id are exactly equal. That scoped key is clustering evidence of its
own, not a strong external id. It never bridges two different strong ids.

An opaque local binding is scoped to `(libraryId, bindingKey, type, id)`.
`LibraryMetaRecord` does not retain which addon issued an opaque id, so two
different bindings that happen to share an opaque value are not proof of the
same title. Paths covered by one title unit or one inherited binding may share
the unit's binding key. A filename, folder name or guessed title is not a
binding. A record may legitimately carry several external namespaces; it then
acts as evidence of a bridge.

`memberKey` is a stable hash of `sourceId`, the source-native item key and its
kind. It is not a title identity and never replaces the strong-ID cluster. It
deduplicates repeated pages from one source and remains the focus/detail anchor
when clusters are rebuilt.

### Conservative cluster algorithm

Do not use a naive transitive union and do not make the final grouping depend on
which source happened to answer first. Each rebuild works on retained records
of one kind. Arrival order is irrelevant. `memberKey` order must not change
which records share a cluster either.

An edge exists between two records only when they share one strong id, or the
same scoped opaque identity, and no namespace disagrees. A missing namespace is
compatible with any value. Two different values in one namespace are not an
edge, even when another namespace matches.

1. Build that pairwise graph.
2. Take its connected components.
3. A component whose union has one value per namespace is one cluster. A true
   bridge survives here: `{imdb:tt1}`, `{tmdb:10}` and `{imdb:tt1, tmdb:10}`
   are one cluster, because the bridge agrees with both and the union is
   `{imdb:tt1, tmdb:10}`.
4. A component whose union disagrees in any namespace is contradicted. Do not
   keep it. Place each record alone. While a merge remains legal, merge the
   legal pair whose joined `memberKey`s are smallest in lexicographic order.
   A merge is legal when the graph has an edge across the two partitions and
   the union still has one value per namespace. This does not depend on page
   arrival or on which record is considered first.
5. Recompute a component whenever any of its records is added, replaced or
   removed. No availability badge crosses partitions.

Records that share neither a strong id nor the same scoped opaque identity are
never joined. A scoped opaque id does not connect two conflicting strong ids.

The contradicted example is:

- A `{imdb:tt1, tmdb:10}`
- B `{imdb:tt2, tmdb:20}`
- C `{imdb:tt1, tmdb:20}`
- D `{imdb:tt2, tmdb:20}`

A and C share an IMDb id and disagree on TMDB, so they have no edge. B and C
share a TMDB id and disagree on IMDb, so they have no edge. B and D agree on
both. The only cluster is `{B, D}`. A is alone. C is alone. `{A, C}` is not a
legal grouping.

A hub can connect pairwise-compatible records into one contradicted component:
`X {imdb:tt1}`, `Y {imdb:tt1, tmdb:10}`, `Z {imdb:tt1, tmdb:20}`. X-Y and X-Z
are edges; Y-Z is not. Step 4 merges X with whichever of Y or Z has the lower
`memberKey` and leaves the other record alone. It never puts Y and Z together.

When records are replaced by a retry or a later page, rebuild the affected
evidence components from the retained records. At the 1,200-record cap this is
bounded and easier to audit than incremental graph surgery. Rebuild once per
material source mutation, not once per poll; a poll with no changed revision
serializes the previous snapshot.

Cluster construction is deterministic:

- each record gets a monotonically increasing `sequence`,
- a cluster receives the lowest member sequence as its internal creation order,
- `clusterKey` is an opaque session-local value derived from that creation
  order,
- if clusters merge, the older cluster survives and the newer key is retired,
- if a cluster splits, each resulting cluster is rebuilt from its members and
  the earliest member anchors the surviving key.

The client keeps the focused `memberKey` as its anchor. When a late record joins
or a conflict splits a cluster, the UI can find the cluster containing that
member and preserve the focused title and viewport. No focus is handed to an
unrequested title.

Episodes are not clustered as series IDs. An episode member carries its own
kind, parent relationship, season, episode and optional provider-verified
`episodeEnd`. Episode clustering uses a synthetic identity, not `parentMemberKey`:
verified parent strong ids plus season, episode and `episodeEnd` when present.
Two copies merge when that synthetic identity agrees, including a local file
and a remote episode whose parents resolved to the same strong id. A remote
`seriesId` is resolved only inside the same remote library and connection
generation, and only to find that parent's strong ids. It is not itself an
identity across libraries. A local episode binding uses its parent's verified
strong id plus one explicit season/episode coordinate. A filename that states
a multi-episode range without a verified binding remains a file or an
unidentified entry; it must never become one episode silently. An episode with
no verified parent strong id stays its own card. Parent arrival after a child
updates the parent relationship in place and may then merge the episode.

### Display metadata

The cluster keeps all member records. The card chooses one primary member by:

1. best title-match rank against the query,
2. presence of a strong external id,
3. metadata completeness for the card (poster, background, year, description),
4. source-class preference `local`, `remote`, `catalog`,
5. stable source and item key.

Missing card fields may be filled from other members. A localized title from a
catalog may be shown while a local file keeps its own name in the detail.
Source labels are display strings, never keys.

Known movies and series without external IDs remain separate cards when their
kind is known. Files, folders, unbound local entries and unsupported item types
go to the expandable unidentified bucket. A movie or series whose strong-ID
bridge conflicts remains a normal, separate card with an internal conflict flag;
it is not hidden as unidentified. Episodes become child members when their
parent's strong identity is known; otherwise they remain separate episode cards.
No parent-detail request is made merely to group them.

## Local searchable index

The current `WalkCache` refreshes on demand and waits for a cold walk. That is
correct for a library visit but not for search. The implementation adds a
separate `LocalSearchIndex` that never walks a disk inside a search request.

The current `videoCache` walks every library serially and publishes only the
combined array; `unitCache` and `libraryCache` depend on it. Wrapping that cache
in per-library search snapshots would still let one hung mount hold every cold
library. The implementation therefore introduces a shared per-library
`LibrarySnapshotStore` and makes the existing browse caches compose from it.
The store owns one job per library, runs at most two builds at once, and publishes
each library's files, title units and browse entries as one immutable generation.
A hung or failed mount affects only that library.

The store consumes the existing `listVideos`, `titleUnits`, `buildLibrary`,
`metaStore` bindings and episode rows. It does not create a second filesystem
walk path. `invalidateLibrary(libraryId)` coalesces to one dirty generation per
library; an invalidation during a build discards that result and schedules one
rerun. Startup calls warm-up after `markServerReady()` releases `/api/status`,
so readiness is unchanged. Search may request a background refresh but only
reads the last published generation.

Each build has a deadline and an abort path. A timed-out mount publishes
`unavailable` for that library; the other libraries continue. Shutdown cancels
queued and active builds that are safe to abandon. Existing browse reads that
currently wait for a current walk keep their behavior; only the all-library
serialization is removed.

Each library snapshot contains:

- library id and generation,
- state `building`, `ready` or `unavailable`,
- normalized title/path fields for bounded title units and unbound files,
- verified metadata binding, when present,
- display title, year, kind, an optional already-existing poster reference and
  source item count,
- episode coordinates and cached episode names only when they are verified,
- a bounded list of file keys represented by that title or episode.

The snapshot is built:

- after startup readiness, through the existing background warm-up path,
- after a library mutation invalidates the walks,
- after a completed library scan,
- on the existing debounced watcher or a health transition,
- when search starts and the published snapshot is older than its freshness
  budget,
- never synchronously from a search request.

A cold or invalidated library is reported as `indexing` while the other sources
continue. If the build fails, the source becomes `unavailable` with a fixed
error code and can be retried after the index changes. A previously built
snapshot may still be served with `stale: true` while a replacement is built;
stale discovery data never authorizes opening or playing a file.
The shared store contains no per-account grants or visibility decisions. Every
session source and every continuation filters the published snapshot through
the current viewer's visible library set. A continuation binds the snapshot
generation; if that generation is retired before the next page, the source marks
the old page closed and requeries the current generation from offset zero.
Indexed records have a per-library byte ceiling and the store reports eviction
rather than silently truncating a library.
`LocalSearchIndex` publishes a generation callback. A session whose source is
`indexing` subscribes for that library and schedules its first page when the
generation becomes ready; the client does not have to submit the query again.
Search never schedules thumbnail generation or probes a media file. It uses an
already present local artwork path through the existing same-origin thumbnail
route, or a placeholder. A local-only title may therefore show no poster in the
first snapshot; a merged catalog or remote member can supply one. The detail
surface remains responsible for normal artwork lookup.

`invalidateLibrary()` remains the single library-epoch signal. It schedules one
debounced index rebuild rather than one per file event. A completed scan and a
health transition use the same path. Builds are serialized per library and
carry a generation; a result from an older generation is discarded. The index
keeps no absolute path in its public projection and no result from a library
that is no longer visible to the requesting account.

Query matching uses `normalizeTitle`-style folding for title and path matching,
keeps the original text for display, searches both localized and stored names,
and tests episode names from cached episode rows. It scores an exact normalized
title, a title prefix, a title substring and a filename match in that order, then
sorts by a stable library/path key. The scan walks the in-memory snapshot with a
bounded top-K heap and yields between chunks so a 100,000-entry index does not
block playback or downloads. It performs no filesystem read and allocates no
unbounded result array. The scan checks the session signal between chunks, so a
replaced query stops consuming CPU as well as network work.

The search session is the only public entry point for local results in v1. A
standalone `/api/library/find` endpoint is not added until a separate consumer
needs it; this avoids widening the authorization surface.

## Web implementation

### State and network

Add `web/src/search-everywhere.ts` for the HTTP client and
`web/src/useSearchEverywhere.ts` for session lifecycle. Call the hook from
`App.tsx`, not inside the conditionally rendered Search page, so opening an
existing local or remote detail does not discard the session, query, results,
scroll position or focus anchor. The hook is active while Search is visible and
while a detail opened from Search is covering it. The hook owns:

- draft and committed query,
- in-memory `slotId`, monotonically increasing generation, `sessionId`,
  revision and latest snapshot,
- one serialized poll loop,
- source-page and retry commands,
- an `AbortController` for each start/poll/page request,
- a generation counter for stale response rejection,
- visibility handling that stops polling when the document is hidden.

The hook reads only `GET /api/search/preferences`, a new read-only projection of
`liveSearch` with no `recent` entries. It must not call
`GET /api/search/state` or display `recent`. Today `App.tsx` loads search state
whenever the session becomes ready, for every view. Move that load to the
Catalog view and the settings surface, so opening Search everywhere does not
fetch history. A language-preference change while a search is open starts the
next generation for the same committed query. The server stamps the session
with the UI language it read at start. When search-while-typing is on, reuse the existing
`live-search.ts` 500 ms, three-code-point, IME-aware commit policy for the web
field; when it is off, only Enter submits. Enter always submits any non-empty
query immediately.
Changing source or kind filters starts a new session. A new query starts a new
session through the same `slotId` and the next `generation`. Leaving Search
deletes the session with a best-effort `keepalive` DELETE and retires the slot;
the server's idle expiry remains the fallback.
An expired session (`410`) is restarted once for the same committed query,
without recording it anywhere. Repeated expiry shows a retry state.
`Available locally` is a client-side membership predicate over the current
snapshot because `hasLocal` is already present; toggling it does not create a
new session. It applies to the main list and to the unidentified list. A local
file stays. A remote-only or catalog-only card, including an unidentified one,
hides.

The new surface does not call `api.searchState`, `api.recordSearch` or any
Catalog history endpoint. The preferences read is the only existing Search-area
call, and its response contains no queries. The page may offer suggestions from
titles already present in the current session; those suggestions die with the
session.

### View

Add `web/src/SearchEverywhere.tsx` and a small result-card/detail component. The
view has:

- one search field,
- source-class filter `All / Catalog / Local / Remote`,
- kind filter `All / Movies / Series`,
- optional `Available locally`,
- a compact source progress and retry strip,
- one ranked list of merged cluster cards,
- a collapsed `Files and unidentified items` section,
- `Load more` that calls the session's aggregate page command once.

The entry is a labelled search button in the top bar: icon-only on the compact
phone chrome, icon plus label where space permits, and never a sixth bottom
navigation item. Home uses the same action wording. `Ctrl/Cmd+K` focuses the
entry from another view and the field when Search is already open.

The source strip is not a result section. It shows status and retry controls;
successful cards are not duplicated under source headings.
Its aggregate state is an `aria-live="polite"` status; individual result arrivals
are not announced one by one. The grid exposes `aria-busy` while replacing a
query, every control has a translated accessible name, and reduced-motion users
do not get card entrance animation.

`Enter` and the field submit the same command. `Ctrl/Cmd+K` focuses the Search
entry but must not intercept an editable element or an active IME composition.
The page has no query-bearing URL and is not restored from browser storage.
The hook creates the slot id once per mounted Search surface, never stores it in
browser storage, and increments the generation for every committed query or
filter change. A lost start response therefore cannot leak a session that the
next query cannot replace.

On a new query, old cards are cleared or visually labelled as the previous query
until the first new snapshot arrives; badges from two queries are never mixed.
The client keeps an ordered list of cluster keys for the current session.
Existing cards retain their position, new clusters are appended in the server's
rank order, and availability badges update in place. A late merge keeps the
position of the cluster containing the focused member; a split keeps the focused
side in place and inserts the other side after it. No snapshot re-sorts the
whole grid underneath the viewer. A focused member that becomes invisible moves
focus to the nearest surviving card and never back to the search field.

### Opening a card

The card asks `GET /members/:memberKey` and opens a member-preserving source
chooser. The chooser lists every source record rather than replacing them with
one re-discovered catalogue title:

1. A catalog member opens the existing catalogue detail for that member's exact
   `addonKey`, `type` and `id`.
2. A local member uses its `localItem` projection to open the existing local
   detail by library-relative key. A file or folder without a title identity uses
   the same surface.
3. A remote member opens the existing remote detail by `libraryId` and `itemId`.
   The remote detail then resolves its own versions through the current provider
   connection.

Each member row shows its source label, episode/range when known, and a bounded
error of its own if opening that member fails. One missing catalog metadata
answer cannot hide the local or remote copies.

When the cluster has a safe canonical movie/series identity, the chooser also
offers a separate "Open title page" action backed by `CatalogueTitleDetail`.
That page is an optional metadata/source discovery surface, not the sole route
to the known members. A canonical target uses the earliest authorized catalog
member in viewer source order when available; otherwise it converts the internal
ID back to route spelling (`imdb:tt…` to `tt…`, preferring IMDb, then TMDB,
then TVDB). The internal identity namespace never leaves the server.

The response does not claim a durable cross-source title record. Member detail
shows every source record so a conflict or edition remains inspectable. Existing
detail and playback routes recheck access; merely receiving a faster or local
copy never selects it or starts playback.

A cluster card has one primary action: open the member chooser. The first release
does not add a separate "Play" shortcut that would have to guess which edition,
language or library should play.

An item whose catalog metadata cannot be read still opens with the card's bounded
name and poster, but the existing detail's metadata error remains visible. The
implementation must not manufacture playable rows from search records.

`App.tsx` gets a new `search` view and passes existing callbacks for catalog,
local and remote details. The Catalog component's search code, state effects and
styles remain untouched.

The member chooser and optional catalogue title page are hosted over Search, so
closing either returns to the same result list. A local or remote member whose
only suitable surface is the existing Library detail records `searchReturn`,
opens that existing surface and keeps the search session alive without polling
while it is covered. Back from that detail returns to Search, resumes polling if
needed, restores the saved scroll offset and focuses the same member. Navigating
from that detail to an unrelated section ends the session.

Home gets an "Open search" action only. No Home result row is added, and no
Home request starts a search fan-out.

## Android TV implementation

Keep the existing rail Search entry. Do not add a second rail item.

The shell already distinguishes Search opened from Catalog from Search opened
from the rail. Split the implementation behind that distinction:

- Catalog-origin search continues to use the existing `SearchViewModel`, scope,
  history, `rememberSaveable` draft and Back destination unchanged.
- The rail's global Search is a separate `GlobalSearchScreen` with a new
  `GlobalSearchViewModel` and the new server contract. It is not a mode flag
  inside the existing composable: keeping the two screens separate prevents a
  conditional `rememberSaveable`, accidental history reads and a ViewModel
  surviving from one mode into the other.

The global view uses explicit submission only: IME Done, remote OK or a completed
voice result. It does not commit on each key. Voice remains conditional on the
platform recognizer. Global query text is never written to `rememberSaveable` or
any disk-backed state. It lives only in the global ViewModel for the current
process and is cleared when the screen leaves the rail.

`ApiClient.call()` currently runs blocking OkHttp execution inside
`withContext(Dispatchers.IO)`, so cancelling the coroutine does not cancel the
underlying `Call`. The new global-search calls use a cancellable adapter that
calls `Call.cancel()` through `invokeOnCancellation`. Leaving Search, replacing a
query, deleting its session and closing a poll therefore stop the HTTP work as
well as the ViewModel jobs. Existing API calls are unchanged.
The global ViewModel owns the same in-memory slot id and generation counter as
the web hook.

The view shows the same source-status strip, source/kind filters, merged poster
grid, unidentified disclosure and retry actions. It gets a new search-result grid
rather than reusing `PosterGrid` unchanged: `PosterGrid` keys by `type:id`,
auto-pages on focus and owns focus requesters, none of which is stable across a
cluster merge. The new grid's Compose item key is the anchor `memberKey`: the
focused member when this card contains it, otherwise the oldest `memberKey` in
the card. `clusterKey` is not a Compose key, because a merge retires one.
After a merge or split the screen finds the card that contains the focused
member and requests focus on that item again. The grid requests the aggregate
page only near the end. Polling is serialized
and stopped when the screen is not active. A page of partial results never steals
D-pad focus. Retry rows are focusable and every source error is reachable without
leaving the screen.

The focused card and its member anchor survive a merge, split or appended page.
Back closes an open filter or detail first, then restores the previous screen.
Returning from a detail restores the same card and scroll position.
The global screen opens catalogue detail through the existing `catalogDetail`
overlay and local/remote detail through the shell's `detail`/`remoteDetail`
overlays without changing `Section.Search`; the Search ViewModel therefore stays
alive and Back closes the overlay rather than rebuilding the result list.
The member-detail response supplies the local `BrowseItem` and a remote item's
library/provider/id. The screen hydrates any missing `RemoteItemDto` through the
existing item route before constructing `RemoteDetailData`; it does not invent a
partial detail model.

Catalog-origin TV search stays catalog-only. It uses the catalog-only session
from phase 3, keeps history, scope and its Back destination, and does not show
local or remote hits. Global search must not call `searchState`, `recordSearch`
or expose Catalog history.

The existing `SearchScreen.kt` tests continue to guard the catalog-origin path.
The new screen reuses extracted presentation pieces only where they do not
carry state: the search field, source-status row and poster grid. The global
screen keeps its draft and result state in its own ViewModel.

## Security and privacy

Every session stores only the user id, session id, source targets, bounded
records and cluster state. It is bound to both the account and the current
session id. Poll, page, retry, detail and delete requests verify that binding.

The existing revocation wrappers in `server/src/index.ts` also call
`dropSession(sid)`, `dropUser(userId)` and `invalidateContent(scope)` on the
search manager. Poll-time revalidation remains necessary because an account can
change in another process or request; the hooks make the common logout/removal
path immediate instead of waiting for the next poll. Background source jobs are
aborted on the same call.

The authority check includes `mustChangePassword`, account disablement, secret
rotation, revoked `sid`, role changes, permission version, addon configuration
and remote connection generation. It runs before dispatching work, again after
an outbound or remote queue admits it, and before every response including a
`changed: false` poll. A manager `close()` cancels sessions and waiters before
the existing shutdown drain, so background fetches cannot keep the process alive.

Before emitting a snapshot, source status, count, badge or cluster detail:

- re-read the current account, session and secret validity,
- recheck addon enablement and grants,
- recheck local library visibility,
- recheck remote library grants and connection generation,
- discard results whose source configuration changed,
- re-run cluster construction after removals.

The source configuration stamp includes addon enablement, role, grant list,
`globalSearch`, manifest version/URL, catalog declarations and viewer addon
order. Remote sources separately bind library grant, connection id, generation
and secret ref. Local sources bind the visible library set and index generation.
An addon removal or `globalSearch` change therefore cancels and removes that
source without waiting for a fresh search; an explicit query cannot resurrect
it from stale records.

Artwork references are same-origin and already authorized. Search snapshots
must not leak upstream addresses, secrets, absolute local paths or provider
cursors. Permission revocation removes affected records from the next snapshot
and makes detail/playback recheck again.

The new routes must be listed in `USER_ALLOWED` and the required session
mutations in `ALLOWED_MUTATIONS`. They must not be added to `OPEN_PATHS`.
The path-level entries are the start/poll/page/retry/delete routes and the
member-detail GET, each with the exact parameter count and no wildcard suffix.
In route terms, with the `/api` prefix stripped:

```text
GET    /search/preferences
POST   /search/everywhere
POST   /search/everywhere/:id/poll
POST   /search/everywhere/:id/page
POST   /search/everywhere/:id/sources/:sourceId/retry
GET    /search/everywhere/:id/members/:memberKey
GET    /search/everywhere/:id/artwork/:artworkId
DELETE /search/everywhere/:id
```

The handler additionally validates the opaque id alphabets before looking them
up. The role list adds the GET preferences route and repeats the mutation paths
in `ALLOWED_MUTATIONS`.
Restricted mode still permits an ordinary account to search its granted
metadata, but never exposes administrator-only connection or path inventory.
Existing same-site cookie and JSON-body behavior is sufficient; this feature
does not introduce a new CSRF token scheme.

No query or result payload enters:

- state files or settings backups,
- search history,
- persistent caches,
- URLs or browser storage,
- Android saved state,
- analytics or client logs.

This does not assert control over a selected addon, Jellyfin or Emby: those
services necessarily receive the query and may log it under their own policy.
Server diagnostics log source class, fixed status/error code, duration and
bounded counts. They never log query text, response bodies or upstream error
messages. `OutboundGuard` must not log raw fetch errors either: Node/undici error
text can contain the addon URL and therefore the query string. Breaker logs use
fixed categories such as `timeout`, `abort`, `network`, `http-503` and
`invalid-json`. Existing artwork bytes may continue to use their separate cache,
but search result mappings do not.

## Failure and edge cases

| Situation | Required behavior |
| --- | --- |
| One addon times out | Other sources stay visible; timed-out source keeps its cursor and can be retried. |
| Poll disconnects | Search keeps running; a later poll can recover the snapshot. |
| Query is replaced | Old session is deleted; queued jobs are removed; generation rejects late responses. |
| Session expires | Poll returns `410 search-restart-required`; the client restarts once. |
| A waiting poll drops | Its waiter is released; no fetch or source job is cancelled. |
| Local index generation changes | Old records may be shown stale; the member detail and playback paths revalidate the current file and grant. |
| Grant is revoked mid-flight | Affected source and members disappear from the next snapshot; detail/playback still revalidate. |
| `globalSearch` changes mid-flight | Excluded catalog is cancelled and removed from all-addon search, including cache and continuation paths. |
| Local library is cold | Source reports `indexing`; no disk walk inside the request. |
| Local library is unreachable | Source reports `unavailable`; other sources continue. |
| Remote library is slow | Source remains independently pending; its retry is available. |
| Remote cursor is stale | Source restarts that page or reports a fixed retry state; no duplicate cards. |
| Source returns only duplicates | Continue up to three no-progress pages, then `stalled`; never call it exhausted. |
| Cluster IDs conflict | Records stay separate; no availability badge is invented. |
| More than 60 sources are discovered | Refuse the start with `search-too-broad`; never search a silent subset. |
| This account already has two sessions and the new start is not a slot replacement | `429 search-session-limit`. The existing sessions stay. |
| The server already holds 50 sessions | `503 search-capacity-limit`. Nothing is evicted. |
| Retry arrives within one second | `429 search-retry-limited`. The source is unchanged. |
| Volume crosses 1,200 records | Stop paging, show `limitReached`, and ask the user to refine the query. |
| A cluster has more members than one detail page | Return 100 members and `nextFrom`. Do not claim the page is the whole cluster. |

## Tests and release gates

### Unit and module tests

- Strict request parsing: unknown fields, bad enums, duplicate source classes,
  empty query, 200/201-code-point boundaries and the 256-UTF-16-unit ceiling.
- Stable ID validation for IMDb, TMDB and TVDB, including type separation,
  exact addon/local ID extraction, prefixed opaque IDs and conflicting bridges.
- Cluster tests for direct IDs, a true three-record bridge, the A/B/C/D
  contradiction (`{B,D}` only), the X/Y/Z hub, opaque ids from one addon,
  opaque ids from two addons, late contradictions, episode synthetic identity
  across a local file and a remote copy, missing parent IDs, parent arriving
  after child, specials, provider episode ranges and multi-episode files.
  The same retained records must cluster the same way under reversed
  `memberKey` order.
- Deterministic primary member, cluster key retirement and member-key focus
  after merge/split.
- Per-class scheduler fairness, queued-work cancellation, execution-time source
  timeout, retry cursor preservation, duplicate-only pages, retained-record
  fairness and server-wide slot release on every cancellation path.
- Catalog raw-offset/buffer accounting, rejected rows, undeclared `skip`,
  ignored `skip`, three-page stall and retry from the unchanged offset.
- Session owner binding, revision notifications, expiry, logout and permission
  invalidation, replacement and one-waiter polling.
- Slot-generation replacement: lost start responses, duplicate same-generation
  starts, different queries under one generation, and reversed response order.
- Route allowlist patterns for every method and path, including no accidental
  match on the existing `/search` routes.
- Default-off flag hides the authenticated clients' entries and every Search
  everywhere route answers `404` while it is off.
- Local index normalization, cold-index behavior, invalidation, bounded memory
  and no request-time walk. Verify title, filename and cached episode-name
  matches and deterministic top-K selection at 100,000 entries.
- Snapshot-store tests: a hung library does not delay a healthy cold library,
  two builds run at most concurrently, an invalidation during a build discards
  the old result, and an in-flight search source becomes ready after the new
  generation publishes.
- Web i18n key parity across all ten catalogues and Android TV string parity via
  the existing `android-strings` check.

### Server integration tests

- Mount the routes behind the real authentication, role, password-change and
  restricted middleware, not only the search manager; cover the default-off
  feature flag and every allowed/refused method.
- Two fake catalog sources: one answers in 100 ms and one in 10 seconds. The
  first snapshot contains the fast source, and the slow source can complete or
  be retried later.
- Sixty sources returning 20 distinct records each stay within the record,
  snapshot and member-detail byte bounds; crossing a bound sets
  `limitReached` rather than hiding already loaded results.
- A queued request is removed when its session is deleted or replaced.
- The server-wide job cap prevents one busy account from starving another and
  no cancelled or expired session retains a scheduler slot.
- A revocation between source fetch and snapshot delivery removes source,
  cluster members, counts and badges.
- Ordinary and restricted accounts can use the feature; another session cannot
  poll, page, retry or delete it.
- `GET /api/search/preferences` returns `liveSearch` and no recent query values;
  the global page makes no `/api/search/state` or history-write request.
- A poll waiter is released on response close, session deletion and expiry; a
  deleted or expired session never leaves a background fetch in the queue.
- `globalSearch: false` targets receive zero calls in all-addon search, retry,
  continuation and cache paths.
- Remote search always uses the library root, recursive title types and the
  requested movie/series/episode inclusion; it cannot inherit folder mode.
  Episode rows with no known parent remain separate, and `episodeEnd` is kept.
  Provider and manager cursors are bound to the operation and type set for both
  Jellyfin and Emby and cannot be reused across filters.
- A cold local index returns `indexing` without waiting on a walk; an invalidated
  generation may serve `stale: true` while its replacement builds.
- A sentinel query appears in no emitted server log, including an outbound
  breaker diagnostic and a malformed addon response path.
- Catalog artwork never exposes its upstream URL in secure mode on or off; a
  source grant revoke and session delete make the same-origin artwork address
  miss, and the proxy refuses a non-image or oversized body.
- Session expiry and malformed/stale cursors return the documented fixed errors.

### Web end-to-end tests

- Type, IME composition, Enter, clear, rapid query replacement, hidden tab and
  Back behavior.
- Source and kind filters start fresh sessions and never mix old badges.
- Fast source cards appear while a slow source is pending.
- Aggregate Load more schedules every continuable source once; per-source retry
  works independently.
- Local, remote and catalog cards open the correct existing detail action.
- Back from a Library-hosted local or remote detail returns to the same Search
  member and scroll offset without recording the query or losing the session.
- A member detail remains reachable after its cluster key changes through a
  late merge, and focus does not jump to another card.
- Catalog controls and the five-entry mobile navigation remain unchanged.
- No query appears in URLs, local storage, session storage or restored state.

### Android TV tests

- Catalog-origin Search still records Catalog history and returns to Catalog.
- Global Search submits on Done/OK/voice only and never writes global history.
- The two modes use separate screens and ViewModels; changing mode cannot carry
  the other mode's draft, results or `rememberSaveable` state.
- D-pad focus survives partial snapshots, page appends, merges and splits.
- Leaving Search or replacing a query cancels the active OkHttp `Call`, not only
  its coroutine.
- Retry and source-status rows are reachable by the remote.
- Back and returning from detail restore the same card and scroll position.
- Local and remote member hydration produces the exact existing detail DTOs,
  including a remote provider, library name and known parent series ids.

### Runtime and visual gates

Run functional checks before visual checks. Then run the web viewport matrix, TV
focus verification and the local Docker deployment/health check described in
`AGENTS.md`. Do not call the feature complete from a documentation-only PR.
Run Android TV Gradle unit/Compose tests explicitly; the root `npm test` command
does not include that workspace.

## Delivery sequence

Every phase ships behind a server-enforced, default-off
`SEARCH_EVERYWHERE_ENABLED` gate. The authenticated settings projection carries
the flag so web and TV hide the entry when the routes are disabled. The routes
themselves answer `404` when off; hiding a button is not rollback.

### Phase 0: contracts, shared snapshots and fake source runner

- Add DTO parsing, session manager, scheduler and identity modules.
- Add the per-library snapshot store and adapt browse caches to compose from it.
  The store warms with or without the feature flag.
- Implement fake raw catalog pages plus local and remote adapters with
  deterministic delays.
- Add route allowlists, real middleware lifecycle tests, the feature gate and
  contract tests.
- Prove fast-source delivery, lost-start replacement, cancellation, expiry,
  shutdown and permission revocation.

No UI ships in this phase. `GET /api/search` still has its old body.

### Phase 1: shared catalog adapter and Everywhere server adapters

- Finish the raw catalog adapter, the Catalog projector, and the `searchAll`
  waiter. IdentifyDialog and library-candidate tests still see today's
  `SearchResult`.
- Finish local and remote adapters, Everywhere paging, paged member detail,
  session artwork, invalidation and 410 tombstones.
- Prove the contract with server fixtures that speak both projectors. Real web
  and TV clients are not in this phase.

### Phase 2: web Search everywhere and Catalog arrival

- Add the web view, top-bar/Home entry, session hook and member chooser.
- Point Catalog `loadPage` at the catalog-only session. Keep history, sort,
  scope, `mergeByName` and the `gainedNothing` stop.
- Move the shell's `loadSearchState()` off the global ready effect and onto
  Catalog and settings.
- Keep the server flag off in production until the web functional, privacy,
  viewport and detail-return gates pass.

### Phase 3: TV global mode, Catalog arrival, and enablement

- Add the separate global ViewModel and screen. Key the grid by anchor
  `memberKey`.
- Point TV Catalog-origin search at the same catalog-only session. Keep its
  history, scope and Back destination.
- Verify D-pad focus across merge and split, partial results, voice,
  cancellable OkHttp calls and Back.
- Enable the feature flag only after both clients pass the shared contract.

### Phase 4: optional follow-ups

- Consider cache/coalescing only after correctness and measured load.
- Defer Home recent-query chips, fuzzy matching, streaming, a Search everywhere
  addon picker, and music-video search.

## Rollout and rollback

The feature is additive and is disabled by the default-off server flag in every
phase before enablement, not merely by hiding entry points. Server sessions are
memory-only, so rollback drops active searches without a migration or persistent
data cleanup. No session data is included in settings backups.
When the flag is off, the new search routes are not registered and
`LocalSearchIndex` does not warm. `LibrarySnapshotStore` is library
infrastructure: browse caches compose from it, and it keeps warming the way
`warmLibraryCaches()` does today, whether or not Search everywhere exists.
Rollback of the flag does not stop library browse and does not skip a library
walk the browser still needs. A hung library blocks only its own build. The
store runs at most two builds at once, which is the deliberate change from
today's one serial walk of every library. Existing readers that wait for a
current walk of one library keep waiting for that library.

The implementation is ready for review when a fake 100 ms source is visible
before a 10-second source, a revoked source disappears from a later snapshot,
and no Catalog search behavior or history contract changes.

## Product decisions carried into implementation

1. Home has an entry action and no query history in the first release.
2. The kind filter is `All`, `Movies`, `Series`. `Series` includes episode hits;
   there is no separate episode filter in the first release.
3. `Available locally` filters the page membership: remote-only and catalog-only
   clusters disappear. It is not a ranking hint.
4. The source-status strip always shows a compact aggregate, with an expandable
   list of individual sources on both web and TV. Failures and retries remain
   reachable with the D-pad.

Recent-query chips, a separate episode filter, persisted global history and
streaming delivery remain deferred product decisions.

## Review status

This proposal follows the review in
[search-everywhere-review.md](search-everywhere-review.md), including the
second-pass decision that Catalog and Search everywhere share one addon
engine. Catalog controls, history, sort, scopes, browsing and `mergeByName`
stay. Catalog search arrival is incremental. `GET /api/search` stays one-shot.
The original brief remains in
[search-everywhere-review-task.md](search-everywhere-review-task.md).
Both review passes are recorded in
[search-everywhere-implementation-review.md](search-everywhere-implementation-review.md).
