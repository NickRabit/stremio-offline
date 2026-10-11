# Agent task: local copies as a catalogue source

Read `AGENTS.md` and [the specification](local-sources-spec.md) before editing.
The specification is the design contract; this file is its execution order.
Where a line number here and a named symbol disagree, the symbol wins — report
the offset that was wrong. Where the specification contradicts itself or the
code, stop and report it rather than choosing.

## Goal

Every library copy of a catalogue title that the viewer may see appears as a
**Local** source at the top of the catalogue detail on the web, the desktop
apps and Android TV, and plays as the library file it is.

## Deliver as three pull requests, in this order

Each is mergeable on its own; a client without the server change keeps working
because a 404 from the new endpoint means "no local copies".

### 1. Server: `GET /api/local-streams/:type/:id`

Files:

| File | Change |
| --- | --- |
| `server/src/local-sources.ts` (new) | Pure lookup: `localCopies(input)` taking the request `type` and `id`, the walked files (`FoundFile[]`), the units (`TitleUnit[]`), the records (`metaStore.qualifiedMeta()`), the visible library ids in display order, and answering the qualifying files in the specified order with their size, library id and episode numbers. It owns the video-id parsing. No I/O, no Express. |
| `server/src/local-sources.test.ts` (new) | `node:test` unit suite for the lookup. |
| `server/src/types.ts` | `PublicStream` gets optional `localPath?: string` and `libraryName?: string`. |
| `server/src/routes/catalog.ts` | The route; a new `CatalogDeps` member that answers the local copies for a viewer. |
| `server/src/index.ts` | Wires the new dependency. |
| `server/src/routes/catalog.test.ts` | Route tests. |

Wiring warning: `registerCatalogRoutes(...)` runs *above* the `const`
declarations of `libraryFiles` and `libraryUnits` in `server/src/index.ts`
(`wirePath` is declared earlier and is safe either way). Pass a closure that reads them when called, never the
functions themselves, or the server dies at start-up with a temporal dead zone
error that no unit test catches. Grep every place that builds `CatalogDeps`
(tests included) and give each the new member.

Route behaviour, in this order with no `await` between steps 3 and 4:

1. `viewerOf(currentUser(req))`.
2. Await the lookup (stale walks are fine: `{ stale: true }`).
3. `requireAccess(req, { libraryId })` for each distinct library in the answer.
4. `mediaResources.listing(items, ownerOf(req))`, then set `localPath`
   (`wirePath(key)`) and `libraryName` on each entry, `cache-control: private,
   no-store`.

Tests that must exist and pass (`npm test`):

- movie bound on its folder → one entry, `kind: "library"`, `playable: true`,
  `localPath`, `libraryName`, `behaviorHints.videoSize`;
- a shared folder with two Heat encodes and an unrelated Ronin film produces
  a file-keyed Heat unit; binding its representative file offers both encodes,
  not Ronin; explicitly unmatching or rebinding the second encode excludes it;
- movie bound, one file under it unmatched (`unmatchAt`) → that file absent;
- a nearer sub-folder that is its own title unit (for example a film folder
  inside a collection folder of a movie library) bound to another title → its
  files absent; a season folder inside a show of a series library is not a
  unit and keeps the show's binding — cover that case too;
- series `tt1:1:2` → only the S01E02 file; `tt1:1:3` → `[]`; `tt1` and
  `kitsu:5:3`-style ids with no matching record → `[]`; a malformed id → `[]`;
- type mismatch (record is `series`, request `movie`) → `[]`;
- file in a library the viewer may not see → absent, the answer for that viewer
  is `[]`;
- ordering by library `order` (not array position), then size descending,
  then path; cap of 20;
- the route answers 401 without a session.

### 2. Web (covers the desktop apps)

Files: `web/src/api.ts` (`localStreams(type, id)`), `web/src/streams.ts`,
`web/src/streams.test.ts`, `web/src/App.tsx`, `web/src/style.css`,
`web/src/i18n/*.ts` (all ten catalogues), `e2e/tests/` (new spec, see below),
and `docs/downloads.md` under "To library vs. to device" (one paragraph on the
local row, plus the progress limitation from the specification).

- `streams.ts`: `isLocalStream(stream)` (`kind === "library"`); `streamBadge`
  answers the local badge marker for it; `canQueue` answers false for it. Add
  a pure `catalogSourceList(local, visibleAddonStreams)` that puts local
  entries first, and test it together with `pickDefaultStream` on the result.
- `App.tsx`:
  - `fetchSources` asks `api.localStreams(type, id)` alongside
    `api.streamSources`, behind the same staleness check, into a new
    `localStreams` state that `closeMeta`, `openMeta` and `fetchSources` clear
    wherever they clear `streams`.
  - Keep local loading independent of addon discovery and subtitles: a failure
    in either must leave local results usable. Do not let an early addon error
    skip the local result, and suppress final empty states until it settles.
  - The rendered list, the default pick and `repickStream` use
    `catalogSourceList(localStreams, visibleStreams)`. Filters, counts,
    `streamAddons`, `streamLangs`, notices and the empty messages keep using
    the addon streams only, except that the empty and "only torrents" messages
    also require `localStreams` to be empty.
  - The local row: badge **Local** with class `local`, the drive icon, file
    name as the main line, `libraryName` as the secondary line,
    `title={t("sources.localHint")}`.
  - **Play** on a local row calls `playLocal`, which gains an optional anchor
    parameter (see the specification); **To library** and its menu are
    disabled with `title={t("sources.localQueueDisabled")}`; **To device**
    calls `downloadLibraryFile(localPath)`; a **Show in library** button calls
    `revealInLibrary(localPath)`.
  - The footer's addon subtitle count shows 0 while a local row is selected.
- Tests:
  - Vitest for `streams.ts` (badge, `canQueue`, ordering, default pick, a
    local entry surviving an addon filter). Include a late local answer after
    the addon pending count reaches zero: an automatic addon pick moves to
    local, an explicit pick stays, and playback is not interrupted. Exercise
    the final update with all loading flags cleared, not just pending states.
  - Playwright, run through Docker only (`npm run test:e2e:docker`). Reuse the
    fixtures of `e2e/tests/library-identify.spec.ts`: copy the sample into the
    download library as `Zkušební film (2024)/Zkušební film.mkv` and the two
    series episodes, bind them (scan or identify), then open the catalogue:
    the movie detail shows the local row first and selected; **Play** starts
    playback; after closing, the Library view shows progress on the file and
    Home shows a single Continue watching row. The series detail shows a local
    row for S01E01 and none for S02E01. Also cover late local arrival, stale
    answers after switching episodes or closing the detail, and local playback
    when addon discovery or subtitle lookup fails. The tests must fail on `main`.
- Screenshot baselines: do not regenerate on a Mac; run the **Update
  screenshot baselines** workflow on the branch if they moved.

Desktop: no code change. Verify that the desktop app shows the local row and
plays it, both on **This Mac** (the bundled server) and connected to the Docker
instance from the verification step; and that against a server without the
endpoint it shows the addon rows without an error. Note the result in the pull
request.

### 3. Android TV

Files: `android-tv/app/src/main/java/cz/stremiooffline/tv/data/TvApi.kt`,
`data/ApiClient.kt`, `data/CatalogDtos.kt` (`StreamDto.localPath`,
`StreamDto.libraryName`), `catalog/Streams.kt`,
`ui/catalog/CatalogDetailScreen.kt`, `ui/catalog/SourcesPanel.kt`,
`ui/shell/Shell.kt`, `android-tv/strings.keys` (+ regenerated resources via
`node scripts/android-strings.mjs`), and every `TvApi` implementation. Today
the only one in the tests is `FakeTvApi.kt` (the screen tests build on it);
grep `: TvApi` again before starting.

- `TvApi.localStreams(type, id): List<StreamDto>`; the client treats any
  `ApiError` as an empty list and rethrows `CancellationException`.
- `Streams.kt`: the same `isLocalStream`, badge, `canQueue` and ordering rules
  as the web; unit tests in `StreamsTest.kt`.
- `CatalogDetailScreen.kt`: fetch alongside `streamSources` in the same
  `LaunchedEffect`; local entries first in the panel and the default pick;
  `play` and `startOverPressed` build the library `PlayTarget` for a local
  entry (`key = Progress.libraryKey(localPath)`, `path = localPath`,
  `sourceId = null`, no catalogue subtitle target). Ordinary Play sets
  `resume = true`, Start over sets `resume = false`; **To library** is hidden
  for a local entry, as for anything that cannot be queued; a **Show in library** button
  in the action row while a local entry is active; `onSources` reports addon
  streams only.
- Track local loading independently; failure of `streamSources` must not
  cancel local lookup or let `sourcesFailed` block Play or Start over on a local
  row. Handle the last local arrival explicitly when repicking, including the
  state where all loading flags are already cleared.
- `Shell.kt`: `PlayerScreen` gets `sources = emptyList()` and
  `sourcesLoading = false` whenever the target has a `path` — the catalogue
  `onPlay` branch today leaves `playerSources` as the detail keeps reporting
  them, unlike the Home and library branches;
  **Show in library** uses the existing `libraryPush` with the file's folder.
- `SourcesPanel.kt`: the badge colour token for **Local** and `libraryName` in
  the line where an addon row shows `addonName`.
- Tests (Robolectric/Compose, in `ui/catalog/`), each failing on `main`:
  - the local row is row 0 and focused by default when the panel opens;
  - D-pad **OK** on Play with a local default starts a `PlayTarget` whose
    `path` is the file and whose `key` is `file:<path>`;
  - an addon filter (sort setting) does not move or hide the local row;
  - **To library** on a local entry never calls `download`;
  - a failing `localStreams` leaves the addon rows untouched;
  - delayed local results replace an automatic addon pick after addons finish,
    but never an explicit pick or a playing source;
  - failed addon discovery still allows a local row to load and play;
  - saved file progress with no catalogue progress resumes on ordinary Play,
    while Start over builds the same file target with `resume = false`;
  - changing episodes or closing the detail ignores stale local responses;
  - a local play from the catalogue detail opens the player with no source
    switcher while the fake addons are still answering.
- Build and test per [android-tv-development.md](android-tv-development.md);
  check on the emulator with the remote once the functional checks pass.

## Every pull request

- Branch off current `main`, rebase before opening, keep it conflict-free.
- Bump the patch version (user-facing change) with `npm version <x.y.z>
  --no-git-tag-version --workspaces --include-workspace-root`;
  `node scripts/check-versions.mjs` must pass. The TV app takes its version
  from the root `package.json`.
- `npm run build`, `npm test`, and for the web PR `npm run test:e2e:docker`.
- Deploy to the local Docker setup and check `/api/status` (see `AGENTS.md`).
- Update [the specification](local-sources-spec.md) status line and the user
  documentation when the last of the three lands.
