# Multiple Libraries — handoff

| Field | Value |
| --- | --- |
| Date | 2026-09-14 |
| State of the work | PR 1–4 on `main` (#114, #115, #117, #118). PR 5 open as #119. |
| Specification | [multi-library.md](multi-library.md) — the design; read *Known gaps* and *Open Questions* first |
| Audience | The agent picking the work up next |

Everything below is either a finding from reviewing the merged work, a defect
found by using it, or the next thing to build. Nothing here changes the design;
if something reads as though it does, the specification wins and this file is
wrong.

## Where the work stands

| PR | What | State |
| --- | --- | --- |
| #114 | Qualified paths, `libraries.ts`, migration | merged |
| #115 | Metadata store split, artwork and image cache policy | merged |
| #117 | Library types, CRUD API, folder picker | merged |
| #118 | Library manager, root browse, cross-library moves | merged |
| #119 | Bulk operations queue and selection UI | open, **e2e red** |
| #120 | Library size in Settings read the file count | open, fix + test |
| #121 | Transfer: a landed copy reported as a failed move | open, stacked on #119 |
| PR 6 | Per-library addon save rules, backup v2, documentation | not started |

Two open PRs both bump `0.4.2 → 0.4.3`. Whichever merges second takes `0.4.4`;
`AGENTS.md` treats that conflict as routine.

## Defects to fix

### #119 is failing e2e on `settings.png`

Five viewports, both attempts, so it is not a flake. The PR regenerated its
`library*.png` baselines and not `settings.png`, and the library manager lives on
the settings screen. Regenerate it — but read *Generating baselines* below first,
and do it **after** #120 lands, because #120 changes the text in that same
screenshot and would otherwise invalidate the new baseline immediately.

### The folder picker cannot create a folder

Adding a library over a folder that does not exist yet answers *"The folder does
not exist."* and stops there. `POST /api/libraries` already accepts
`create?: boolean` and `requireLibraryRoot` carries it; the client never sends it
and the picker offers no way to make one. Under Docker the app is the only
interface its owner has, so this is a dead end rather than a hint.

Wire what is already there: a **New folder** action in the picker, creating
inside the browsed grant, and `create: true` on the request that follows. Keep
`mkdir` refused outside every grant and refused in restricted mode. Specified
under *Known gaps* in [multi-library.md](multi-library.md).

### Two controls decide where a poster goes

`Settings.artworkLocation` is global and defaults to `"data"`; `writeArtwork` is
per library and defaults to `true`. A poster lands beside the media only when
both agree, which is why an install that asked for posters beside the media kept
writing them into `DATA_PATH`.

Retire the global one. `writeArtwork` becomes the single control, on by default,
forced off and locked where the root is read-only — the case it exists for.
Migration reads the old global once so nobody's layout changes under them.
Specified under *Known gaps*.

## Findings from the review that are already fixed

Recorded so they are not re-litigated, and because two of them are worth
remembering as classes of bug rather than incidents.

- **The migration deleted every generated thumbnail when the media root was
  unreachable.** `listVideos` answers an unreadable root with an empty tree, so
  the valid-key set came out empty and the removal pass took everything older
  than an hour. Fixed in #114 with an `R_OK` probe. The class: *an empty walk and
  an empty library are indistinguishable at the call site, and one of them must
  never drive a delete.* The same shape is why the orphan sweep checks the root
  is readable.
- **Artwork re-keying missed the ancestor rows.** Folder thumbnails are keyed
  `dir:<path>` for paths that appear in no `libraryMeta` key and in no
  `listVideos` result, because a folder is not a file and need not be bound to
  anything. Mirror `sweepArtwork`'s `remember()` rather than approximating it.
- **`primaryLibrary()` was a single-library shim across ~35 call sites.** Now
  `singleLibrary()` throws when the count is not one, so a call site that forgot
  to qualify a key fails loudly instead of writing into the first library.
- **A resumed scan from before the migration** held unqualified `remaining[]`
  while the units had become qualified. `LibraryScan.load()` now discards a run
  whose remaining set matches nothing.

## Generating baselines

`docs/testing.md` used to say that the container was enough and that generating
on an Apple Silicon Mac matched CI. **It does not.** The image pins the browser
and the fonts, but glyph rasterisation differs between arm64 and amd64: one
settings baseline regenerated on arm64 failed all five viewports on CI,
including the two whose text had not changed. The fixed 120-pixel tolerance does
not come close.

Either use the **Update screenshot baselines** workflow, which runs on the same
amd64 runner that checks them, or force the platform locally:

```
docker build --platform linux/amd64 -t stremio-offline-e2e -f e2e/Dockerfile .
docker run --rm --platform linux/amd64 -v "$PWD":/work -w /work -e CI=1 \
  stremio-offline-e2e npx playwright test layout/screenshots.spec.ts -g "settings" --update-snapshots
```

Narrow with `-g`. Regenerating everything commits a megabyte of churn nobody can
review.

## Verifying in Docker

`AGENTS.md` asks for a local deploy after implementing. Two additions for this
feature specifically:

- **Verify with a library whose root is away**, not only with a healthy one. Stop
  a mount, or point a second library at a folder you then rename, and confirm the
  row is flagged, the scan and sweep skip it, and nothing is deleted. That branch
  has already cost one data-loss bug.
- **Leave the container up** when you are done, so the owner can try the change.

```
docker compose up -d --build
docker compose ps
curl -s localhost:${STREMIO_OFFLINE_PORT:-8090}/api/status
```

## What to build next

In order. Each is a branch off `main` and its own pull request, per `AGENTS.md`.

1. **Land #120, then fix #119's baseline.** In that order, for the reason above.
2. **#121** — review and merge with #119; it is stacked on that branch.
3. **Finish PR 3's loose ends**: New folder in the picker with `create: true`.
4. **Retire `artworkLocation`** in favour of per-library `writeArtwork`, with the
   one-time migration.
5. **PR 6 — per-library addon save rules.** `DownloadTargetSettings.libraryId`
   end to end: the select offering only libraries of the matching type or
   `mixed` and never a `readOnly`, disabled or unreachable one; validation on
   `PATCH /api/addons/:key`; backup v2 that remaps libraries by root then name
   **and** remaps `defaultMovieLibrary` / `defaultSeriesLibrary` inside the
   settings blob; `/downloads` gone from `web/src`. §11 of the specification.
6. **User documentation**: `docs/libraries.md`, and the split guide — carve-outs
   make splitting `/downloads` free, and nothing currently tells anyone that.
   Note explicitly that re-root moves no files, because the name suggests it
   does.

## Two things worth not getting wrong

**Pass-through is on exactly one *configured* library** — not one enabled, not
one reachable. A second library that is switched off or whose disk is unplugged
is still a deliberate part of the setup, and a browse root that changed shape
when a drive spun down would be worse than one extra click.

**Nothing is destroyed by absence.** A pulled disk, a revoked grant and a
disabled library are recoverable states. Only an explicit
`DELETE /api/libraries/:id?forget=1` removes remembered data. Every guard in the
scan, the sweep, the autoscan and the ops queue exists to keep that true.
