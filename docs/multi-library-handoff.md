# Multiple Libraries — handoff

| Field | Value |
| --- | --- |
| Date | 2026-09-14 |
| Design | [multi-library.md](multi-library.md). Read **Known gaps** and **Open Questions** before starting. |
| Audience | The agent picking the work up next |

Findings from reviewing the merged work, defects found by using it, and what to
build next. Nothing here changes the design; where this file and the
specification disagree, the specification wins and this file is wrong.

## Where the work stands

| PR | What | State |
| --- | --- | --- |
| #114 | Qualified paths, `libraries.ts`, migration | merged |
| #115 | Metadata store split, artwork and image cache policy | merged |
| #117 | Library types, CRUD API, folder picker | merged |
| #118 | Library manager, root browse, cross-library moves | merged |
| #120 | Library size in Settings read the file count | merged |
| #121 | Transfer reported a landed copy as a failed move | merged into #119 |
| #119 | Bulk operations queue and selection UI | merged |
| PR 6 | Per-library addon save rules, backup v2, documentation | not started |

`main` is at `0.4.4`, which includes #119. #123 (`0.4.5`) carries the folder
picker; the artwork retirement is the branch right after it.

## Defects to fix

### The folder picker cannot create a folder

Adding a library over a folder that does not exist yet answers *"The folder does
not exist."* and stops. `POST /api/libraries` already accepts `create?: boolean`
and `requireLibraryRoot` carries it — the client never sends it, and the picker
offers no way to make one. Under Docker the app is the only interface its owner
has, so this is a dead end rather than a hint.

Wire what is already there: a **New folder** action in the picker, creating
inside the browsed grant, and `create: true` on the request that follows. Keep
`mkdir` refused outside every grant and refused in restricted mode.

**Fixed** in #123: the picker names the folder, the create request makes it, and
a cancelled flow leaves nothing on disk. Re-root still takes only folders that
exist, because it moves no files.

### Two controls decide where a poster goes

`Settings.artworkLocation` is global and defaults to `"data"`; `writeArtwork` is
per library and defaults to `true`. A poster lands beside the media only when
both agree, which is why an install that asked for posters beside the media kept
writing them into `DATA_PATH`.

Retire the global one. `writeArtwork` becomes the single control, on by default,
forced off and locked where the root is read-only — the case it exists for. It
also sits at the right level: whether to write into a tree is a property of that
tree, not of the installation. Migration reads the old global once, so an install
that had `"data"` gets `writeArtwork: false` and nobody's layout changes under
them.

**Fixed**: the global is gone from the settings, the backup and the Storage
section, and the migration reads the old value while the key is still in
`state.json` — a library keeps its own answer only where the install had asked
for `"media"`.

### Nothing explains how to split the download directory

Carve-outs make splitting `/downloads` into `/downloads/Films` and
`/downloads/Series` free, and cross-library moves carry metadata with each title
— and nothing says so. Two routes, both worth writing up:

1. **Split from inside.** Add the new libraries as folders under the existing
   root; the parent carves them out. Move titles across in the interface. No
   downtime, metadata travels, and on one volume each move is a `rename`.
2. **Re-root.** `PATCH /api/libraries/:id { root }` rewrites the record and
   **moves nothing**. To push a library one level down: stop the server, move the
   tree on disk, start, re-root onto the new folder. Keys are
   `<libraryId>/<relative>` and the relatives do not change, so the match history
   survives whole. With the server running, a scan could observe the half-moved
   tree and read it as new unmatched titles.

Say explicitly that re-root moves no files. The name suggests otherwise.

**Written up** in `docs/libraries.md`, both routes. The library-manager wizard
is still open.

### Remembered metadata a re-add cannot find

Found while writing that guide. `DELETE /api/libraries/:id` without `forget=1`
keeps `data/library/<id>.json` and `data/artwork/<id>/`, and the row reads as if
the plain *Remove* were the recoverable choice. It is not: `POST /api/libraries`
always mints a new id and nothing maps a root back to a retired one, so a
library added again at the same folder starts with an empty match history and
the kept files are reachable by nothing. Recorded under *Known gaps* in
[multi-library.md](multi-library.md), with the two ways out: say so, or keep a
retired-root index and let the re-add take the old id back. The second is the
behaviour §12 implies, and per-library save rules will want the same mapping.

## Fixed, recorded so they are not re-litigated

Two of these are worth remembering as classes rather than incidents.

- **The migration deleted every generated thumbnail when the media root was
  unreachable.** `listVideos` answers an unreadable root with an empty tree, so
  the valid-key set came out empty and the removal pass took everything older
  than an hour. The class: *an empty walk and an empty library are
  indistinguishable at the call site, and one of them must never drive a delete.*
  The same shape is why the orphan sweep checks the root is readable first.
- **Artwork re-keying missed the ancestor rows.** Folder thumbnails are keyed
  `dir:<path>` for paths that appear in no `libraryMeta` key and in no
  `listVideos` result, because a folder is not a file and need not be bound to
  anything. Mirror `sweepArtwork`'s `remember()` rather than approximating it.
- **`primaryLibrary()` was a single-library shim across ~35 call sites.** Now
  `singleLibrary()` throws when the count is not one, so a call site that forgot
  to qualify a key fails loudly instead of writing into the first library.
- **A scan resumed from before the migration** held unqualified `remaining[]`
  while the units had become qualified. `LibraryScan.load()` now discards a run
  whose remaining set matches nothing.
- **The sweep skipped `readOnly` libraries**, letting their orphans grow without
  bound — the common case for an added archive. `readOnly` describes the media
  root; the thumbnails being swept live in `data/artwork/<libraryId>/`. Only an
  unreadable root skips now. This one was the specification's error, not the
  implementation's.

## Screenshot baselines — read before regenerating

This cost a day of red CI. Three separate things are true:

**Local generation does not work on an Apple Silicon Mac.** `docs/testing.md`
used to say the container was enough. It is not: the image pins the browser and
the fonts but not the rasteriser. One settings baseline regenerated on arm64 was
rejected on all five viewports, including the two whose text had not changed.

**Forcing `--platform linux/amd64` is not enough either.** The emulated run still
produced a page **two pixels taller** than the runner does, and a height mismatch
fails the comparison outright — tolerance does not enter into it.

**Use the workflow.** `Update screenshot baselines` runs on the same runner that
checks the result, and it now works:

```
gh workflow run "Update screenshot baselines" -f branch=<your-branch>
```

It was broken until #122: it ran in the bare Playwright image, which carries no
ffmpeg, so the fixture could not build its test media and the web server never
started. That is why nobody used it and everyone generated locally. It pushes a
commit to your branch — and because that push comes from `github-actions[bot]`,
**it does not trigger CI**. Push something of your own afterwards (a squash of
the baseline commit is tidiest) or the run sits at `action_required`.

**The settings screenshot covers the Storage section.** Anything that changes
that panel needs the workflow, even when the change reads like a one-line
removal on a screen nobody thinks of as layout.

**A local container fails all five settings comparisons on untouched `main`
too**, two pixels of height apart. Run that one spec on `main` before blaming
the branch.

## Verifying in Docker

`AGENTS.md` asks for a local deploy after implementing. Two additions for this
feature:

- **Verify with a library whose root is away**, not only a healthy one. Stop a
  mount, or point a library at a folder you then rename, and confirm the row is
  flagged, that scan and sweep skip it, and that nothing is deleted. That branch
  has already cost one data-loss bug, and the test that was supposed to cover it
  passed because the temporary directory held no artwork.
- **Leave the container up** when you are done, so the owner can try it.

```
docker compose up -d --build
docker compose ps
curl -s localhost:${STREMIO_OFFLINE_PORT:-8090}/api/status
```

## Working alongside other branches

- **Version bumps collide.** Two open PRs both bumping the same patch is routine;
  `AGENTS.md` says the branch takes the next patch after whatever is on `main` at
  rebase time. Check `main` before bumping, not when you opened the branch.
- **`player-sidecars.test.ts` is flaky on CI.** "cues are held back until they
  reach past the playhead" reads subtitles through ffmpeg and is timing
  sensitive; it fails under runner load and passes on a re-run. Confirm locally
  before treating it as a regression.
- **A rebase strands other worktrees.** Several `/private/tmp/stremio-*`
  checkouts track these branches. After a force-push, `git -C <worktree> reset
  --hard origin/<branch>` — but look at `git status` there first; one of them had
  uncommitted work.

## What to build next

In order. Each is a branch off `main` and its own pull request.

1. **Finish #119.** Baselines are regenerating; merge once green.
   Done: merged into `main` as `0.4.4`.
2. **Loose ends of PR 3**: New folder in the picker with `create: true`. Done in
   #123, open when this was written.
3. **Retire `artworkLocation`** in favour of per-library `writeArtwork`, with the
   one-time migration. Done: the migration reads the old global once, keyed on
   the key still being in the state file, and the Storage section lost the
   select.
4. **PR 6 — per-library addon save rules.** `DownloadTargetSettings.libraryId`
   end to end: the select offering only libraries of the matching type or
   `mixed`, never a `readOnly`, disabled or unreachable one; validation on
   `PATCH /api/addons/:key`; backup v2 remapping libraries by root then name
   **and** remapping `defaultMovieLibrary` / `defaultSeriesLibrary` inside the
   settings blob; `/downloads` gone from `web/src`. §11 of the specification.
   Done in #126, with the review's first point folded in: a job whose library is
   switched off, read-only or away **pauses** with `pauseReason: "library"` and
   resumes by itself, instead of being redirected to the default.
5. **User documentation**: `docs/libraries.md`, including the split guide above.
   Done: the guide covers the split, the types, the switches, unreachable and
   read-only roots, removing against disabling, and where the state lives.
6. **A removed library keeps its identity** for a month, so a folder added again
   takes its id back and everything remembered under it is live again. Done in
   #127 — the review's second point, and what makes the dialog's promise true.

## The review of these four branches

An independent review (`LIBRARY_REVIEW.md`, answered in `LIBRARY_REVIEW.md` next
to it) settled two blocking points and left one merge-order warning. All three
are reflected above; the warning is worth repeating here because it is the kind
that resolves into a type error rather than a merge conflict:

**Rebasing #126 over #125 is semantic.** #125 removes `artworkLocation` from
`Settings`; #126 was written against the version that still has it, so
`server/src/backup.ts` and `server/src/store.ts` carry the field in two places.
After #125 lands the line has to go rather than be merged, and the rebased branch
needs `npm run build` before the tests, not only the tests.

**A second review (`LIBRARY_REVIEW.md` again) followed the fixes.** Three points,
all settled: the reference table in *When a library stops being available* still
described the old fallback in two of its three cells, the delete-versus-pause
pair was inconsistent (#126 fell back at once, #127 made removed libraries come
back), and the ffmpeg sidecar test guessed how long a reader takes to start.
That last one is #128; the other two are in #126, where the behaviour lives. The
answer to the delete question: a removed library pauses a job like an
unavailable one, and the job takes the default after `LIBRARY_WAIT_MS` (half an
hour) if the folder is never added back.

The review also confirmed, so nobody spends a day on them again: the create path
cannot escape a grant through a symlink (`grantingRoot` resolves both sides), the
artwork migration preserves the old layout, and backup v2 remaps every id it
restores.

## Two things worth not getting wrong

**Pass-through is on exactly one *configured* library** — not one enabled, not
one reachable. A library that is switched off or whose disk is unplugged is still
a deliberate part of the setup, and a browse root that changed shape when a drive
spun down would be worse than one extra click.

**Nothing is destroyed by absence.** A pulled disk, a revoked grant and a
disabled library are recoverable states. Only an explicit
`DELETE /api/libraries/:id?forget=1` removes remembered data. Every guard in the
scan, the sweep, the autoscan and the ops queue exists to keep that true.
