# Home page: design specification

Status: proposed, not implemented. Written 2026-10-05 against `main` at 0.5.6.
The [roadmap](roadmap.md) owns priority; this file owns the shape of the page.
It was drafted with an independent read of the code, and every claim about
current behaviour below was checked against the source.

## What it is

An additional **Home** view for an account. The catalogue and the library stay
exactly as they are: same navigation entries, scroll restoration and API
contracts, and the app still opens on the catalogue. Home is built from state
the app already holds. It never scans a disk and never fans out to addons on
load.

The app is a download manager first and a player second, so Home leads with the
queue rather than with a "watch what you have" shelf. The official Stremio home
is deliberately not the model. Ideas taken from Jellyfin, Plex and Infuse:
short horizontal rows, one merged Continue watching row that mixes movies and
episodes, progress drawn on the tile, and removal from the row on the card
itself. A full-width resume hero was considered and rejected: on a phone on its
side (802x293) it would take the only visible band.

## Rows

Fixed order. A row with nothing in it is not drawn, so a quiet queue lets
Continue watching rise to the top and a busy one pushes it down. Nothing is
re-ordered by a heuristic, which keeps scroll restoration honest.

| # | Row | Contents | Status |
| --- | --- | --- | --- |
| 1 | Downloads | Needs attention first (failed, paused for space, library or permission), then running, waiting and queued. Cards offer pause, resume and retry. | Ready: the client already holds and polls the queue |
| 2 | Continue watching | Library files with a stored position and the catalogue's next-episode rows, merged, one per show, bounded to 20. Progress on the tile, Remove from Continue watching, an alternative-episode picker for a series. | Ready: `/api/progress`, `/api/library/resume` |
| 3 | Ready to play | The account's own completed downloads, resolved to a file that can be opened today. | Small server change |
| 4 | Favourites | Library favourites, filtered by grant. | Ready |
| 5 | Recently added | Files first seen by a library scan. | Needs new persisted data |
| - | New episodes of followed shows | A slot only. Follow show does not exist yet. | Not built |

## Rules that apply to every row

- Per account, always. Home is personal even for an administrator: the queue row
  shows only the viewer's own jobs, unlike the Downloads view.
- Filter before counting. A library or addon the account has lost must not leak
  through a poster, title, count, suggestion or cache. Use `pathVisible`,
  `libraryVisible` and `allowedAddons`, and answer "no access" the way the
  server already answers "does not exist".
- Bounded: at most 20 cards per row, with "Show all" going to the existing
  `:resume`, `:favorites` or Downloads target rather than loading more on Home.
- A completed queue record is not proof of a playable file. Resolve it with
  `describeLibraryPath` and `pathVisible`. A disabled library or a lost grant
  drops the card; a file that is gone is shown as unavailable with Show in
  library, never as a dead tile.
- One row failing shows its own error and a retry and leaves the others alone.
- Every row that fetches from the server gets its own loading and error state.

## Card behaviour

| Card | Click | Notes |
| --- | --- | --- |
| Queue job | Opens Downloads | Pause, resume and retry are guarded by `requireOwnJob`. Cancel stays in Downloads. |
| Library file in Continue watching | `playLocal`, resuming at the stored position | Menu: Show in library, Remove from Continue watching (`DELETE /api/progress/:key`) |
| Next episode (catalogue) | `openMeta` on the remembered episode | The episode list is the alternative picker. Numbering is never guessed: `nextEpisodeOf` needs a season and an episode. |
| Ready to play | `playLocal` on the resolved file | Gone file: unavailable state plus Show in library |
| Favourite | Opens the folder or plays the file | |

"Download next episode" on a Continue watching card reuses the series download
dialog and bulk route, and waits for the owner-scoped duplicate check
(#294): until it lands, a download of the same episode queued by another account
is silently skipped.

## States

- First run, nothing at all: one empty state pointing at the catalogue. Only an
  administrator also gets the setup shortcut; a restricted account gets the
  restricted notice and no Home.
- A single empty row: omitted.
- Slow addon: only Continue watching can wait on one. Draw the library files
  first, bound the catalogue lookups (at most one `cachedMeta` per series,
  six-hour cache) and omit a card whose lookup does not answer in time.

## Server

Slice 1 adds none. From the first row that needs server resolution, add
`GET /api/home` returning one envelope per row:

```ts
type HomeRowId = "resume" | "favorites" | "recent" | "completed";
interface HomeRow { status: "ok" | "error"; error?: ApiError; items: HomeCard[]; total: number; truncated: boolean }
interface HomeResponse { generatedAt: string; rows: Partial<Record<HomeRowId, HomeRow>> }
```

`?rows=resume` re-requests one row for a retry. `Cache-Control: private,
no-store`. No aggregation cache in the first slices: the rows are in-memory
reads plus at most 20 `stat` calls. If measurement on the NAS asks for one, key
it by account and permissions version and invalidate it on a progress write, a
download completing, a library change and a grant change.

The queue row needs `ownerUserId` and the `"permission"` pause reason on the
client's `Download` type; the server already sends both.

## Client

- `type View` gains `"home"`. It scrolls on the document like Downloads and
  Settings, so `scrollByView` and `openView` need no new branch.
- One `Nav` entry. The phone bottom bar and the landscape rail are the same
  element restyled, so there is no second list. Reset on a second click of Home.
- `web/src/home-rows.ts` holds the pure logic (`partitionQueue`, the attention
  order, the owner filter) and is unit-tested without a DOM. The `Home`
  component sits in `App.tsx` beside the other views; do not split `App.tsx` as
  part of this.
- Reuse `TileArt` and the tile-shape rules, the `.resume-bar` progress overlay,
  `.resume-strip` and `.row-strip`, `Empty`, `queueDestination` and the existing
  download actions.
- Rows are horizontal strips, never wrapping grids, so a row keeps a constant
  height.
- The selected view is not persisted today. A landing preference, row order and
  hidden rows would live in `UserViews` (`server/src/views.ts`), written on
  change with no save button, and stay out of the settings backup.

## Layout

Desktop and tablet use the existing strips (168 px wide 16:9 cards, 118 px
portrait cards); a phone shows about 2.6 cards so the next one peeks. Touch
targets on Home are 44 px, stricter than the 24 px the layout invariants
enforce. Home has no search bar and does not take part in the folding headers.

The place most likely to break is a phone on its side, 802x293: the rail
carries seven entries for an administrator, and one row heading plus a row of
cards is all that fits. Keep the heading and "Show all" on one line, clamp card
labels to two lines, shrink the cards in that orientation, and verify first at
`mobile-landscape-small`. Six entries in the portrait bottom bar are tight at
390 px and need the invariants run.

## i18n

All ten locales are enforced by the type system and `i18n.test.ts`, not only
English and Czech. New keys: `nav.home`, `home.eyebrow`, `home.title`,
`home.downloads`, `home.attention`, `home.readyToPlay`, `home.recent`,
`home.nextEpisode`, `home.pickEpisode`, `home.downloadNext`,
`home.removeFromResume`, `home.unavailableFile`, `home.unavailableLibrary`,
`home.rowFailed`, `home.emptyTitle`, `home.emptyText`, `home.emptyAdminHint`.
Reuse `library.continueWatching`, `library.showAll`, `library.showInLibrary`,
`downloads.retry` and the `downloads.status.*` labels.

## Tests

- Domain (`node:test`): a second account never sees another's rows; a library
  removed from `visibleTo` drops its cards and its count; a marker whose addon
  is no longer allowed yields no next-episode card; a completed job whose file
  is gone is unavailable; every row is bounded and `truncated` is exact; one
  failing row leaves the others `ok`. Copy the two-account harness in
  `server/src/routes/personal.test.ts`.
- Client: `partitionQueue` and the card helpers, with the network mocked at the
  boundary.
- End to end, three journeys: two accounts see only their own rows; a finished
  download becomes a playable Ready to play card; Continue watching resumes at
  the stored position. Add Home to the view lists in `invariants.spec.ts` and
  `accessibility.spec.ts`, and fix the index-based Settings lookup in
  `locales.spec.ts`, which Home as the first entry would shift.

## Slices

1. **Shell and Downloads, plus Continue watching.** The nav entry, the `home`
   view, the queue row from existing client state, Continue watching from the
   existing endpoints, the keys, and the test-list updates. No new server code.
2. **Ready to play.** `GET /api/home` and the `completed` row, with the
   refetch when a job reaches completed.
3. **Favourites.** Library favourites only.
4. **Recently added.** A write-once first-seen index written by the scan walk
   (`library/seen.json`), remapped on move and rename, with entries that
   predate it left out.
5. **Order, visibility and landing.** Owner-gated; ships after the rows exist so
   Home can be judged with real content.

## Open questions for the owner

- Should Favourites later include starred catalogue titles? The watchlist
  returns titles with no check of the addons the account may use and stores no
  addon key, so that needs fixing first.
- Should Home ever be the landing view? Recommended: no, until slice 5 and then
  only as an opt-in.
- Should a queue card be able to cancel? Recommended: no, cancel stays in
  Downloads.
