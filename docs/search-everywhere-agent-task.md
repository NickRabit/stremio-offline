# Agent task: implement Search everywhere

Implementation brief derived from PR #449 (`docs/search-everywhere-*.md` on
branch `docs/search-everywhere-review`). Those four documents remain the design
record; [search-everywhere-implementation.md](search-everywhere-implementation.md)
is normative **except where this brief overrides it**. Every override is listed
in "Decisions" below, with the reason, so a later reader does not "fix" it back.

Code references were re-checked against `main` at `ca4608fb`.

## Goal

Add an additive **Search everywhere** surface on web and Android TV that searches
addon catalogs, local libraries and attached Jellyfin/Emby libraries in one
place. Fast sources paint first, results merge only by conservative strong ID,
queries are never persisted, and the whole feature hides behind a default-off
server flag until both clients are done.

## What the review of PR #449 found

### Verified against the code (the plan's premises hold)

| Claim | Where |
| --- | --- |
| `searchAll` waits on every catalog with `Promise.allSettled`; a rejected catalog gets offset `-1` (permanently exhausted). | `server/src/addons.ts:170-205` |
| `globalSearch: false` is honoured only for an unscoped search. | `addons.ts:149`, `routes/catalog.ts:105` |
| `reasonOf(error)` is logged for a failed search; undici error text can carry the addon URL with the query. | `addons.ts:11`, `:191` |
| `jsonFetch` passes only `AbortSignal.timeout`; the timeout starts before host-queue admission. | `addons.ts:16-25` |
| `OutboundGuard.acquire` has no cancellation; breaker logs a raw `reason`. | `outbound.ts:162`, `:201` |
| `images.proxied()` returns the upstream URL when Secure Mode is off and persists the mapping when on. | `images.ts:269` |
| One serial all-library walk (`videoCache`) feeds `unitCache` and `libraryCache`; `WalkCache.get` blocks on a cold value but already supports a `stale` read. | `index.ts:1017-1065`, `walk-cache.ts:24` |
| Title browse types are `Movie,Series,MusicVideo`, without `Episode`. | `media-server-provider.ts:62`, `:671` |
| Web loads Catalog history for every view once the session is ready. | `web/src/App.tsx:1910` |
| Both clients stop Catalog continuation on a page that adds nothing new. | `App.tsx:1882`, `SearchViewModel.kt:175` |
| TV shell already distinguishes Search opened from Catalog. | `ui/shell/Shell.kt:239`, `:294` |
| Ten web catalogues (`en cs de es fr it pl ptBR ru sk`) and ten TV `values*` locales. | `web/src/i18n/`, `android-tv/app/src/main/res/` |

### Gaps and contradictions in the plan

1. **Catalog on the session engine is underspecified and collides with the
   flag.** The second pass moves the web and TV Catalog grid onto a
   "catalog-only session", but:
   - the start request has no `type`, `addonKey`, `catalogType`, `catalogId`
     fields, so Catalog's scopes cannot be expressed;
   - the snapshot carries clusters, while Catalog needs `MetaItem`s folded by
     `type:id` in target order with `sources` names;
   - every session route answers `404` while `SEARCH_EVERYWHERE_ENABLED` is off,
     so Catalog search would break in the default configuration;
   - `search-too-broad` (> 60 targets) would refuse a Catalog search that works
     today;
   - two sessions per browser session: Catalog + Search everywhere + a second
     tab already hits `search-session-limit`;
   - the Catalog projector row says the cursor is a stateless base64url object,
     which contradicts reading it from a server-owned session.
2. **The document contradicts itself on Catalog.** The "Existing files touched"
   row for `web/src/App.tsx` and the "Opening a card" section say Catalog search
   code stays untouched; Phase 2 changes Catalog `loadPage`. The earlier review
   file still says "20 rows per source page" for catalogs, which the Catalog
   projector no longer does.
3. **Session artwork store protects nothing Catalog does not already expose.**
   The same addon posters reach the client today through `images.rewriteMeta`
   on `/api/search`. A poster URL is the addon's, not query-derived. A
   memory-only artwork proxy per session is a new image pipeline with its own
   limits, LRU and tests for no user-visible gain.
4. **`LibrarySnapshotStore` rewrites library browse caching for everyone.**
   It changes the infrastructure behind daily library browsing, ships while the
   flag is off, and is the riskiest part of the plan. Search only needs a
   non-blocking read; the hung-mount isolation is a separate improvement.
5. **Scope.** Eight new server modules, a cache refactor, a new web view, a new
   TV screen and grid, and the Catalog migration are one feature but far too
   much for one unverified step. It needs slices with a working, testable
   state after each.
6. The plan does not say what TV's rail Search does while the flag is off
   (answer: exactly today's behaviour) or how the flag reaches TV (answer: the
   same authenticated settings projection).

## Decisions (overrides of the PR #449 plan)

The owner approved these four decisions on 2026-10-17.

| # | Decision | Decision |
| --- | --- | --- |
| D1 | Catalog incremental arrival | **Separate last slice (S5), own contract, own flag.** Slices S0-S4 keep both Catalog clients on `GET /api/search`. On the server, `searchAll` already runs over the shared raw adapter from S1, so Catalog gets the abort, admission-deadline and log fixes immediately. |
| D2 | Catalog artwork in Search everywhere | **Reuse `images.rewriteMeta`, exactly as Catalog does.** No `search-artwork.ts`, no `/artwork/:artworkId` route. Revisit only if Secure Mode policy changes. |
| D3 | Local index source | **`LocalSearchIndex` built in the background from the existing `videoCache`/`unitCache` + `metaStore`.** Search reads only the last published index; cold → source `indexing`, failure → `unavailable`. No `LibrarySnapshotStore`, no change to browse caches. Per-library isolation is a follow-up. |
| D4 | Delivery | **One branch, one PR, one commit series per slice** (owner rule: slices of one feature share a PR; screenshots and UX checks once at the end). |

Everything else in the implementation proposal stands: session + JSON polling,
slot/generation replacement, per-catalog sources, strong-ID clustering with the
A/B/C/D and X/Y/Z cases, member-preserving chooser, privacy rules, default-off
flag with `404` routes, separate TV screen and ViewModel, no history.

## Slices

Each slice ends green (`npm test`, `npm run build`, TV `testDebugUnitTest` where
touched) and is committed on the same branch.

### S0 – contracts, identity, session manager (server, no I/O)

New: `server/src/search-contracts.ts`, `search-identity.ts`,
`search-session.ts`, `search-sources.ts` (interface + scheduler + fake sources).

- Strict request parser: 1-200 code points **and** ≤ 256 UTF-16 units; `kind`,
  `sources`, `slotId`, `generation`; unknown keys rejected.
- `SearchAuthority` from `currentUser`/`currentSession`; revalidated before
  dispatch, after admission and before every response (including
  `changed: false`).
- Session store: owner binding, slot/generation replacement (validated before
  the old session is cancelled), idempotent duplicate generation, conflict on
  a different query under one generation, 2 sessions per browser session
  (replacement takes no new seat), 50 server-wide, 5 min idle expiry on a
  timer, 256 owner-bound tombstones for `410`, one waiting poll per session.
- Scheduler: independent catalog (8) / local (1) / remote (8, 2 per connection)
  pools, server-wide 32, round-robin across sessions, then class, then
  host/connection, then target order. Every cancel path releases its tokens
  exactly once.
- Source lifecycle states and rules exactly as the plan: retry keeps cursor and
  buffer; three no-progress pages → `stalled`; only a successful end page →
  `exhausted`; 1,200 records / 4 MiB → `limitReached`.
- Identity: IMDb/TMDB/TVDB only, exact-match extraction, kind-scoped; pairwise
  edge graph → components → deterministic partition of contradicted components
  by lowest joined `memberKey`; scoped opaque ids; episode synthetic identity;
  deterministic primary member; cluster key retirement + `aliases`.
- All limits are named constants in `search-contracts.ts`.

Tests (unit, controllable clock): every case listed under "Unit and module
tests" in the plan, minus artwork and snapshot-store items. Clustering cases
run under reversed `memberKey` and reversed arrival order.

### S1 – outbound and the shared raw catalog adapter (server)

Touch: `outbound.ts`, `addons.ts`.

- `OutboundGuard.acquire(signal)`: an aborted waiter leaves the queue and
  settles once; releases slot, spacing and half-open trial; caller abort is
  `cancelled`, never an outage. Optional fairness key.
- `guardedJson`: execution deadline from admission, covering the bounded body
  read; host slot held until parse ends; malformed JSON is a provider failure.
- Breaker and adapter logs use fixed codes (`timeout`, `abort`, `network`,
  `http-<status>`, `invalid-json`); no `reasonOf`, no URL, no body. The legacy
  `guardedFetch` callers keep their behaviour apart from the log text.
- Raw catalog adapter: one `(addon, catalog)` target, `search` + `skip`,
  returns raw metas + next raw offset; `skip` support read from manifest extras.
- `searchAll` becomes a waiter over that adapter. `SearchResult`, target-order
  fold, `-1` on failure and `GET /api/search` body stay byte-identical.

Tests: queue cancellation, deadline starts at admission, body-read timeout,
caller abort not counted by the breaker, a sentinel query absent from every log
line (including a malformed-JSON path), and the existing `addons.test.ts`
`searchAll` / IdentifyDialog / `LibraryCandidates` cases unchanged.

### S2 – real adapters and routes behind the flag (server)

New: `search-local-index.ts`, `routes/search-everywhere.ts`. Touch:
`media-server-manager.ts`, `media-server-provider.ts`, `index.ts`,
`server-shutdown.ts`, `routes/personal.ts`, `routes/settings.ts`,
`api-types.ts`, `roles.ts`, `restricted.ts`, `docs/configuration.md`.

- `SEARCH_EVERYWHERE_ENABLED` (default off): routes not registered, index not
  warmed, settings projection carries `searchEverywhere: false`.
- Catalog source: discovery via `allowedAddons` → `orderedForUser` →
  `searchableCatalogs(..., { respectGlobalSearch: true })`; Everywhere
  projector with field allowlist, 20 accepted rows, server-only raw offset and
  buffer, `continuation: "unsupported"` without declared `skip`; artwork via
  `images.rewriteMeta` (D2).
- Local source (D3): index built after `markServerReady()` and after
  `invalidateLibrary()` (debounced, generation-stamped, older result
  discarded); top-K scan in chunks with abort checks; filtered per session by
  the viewer's visible libraries; `indexing` → subscribe and start when the
  generation publishes.
- Remote source: new root-scoped recursive search op, include types
  `Movie` / `Series,Episode` / `Movie,Series,Episode`, no `MusicVideo`; cursors
  bound to op version + type set; existing post-await checks.
- Routes exactly as listed in the plan except `/artwork/:artworkId` (D2);
  `Cache-Control: private, no-store` before the first await; added to
  `USER_ALLOWED` / `ALLOWED_MUTATIONS` with exact parameter counts; not in
  `OPEN_PATHS`.
- `GET /api/search/preferences` returns only `liveSearch`.
- Revocation hooks: `dropSession`, `dropUser`, `invalidateContent`; manager
  `close()` before the shutdown drain.
- Paged member detail (100 / 512 KiB, `nextFrom`), local `BrowseItem` via
  `describeLibraryPath` at click time.

Tests: all "Server integration tests" in the plan through the real auth, role,
password-change and restricted middleware, with the flag on and off. The
headline gate: a 100 ms fake catalog is in the first snapshot while a 10 s one
is pending; replacing the query with 100 queued jobs leaves none queued.

### S3 – web Search everywhere

New: `web/src/search-everywhere.ts`, `useSearchEverywhere.ts`,
`SearchEverywhere.tsx` (+ card / member chooser). Touch: `api.ts`, `types.ts`,
`App.tsx`, `Home.tsx`, `style.css`, all ten `i18n/*.ts`.

- Hook lives in `App.tsx` so a detail opened from Search keeps the session,
  query, scroll and focus anchor; polling pauses while covered and when the
  document is hidden; `keepalive` DELETE on leave.
- Move `loadSearchState()` off the global ready effect onto Catalog and
  settings only. Catalog behaviour must not otherwise change.
- Top-bar entry (icon-only on compact chrome), Home "Open search" action,
  `Ctrl/Cmd+K` that ignores editable targets and IME composition; no sixth
  bottom-nav item; no query in URL or storage.
- Source/kind filters start a new generation; `Available locally` is a
  client-side predicate on both lists.
- Append-only layout keyed by member anchor; badges update in place; merge
  keeps the focused card's position; split keeps the focused side.
- Member chooser reuses the existing catalogue, local and remote details; no
  Play shortcut; optional "Open title page". Do not restructure those details
  (owner rejected the shared-detail rewrite).
- Dialog and control styling per `docs/ui-conventions.md`.

Tests: Vitest for the hook (generation rejection, 410 restart once, poll
back-off, hidden tab) and Playwright for every "Web end-to-end tests" item in
the plan, against fake addon fixtures with 100 ms / 10 s delays.

### S4 – Android TV global Search

New: `GlobalSearchViewModel.kt`, `GlobalSearchScreen.kt`, a focus-stable result
grid. Touch: `ApiClient.kt`, `TvApi.kt`, `CatalogDtos.kt`, `Shell.kt`, every
`values*/strings.xml` (+ `strings.keys`).

- Rail Search opens `GlobalSearchScreen` **only when the flag is on**; otherwise
  today's `SearchScreen`. Catalog-origin search keeps `SearchViewModel`, history,
  `rememberSaveable` draft and Back destination untouched.
- Explicit submit only (IME Done / OK / voice); no `rememberSaveable` for the
  global draft.
- Cancellable OkHttp adapter (`Call.cancel()` via `invokeOnCancellation`) for
  the new calls only.
- Grid key = anchor `memberKey`; focus restored after merge/split/append;
  partial results never steal focus; retry rows focusable; detail opens through
  the existing overlays so the ViewModel survives and Back restores the card.

Tests (Robolectric + Compose in `testDebugUnitTest`, each written to fail on a
naive implementation first): focus survives merge, split and appended page;
retry row reachable by D-pad; Back from detail restores the same card;
Catalog-origin path still records history and returns to Catalog; leaving the
screen cancels the `Call`. Then an emulator pass.

### S5 – Catalog incremental arrival (D1)

Only after S0-S4 pass. Own flag `CATALOG_INCREMENTAL_SEARCH` (default off);
when off or when the route answers `404`, both clients use `GET /api/search`
as today.

Contract to add (fills gap 1):

- Start body `mode: "catalog"` with `type?`, `addonKey?`, `catalogType?`,
  `catalogId?`; `respectGlobalSearch` follows today's rule (`!addonKey`).
- Snapshot in catalog mode: `items: MetaItem[]` folded by `type:id` in target
  order with `sources` names, passed through `images.rewriteMeta`; per-source
  states; `hasMore`; no clusters.
- No 60-target refusal in catalog mode. Its seat is separate from the
  Everywhere seat (one slot per surface per browser session).
- Load more = the aggregate page route; a page that adds no new `type:id` still
  ends continuation (current `gainedNothing`).
- History, sort, scope picker and `mergeByName` stay in the clients.

Tests: existing Catalog e2e and TV `SearchScreen` tests unchanged and green;
new test that a fast catalog paints before a slow one on both clients; scope
matrix for `globalSearch: false` (zero upstream calls for "all", reachable when
explicitly selected).

## Out of scope

Cache/coalescing, Home recent-query chips, fuzzy matching, SSE, a Search
everywhere addon picker, music-video search, `LibrarySnapshotStore`, the
session artwork store.

## Workflow

- Branch `feature/search-everywhere` off a fresh `origin/main`, in its own
  worktree (the main checkout carries unrelated uncommitted work).
- One PR for all slices. Rebase on `main` whenever it moves.
- User-facing → patch bump at the end, reading `main`'s version and tags right
  before bumping (`npm version <x.y.z> --no-git-tag-version --workspaces
  --include-workspace-root`, then `node scripts/check-versions.mjs`).
- Functional checks first, then once at the end: web viewport matrix,
  screenshot baselines, TV emulator focus check, `docker compose up -d --build`
  with `SEARCH_EVERYWHERE_ENABLED=1` and `/api/status` → `{"status":"ok"}`.
- Record measured timings (fast vs slow source, 100,000-entry local index) and
  the hardware in the PR description.

## Definition of done

- With the flag off: no new route answers, no entry is visible, Catalog search
  and library browsing behave exactly as on `main` (existing suites green).
- With the flag on: a 100 ms source is visible within one second while a 10 s
  source is pending, on web and TV; a revoked source disappears from the next
  snapshot; a sentinel query appears in no log, URL, storage or saved state;
  `globalSearch: false` addons receive zero calls from Search everywhere.
- All tests listed per slice exist and pass; TV tests were shown failing on the
  naive code first.
