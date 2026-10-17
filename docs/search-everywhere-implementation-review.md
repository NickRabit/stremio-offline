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

- The new surface is additive and leaves `/api/search`, `searchAll`, Catalog
  browsing and Catalog history creation unchanged.
- One catalog source per searchable catalog is the right pagination and failure
  granularity.
- `globalSearch` remains a server-side source-selection rule.
- The page never merges by title/year and performs no identity metadata lookup
  during search.
- Partial source delivery, a server-owned session and JSON polling are
  testable and fit both clients better than browser-side fan-out or SSE in the
  first release.
- Home is an entry point, not a second result page.
- Cache/coalescing and Catalog's internal incremental migration are correctly
  deferred until the runner is correct.

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
