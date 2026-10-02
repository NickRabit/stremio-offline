# Enhanced catalog search: research and implementation specification

Status: proposed; no behavior in this document is implemented by this change.
Research date: 2026-10-02. Baseline: main, commit b67ce84.

## Outcome and scope

Make catalog search useful while typing, sort loaded results by how well their
title matches, and offer recent queries and already seen titles as suggestions.
Each account can clear its search history and turn history off in Settings.

This covers the catalog search box only. Library filtering, download filtering,
metadata identification, playback history and diagnostic log search keep their
existing semantics. No external autocomplete service, AI query expansion, fuzzy
remote search or extra metadata provider is introduced.

The design is deliberately small: the app runs on a home server for a handful
of accounts. Where a stronger guarantee would need its own protocol (revision
counters, cross-tab synchronisation, server-side provenance), this document
names the weaker guarantee it accepts instead.

## Research: current implementation

| Area | Evidence | Consequence |
| --- | --- | --- |
| Submission | `web/src/App.tsx`: the input only sets the `search` draft; `submitSearch` copies it into `submittedQuery` on form submit | Live input needs a debounced path from draft to committed query. |
| Request lifecycle | `App.tsx`, `loadPage`: `requestRef` generation counter and `stale()` guard; no `AbortController` | Late responses are already ignored; transport cancellation is new. |
| Transport | `web/src/api.ts`, `request`: `signal: init.signal ?? AbortSignal.timeout(timeoutMs)` | A caller signal would silently drop the 30 s deadline. Combine both. |
| Scopes | `web/src/search-scope.ts` (`parseSearchScope`); `/api/search` and `/api/searchable` in `server/src/routes/catalog.ts` | Keep all/addon/catalog scopes, type filter, grants, addon order and `globalSearch`. |
| Fan-out | `server/src/addons.ts`, `searchAll` → one `catalog()` per target from `searchableCatalogs`; `TIMEOUT_MS = 12_000`; no cache keyed by query | Every committed query is a full fan-out to every eligible catalog. Prefixes are not cheaper than whole words. |
| Pagination | `searchAll` keeps a per-source offset in an opaque cursor; the client deduplicates and stops when a page gains nothing | Reset on query/scope/type change; sorting never touches cursors. |
| Result ordering | `App.tsx`, `visibleItems`: optional grouping by name, then `sort` of `"default"` (source order), `"name"` or `"year"`. One `sort` state serves browse and search | Search needs its own sort state to offer Title match. |
| Personal storage | `UserData` in `server/src/users.ts`; `dataOf`/`updateData` implemented in `server/src/index.ts`, injected into `routes/personal.ts` | Use the account store, not localStorage or instance settings. |
| Atomicity | `Store.update` in `server/src/store.ts` runs the mutator synchronously on live state, then queues the file write | A read-modify-write done *inside* the `updateData` mutator is already atomic per account. `PATCH /api/views` computes its value from `dataOf` outside the mutator; do not copy that pattern. |
| Restricted mode | `ALLOWED_MUTATIONS` in `server/src/restricted.ts`, matched on the Express-stripped path (`/views`, not `/api/views`) | New personal routes must be listed there. |
| Settings prefs | `UserPrefs`/`PERSONAL_SETTINGS` flow through `PATCH /api/settings` (403 in restricted mode) and into the settings backup | Search preferences must not live in `UserPrefs`. |
| Logging | `addons.ts`, `searchAll` failure: `log("WARN", "Addon request failed", { …, query, reason })`. The generic `/api` request logger logs `req.path` only | That warning is the only server log line carrying a catalog search query. |
| i18n | `web/src/i18n/index.ts`, `LOCALES`: en, cs, sk, de, es, fr, it, pl, pt-BR, ru; `i18n.test.ts` enforces key parity | Every new key goes into all ten catalogues. |

External findings:

- The Stremio [manifest format](https://stremio.github.io/stremio-addon-sdk/api/responses/manifest.html)
  declares search through catalog extras, and the
  [catalog guide](https://stremio.github.io/stremio-addon-guide/sdk-guide/step2)
  describes `skip` pagination. Neither offers autocomplete, so suggestions are
  derived locally and matching stays with the addons.
- The W3C [combobox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/)
  is the keyboard and accessibility contract for the suggestion popup.
- MDN [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal)
  documents `AbortSignal.any` for combining cancellation with a deadline.

Thresholds below are product choices, not benchmark results.

## Product behavior

### Search while typing

- On by default; Settings > Search can turn it off per account, which restores
  explicit submission.
- Commit the trimmed draft after **500 ms** without input when it has at least
  **three** Unicode code points. Three, not two: there is no query cache, and a
  two-letter prefix costs the same full fan-out as a word while matching almost
  everything. Never commit during IME composition; start the timer on
  `compositionend`.
- Enter and the Search button submit any non-empty draft immediately, including
  one or two characters, and cancel the pending timer. Submitting the query that
  is already committed in the same scope/type does not start another request.
- Any new commit, scope/type change, clear, leaving the catalog view or account
  change aborts the in-flight request (`AbortController`) and invalidates its
  generation. An aborted request shows no error. Busy and loading-more state
  are cleared by the code that invalidates, not by the stale request's
  `finally`, so no spinner can be left running.
- While a draft is pending or its first page is loading, the previous results
  stay visible under their own query heading with an Updating indicator.
  Loading further pages is paused until the new first page arrives.
- A draft shorter than the minimum and not submitted leaves the committed
  results as they are and shows a hint: type more or press Enter.
- Clearing the input to empty aborts search and returns to the selected
  browsing catalog, as the existing Cancel button does today.
- Changing scope or type with a committed query reloads the first page
  immediately. Changing sort only reorders loaded items.

### Title match order

- The search sort menu offers Source order (today's "By addon"), Title match,
  Name and Year. Browse keeps its own sort with the existing three options;
  this splits today's shared `sort` state into a browse sort and a search sort.
- The search sort starts from the account's default order (Settings > Search,
  Source order unless changed) each time search is entered from browsing, and
  keeps a manual choice for the rest of that search session.
- Rank by: exact normalized title; title starts with the query; every query
  token is a whole title token; title contains the query; everything else.
  Ties keep source/page arrival order. A query that normalizes to nothing keeps
  source order. Ranking runs after deduplication and grouping and never changes
  IDs, metadata or cursors.
- Only loaded results are ranked; the option is labelled "Title match (loaded
  results)" because a later page can bring a better match. Appending a page
  keeps the scroll position.

### Suggestions

- A listbox under the input shows at most eight rows: up to three recent
  queries matching the draft, then titles from the candidate pool. With an
  empty focused input it shows up to eight recent queries. Opening it never
  makes a request except refreshing history (below).
- The candidate pool holds up to 500 titles from catalog and search pages
  loaded in this session, oldest evicted first, in memory only. Each candidate
  records its type and, when the page came from one addon (a browse catalog or
  an addon/catalog-scoped search), that addon's key. No artwork, details or
  extra pages are fetched for it, and nothing from the library, playback lists
  or other accounts enters it.
- In an addon or catalog scope only candidates tagged with that addon are
  offered; in the all-addon scope every candidate is. The type filter applies
  in every scope. The pool is emptied on logout, account change and whenever
  the addon list or grants are reloaded.
- This is not an authorization boundary and needs no server provenance: every
  candidate is a title this account was already shown, and choosing one only
  submits its text, which `/api/search` authorizes again. The accepted cost is
  an occasional suggestion that returns nothing in the current scope.
- Choosing a recent query or a title submits its text in the current scope; a
  title suggestion does not open details. History stores text only.
- Up/Down move the active option, Enter chooses it or submits the draft,
  Escape closes the popup and keeps the text, Tab moves focus normally.
  Typing reopens it. Use the combobox roles with `aria-activedescendant`, and
  announce result status in a polite live region, not on every keystroke. On a
  phone the popup fits the viewport and does not cover the scope controls; a
  touch on an option must win over the input's blur.
- Matching uses `matchKey` (see Normalization) for both kinds of row. Rows
  display their original text, and title rows are labelled as titles.

### History and privacy controls

- Settings > Search has: Save search history (on), Clear search history,
  Search while typing (on) and Default order (Source order / Title match).
  Toggles and the select write as soon as they change, like the rest of the
  account settings; Clear asks for confirmation first. They apply to the
  signed-in account only, admins included, and stay usable in restricted mode.
  They are separate from the existing Clear playback history action.
- Helper text under Save search history: “Recent searches are suggested on all
  your devices. Turning this off also deletes them.”
- Turning saving off sets the flag and empties the list in one mutation.
  Turning it on starts empty. Clearing leaves saving on. Errors are shown and
  the control returns to the server's state; nothing reports success before the
  server answers.
- At most 20 queries, newest first, kept 90 days by server timestamp.
  Duplicates are detected with `historyKey`; the newest spelling is kept.
  Blank queries and queries over 200 code points are refused.
- A query is recorded when both hold: its first page completed without a
  transport error (an empty result counts), and the user acted on it — pressed
  Enter or Search, chose a suggestion, or opened a result. Debounced commits the
  user only looked at, superseded drafts, failed requests, pagination and
  filter changes are not recorded. Each committed query is recorded at most
  once.
- The server checks Save search history inside the same `updateData` mutator
  that would append, so nothing is stored while saving is off, whatever a stale
  tab sends. Clearing or disabling in a tab drops that tab's not-yet-sent
  record.
- Accepted limitation: if another tab or device had a record in flight when
  history was cleared (saving still on), that one query can reappear. No revision
  protocol is added for this; it only ever re-adds the user's own latest search.
- History is reloaded when the search input gains focus, so other tabs and
  devices catch up without polling. Draft text is never written to
  localStorage, URLs, analytics or telemetry.

### Logging and caching

- Drop `query` from the `searchAll` failure warning in `addons.ts`; keep addon,
  catalog and the reason category. This line is shared with library
  identification, which is fine: it loses nothing it needs.
- The two DEBUG lines in `server/src/library-candidates.ts` that log a library
  title are out of scope: they carry file-derived titles, not anything a person
  typed.
- Send `Cache-Control: no-store` on `/api/search` and the new search routes.
- Search state is not part of the settings backup; it does not live in
  `UserPrefs`, so `createSettingsBackup` never sees it. Old logs, backups,
  browser history and addon-side logs are not erased; a remote search always
  sends its text to the addons.

## Architecture and API contract

Add an optional `search` field to `UserData`, read tolerantly. Do not add it to
`emptyUserData()`: the exact-shape assertion in `server/src/users.test.ts`
stays as it is, and every fake store keeps working.

```ts
type SearchState = {
  saveHistory: boolean;                           // true when absent
  liveSearch: boolean;                            // true when absent
  defaultOrder: "source" | "titleMatch";          // "source" when absent
  recent: { query: string; usedAt: string }[];    // newest first
};
```

Routes in `server/src/routes/personal.ts`, all session-derived through
`dataOf`/`updateData`, never accepting a user ID:

| Endpoint | Contract |
| --- | --- |
| GET `/api/search/state` | Preferences plus recent entries, expired ones filtered out (not written back). Empty `recent` when saving is off. |
| PATCH `/api/search/preferences` | Strict partial patch of the three preferences; unknown keys or wrong types are refused. `saveHistory: false` also empties `recent`. Returns the state. |
| POST `/api/search/history` | `{ query }`. 204 when stored, and 204 without a write when saving is off. Prunes expired entries while writing. |
| DELETE `/api/search/history` | Empties `recent`, idempotent. Returns the state. |

Every mutation reads and writes inside the single `updateData` mutator. Add
`PATCH /search/preferences`, `POST /search/history` and `DELETE /search/history`
to `ALLOWED_MUTATIONS`. If the state fails to load, manual search still works,
history is not recorded, and live search falls back to on.

The `/api/search` envelope, cursor and scope authorization are unchanged.
Recording is a separate request, so API callers, scans and pagination never
write history.

Client structure: move the draft/debounce/abort lifecycle, normalization and
ranking, and the suggestion pool out of `App.tsx` into focused modules next to
`web/src/search-scope.ts`, plus a combobox component. `api.search` takes an
optional signal; `request` combines it with the deadline via `AbortSignal.any`
(or an equivalent tested fallback). Upstream addon requests are not cancelled
in this release; the browser abort only frees the client.

### Normalization

Two functions with different jobs, named so they cannot be swapped:

- `matchKey(text)`: NFD, strip combining marks, lowercase, punctuation to
  space, collapse whitespace. Used for ranking and for matching suggestions, so
  "pribehy" finds "Příběhy".
- `historyKey(text)`: NFC, trim, collapse whitespace, lowercase, diacritics
  kept. Used only to deduplicate history, so "Pes" and "Peš" stay separate.

## Acceptance and validation

1. Unit, fake timers: 499/500 ms boundary, three-code-point minimum, Enter with
   one character, IME composition, duplicate submission, live search off,
   clear and unmount cancel the timer.
2. Unit: `request` with a caller signal still times out; an abort raises no
   error toast.
3. Integration, delayed fixture: response A arriving after B was committed
   changes nothing visible and records nothing; no spinner survives a clear or
   a sub-minimum draft.
4. Routes: two accounts including an admin stay isolated; unauthenticated
   requests are refused; strict validation; defaults when `search` is absent;
   20-entry and 90-day bounds; dedupe by `historyKey`; disable empties; record
   while disabled is a no-op 204; all three mutations pass in restricted mode;
   a settings export/import leaves `search` untouched.
5. History: typing several prefixes and pressing Enter stores one query; a
   debounced result nobody acted on stores nothing; a zero-result search acted
   on is stored; failures, pagination and filter changes are not.
6. Ranking and normalization: accented Czech titles, punctuation-only queries,
   duplicate titles, stable ties, grouping on and off.
7. Suggestions: eight-row and 500-candidate bounds, addon-scope filtering, pool
   emptied on account and addon/grant reload, keyboard and touch selection.
8. E2E: search while typing, choosing a suggestion, a one-character Enter,
   clear and disable history on a regular user without touching another
   account; Settings > Search usable in the restricted suite without changing
   its existing assertions.
9. Server log: a failing addon during search logs no query text.
10. After the functional checks are stable: keyboard and screen reader pass,
    layout across the viewport matrix, then the repository gates and local
    Docker check per AGENTS.md.

## Delivery sequence

1. Search while typing, request cancellation with the kept deadline, separate
   search sort with Title match, and the logging/no-store fix. Visible on its
   own and needs no new storage.
2. Search state, the four routes, Settings > Search and history recording.
3. Suggestion popup with recent queries and the candidate pool.

Each step is its own pull request with a patch version bump. Update shipped
docs only when a step is released.
