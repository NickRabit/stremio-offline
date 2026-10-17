# Search everywhere: review and recommended design

Reviewed on 2026-10-17 against `main` at
`e31351afecc62b72bd794a8970bb3c2a0dc4a1c4` and the original brief in PR #449.
File/line references below refer to that revision. This is a design decision
record, not an implemented feature or a performance measurement.
The concrete module, API, state, test and delivery plan is in
[search-everywhere-implementation.md](search-everywhere-implementation.md).
Its independent review and resolved corrections are recorded in
[search-everywhere-implementation-review.md](search-everywhere-implementation-review.md).
That later document is normative for code-level mechanics where its second
review corrected this review's original paging, queue-time and remote-type
assumptions. This file remains the product decision record.

## Verdict

Proceed with a separate Search everywhere experience. Keep web Catalog browsing
and search intact. Share the search contract and identity rules between web and
Android TV, but give TV explicit submission and stable D-pad focus. Ship the
incremental source runner before expanding the result surface: three parallel
requests are insufficient if the catalog request still waits for every addon.

The proposal needs the following corrections before implementation.

| Priority | Finding and evidence | Required decision |
| --- | --- | --- |
| P1 | `server/src/addons.ts:170` awaits every catalog through `Promise.allSettled`; line 192 marks failures exhausted. | Deliver completed source pages independently; failed and timed-out pages retain their cursor and can be retried. |
| P1 | `server/src/media-server-match.ts:26` already rejects conflicting shared IDs. An unconstrained transitive union would weaken that behavior. | Validate the complete candidate cluster before merging; quarantine conflicting bridge records. |
| P1 | `server/src/routes/personal.ts:244` persists history; `web/src/App.tsx:718` and `SearchViewModel.kt:96` call it. | New global queries never use existing persisted history. Scope this privacy promise to the new surface so Catalog behavior remains unchanged. |
| P1 | `server/src/routes/catalog.ts:101` checks addon visibility before awaiting search, unlike the post-await checks in remote browse at `server/src/media-server-manager.ts:1301`. | Reauthorize every delivered page and every cache hit; do not rely on initial target discovery. |
| P2 | `server/src/outbound.ts:162` queues resolver callbacks without a cancellation signal; `server/src/addons.ts:16` supplies only a timeout. | Cancellation must remove queued work as well as abort active upstream fetches. |
| P2 | `server/src/walk-cache.ts:24` waits for a refresh on a cold or invalidated cache. | A maintained walk is not yet a ready, nonblocking search index. Report indexing/unavailable instead of waiting on a disk walk in search. |
| P2 | `server/src/media-server-manager.ts:1274` defaults to the library's browse mode; `server/src/media-server-provider.ts:677` recurses only in titles mode and title types omit episodes. | Add a dedicated root-scoped recursive search operation with an explicit movie/series/episode type set; never inherit the open folder or ordinary browse mode. |
| P2 | `SearchViewModel.kt:174` stops pagination when a page adds no distinct items. | Duplicate-only pages must not hide later unique results. Follow source continuation, with bounded work and an explicit Load more action. |

Android references in this document are under
`android-tv/app/src/main/java/cz/stremiooffline/tv/ui/catalog/`, unless noted.

## Catalog optimization and excluded addons

The full review recommends including Catalog search in the performance work.
The [implementation proposal](search-everywhere-implementation.md) deliberately
defers that migration to a later, separately approved phase: the first release
keeps Catalog controls, search and browsing behavior unchanged and delivers the
incremental runner only through Search everywhere. If Catalog is migrated later,
preserve its entry points, controls, browsing, scopes, history preference and
selected sort; use the same bounded source runner with a separate Catalog
adapter. Keep the legacy `/api/search` response compatible for older clients
until that migration is complete.

Deliver fast catalogs first, cancel superseded work through the queue, retry only
failed pages and preserve per-source pagination. Cache/coalesce successful pages
under the same authorization and configuration rules described below. Catalog
keeps its existing sort semantics as batches arrive; preserve scroll/focus by
stable identity, especially on TV. Do not apply the global page's append-only
ranking policy or disable Catalog history as a side effect of sharing the runner.

The existing `globalSearch` switch is mandatory source-selection policy, not an
optimization hint. `server/src/addons.ts:144` already implements the distinction,
and `server/src/routes/catalog.ts:105` enables it for an unscoped search:

| Search scope | Addon with `globalSearch: false` |
| --- | --- |
| Catalog: search all addons | Excluded |
| Search everywhere: All | Excluded from the catalog portion |
| Search everywhere: Catalog source-class filter | Excluded; this filter does not explicitly select an addon |
| Explicitly selected addon or one of its catalogs | Searchable if enabled and authorized |

An addon excluded from all-addon search stays available in the explicit scope
picker. This flag is separate from enablement, user grants and Show on Home;
explicit selection never bypasses enablement or authorization. Discover targets
server-side using `searchableCatalogs` after grants and user order are applied.
No fallback, retry, pagination, cache hit or coalesced request may broaden that
scope. Local and remote-library searches are unaffected by this addon flag.

Bind each search to its selection policy and addon configuration generation.
If the flag changes during an all-addon search, cancel that source and discard
its late/cached records before the next delivery; remove its badges and counts
from existing clusters. An explicitly scoped search can continue if the addon
remains enabled and authorized. Re-enabling all-addon participation takes effect
on a fresh search. Cached pages from an explicit scope must never make an
excluded addon visible to an all-addon search.

## Identity and result contract

Keep source records separate from title clusters. A source record contains a
stable source key, item key, kind, normalized external IDs, display metadata,
authorized artwork references and a typed detail locator. A title cluster has a
stable session-local key and references its member records. Display names are
not keys: two addons can have the same name.

- Recognize only validated IMDb, TMDB and TVDB namespaces, scoped by content
  kind. Reuse the syntax checks in `server/src/media-server-provider.ts:251`.
  A namespaced identifier is evidence, not proof that a provider's metadata is
  correct; retain provenance and prefer a missed merge over a speculative one.
- An arbitrary addon ID is local to `(addonKey, type, id)`. Identical opaque IDs
  from different addons do not merge. Remote locators include the local remote
  library ID and provider item ID; local locators use authorized library-relative
  keys, never absolute filesystem paths.
- Merge only if there is a shared external ID, the kinds match, and the union
  has no conflicting value in any namespace. Check the whole cluster, not only
  the two incoming records. For example, A `{imdb: tt1, tmdb: 10}` and B
  `{imdb: tt2, tmdb: 20}` must remain separate when C `{imdb: tt1, tmdb: 20}`
  arrives. C is ambiguous and must not connect them. If a contradiction appears
  later, recompute the affected component conservatively and remove disputed
  availability; never keep a known false merge just to preserve layout.
- A consistent bridge can join `{imdb: tt1}` and `{tmdb: 10}` only when a returned
  record already carries both IDs. No metadata resolver or parent-detail request
  is allowed just to establish search identity.
- Movies, series, episodes, seasons and folders are distinct kinds. Episode
  identity needs a known parent-series identity plus season and episode, or a
  validated episode-specific ID. Never interpret an episode's own IMDb ID as a
  series ID. Specials allow season zero. Multi-episode files retain their range
  and cannot silently become one episode; unknown numbering remains separate.
- Bind local items using existing metadata bindings and title units. A folder
  name is not a binding. Preserve every edition/file as a separate member source.
  Do not reuse `groupByName` (`web/src/App.tsx:1968`) or make the global view obey
  the Catalog merge-by-name preference.

Known movies and series without external IDs still belong in the main title
list as separate cards. Only files, folders, ambiguous bindings and unsupported
item kinds belong in an expandable Files and unidentified items area. Episode
matches are child hits when the parent identity is already present; otherwise
they remain separate episode cards. Do not fetch a parent just to group them.

## Interaction on web and TV

Use a dedicated page on web, entered from Home or a compact top-bar action.
Support Ctrl/Cmd+K without intercepting editable controls or IME composition.
Keep the mobile bottom bar at five entries. Home contains the entry only in the
first release; recent-query chips are deferred. Keep queries out of route URLs,
browser storage and restored navigation state. In-memory Back navigation may
restore the current query and scroll while the authenticated session is alive.

Use two independent filters: source class (All, Catalog, Local, Remote) and kind
(All, Movies, Series). A source filter limits both requests and merge membership;
a local-only card must not claim an unchecked remote source. Series includes
known episode hits. In All, an optional Available locally predicate retains only
clusters with a visible local member. A stale index means a copy was indexed,
not that it is playable now. Catalog presence alone never means playable.

On web, reuse the 500 ms/three-code-point, IME-aware commit policy from
`web/src/live-search.ts:1`; Enter submits any nonempty query. Remote requests run
only for committed queries under the same bounded scheduler. Preserve the
account's search-while-typing preference, but never its save-history behavior
for this new surface. A new generation clears previous results or labels them
explicitly as the previous query; it must never mix their badges into the new one.

On Android TV, reuse the Search rail entry for global search; do not add another
rail item. Preserve the Catalog-origin path as catalog-only scoped search with
its existing Back destination and history behavior. The shell already records
this distinction (`ui/shell/Shell.kt:205`, `:291`). Implement distinct global and
catalog search state so the current `SearchViewModel` cannot accidentally record
global queries. Global draft text must not use disk-backed saved state.

TV submits on IME action or a completed voice result, never on each key. Keep
the microphone conditional on recognizer availability (`SearchScreen.kt:128`).
Back first dismisses input/filters, then restores the originating screen. Partial
results do not steal focus; errors and retries are reachable with the D-pad.
Return from detail restores the same card and scroll position. Voice recognition
is platform-provided: do not promise that a third-party recognizer never retains
audio or queries.

Cards open a detail/source chooser; merely receiving a faster or local source
must never start playback or change a selected copy. The chooser lists local
files, remote copies and addon choices with edition, language and quality when
known. Reuse existing playback paths and revalidate access when opening/playing.
Support local-only and remote-only details without inventing a catalog ID.
Canonical detail is a presentation over member locators, not a new durable title
ID or a cross-provider watch-history merge.

Rank each newly delivered batch by title match, then local availability as a
tie-breaker, then stable source/item order. Append new cards; update existing
badges in place without reranking. This is ranking of loaded batches, not a
promise of globally sorted results. Offer an explicit rerank after completion.
If a late bridge joins visible cards, keep the focused card's key and position
(otherwise the earliest card), redirect retired keys and preserve the viewport
anchor. A split caused by conflicting IDs preserves the focused source record.
This focus policy is necessary even without sorting: deduplication removes cards.

## API and source lifecycle

Prefer one server-owned, in-memory search session with bounded JSON polling over
browser per-catalog fan-out or SSE in the first release. This keeps scheduling,
identity and pagination identical for web and TV. Streaming can replace delivery
later without changing source semantics. The following routes are proposed,
not existing APIs:

1. `POST /api/search/everywhere` accepts bounded query text, filters and a
   client slot/generation. It returns an opaque session ID and a first snapshot
   within a 300 ms soft delivery budget, even if all sources remain pending.
   This budget does not cancel upstream work or mark it exhausted.
2. `POST /api/search/everywhere/:id/poll` takes the last revision and waits at
   most 500 ms for a change. Return a bounded current snapshot on change, with
   cluster upserts/removals if deltas are introduced later. Serialize polls;
   back off to 250 ms while sources load and reduce polling when idle. Hidden
   clients stop polling.
3. `POST /api/search/everywhere/:id/page` advances every ready source once;
   `/sources/:sourceId/retry` retries one failed source. Repeated commands share
   the same page job. The client cannot supply upstream URLs, provider
   credentials or arbitrary provider cursor contents.
4. `DELETE /api/search/everywhere/:id` cancels work and releases memory. Expiry,
   logout and revocation also clean it up; do not depend on DELETE arriving.

All responses are `private, no-store`. Route registration must include the
ordinary-account and restricted-mode allowlists, authentication and the existing
mutation protections. Bind session IDs to the authenticated session, account,
query, filters, the viewer's language configuration and source configuration.
Another session cannot read, cancel or page them. Expiry returns an explicit
restart-required response.

Each source is one searchable addon catalog, one local library or one attached
remote library. Track `queued`, `loading`, `ready`, `stalled`, `exhausted`,
`failed`, `timedOut`, `indexing` and `unavailable`, plus a cursor and result
revision.
Partial is an aggregate state, not an error. Only a successful end-of-source
response exhausts a source. No new merged cards is not end-of-source. Retrying
preserves successful records and deduplicates by source record key.

Start with configurable implementation limits: independent pools of eight
catalog and eight remote jobs, two remote jobs per connection, 20 rows per source
page, 1,200 retained source records, 60 targets, two sessions per authenticated
session, five-minute idle expiry and server-wide session/byte caps. Stop
requesting pages at the retained-result cap and show a limit/refine-query state;
never silently truncate then say complete.
Cap provider body size and text fields before retaining them. Fairly schedule
source classes so addon backlog cannot starve local or remote work. These are
initial engineering budgets to validate, not measured optimal values.

Use a 12-second source execution budget from outbound admission, not including
host-queue waiting. The deadline covers the body read. Plumb abort through
catalog helpers and the outbound queue, and keep the host slot until bounded JSON
parsing finishes. A soft delivery deadline is not a hard source timeout.
Disconnecting a poll does not cancel the search; explicit replacement, session
expiry or logout does. Shared in-flight work is reference counted: one cancelled
subscriber cannot cancel another's request.

Local search needs a per-library searchable snapshot derived from maintained
walks and bindings. Building it runs outside the request; a cold library reports
indexing while other libraries answer. Expose freshness and index generation;
bind continuation to that generation or require a restart on invalidation.
Search titles and filenames with deterministic normalization, keeping original
text for display. Never recurse through disks on a keystroke. A warm snapshot
can be stale for display, but stale visibility can never authorize a result.

Remote work reuses the manager's scoped transport and post-await checks. Search
the attached root in a dedicated recursive title/episode search mode; keep
provider pagination per library. Existing
`publicRemoteItem` retains provider IDs (`server/src/media-server-types.ts:256`),
so identity does not require a detail request. Do not load every remote page or
run the existing playback source-discovery flow for every search card.

## Security and privacy boundary

Recheck current user/session, library/addon grants, enablement and connection
generation before emitting any snapshot, cache hit, count, badge or artwork
reference. Remove revoked records from active clusters and cancel their jobs.
Check detail and playback again. In-flight replies from a prior generation are
discarded even if network cancellation is too late. UI memory is cleared on
logout/account change; revocation cannot undo pixels already shown.

A short successful-page cache and coalescing are optional after the runner is
correct. Keep them in memory, bounded by entries and bytes, scoped to session,
permissions/configuration generation, source, query, language, filters and page.
Start with a 15-second TTL. Failures are not cached as empty success. Invalidate
on grant, connection, addon configuration and local-index changes; offer Clear
search data for the current session. Do not expose query-bearing cursors in URLs.

Global search never calls `/api/search/history` and never reads persisted Catalog
history for suggestions. No query/result payload enters disk caches, analytics,
logs, browser storage or Android saved-state persistence. Existing artwork
caching may continue under its separate authorization rules; this prohibition
concerns search payloads and mappings, not every referenced image byte.

POST keeps queries out of our request URLs, but selected upstream addons and
media servers necessarily receive them and may log them. Do not promise control
over third-party retention. Audit proxy/body logging and upstream error messages:
the existing logger redacts URLs (`server/src/logger.ts:43`), which does not
guarantee that arbitrary response text cannot echo a query. Search diagnostics
use fixed error codes, duration and counts, never raw errors or payloads.

## Delivery and acceptance

1. Build the bounded incremental runner and cancellation path with fake sources.
   Preserve `/api/search`'s legacy response contract and keep web Catalog and
   TV Catalog-origin search on it in the first release. Include the addon
   exclusion policy above. A separate later phase may migrate Catalog to the
   incremental catalog-scoped contract; existing controls, browsing, history and
   sorting remain covered by regression tests until then.
2. Add global Catalog search on web and TV against the new contract, including
   partial states, retries, stable card keys and no persisted history.
3. Add per-library local snapshots and remote adapters, conservative clustering
   and the source chooser. Ship only once both clients handle all three classes.
4. Add cache/coalescing only after correctness and measured load justify them.
   Defer Home history chips, fuzzy matching and streaming until then.

Required tests and release gates:

- Unit: conflicting/transitive bridges in multiple arrival orders; opaque-ID
  collisions; type separation; missing parent IDs; specials and multi-episode
  files; duplicate-only pages; retry cursor preservation; generation resets;
  cache expiry, byte limits and subscriber cancellation.
- Server integration: delayed source cannot hold a fast one; cancellation while
  queued removes work; permission revocation during a fetch and before cached
  delivery removes titles, counts and badges; ordinary/restricted accounts work;
  cross-session access fails; cold local index does not walk inline; stale
  cursors restart safely; remote folder mode cannot narrow global search.
- Scope regression matrix on server, web and TV: an excluded addon receives
  zero upstream calls for Catalog All, global All and global Catalog; explicit
  addon/catalog search still works when authorized. Disabled/ungranted addons
  receive zero calls even when explicitly selected. Repeat with cached pages,
  retries, continuations and a mid-flight `globalSearch` toggle; verify source
  picker visibility, counts and badges as well as returned cards.
- Privacy: distinctive query text never reaches stored user data, emitted logs,
  persisted cursors or client saved state, including timeout and malformed
  upstream response paths. Catalog history still behaves as before.
- Web end-to-end: type, IME, Enter, clear, rapid replacement, source/type filters,
  mixed success/failure, detail and Back, retries and keyboard focus. Verify
  Catalog controls unchanged and the mobile five-entry navigation intact.
- TV: submit and voice, global versus Catalog entry, D-pad retries, Back and
  restored detail focus; late bridge merge/split and appended pages never jump
  focus to another title. Verify with Compose tests and an emulator/device.
- With a fixture answering at 100 ms and another at 10 seconds, display the
  first within one second in both clients. With 100 queued jobs, replacing the
  query leaves no superseded queued work. Exercise 100,000 indexed local entries
  and many remote libraries with bounded memory and no per-query disk walk.
  These are proposed acceptance targets; record hardware and measured results.

Run functional checks before visual verification, then the web viewport matrix,
TV focus verification and local Docker deployment/health check. A documentation
review does not establish that these runtime gates have passed.

## Unverified assumptions

The brief's 22-catalog and 0.1–10-second measurements were not reproduced. Real
Jellyfin/Emby search ordering, provider ID accuracy, voice-service retention,
low-end TV memory and large-library index cost remain to be measured. A unified
source chooser is additional implementation work; existing playback/source
routes do not establish that such a detail already exists. The historical
enhanced-search specification describes an older baseline; current code takes
precedence for behavior claims in this review.
