# Enhanced catalog search: research and implementation specification

Status: proposed; no behavior in this document is implemented by this change.
Research date: 2026-09-30. Baseline: main, commit 5719f52.

## Outcome and scope

Make catalog search useful while typing, with recent queries, suggestions from
already loaded catalogs, and optional title relevance sorting. Each account can
clear its search history and disable history storage in Settings.

This covers the catalog search box only. Library filtering, download filtering,
metadata identification, playback history, and diagnostic log search keep their
existing semantics. No external autocomplete service, AI query expansion,
fuzzy remote search, or extra metadata provider is introduced.

## Research: current implementation

| Area | Evidence | Consequence |
| --- | --- | --- |
| Submission | `web/src/App.tsx`, `submitSearch`, updates `submittedQuery` on form submit | Live input needs a separate draft/committed query lifecycle. |
| Request lifecycle | `App.tsx`, `loadPage`, request generation refs and first-page reset effect | Stale results are guarded, but transport cancellation is not implemented. Invalidating only at dispatch leaves a debounce window where an old response can still win. |
| Transport | `web/src/api.ts`, `request`, uses caller signal OR a 30-second timeout | Adding cancellation must retain the deadline; the current OR would lose it. |
| Scopes | `web/src/search-scope.ts`; `/api/search` and `/api/searchable` in `server/src/routes/catalog.ts` | Keep all/addon/catalog scopes, type restrictions, user grants, addon order and globalSearch behavior. |
| Fan-out | `server/src/addons.ts`, `searchableCatalogs` and `searchAll` | One first-page query can contact every eligible catalog. Debounce reduces calls but does not cancel upstream work by itself. |
| Pagination | `searchAll` uses a separate offset per source; client deduplicates and stops on no gain | Preserve opaque cursors and reset on query/scope/type changes. Sorting must not rewrite cursor semantics. |
| Result ordering | `App.tsx`, `visibleItems`, default/name/year sorting after optional name/year grouping | Add relevance after existing grouping; preserve other sort modes. |
| Personal storage | `server/src/users.ts`, `UserData`; `routes/personal.ts`, `dataOf` and `updateData`; `views.ts` | Use authenticated account storage, not shared localStorage or global configuration. |
| Settings | `App.tsx`, Settings has a playback-history action and restricted controls | Add clearly named search controls accessible to all account roles; do not reuse Clear playback history. |
| Logging | `server/src/addons.ts`, search failure warning includes query and error reason | New history controls must not leave raw queries in newly generated application logs. |

External findings:

- The Stremio [manifest format](https://stremio.github.io/stremio-addon-sdk/api/responses/manifest.html)
  declares search capability through catalog extras. The
  [catalog guide](https://stremio.github.io/stremio-addon-guide/sdk-guide/step2)
  describes `skip` pagination. Neither is an autocomplete interface. Therefore
  this proposal derives suggestions locally and preserves addon-owned matching.
- The W3C [combobox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/)
  provides the keyboard and accessibility contract for an editable input with a
  suggestion popup. Use this pattern, with manual selection and no automatic
  replacement of the user's text.
- MDN [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal)
  documents cancellation and composing signals. Combine request cancellation
  with the existing deadline, using a tested compatibility fallback if needed.

The thresholds below are product choices, not results of a latency benchmark.
No production traffic measurement or external-addon load test was run.

## Product behavior

### Live input

- Default: enabled. Commit a trimmed query after 400 ms without input, only
  when it contains at least two Unicode code points. Never dispatch during IME
  composition; start the timer after compositionend.
- Enter and Search immediately submit any non-empty query, including one
  character. Cancel the pending debounce. Repeated submission of the same
  query/context does not create another first-page request.
- Settings offers Search while typing. Turning it off restores explicit
  submission and cancels any pending timer. This preference is per account.
- Invalidate the current request generation on draft edits, scope/type changes,
  clearing, leaving the catalog view, and account changes. Abort obsolete
  client requests immediately. A late result cannot change items, selection,
  source count, cursor, errors, busy state, or history eligibility.
- While a new draft is pending, existing results may remain visible with their
  old query heading and an Updating state. Disable pagination and selection of
  stale result cards until that draft is committed or explicitly reverted.
- Clearing immediately aborts search, clears draft/committed query and search
  paging, and restores the selected browsing catalog. No empty-query request.
- A one-character unsubmitted draft cancels pending work and shows a hint to
  type another character or press Enter; it does not execute automatically.
- Scope/type changes with a committed query start a new first page immediately,
  unless an edited draft is pending: then apply the same debounce/minimum rules
  to that draft. Changing sort only rearranges loaded items.
- Leaving search cancels timers. Returning does not execute an unfinished draft.
  Session reset clears all in-memory query, history and suggestion state before
  rendering the next account. Authentication failures retain existing handling.

### Suggestions

- Show at most eight rows: up to three matching recent queries, then locally
  loaded titles filling the remaining slots. With empty input show up to eight
  recent queries; no remote request is made just to populate the popup.
- Match case-insensitively, ignoring diacritics and repeated whitespace. Keep
  original spelling for display and remote requests. History and title rows
  have distinct labels and are deduplicated within their kind.
- Candidate titles come only from catalog pages loaded during the current
  authenticated session. Maintain a bounded memory pool of 500 identities
  (type/id plus provenance), evicting oldest candidates. Do not fetch artwork,
  details, or extra pages to build it; do not persist this pool.
- Filter candidates by current scope/type and current addon grants/enabled
  state. Track contributing sources when deduplicating. In all-addon scope,
  exclude provenance that is opted out of global search. Clear the pool on
  logout/account changes and conservatively on grants/addon configuration
  changes. Never index playback lists, library filenames or other accounts.
- Clicking a title suggestion submits its displayed title in the current
  context; it does not navigate directly to details. Clicking a history query
  also uses the current context. History stores text only, not old scopes.
- Up/Down move the active option, Enter selects it or submits the draft, Escape
  closes the popup without clearing input, and Tab moves focus normally.
  Editing reopens suggestions. Preserve text editing and IME keys.
- Follow the W3C combobox roles and active-descendant pattern. Announce loading
  and final result status through a polite status region without announcing
  each keystroke. Popup fits phone/tablet viewports and does not obscure scope
  controls; touch selection must survive blur ordering.

### History and privacy controls

- Settings > Search contains Save search history (default on), Clear search
  history, Search while typing, and default result order (Source order or Title
  match). Controls apply only to the signed-in account, including admin accounts.
  They remain available when server-level settings are restricted.
- Helper text: “Save queries for recent-search suggestions on your devices.”
  Explain that turning saving off also deletes existing search history.
- Turning Save search history off atomically sets the preference to false and
  deletes all entries. Hide recent-query suggestions immediately. On failure,
  show an error and retain/reload the server state; never report success early.
- Turning it on starts with an empty history. Clearing history while saving is
  on leaves saving on. Clear requires a confirmation, succeeds only after
  persistence, is idempotent, and affects no playback history or other account.
- Store at most 20 unique queries for 90 days, most recent first, using server
  timestamps. Prune on read and mutation; expired entries are never returned.
  Duplicate key: NFC, trim, whitespace collapse and Unicode lowercase; retain
  diacritics in the key to avoid merging distinct searches. Display the latest
  submitted spelling. Reject blank/invalid/over-200-code-point history writes.
- Do not store each debounce submission. A query becomes eligible only after
  its current first-page request completes successfully (empty results count).
  Record it on explicit Enter/Search/suggestion selection, result activation,
  or leaving the input after completion. If blur occurs before completion,
  defer until completion while that same query/context remains current. Drop
  intermediate/superseded drafts and pagination/filter-only operations.
- The server rechecks Save search history at mutation time. Add a monotonically
  increasing history revision to prevent delayed record requests from
  repopulating history after clear/disable. Record requests carry the revision
  obtained from GET; mismatches return 409 and do not retry automatically.
- Serialize clear/disable/record within the account storage transaction. Never
  replace a stale full UserData snapshot. A disable that wins before a record
  prevents it; a clear that wins after a record removes it.
- Other tabs/devices refresh history/preferences on focus and before recording.
  A stale tab cannot store history while disabled or restore cleared entries.
  Client draft text is not saved in localStorage, URLs, analytics or telemetry.
- Remove raw search query and query-bearing error URLs/reasons from new search
  logs at every log level; retain addon/catalog identifiers and safe error
  categories. Audit generic request logging and URL-keyed caches before claiming
  this. No promise of erasing old logs, backups, browser network records or
  external addon logs: remote search necessarily sends its query to addons.
  Personal history stays out of settings export/import and diagnostic bundles.

### Optional relevance order

- Existing source order remains the default. Title match is selectable in the
  search sort menu and as the account default; existing name/year modes remain.
- Normalize query/title with Unicode decomposition, diacritic removal,
  lowercase, punctuation-to-space and whitespace collapse. Rank by: exact full
  normalized title; title prefix; all query tokens as full title tokens; title
  substring; remaining results. Ties preserve original source/page arrival order.
  A normalization that yields empty text preserves source order.
- Rank after existing deduplication/grouping without changing IDs, metadata or
  stream lookup. Rank only loaded results; label it “Title match (loaded
  results)” because later pages can insert better matches. Preserve the scroll
  anchor when appending a page. Do not claim global relevance or fetch all pages.

## Architecture and API contract

Add `search` to account `UserData`, with tolerant reads and strict mutation
validation. Proposed storage:

```ts
type SearchState = {
  saveHistory: boolean;        // true when absent
  liveSearch: boolean;         // true when absent
  defaultOrder: "source" | "titleMatch";
  historyRevision: number;     // zero when absent; increment on clear/disable
  recent: { query: string; usedAt: string }[];
};
```

Do not put the history array in `/api/views` or global settings. Add personal
routes using the existing session-derived `dataOf`/`updateData` boundary:

| Endpoint | Contract |
| --- | --- |
| GET `/api/search/preferences` | Returns preferences, revision and pruned recent entries; response Cache-Control: no-store. |
| PATCH `/api/search/preferences` | Partial strict preference patch. Disabling atomically clears and advances revision; returns updated state. |
| POST `/api/search/history` | `{ query, historyRevision }`; server timestamp/dedup/bounds; 204 if saved or saving is disabled, 409 on stale revision. |
| DELETE `/api/search/history` | Clears entries and advances revision atomically; returns updated state. |

All routes require a session, derive the account server-side, reject unknown
mutation keys and never accept a target user ID. A disabled history is always
returned as empty. Preferences loading failure must allow manual search but
must not assume history saving is permitted. Existing users get defaults
lazily; do not copy any shared query history into accounts.

Retain `/api/search` response shape and scope authorization. History writes
are separate from GET search, so scans/API callers and pagination cannot
accidentally record queries. Existing failures do not distinguish complete
addon failure from genuinely empty search: recording acknowledges a completed
API response, not successful access to every addon. Do not add a reliability
claim or treat an empty response as proof that no matching title exists.

Extract draft/debounce/request lifecycle, normalization/ranking and suggestions
from `App.tsx` into focused search modules/components. Extend `api.search` to
accept a signal composed with the deadline; an intentional abort is silent.
Browser abort alone is not an upstream cancellation guarantee. Keep upstream
cancellation out of the initial release unless its propagation through shared
fetch/cache work is proven safe. Audit fan-out load with a delayed fixture.

All UI text is added to English and Czech catalogs. Deliver controls with
explicit Search wording, distinct from the existing playback-history action.

## Acceptance and validation

1. Fake-timer tests: 399/400 ms boundary, rapid edits, one-character Enter,
   composition events, duplicate submission, live-search off, clear and unmount.
2. Delayed-response integration: A resolves while B is debouncing or after B;
   A cannot update any visible state or record history. Deadline still applies
   when caller cancellation is supplied; abort does not produce an error toast.
3. Account route tests: isolation between two users including admin, unauthenticated
   rejection, strict validation, defaults, restart persistence, retention/bounds,
   clear without changing saving, disable+erase, reenable empty.
4. Race tests: delayed record after clear or disable, concurrent tabs, stale
   revision, and simultaneous unrelated account mutations cannot resurrect
   history or overwrite preferences. Failed persistence is surfaced in Settings.
5. History interaction tests: typing several prefixes stores only the settled
   used query; zero-result completion can be recorded; failed/superseded requests,
   paging and filter changes do not add entries.
6. Ranking/suggestion tests: accented Czech titles, punctuation-only queries,
   duplicate names and identities, stable ties, grouping on/off, all scopes,
   revoked grants and global-search exclusions; eight-row/500-candidate bounds.
7. Functional E2E: Search while typing, keyboard/touch suggestion selection,
   explicit one-character query, disable/clear on a regular user, another account
   stays unaffected. Query text is absent from captured application logs and
   settings export; inspect nested error reasons as well as top-level fields.
8. Performance fixture: a burst within 400 ms produces one first-page fan-out;
   no autocomplete requests, no overlapping pagination, and no extra call for
   immediate Enter. Record behavior with delayed/failed addon fixtures.
9. After functional checks stabilize, verify keyboard/screen-reader operation
   and phone/tablet/desktop layout once. Run repository build/unit/E2E gates for
   implementation, then local Docker deployment and health check per AGENTS.md.

## Delivery sequence

1. Account state, personal API, history controls and privacy logging audit, with
   isolation and race tests. Deliver erase and disable together.
2. Draft lifecycle, debounce, cancellation and local suggestions, with functional
   and load fixtures. Preserve all current scopes and pagination.
3. Optional title ranking, preference, translated labels and final accessibility
   and visual verification. Update shipped docs only when behavior is released.

This specification PR needs documentation review only: no application build,
version bump or Docker deployment because it ships no executable change.
