# Local copies as a catalogue source

Status: specification, not implemented. The execution order is in
[local-sources-agent-task.md](local-sources-agent-task.md).

## Problem

The catalogue detail lists the sources that addons offer for a title. It says
nothing about a copy of the same title that is already in one of the viewer's
libraries. The viewer streams the film again from an addon, or queues a second
download of a file they already have.

A library copy is the best source there is: it needs no addon, no Real-Debrid
and no network beyond the server, it keeps working while the addons are down,
and its tracks are known from the file rather than guessed from a title.

## Goal

When the catalogue detail asks for the sources of a movie or of one episode,
every library file bound to that title (and, for an episode, to that season and
episode) that the viewer may see is offered as a **local source**:

- above every addon source, marked with a **Local** badge and a drive icon;
- outside the addon and language filters and the addon-priority sort;
- picked by default, so **Play** plays the local copy unless the viewer picks
  another row;
- played exactly the way the Library view plays that file, so the progress, the
  Continue watching row, the favourites star and the adjacent-file navigation
  are the ones the file already has.

This applies to every client: the web interface, the desktop apps (which show
the server's web interface and bundle the same server) and the Android TV app.

## Non-goals

- Copies saved **to a device** (browser or desktop native downloads). The server
  knows what it sent, not what the device kept
  ([downloads.md](downloads.md#to-library-vs-to-device)).
- Files without a binding, or bound to a different title. A wrong or missing
  binding is fixed with **Identify** in the library; the catalogue does not
  guess by name.
- Matching across id schemes (a library title bound to `tmdb:…` while the
  catalogue shows `tt…`). Only an exact id match counts in this version.
- Series ids that do not end in `:<season>:<episode>`. The parse below cannot
  tell `kitsu:123:5` (an absolute episode number) from a season and episode, so
  it reads it as title `kitsu`, season 123, episode 5; such an id gets no local
  source only because no library record carries the title id `kitsu`.
- Merging the catalogue resume position with the file's. The catalogue detail
  keeps reading its own progress key; see [Progress](#progress).
- Badges on the catalogue grid tiles. A possible follow-up.
- Offering local copies inside the player's own source switcher.

## Server

### Endpoint

`GET /api/local-streams/:type/:id`

- `type` is `movie` or `series`; any other type answers `[]`.
- `id` is the id the clients already pass to `GET /api/streams/:type/:id`: the
  meta id for a movie, the video id for an episode.
- Answers `PublicStream[]` (see `server/src/types.ts`), `cache-control:
  private, no-store`, like the stream listing.
- Requires a signed-in account, like every catalogue route (`viewerOf`).

It is a separate endpoint rather than part of `GET /api/streams`: both clients
ask each addon separately through `GET /api/stream-sources` +
`GET /api/streams?addon=…`, and `GET /api/stream-sources` also feeds the
download source picker, where a pseudo-addon for the library would be wrong.
An older server answers the new endpoint with 404; clients treat any failure as
"no local copies" and say nothing.

### Which files qualify

Parse the request:

- **movie**: the title id is `id`; no episode.
- **series**: split `id` on `:`. When it has at least three parts and the last
  two are non-negative integers, the title id is everything before them and the
  episode is `{ season, episode }`. Otherwise answer `[]`.

A file qualifies when all of the following hold:

1. It is a video file in the current walk of a walkable library
   (`libraryFiles({ stale: true })` in `server/src/index.ts`; switched-off and
   unreachable libraries are already absent from the walk).
2. Its library is visible to the viewer (`visibleLibraries(store.libraries(),
   viewer)` from `server/src/libraries.ts`).
3. Its effective binding is the requested title:
   `knownTitleForUnit(unitFor(file, units), records, file)` from
   `server/src/library-match.ts`, with `records = metaStore.qualifiedMeta()` and
   `units = await libraryUnits({ stale: true })`, returns a record whose
   `type` equals the requested type and whose `id` equals the title id. This is
   the same resolution the Library view uses (`attachBrowseMeta`), so the
   answer is exactly what the Library view shows as that title. An **Unmatch**
   on a file is honoured, and so is a nearer binding on a sub-folder that is a
   title unit of its own. A sub-folder that is not a unit (a season folder
   inside a show of a series library) resolves to the show's binding, in the
   Library view and here alike.
4. For an episode: `episodeNumberOf(file, ownRecord(file, records), { loose:
   true })` equals the requested season and episode. A file without numbers
   does not qualify for any episode.

Evaluating rule 3 for every file in a large library is too slow
(`unitFor` filters every unit per call). First collect the binding keys whose
record has the requested `type` and `id` (one pass over `records`), build a
candidate set from files equal to or inside those keys (`isPathWithin`)
**plus every sample file of a unit whose key is equal to or inside those keys**,
and only then apply rules 3 and 4. Deduplicate candidates by qualified file key.
A unit can be keyed by a representative video file: in a shared folder,
`Heat.1995.1080p.mkv` and `Heat.1995.720p.mkv` can share the first file's
binding without one path containing the other. Path containment alone would
lose the second copy. Sample membership only widens the candidate set; it
never bypasses the effective-binding check (including a sibling's Unmatch).

Order: by library display order (the visible libraries sorted by
`LibraryRecord.order`, as `libraryRootBrowse` sorts them), then by size
descending, then by path. Cap the answer at 20 entries.

### What each entry carries

Each qualifying file becomes one `PublicStream` minted through
`mediaResources.listing(...)` from a `StreamItem` of
`{ url: "file://<qualified key>", behaviorHints: { filename: <file name>,
videoSize: <FoundFile.size> } }`, so it gets `kind: "library"` and
`playable: true` from the existing `streamKind`. Before minting, call
`requireAccess(req, { libraryId })` for every library in the answer, with
nothing awaited between that check and the listing — the same rule
`GET /api/streams` and `POST /api/library/source` follow.

Two new optional fields on `PublicStream` (server `server/src/types.ts`, web
`web/src/types.ts`, TV `StreamDto`):

| Field | Value |
| --- | --- |
| `localPath` | The file's path in the form the Library view and `POST /api/library/source` use: `wirePath(key)` in `server/src/index.ts`. The web `Stream` type already has this field; the server now fills it. |
| `libraryName` | The library's display name, so a viewer with several libraries can tell the copies apart. |

`addonKey` and `addonName` stay empty: a local source belongs to no addon, and
filling them would put it into the addon filter and the priority sort.

No sidecar subtitles in the listing: playing the entry goes through
`POST /api/library/source`, which mints the source with its sidecars.

## Clients

The rules below are the same for the web and the TV app. The desktop apps
render the server's web interface and ship the same server
(`desktop/scripts/stage-local-backend.mjs`), so they need no code of their own;
they need the verification in the agent task.

### Fetching

When the detail asks for the sources of a movie or an episode, it also asks
`GET /api/local-streams/:type/:id` with the same `type` and `id`, in parallel
with the addon requests, and drops the answer if the request it belonged to is
stale (the existing `sourcesRequestRef` on the web, the `LaunchedEffect` key on
TV). A failure is an empty answer, logged at most at debug level.

The local request must complete independently of addon discovery and subtitle
requests: their failure must not discard local results or disable local Play.
Track local loading separately, reset it with the request generation, and do
not show a final empty state while it is pending. In Kotlin, cancellation must
propagate; do not turn `CancellationException` into an empty successful result.

Local entries are kept apart from the addon streams (their own state), never
mixed into the list the filters, counts and notices are computed from.

### The list

- Local entries come first, in the server's order, followed by the visible
  addon streams exactly as today.
- The addon and language filters, the sort, the "N of M" count and the
  "no source matches the filter" message apply to addon streams only. A local
  entry is never hidden by a filter.
- The empty and "only torrents" messages appear only when there are no local
  entries either.
- Badge text **Local** (`sources.localBadge`), in its own colour (the web
  `.stream-list i.local`, a TV token), plus the drive icon the library uses
  (`HardDrive` on the web).
- The main line is the file name (`behaviorHints.filename`); the secondary line,
  where an addon row shows the addon name, shows `libraryName`.
- Size and language badges as for any row.
- The footer's addon subtitle count reads 0 for a local row: a local play gets
  the file's own sidecars, not the addon subtitles (the web player is given
  `subtitles={localStream ? [] : subtitles}`).
- The default pick (`pickDefaultStream` and its TV twin) is the first local
  entry when there is one. Preserve the `repickStream` protections: a row the
  viewer chose is never moved, and nothing is repicked while playing. Extend
  the arrival handling so the first local entry replaces an automatic addon
  pick even when it arrives last. Both current helpers require `pending > 0`
  to replace a valid selection; simply prepending local rows and clearing the
  last pending flag in the same update does not satisfy this contract. Test
  the completed state as well as intermediate loading states.

### Actions on a local entry

- **Play** plays it as a library file:
  - web: `playLocal(title, localPath, poster, episode)` in `web/src/App.tsx`,
    with the catalogue title (plus the episode label) as `title`, the catalogue
    poster, and `episode` true for a series. `playLocal` captures the return
    anchor as `{ kind: "library", key: path }`, which does not exist in the
    catalogue view; it takes an optional anchor argument and the catalogue
    passes its own `{ kind: "catalog", key: "<type>:<id>" }`.
  - TV: `PlayTarget(key = Progress.libraryKey(localPath), path = localPath,
    sourceId = null, …)`, the same target the library detail builds; the player
    mints the source through `librarySource(path)`. Ordinary local Play uses
    `resume = true` so the player reads the file's own progress even when the
    catalogue has none; do not copy the catalogue's `resuming` boolean.
    Start over builds the same target with `resume = false`. Omit catalogue
    `subtitleType` and `subtitleTarget` on local targets, so subtitles come
    from the library source just as they do for a Library play.
- **To library** (and its target menu) is disabled: `canQueue` answers false
  for `kind === "library"` on both clients. It already answers true for any
  playable stream, which would queue a download of a file that is on disk.
- **To device** on the web uses `downloadLibraryFile(localPath)`, as the player
  already does for a library file.
- A **Show in library** action (`library.showInLibrary`, existing key) opens
  the file in the Library view: `revealInLibrary(localPath)` on the web; on TV,
  the existing library push the Home cards use (`libraryPush` in `Shell.kt`)
  with the file's folder. On TV it is a button in the action row while a local
  entry is the active one.

### The player

- A local play behaves like a library play everywhere: progress key
  `file:<localPath>`, favourites star on the file, previous/next file, device
  download of the file.
- The player's source switcher does not list local entries, and a local play
  gets no catalogue sources to switch to. On TV the detail keeps reporting
  `OfferedSources` while the player is open, so clearing them once on Play is
  not enough: `Shell.kt` passes `sources = emptyList()` (and `sourcesLoading =
  false`) to `PlayerScreen` whenever the target has a `path`. The
  `OfferedSources` the detail reports contain addon streams only.

### Progress

Playing a local entry writes the file's progress, not the catalogue's. That is
deliberate: the file already has one progress entry and one Continue watching
row, and a second key for the same viewing would split them. The consequence is
that the catalogue detail's own resume line does not move after a local play;
the Library view and Home do. Home merges a file row with a catalogue row only
for a series (`mergeResume` in `server/src/home.ts` joins on the series id), so
a movie that already had catalogue progress from an earlier addon play keeps
its two Continue watching cards, as it does today. Both are listed as known
limitations in the user documentation.

## Strings

New keys in `web/src/i18n/en.ts` and translated in all ten catalogues
(`cs` is type-checked against `en`; fill the other eight too):

| Key | English |
| --- | --- |
| `sources.localBadge` | `Local` |
| `sources.localHint` | `Already in your library — plays from the server's disk` |
| `sources.localQueueDisabled` | `This file is already in the library.` |

`sources.localHint` is the row's `title` attribute on the web and the TV
row's description for accessibility. `sources.localQueueDisabled` is the
title of the disabled **To library** button on the web and the message TV shows
when **To library** is pressed on a local entry. The TV keys go into
`android-tv/strings.keys` and the resources are regenerated with
`node scripts/android-strings.mjs`. `library.showInLibrary` exists already; add
it to `android-tv/strings.keys` if TV does not use it yet.

## Security and access

- Visibility is filtered on the server by `visibleLibraries`; the client never
  sees a path in a library the account may not open.
- `requireAccess(req, { libraryId })` runs per library at minting time.
- The endpoint does not reveal whether a file exists in an invisible library:
  such a file is simply absent.
- The path in `localPath` is the same wire path the Library view already sends
  to that account.

## Acceptance

1. A movie bound in a visible library shows one **Local** row first in the
   catalogue detail on the web, the desktop app and TV, picked by default.
   **Play** starts the file; afterwards the Library view shows its progress and
   Home has one Continue watching row for it (on a title with no earlier
   catalogue progress), not two.
2. With an addon filter that matches nothing, the local row is still there.
3. An episode shows a local row only for the season and episode the file holds.
4. A file unmatched inside a bound folder does not appear.
5. A file in a library the account may not see does not appear, and the
   endpoint's answer for that account is `[]`.
6. **To library** is disabled for the local row; **To device** saves the file.
7. With every addon removed, the local row still appears and plays.
8. A client against a server without the endpoint shows the addon sources as
   before, with no error.
9. On TV, a local play offers no source switching in the player, even while
   addons are still answering for the title underneath.
10. Two encodes sharing a file-keyed title unit both appear, unless one has an
    explicit different binding or Unmatch.
11. A local answer arriving after all addons replaces only an automatic pick;
    it never interrupts playback or replaces an explicit choice.
12. Addon discovery or subtitle lookup failure does not prevent local playback.
13. On TV, ordinary local Play resumes saved file progress even without
    catalogue progress; Start over starts at zero.
