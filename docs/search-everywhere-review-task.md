# Design review: Search everywhere

## Review status

Reviewed on 2026-10-17. Read [the review and recommended design](search-everywhere-review.md)
before implementation. It resolves the open questions below, including the TV
entry point, privacy scope, conflicting identities and incremental delivery.
This file retains the original brief; where proposals differ, the review's
recommendations take precedence. No search implementation ships in this PR.

## Role

You are an independent product/UX and frontend/backend architecture reviewer.
Review the proposed design below. Do not modify the repository. Do not implement
the feature. Inspect the referenced code and documents where relevant, challenge
assumptions, identify missing cases, and recommend a final design.

Repository: `/Users/holubo/Projects/stremio-offline`

## Context

Catalog search already exists on the Catalog page. It supports browsing, scoped
search across addons, live search, suggestions, recent history and title-match
sorting. The user explicitly wants the Catalog page to remain unchanged, including
both searching and browsing.

The proposal adds a separate **Search everywhere** surface that can search:

- addon catalogs,
- the user's local Stremio Offline library,
- attached Jellyfin/Emby libraries.

The existing Catalog page remains the place for catalog browsing and catalog
search. The new surface is additive, not a replacement.

A live measurement on the current local configuration showed that the existing
catalog search fans out to 22 searchable catalogs. Typical responses were roughly
0.1-1.1 seconds, but a single slow source produced end-to-end waits of 2, 7.3 and
10 seconds. Relevant code:

- `server/src/addons.ts` - `searchAll`, one target per searchable catalog,
  `Promise.allSettled`, 12-second per-addon timeout.
- `server/src/routes/catalog.ts` - `/api/search`.
- `server/src/outbound.ts` - per-host request guard and queue.
- `web/src/App.tsx` - current catalog search orchestration and rendering.
- `web/src/live-search.ts`, `web/src/search-scope.ts`,
  `web/src/search-suggestions.ts`.
- `server/src/routes/content.ts` - local library browse; its `query` only filters
  the currently opened folder.
- `server/src/media-server-manager.ts` - remote library browse and provider search.
- Android TV uses a separate search screen in
  `android-tv/app/src/main/java/cz/stremiooffline/tv/ui/catalog/SearchScreen.kt`.

Review these files and any directly relevant specifications, especially:

- `docs/enhanced-search-spec.md`
- `docs/home-spec.md`
- `docs/media-server-libraries-spec.md`
- `docs/ui-conventions.md`
- `docs/roadmap.md`

## Hard constraints

1. The Catalog page must keep its current UX and behavior for both search and
   browsing. No relocation, removal or visual redesign of its search controls.
2. The new Search everywhere surface is additive.
3. One slow addon, local library scan or media server must not block results from
   faster sources.
4. Results must not be merged merely by title and year.
5. No additional metadata/network lookup may be required merely to decide whether
   two search results are the same title.
6. Search queries must not be persisted to disk, analytics or logs. Any cache must
   be in memory, bounded, and clearable.
7. Library visibility, grants, addon grants and remote-library permissions must be
   enforced server-side before results are returned.
8. Future implementation must follow the project's i18n and UI conventions, but
   this review is design-only.

## Proposed product behavior

### Entry points

- Add a prominent **Search everywhere** entry, likely a top-bar search control and
  `Ctrl/Cmd+K`.
- A sixth item in the mobile bottom navigation is not assumed; the compact bottom
  bar is intentionally limited to five slots.
- Home may contain a search entry and optional recent-query chips. Home must not
  render live search result rows.
- The Catalog page remains unchanged. Its existing search may continue to benefit
  from backend performance improvements, but its UI and behavior stay the same.

### Sources and filters

The new page searches three source classes:

- local libraries,
- remote Jellyfin/Emby libraries,
- addon catalogs.

Possible filters: All, Catalog, Local library, Remote libraries, Movies, Series,
and optionally "Available locally". Review whether these filters are sufficient
and how they should interact with merged results.

### Loading model

Sources load independently:

- one catalog search request or streamed/partial catalog result,
- one local-library search,
- one request per visible remote library.

Each source reports loading, partial, failed and retry states independently.
A compact source-status area shows messages such as "Still searching 2 sources".
Source errors must not replace successful results.

The design should also consider backend changes to reduce tail latency:

- a short overall soft deadline with partial results,
- retrying pending sources,
- a short in-memory cache and in-flight request coalescing,
- propagating request cancellation to upstream addon requests,
- per-source timing diagnostics without logging the query.

Evaluate whether these should be implemented together with the new page or before
it.

## Result presentation and identity

### Core recommendation to review

Separate source loading, but merge the displayed results by strong identity.

Do not create permanent result sections such as "Local", "Jellyfin" and "Catalog"
that repeat the same title in multiple places. Instead, show one ranked list of
title cards. A card carries source/availability badges and opens a canonical
detail with every available source.

Unbound or ambiguous items remain separate in a secondary section, for example
"Files and unidentified items".

### Strong identity rules to review

Merge only when records share a strong identifier and the same content type.

Examples:

| Identity relationship | Merge |
| --- | --- |
| `movie` + IMDb `tt...` from two catalogs | Yes |
| `movie` + TMDB ID from a catalog and a remote library | Yes |
| One record has both IMDb and TMDB and bridges two otherwise separate records | Yes |
| Same normalized title and year, but no shared strong ID | No |
| Same numeric ID but different content type, e.g. movie vs series | No |
| Local folder/file with no verified metadata binding | No |
| Same series + same season/episode | Merge with the episode, not with the series card |
| Different edition or quality of the same strong ID | One title card; keep editions as separate sources/rows |

Important questions for the reviewer:

- Should identity be represented as a set of namespaced IDs, for example
  `movie|imdb:tt0133093`, `series|tmdb:123`, `series|tvdb:456`?
- Is union/intersection over ID sets sufficient to bridge IMDb, TMDB and TVDB
  without unsafe transitive merges?
- Are there false-positive risks in remote provider IDs or addon IDs?
- Which content types must never merge, even if a provider reports the same ID?
- How should a catalog item with an arbitrary addon-local ID and no external ID
  be handled?
- How should remote episode search results be grouped when the parent series is
  known?
- Should the existing `groupByName` behavior be explicitly excluded from the new
  page? Current behavior is in `web/src/App.tsx` around `groupByName`.

### Merged card behavior

A merged card should contain:

- best available title, year, artwork and short metadata,
- badges or a concise source summary such as Local, Jellyfin - Movies, Cinemeta,
- a primary action that reflects available copies,
- access to a canonical detail listing all files, remote copies and addon sources.

Review:

- what the primary action should be when local, remote and catalog records exist,
- whether the card should open a unified detail or the detail of the best source,
- how to preserve language, edition and quality distinctions,
- how merging should affect ranking and sorting,
- whether local availability should boost otherwise equal title matches,
- how to avoid cards jumping when a later source adds an availability badge.

Proposed asynchronous rule: a result may first appear from one source and later be
augmented in place with another source's availability. Existing cards should not
be reordered merely because a source arrived late. Re-ranking should happen on a
new query or an explicit sort change.

## Local library search

The current local library filter only searches within the opened folder through
`browseDirectory`. It is not a global recursive search.

The proposal requires a new server endpoint, for example
`GET /api/library/find?query=...`, backed by the already maintained library walk
index rather than scanning disks on every keystroke. It must:

- search only visible, granted libraries,
- search recursively across title/unit identities,
- return bounded, paged results with enough information to render a card,
- distinguish identified titles from unbound files/folders,
- avoid per-keystroke disk walks,
- handle stale or unavailable library walks truthfully.

`GET /api/library/search` is not this endpoint; it is the manual metadata
identification search through trusted providers.

Review the proposed API shape, identity fields, pagination, latency implications
and permission boundary.

## Remote library search

Remote libraries already support provider-side search through the existing browse
API. The proposal is one search request per visible remote library, run in
parallel with independent timeout, failure and retry states.

Review:

- whether one request per library is preferable to a server-side combined
  endpoint,
- how to bound concurrency and load on Jellyfin/Emby,
- whether search should run while typing, after a longer debounce, or only on
  Enter,
- how to map remote provider IDs and item types into the common identity model,
- how to handle folders, seasons and episodes,
- how revocation and stale grants are rechecked,
- how partial remote failures are presented without making the whole page fail.

## Performance requirements

The design must prevent one slow source from delaying all useful results.

Proposed acceptance targets for a future implementation:

- fast sources visible well before the current 10-12 second worst case,
- no blocking on the slowest addon before rendering other results,
- cancelled or superseded queries do not keep occupying addon queues,
- repeated identical queries become fast through a short in-memory cache,
- pending sources can be retried without duplicating already rendered results,
- no search query appears in logs or persistent storage,
- failures and timeouts remain retryable rather than permanently marking a source
  exhausted.

Review whether a short partial response plus pending-source retry is preferable
to SSE/NDJSON streaming or client-side per-source fan-out. Consider browser
connection limits, TV clients, pagination, cache invalidation and testability.

## Home behavior

Home should provide a search entry, not live results. Review whether a "Recently
searched" row or recent-query chips add value without duplicating the Search page.
The current Home specification describes a curated page with lazy-loaded rows;
evaluate the risk of turning Search into another Home fan-out.

## Non-goals

- Do not redesign or move Catalog search.
- Do not merge results by title/year alone.
- Do not add a second permanently visible global search panel to the Catalog page.
- Do not persist search queries or results to disk.
- Do not change playback behavior or library ownership semantics.
- Do not require extra metadata-provider lookups during search to establish
  identity.
- This review does not implement or edit code.

## Required review output

Return a concise but evidence-backed review with:

1. A clear verdict on the proposed architecture.
2. Corrections or missing cases in the identity and merge model.
3. A recommended result model and UI structure, including how to handle unbound
   items, partial sources and late-arriving availability.
4. Recommended desktop, mobile and Android TV behavior, noting what should remain
   unchanged.
5. A recommended server API and client state model.
6. A phased delivery plan with the highest-value performance work first.
7. Required unit, integration and end-to-end tests.
8. Security, privacy and stale-permission risks.
9. Specific file:line references supporting each important conclusion.
10. Explicitly list any assumptions you could not verify.

Do not modify files or open a pull request. This is a design review only.
