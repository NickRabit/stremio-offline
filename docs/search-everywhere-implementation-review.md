# Search everywhere: implementation proposal review

Independent read-only review on 2026-10-17 of the branch behind PR #449, after
the detailed plan in
[search-everywhere-implementation.md](search-everywhere-implementation.md) was
written.

The reviewer inspected the actual authentication, outbound, addon, local-library,
media-server, web and Android TV code. This is a design review, not implementation
or runtime verification.

## Verdict

The architecture is viable, but the first proposal could not be implemented as
written. Two assumptions were blockers: the general image cache was not safe for
query-derived artwork, and a single canonical catalogue detail could lose source
records that were merged through a different ID namespace.

The normative plan now includes the corrections below. Product direction comes
from the task brief and
[search-everywhere-review.md](search-everywhere-review.md); code-level mechanics
come from the implementation proposal after this review.

## Blockers corrected

### Artwork privacy

The existing `images.proxied()` helper returns an upstream URL when Secure Mode
is off, and persists the URL mapping when Secure Mode is on
(`server/src/images.ts:269`). `/api/image/:id` has its own long-lived cache rather
than a search-source grant (`server/src/routes/catalog.ts:182`). Using that helper
would violate the requirement that search snapshots contain no upstream address
and no query-derived disk mapping.

The plan now adds a separate memory-only, session-bound search artwork route.
Its URL mapping never reaches disk, every image read rechecks the source grant
and session, and source revocation makes the artwork id miss. Existing image
behavior is unchanged for the rest of the application.

### Merged-member action

Opening every strongly identified cluster through one `CatalogueTitleDetail`
target is lossy. Local copy lookup matches the exact stored title ID
(`server/src/local-sources.ts:34`), so an IMDb target can miss a local member
that is bound to TMDB and merely bridged through another record. A series without
known episodes also has no playable rows until an episode is selected
(`web/src/CatalogueTitleDetail.tsx:147`).

The plan now opens a member-preserving chooser. Each local, remote and catalogue
member keeps its native action. A canonical catalogue title page is an optional
extra action when a safe identity exists, never the only path to already known
members.

## Required corrections incorporated

1. Search sessions now have explicit logout, account, secret, permission,
   content and shutdown invalidation hooks. Delivery and unchanged polls
   revalidate the current authority. Owner-bound tombstones provide a bounded
   `410` response without retaining query text.
2. Rapid replacement now uses a client-generated slot id and generation rather
   than a session id that may never have reached the client. A lost start
   response is replaceable; duplicate generation requests are idempotent.
3. Catalog scheduling is host-aware and fair across sessions. Remote scheduling
   is connection-aware. The execution deadline covers the bounded body read,
   begins at admission rather than host-queue entry, and caller cancellation
   does not count as an addon outage.
4. Catalog paging distinguishes raw provider offset from accepted records and
   keeps unaccepted rows in a bounded server-only buffer. An addon that does not
   declare `skip` has unsupported continuation, not a false complete result.
   Repeated no-progress pages become retryable `stalled`.
5. Record, snapshot and member-detail byte limits now have explicit
   `limitReached`/refine behavior. The proposal no longer retains 1,200 records
   but exposes only a smaller, unpaged display window.
6. Local indexing now depends on a shared per-library snapshot store, not the
   one serial all-library `videoCache`. One hung or failed mount cannot block a
   healthy cold library. Grants stay outside the shared snapshot and are applied
   per session.
7. Conflicting ID evidence is recomputed for the whole affected component in a
   deterministic member-key order. The result no longer depends on which source
   answered first, and later contradictory bridges can split earlier clusters.
8. Episode members now carry parent, season/episode and provider-verified range
   fields. A local multi-episode name without a verified single-episode binding
   cannot silently become one episode.
9. The proposed remote search method is retained, but its provider and manager
   cursors bind a dedicated operation version and effective include-type set.
   Ordinary browse cursors and a cursor from another filter cannot be reused.
10. Web search state lives above temporary detail navigation. TV gets a separate
    global screen, a focus-stable grid and a cancellable OkHttp call adapter.
    Member detail hydrates the exact existing local/remote detail DTOs.
11. The whole feature is behind a default-off server flag. Hiding entry points
    is not the rollback mechanism. Authorization, privacy, cancellation and
    member actions must be complete before the flag can be enabled.
12. The new page gets a preference-only `GET /api/search/preferences`. It honors
    search-while-typing without reading or displaying Catalog history.

## Already sound

- The new surface is additive. Catalog browsing and Catalog history creation
  stay. `GET /api/search` keeps its JSON shape. The second pass below changes
  the earlier claim that `searchAll` itself stays untouched: it becomes a
  waiter, and the Catalog grid stops using that one-shot response.
- One catalog source per searchable catalog is the right pagination and failure
  granularity.
- `globalSearch` remains a server-side source-selection rule.
- The page never merges by title/year and performs no identity metadata lookup
  during search.
- Partial source delivery, a server-owned session and JSON polling are
  testable and fit both clients better than browser-side fan-out or SSE in the
  first release.
- Home is an entry point, not a second result page.
- Cache/coalescing stays deferred until the runner is correct. Catalog's
  incremental arrival is no longer deferred; the second pass puts it on the
  shared engine.

## Recommended first implementation slice

Ship a default-off server-only slice:

- strict request/response contracts;
- the per-library snapshot store;
- owner/generation-bound session manager;
- slot/generation replacement;
- host/connection-aware scheduling;
- cancellable outbound admission and bounded body parsing;
- fake catalog/local/remote sources;
- real authentication, role, restricted-mode and shutdown integration;
- tests for lost start responses, queue cancellation, revocation during a poll,
  no-progress pagination and unchanged legacy Catalog behavior.

No user-facing entry point should be enabled in that slice.

## Remaining assumptions

- Real Jellyfin/Emby search ordering, episode inclusion and provider ID accuracy
  still need fixture or device verification.
- Real addons differ in how faithfully they implement `skip`; the proposed
  unsupported/stalled states are the safe default.
- The earlier local timing measurements were not repeated against this checkout.
- Large or stalled network library cost, low-end TV memory/focus behavior and
  third-party query/voice retention remain runtime questions.

## Second pass

On 2026-10-17 the owner asked for one shared search, and a read-only DeepSeek
pass checked this plan against `searchAll`, `GET /api/search`,
`GET /api/catalog`, `IdentifyDialog`, `LibraryCandidates.searchCinemetaOf`,
`ImageCache.proxied`, `videoCache`, `remoteIdsMatch`, the role allowlists, and
both Catalog clients' `gainedNothing` stop. The normative plan now includes
the corrections. Findings that were not adopted are named here so they are not
silently "fixed" later.

Adopted:

- The shared piece is a raw per-catalog fetch. The 20-row buffer, field
  allowlist, merge and cursor encoding stay in the projector that needs them.
  `searchAll` can therefore keep returning every meta and a stateless offset
  cursor. Search everywhere can keep its session buffer.
- Catalog web and TV read a catalog-only session and fold results in target
  order. `GET /api/search` stays one-shot for IdentifyDialog and
  `LibraryCandidates`. `GET /api/catalog` stays browse and is not the shared
  engine.
- Clustering no longer calls `{A, C}` compatible when their TMDB ids disagree.
  A true bridge of three consistent records stays one cluster. A contradicted
  hub is partitioned without putting two values of one namespace together.
  The partition does not depend on iteration order. A tie uses the lower
  `memberKey`, so the same records always produce the same clusters.
- Scoped opaque ids are clustering evidence. Records with neither a strong id
  nor the same scoped opaque id still do not merge.
- Episode identity is the parent's verified strong ids plus season, episode
  and range. `parentMemberKey` and a remote `seriesId` are not cross-library
  identities.
- `LibrarySnapshotStore` warms even when the feature flag is off.
  `LocalSearchIndex` and the new routes do not.
- Session caps return `search-session-limit` and `search-capacity-limit`.
  Replacing one's own slot is not a new seat. Nothing is evicted.
- Member detail is paged. One response does not claim to list every member.
- The TV grid's Compose key is the anchor `memberKey`.
- `Available locally` applies to both result lists. Music videos are out of
  search v1. Explicit addon scope stays Catalog-only.
- Search everywhere does not fetch `/api/search/state`. The shell stops
  loading that state for every view.
- Adapter failures, including the `searchAll` path, log a fixed code.

Left as they are, on purpose:

- Catalog clients still stop continuation when a page adds no new `type:id`.
  That is current Catalog behavior. Search everywhere uses the three-page
  stall instead and must not copy the Catalog stop.
- Phase 1 proves the contract with server fixtures. Web and TV proof stays in
  phases 2 and 3.
