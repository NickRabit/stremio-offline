# Home page: design specification

Status: proposed, not implemented. Written 2026-10-05 and revised the same day
against `main` at 0.5.8, which already ships Following and owner-scoped duplicate
checks. The [roadmap](roadmap.md) owns priority; this file owns the shape of the
page. Every claim about current behaviour was checked against the source. An
independent review (the closed PR #303) found the contract gaps folded in below.

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
| 1 | Downloads | The account's own jobs: failed or blocked first, then running, waiting and queued. One action per card. | Ready: the client already holds and polls the queue |
| 2 | Continue watching | Library files with a stored position, catalogue progress and next-episode rows. | Needs a server identity contract, see below |
| 3 | Ready to play | The account's own completed downloads that resolve to a file that can be opened now. | Small server change |
| 4 | Favourites | Library favourites, filtered by grant. | Ready |
| 5 | New episodes | The existing `NewEpisodesRow` from Following, after a check of its grant semantics. | Ready, reuse |
| 6 | Recently added | Files first seen by a library scan. | Needs new persisted data |

Following is its own destination and is not rebuilt here.

## Rules that apply to every row

- Per account, always. Home is personal even for an administrator: the queue row
  shows only the viewer's own jobs, unlike the Downloads view.
- Filter before counting. A library or addon the account has lost must not leak
  through a poster, title, count, suggestion or cache. Use `pathVisible`,
  `libraryVisible` and `allowedAddons`, and answer "no access" the way the
  server already answers "does not exist".
- Bounded: at most 20 cards per row, with "Show all" opening a list that holds
  the same items in the same order rather than loading more on Home.
- A completed queue record is not proof of a playable file. Resolve it with
  `describeLibraryPath` and `pathVisible`; a disabled library, a lost grant or a
  missing file is not a card (see Ready to play).
- One row failing shows its own error and a retry and leaves the others alone.

## Downloads row

Text-first cards, not posters. A card shows the title, the episode when known,
the state, a progress bar only when the size is known, and one primary action.
Wide screens may add the rate and the destination. No ETA is invented when size
or rate is unknown.

Order: failed or blocked, manually paused, checking or downloading, waiting,
queued. Within a group keep the persisted queue order, then the job id, so a
changing byte count never reorders cards. Completed jobs leave the row.

| State | Action |
| --- | --- |
| Failed | Retry, with the failure reason as text |
| Manually paused | Resume |
| Paused for space, a missing library or a lost permission | The reason, and Open downloads. Home cannot repair a grant or a disabled library, so it must not offer Resume |
| Checking, downloading, waiting, queued | Pause where the existing action allows it |

The title and the action are sibling buttons, never a clickable parent holding
another button. Only the card whose action is pending is disabled; a failure
stays on that card and restores its state. Cancel stays in Downloads. "Show all"
opens Downloads, filtered to the account's own jobs even for an administrator.
Screen readers hear the result of an action and real state changes, not every
progress poll.

## Continue watching: identity and truthful actions

A local file in progress says **Resume** and shows its progress. A catalogue
entry says **Open episode** (or **Open title** for a film), because opening the
title does not guarantee that playback starts. A pending next episode says
**Next episode** and has no invented 0% bar. Episode numbering is shown whenever
it is known. `showResumeRow` and each library's and addon's
`showInContinueWatching` are respected.

Today the two sources do not share an identity: `/api/progress` awaits
`cachedMeta` for every owed marker before it slices to 40, `/api/library/resume`
resolves stored paths before paging and drops the show key from its response,
and `:resume` covers only library items. So a merged row needs a server
contract with a stable card id, a source, the progress keys it represents, an
optional canonical series identity, a target and a freshness time. Rules:

1. Apply permissions and visibility first, on the server, before selecting or
   counting. That includes stored catalogue progress, whose current filter checks
   paths and not `addonKey`. A client-side filter is presentation, not permission.
2. Deduplicate identical local files on the qualified library id plus path.
3. Group a show only on a verified series identity. Never match names, guess
   seasons or strip metadata namespaces; unknown identities stay separate.
4. For a known show the newest real playback wins. A playable local copy wins
   only when its episode and time agree. A pending next episode never replaces
   unfinished playback of the same show.
5. Sort by playback or marker time descending, break ties by id, then take 20. A
   download's completion time is not a viewing time.

If the identity contract is not in the first Continue watching slice, show
**In library** and **In catalogue** as labelled groups and do not promise a
merged count or de-duplication. "Show all" must open a list with the same items
and order, paged; until that exists, offer the two existing destinations and no
exact merged total.

**Forget progress.** `DELETE /api/progress/:key` forgets the saved position and
can remove a next-episode marker, so the action is called Forget progress, says
that the position will be lost and asks for confirmation. A later Hide from
Home needs its own per-account dismissal that keeps the position. For a merged
card, all represented keys are forgotten in one owner-scoped operation, and a
failure must not leave a show that looks removed and returns on the next poll.

## Ready to play

Only playable, accessible files belong here, so a missing file is not a card.
It stays actionable from Downloads. A card that goes stale after it was drawn
shows an inline "no longer available" result and refreshes the row. "Show all"
opens the same resolved, owner-scoped list, not the library root.

## Card behaviour

| Card | Click | Notes |
| --- | --- | --- |
| Queue job | Title and Show all open Downloads | See the Downloads row. Pause, resume and retry are guarded by `requireOwnJob`. |
| Library file in Continue watching | `playLocal`, resuming at the stored position | Menu: Show in library, Forget progress |
| Catalogue entry or next episode | `openMeta` on the remembered episode | The episode list is the alternative picker. Numbering is never guessed: `nextEpisodeOf` needs a season and an episode. |
| Ready to play | `playLocal` on the resolved file | |
| Favourite | Opens the folder or plays the file | |

"Download next episode" on a Continue watching card reuses the series download
dialog and bulk route. The owner-scoped duplicate check has landed
(`ownedBy` in `server/src/downloads.ts`); recheck it and its cross-account
tests when starting that slice, rather than treating it as a blocker.

## States

- Nothing at all, and every applicable source has answered empty: one empty
  state pointing at the catalogue. Only an administrator also gets the setup
  shortcut. A source that failed or is still loading is not an empty account.
- A restricted account does not mount Home and does not issue its requests.
- A single empty row is omitted.
- A row answers `ok`, `partial` or `error`. A partial row keeps its usable local
  cards while catalogue enrichment is unavailable, and its Retry retries only the
  missing source. An error row shows no invented empty count.
- First load: a fixed-height skeleton per row. Refresh: keep the cards on screen
  with a quiet loading state.
- On an account switch, discard all Home state and in-flight responses. On a lost
  grant, remove the cards, artwork, counts and cached totals of that source
  before rendering another stale response, and check permission again at every
  action.

## Server

Home opening starts no scan and no follow-discovery cycle. The honest claim is
"no recursive scan and no new addon discovery": resolving a stored path may
touch storage and cached metadata may miss, so the read path is bounded
explicitly. A client-side slice to 20 is not a server work bound. Candidate
reads, metadata concurrency and each dependency's timeout get separate numeric
budgets, chosen from measurement on the NAS before the endpoint is written. A
timeout leaves a next-episode marker intact.

Slice 1 adds no server code. From the first row that needs server resolution,
add `GET /api/home`, one envelope per row, `Cache-Control: private, no-store`:

```ts
type HomeRowId = "resume" | "favorites" | "recent" | "completed";
interface HomeRow { status: "ok" | "partial" | "error"; error?: ApiError; items: HomeCard[]; hasMore: boolean; total?: number }
interface HomeResponse { generatedAt: string; rows: Partial<Record<HomeRowId, HomeRow>> }
```

`HomeCard` is a discriminated union (download, local resume, catalogue resume,
next episode, completed file, favourite), each with the actions valid for its
kind, and it never exposes a server filesystem path. `total` is present only when
it was computed over the complete eligible set after visibility and identity
resolution; otherwise return `hasMore` and omit it. `?rows=resume` re-requests
one row. Local and catalogue sources are fetched independently so a slow addon
cannot hold the page.

No aggregation cache at first. If measurement asks for one, key it by account and
permissions version and invalidate it on a progress write, a download completing,
a library change and a grant change.

The queue row needs `ownerUserId` and the `"permission"` pause reason on the
client's `Download` type; the server already sends both.

## Client

- `type View` gains `"home"`. It scrolls on the document like Downloads and
  Settings, so `scrollByView` and `openView` need no new branch.
- Navigation is a single permission-aware destination model that every
  presentation renders, see Layout. A second activation of Home resets the page
  and each shelf's offset.
- `web/src/home-rows.ts` holds the pure logic (queue ordering, the attention
  order, the owner filter, card identity) and is unit-tested without a DOM. The
  `Home` component sits in `App.tsx` beside the other views; do not split
  `App.tsx` as part of this.
- Reuse `TileArt` and the tile-shape rules, the `.resume-bar` overlay,
  `.resume-strip` and `.row-strip`, `Empty`, `queueDestination`, the existing
  download actions and `NewEpisodesRow`.
- Rows are horizontal shelves, never wrapping grids, so a row keeps a constant
  height. A shelf is a keyboard-reachable scroll region.
- Preserve each shelf's horizontal offset when returning from playback and the
  page's vertical offset when returning from another view. A poll never reorders
  a focused or touched card; a pending reorder applies when the interaction ends.
- The selected view is not persisted today. A landing preference, row order and
  hidden rows would live in `UserViews` (`server/src/views.ts`), written on
  change with no save button, and stay out of the settings backup.

## Layout

### Navigation

Destinations for an administrator are now Home, Catalogue, Library, Following,
Downloads, Addons, Settings and Statistics: eight. Today seven already do not
fit the compact chrome: the phone bar gives each a 68 px minimum, and the
landscape rail squeezes seven icons into about 229 px, roughly 32 px each.

- **Wide** (the labelled sidebar on desktop and tablet landscape): every allowed
  destination, with the Following and Downloads badges. In its collapsed state it
  stays labelled by icon and tooltip as today.
- **Tablet held upright** (701-980 px portrait): the existing collapsed sidebar
  rail, 76 px wide, with every destination and the label under the icon. Eight
  items at about 49 px fit the 1180 px height, so nothing needs a More menu.
- **Compact** (up to 700 px, and a phone on its side, the short-landscape rule):
  exactly five slots, **Home, Catalogue, Library, Downloads, More**. Icon and
  label in every slot. Today the phone bar hides its labels at 420 px and below
  because seven items do not fit; with five they do (about 59 px each at 320 px),
  so the labels come back at 10 px.
- **More** holds Following, Addons, Settings and, for an administrator,
  Statistics. It is marked active while one of them is open and says which. It
  carries the new-episodes and attention indicator that Following shows, built
  only from the account's visible data. On a phone it opens a sheet; on a rail it
  opens a menu anchored to the trigger. It uses the existing dialog focus
  handling, closes on Escape or a choice, returns focus to the trigger and
  scrolls itself in a short viewport. Account and sign-out stay reachable from
  it wherever the top bar chrome is suppressed.

This changes the existing chrome for every account, not only for Home, so it
ships first and on its own.

### Row anatomy and sizes

| Viewport | Navigation | Cards |
| --- | --- | --- |
| Desktop 1440x900, 1280x760 | Labelled sidebar | Queue ~264 px wide, media 16:9 ~208 px |
| Tablet upright 820x1180 | Collapsed rail, all destinations | Queue ~264 px, media ~184 px |
| Tablet landscape 1180x820 | Labelled sidebar | As desktop |
| Phone upright 390x844 (and 320) | Five-slot bottom bar | 16 px gutters, 12 px gaps, media ~144 px (about 2.3 cards at 390, 1.9 at 320), queue ~244 px |
| Phone landscape 844x390 and 802x293 | Five-slot rail | 12 px gutters, media 144-168 px, queue ~232 px |

Use the existing 700 px and 980 px breakpoints and the short-landscape rule, and
use available width and height, never device detection. Every card action is at
least 44x44 CSS px even when the artwork shrinks. Media cards use the wide
artwork the resume strip already generates, with the existing fit rules as a
fallback. Leave safe-area space at the rail, the bottom bar and the content
edges, and include the bottom bar in the scroll padding. At 200% zoom a heading
wraps rather than forcing a heading, a count and Show all onto one line.

### Tile shape

Catalogue and Library each have their own portrait or landscape tile setting
(`catalogTileShape`, `libraryTileShape`). Home gets the same choice for its
shelves, `homeTileShape`, in the same place in Settings, defaulting to landscape.
The existing Continue watching strip in the library is always 16:9 and ignores the
setting; Home deliberately does not.

- Landscape: 16:9 tiles, 208 px on desktop and tablet landscape, 184 px on a
  tablet held upright, 144 px on a phone.
- Portrait: 2:3 tiles, 148 px on desktop, 132 px on a tablet, 120 px on a phone,
  with the caption allowed two lines instead of one. `TileArt` already letterboxes
  the other artwork variant over a blurred copy, so a title with only one picture
  still fills its tile.
- **Short landscape forces 16:9 whatever the setting.** A 2:3 tile with its caption
  needs about 240 px, and that band has 231 px for everything. Say so beside the
  setting.
- The queue cards are not tiles and ignore the setting.

### Short landscape (802x293, 844x390)

This is where the page can break, so it is designed first.

- The top bar is 54 px and `main` starts at 62 px, leaving about 231 px of content
  at 293. The page eyebrow, title and lead are dropped there: the rail already
  says Home, and the first thing on screen is the first row.
- The rail needs 5 x 44 px plus 5 px padding at each end, about 230 px, against
  the 239 px below the top bar. In a Home Screen app the bottom inset takes about
  21 px more, so the targets may shrink to 40 px and the rail may scroll as a last
  resort. That is the only place the 44 px rule gives way, and it is verified in
  the standalone orientation.
- A queue card is about 112 px tall: a title and a state line, a thin bar, and a
  44 px action row. With a 28 px row heading, the first complete row ends near
  210 px and the next heading shows beneath it. Lower rows scroll with the
  document; nothing scrolls inside a nested box.
- With an empty queue, Continue watching comes first: heading plus a ~152 px
  wide card with a two-line caption fits in the same band.
- Show the right edge of the next card (a fraction of a card) so the shelf reads
  as scrollable.

### Measured

A prototype, [docs/home-prototype](home-prototype/README.md), built on the real
`style.css` and markup, was measured in a browser at the sizes below. None had page-level
horizontal overflow.

| Viewport | Measured |
| --- | --- |
| 802x293 | Rail 64 px wide, five items at 46 px; queue card 232x116; first row ends near 231 px and the next heading starts at 265 px; portrait setting correctly forced to 16:9 art (152x86) |
| 844x390 | Same geometry, the second shelf also reaches the screen |
| 320x640 | Bar slots 59 px; queue card 244 px, media 144 px (about 1.9 cards); action button 129x44 |
| 390x844 | Three shelves and the bar visible; More sheet 366 px wide above the bar; the More slot carries the Following count |
| 820x1180 | Rail 76 px, eight items at 49 px; queue 264 px, media 184 px |
| 1180x820 | Labelled sidebar 226 px; media 208 px, a little under four cards |

Two phone details came out of it: "Show all" is borderless and the count sits under
the heading, because a bordered button wrapped onto its own line and cost a whole
row; and the heading row must not wrap at all below 700 px.

### What was taken from the mockups, and what was not

Taken: the five-slot compact navigation with labels, the text-first queue card
with a coloured state line and a thin bar, the "N jobs, M need attention" count in
the queue heading, wide artwork with the progress bar on the tile, and a "More"
sheet and menu.

Not taken: the avatar circle in the page header (the account lives in the top bar
and the sign-out control), the marketing sub-line under the title (our pages have
an eyebrow and a title and no slogan), and a progress bar on a favourite, which
is not progress. A waiting job gets Pause, not Open downloads; Open downloads is
for a job that Home cannot fix. The sample data and the artwork in the mockups
are illustrative, and the mockups are layout proposals, not evidence that the
application has passed any of the checks below.

## i18n

Every shipped locale is enforced by the type system and `i18n.test.ts`, ten today.
Do not hard-code the count in code or tests. New keys: `nav.home`, `nav.more`,
`home.eyebrow`, `home.title`, `home.downloads`, `home.attention`,
`home.readyToPlay`, `home.recent`, `home.nextEpisode`, `home.openEpisode`,
`home.openTitle`, `home.pickEpisode`, `home.downloadNext`, `home.forget`,
`home.forgetConfirm`, `home.source.library`, `home.source.catalogue`,
`home.partial`, `home.unavailableFile`, `home.rowFailed`, `home.emptyTitle`,
`home.emptyText`, `home.emptyAdminHint`. Reuse equivalent existing keys first:
`library.continueWatching`, `library.showAll`, `library.showInLibrary`,
`downloads.retry` and the `downloads.status.*` labels.

## Tests

Functional gates, at the domain layer first (copy the two-account harness in
`server/src/routes/personal.test.ts`): two accounts, and an administrator's
ownership; a revoked library; a revoked addon, covering stored catalogue progress
as well as markers; the same show in local and catalogue records; an unknown
identity; a next episode against an unfinished episode; a missing completed file;
one source timing out; a queue mutation failing; an account switch during a
fetch; each Show all target; forgetting a merged card without losing unrelated
progress; a total that is exact only when it was computed over the eligible set.

Client: the pure queue and identity logic, with the network mocked at the
boundary.

End to end, three journeys: two accounts see only their own rows; a finished
download becomes a playable Ready to play card; Continue watching resumes at the
stored position. Add Home and the More menu to the view lists in
`invariants.spec.ts` and `accessibility.spec.ts`, and replace the index-based
Settings lookup in `locales.spec.ts` with a name-based one, since the navigation
changes under it.

Visual and accessibility checks run once, after the functional gates are stable,
across the viewport matrix above plus the existing WebKit landscape project: 44 px
targets, keyboard access to a shelf's overflow, More focus and Escape, long German
and Czech labels, 200% zoom, safe areas, no page-level horizontal overflow,
restored offsets after playback and after rotation, and the busy, empty, partial,
failed and revoked states.

## Slices

0. **Compact navigation with More.** Its own PR: the five-slot navigation for
   phones and short landscape, the labelled tablet rail, the More sheet and menu,
   and the updated layout tests. It fixes today's squeeze and changes chrome for
   everyone, so it does not travel with Home.
1. **Home shell and Downloads.** The view, the queue row from existing client
   state with the owner filter, and the type additions. No new server code.
2. **Continue watching.** Fix stored-addon visibility first. Then either the
   server identity contract and unified list, or labelled In library and In
   catalogue groups and truthful action labels.
3. **Ready to play.** `GET /api/home`, the resolved row, its full-list route and a
   refresh when a job completes.
4. **Favourites**, and optionally `NewEpisodesRow` beneath it.
5. **Recently added.** A write-once first-seen index written by the scan walk
   (`library/seen.json`), remapped on move and rename, with entries that predate
   it left out.
6. **Order, visibility and landing.** Owner-gated; ships after the rows exist.

## Open questions for the owner

- Should Favourites later include starred catalogue titles? The watchlist
  returns titles with no check of the addons the account may use and stores no
  addon key, so that needs fixing first. Until then: library only.
- Should Home ever be the landing view? Recommended: no, until slice 6 and then
  only as an opt-in.
- Cancel on a queue card? Recommended: no, cancel stays in Downloads.
- A `homeTileShape` setting, default landscape, forced to landscape on a short
  screen. Recommended; the alternative is a fixed 16:9, which is simpler.
- Should Continue watching ship with the full identity contract, or with the two
  labelled groups first? The groups are smaller and honest; the contract gives
  the merged row the mockups show.
