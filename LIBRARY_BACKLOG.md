# Library backlog — twelve findings from a day of real use

| Field | Value |
| --- | --- |
| Date | 2026-09-15 |
| `main` | `8c444fb`, `0.4.6`. #138 open (segmented-download fallback, `0.4.7`). |
| How | Each item below is one `ai-team` task: I write the specification, DeepSeek Flash implements in its worktree, gates run, I review. |
| Investigated | All twelve, from the code and the running instance. Nothing implemented. |

## How to run this without burning money

The Playwright suites are the expensive part, and most of these items do not
need them.

- **The implementer runs `npm test` only** — the server and web unit suites. The
  specification for each task says so explicitly.
- **No `npm run test:e2e:docker` from the implementer**, ever, on these tasks.
- **Layout baselines are not regenerated per task.** Several of these change the
  same two screenshots (`settings.png`, `library.png`), so regenerating each time
  would be both slow and pointless churn.
- **I verify at the end of each block**, in the browser and with one e2e run, and
  regenerate the baselines once for the whole block.

The blocks below are ordered so that each one leaves the app in a shippable
state.

---

# Block A — the things that block a real reorganisation

These are the ones that cost the owner actual work today. Ship them first.

## A1 · The picker cannot select a granted root  *(finding 8)*  — **done, #140**

**Correction to my first reading.** A granted root *can* be reached: opening it
makes `browse.path` the grant, and the button then works. What is true is that
at the top level, where the rows are the grants themselves, the only control is
disabled, and nothing says that opening a row first is what enables it. Fixed by
making every row selectable in place.

**Confirmed in code.** `LibraryManager.tsx`:

```tsx
<button className="library-picker-use" disabled={!browse?.path} …>
```

At the top level the picker lists the grants and `browse.path` is `""`, so
**Use this folder is disabled**. A folder can only be chosen from *inside* a
grant, never the grant itself.

The consequence is what the owner hit: `/downloads` is the grant, the library was
re-rooted into a subfolder, and now nothing can point back at `/downloads`. Films
left at the top level are unreachable and the library cannot be put back.

Fix: a granted root is a selectable destination like any other. Check the
neighbouring guards too — `checkLibraryRoot` refuses a root that *equals* another
library's root, which is right, and allows one that contains it, which is the
carve-out and must stay allowed.

## A2 · Re-root offers no way to create a folder  *(finding 7)*  — **done, #140**

**Confirmed in code.** The create-folder control is hidden in re-root mode:

```tsx
{!reroot && browse?.path && <div className="library-picker-manual library-picker-create">
```

So moving a library to a folder that does not exist yet means creating it by
hand outside the app — which is exactly what the owner had to do. There is no
reason for the asymmetry: the same grant rules apply either way.

## A3 · Re-root should offer to bring the content  *(finding 9)*

`PATCH /api/libraries/:id { root }` rewrites the record and **moves nothing** —
`docs/libraries.md` says so, but the dialog does not. Offer it as a choice at the
moment of re-rooting: *point at the new folder* or *move what is there into it*.

**The carve-out is the trap.** A library root can contain another library's root.
Anything that moves content must skip those subtrees, or it drags a second
library's files along with the first. `carveOuts()` already computes them; the
move must honour them, and the specification must name that.

Worth doing as a queued operation rather than inside the request: it can be
hundreds of gigabytes.

## A4 · Deleting the last library, and deleting the default  *(finding 5)*  — **done, #139**

**No guard exists.** `DELETE /api/libraries/:id` checks only that the library is
there. From reading the code:

- **Deleting the default** clears `defaultMovieLibrary` / `defaultSeriesLibrary`
  to `""`, and `defaultLibrary()` falls back to the first enabled library of the
  kind, then the first `mixed`. That part is fine.
- **Deleting the last one** leaves `store.libraries()` empty. `singleLibrary()`
  then throws on anything that touches an unqualified path, and `Store.load()`
  only seeds a replacement **at startup** — so the running server is broken until
  it is restarted, and then it comes back with a *new* library and a new id,
  which no stored key matches.

Decide and then enforce it: either refuse to remove the last library, or handle
zero libraries as a real state with an empty-state screen. Refusing is smaller
and honest. Verify the behaviour on a fixture first — do not test this against
the owner's instance.

---

# Block B — the mosaic and the library list

## B1 · Order libraries by priority, not by accident  *(finding 2)*  — **done, #140**

Half of this already exists. The server sorts by `order`:

```ts
[...store.libraries()].sort((a, b) => a.order - b.order)
```

and `PATCH /api/libraries/:id` accepts `order`. **Nothing in the interface sets
it**, and a new library takes `max + 1`, so the list is insertion order — which
looks alphabetical when the libraries happen to be.

So this is not "build ordering", it is "expose the field that is already
plumbed": up/down controls, or drag, in the library manager. `library.moveUp` in
the i18n file is the picker's *go up a folder*, not this — pick a different key.

## B2 · Exclude items and folders from a library's mosaic  *(finding 3)*

The root browse returns `posters?: string[]`, up to five distinct prepared
artworks, scanned over the library's entries. There is no way to say *not that
one*. For a library whose covers are not for the living-room screen, that is the
difference between using the feature and turning it off.

Per path, and inherited by everything below it, so excluding one folder is one
action. It belongs next to the existing per-path flags in `libraryMeta` rather
than in a new store.

## B3 · Turn the mosaic off for a library  *(finding 4)*

Blunter than B2 and wanted for the same reason: a switch on the library, a
neutral placeholder instead. The empty-library placeholder already exists; this
reuses it.

B2 and B3 are one specification — same data, same screen — and should not be
split into two rounds.

---

# Block C — the dialogs

## C1 · Nested scrolling in the picker and the identify dialog  *(findings 6, 12)*

**One root cause, confirmed in the CSS.** `.identify-card` is the shared shell:

```css
.identify-card{ max-height:min(90dvh,720px); overflow:auto }
.identify-results{ max-height:280px; overflow:auto }
.library-picker-card{ max-height:min(92dvh,780px) }
```

So the card scrolls **and** a list inside it scrolls. The wheel moves the inner
list until it bottoms out and then jolts the card; on touch it is worse. Both
dialogs the owner called out share this shell, which is why both feel wrong in
the same way.

Fix the shell once: one scroll region, with the head and the primary action
pinned outside it. That also fixes the thing I measured earlier — at 1440×900 the
picker's **primary button sits at y=899, off the bottom of the screen**, with the
name field and the type picker below the fold.

Do C1 before the add-library redesign in the older UX notes: it is the structural
half of the same complaint.

## C2 · The identify dialog scrolls more than it should  *(finding 12)*

What is left of finding 12 once C1 lands is content, not mechanics: the dialog
asks for a lot in a narrow column. Look at it again **after** C1 and decide
whether anything more is needed — it may not be.

---

# Block D — smaller, independent

## D1 · Name the library in the download queue  *(finding 10)*

The queue detail shows `job.target` and nothing else:

```tsx
<small>{job.target || (job.pending ? t("downloads.sourcePickedLater") : "")}</small>
```

With one library that reads as a path. With several it reads as
`lib_a1b2c3d4/Film/Film.mkv` — an opaque id where a name belongs. The job already
carries `libraryId`; resolve it and show the name, with the path below it.

## D2 · A copied film gets a frame where a poster was available  *(finding 11)*

Reported: copying an existing film into a folder produced a video frame, while
the identify dialog found the title in the catalogue without difficulty.

**Do not assume the cause.** A match already replaces a generated frame —
`clearGeneratedArt` runs on the match route and is wired into the scan through
`deleteGeneratedArt`. So the likely story is that the file was never matched
automatically: the scan's auto-accept bar is deliberately conservative (*"wrong
poster is worse than none"*, Key Decision 3 in `library-metadata.md`), and a
human choosing from the dialog clears a bar the scanner will not.

Reproduce it first, on a fixture, and find out which of these it is:

1. the artwork job simply ran before any scan, and a later scan never matched;
2. the scan matched but the frame stayed — that would be a real bug in the
   replacement path;
3. the scan declined the match that Identify accepted — working as designed, and
   then the question is whether a fresh file should wait for a lookup before
   spending ffmpeg on a frame.

The answer decides whether this is a bug or a tuning decision. It is the one item
here that is not yet understood, so it goes last.

---

# Found while reviewing, not from the twelve

## E1 · Two libraries can still converge on one folder, if a disk is away

Two libraries on the same folder are refused, and properly: `checkLibraryRoot`
compares through `realpath`, so the same path written with a trailing slash,
with `/.`, in another case (on a case-folding filesystem) or through a symlink
all collapse to the same `err.libraryRootTaken`. Both routes that set a root —
`POST /api/libraries` and `PATCH /api/libraries/:id` — go through it, and the
settings import writes no libraries at all (`libraries: []`).

The gap is the fallback:

```ts
const other = await realpath(library.root).catch(() => path.resolve(library.root));
```

When an existing library's disk is **unreachable**, its `realpath` fails and the
comparison falls back to the literal path. So this passes: the library's root is
`/mnt/archive`, a symlink to `/data/archive`; the disk is away; a new library is
created directly on `/data/archive`. When the disk comes back, two libraries
point at one tree.

If it ever happens, nothing downstream catches it. `carveOuts()` drops the
"same path" relation (relative `""` is filtered out), so neither library carves
the other out of its walk: every file is seen twice under two ids, with two sets
of metadata and thumbnails, and two writers for the same `poster.jpg` if both
have `writeArtwork`.

Narrow, and not worth a round on its own. When something else touches this
function: compare the unresolved paths as well as the resolved ones, and refuse
on either match.

---

# Finding 1 — the library type gate: my view

> *nevím jestli je úplně nutná logika, která hlídá typ cílové knihovny*

**I would soften it rather than remove it.** Today it is a hard refusal:

```ts
throw new AppError(`A ${destination.type} library does not take ${kind === "movie" ? "films" : "series"}.`, "err.libraryTypeMismatch");
```

The case for keeping something: the type drives classification. `titleUnits` is
given the library's type, and the scan searches movie or series catalogues
accordingly. A series sitting in a `movie` library will be re-read as a film by
the next scan of that library.

The case for softening it: the damage is small and reversible. Display uses the
**binding's** type, not the library's, so a bound series in a movie library still
renders as a series; only a future scan would mis-handle it, and moving it back
undoes that. Against that, a hard refusal stops a reorganisation mid-flow with an
error — which is exactly what the owner hit while sorting a mixed library into
typed ones, and the app is at that moment refusing to do what its owner asked
with their own files.

So: **warn and confirm, do not refuse.** Say what will happen — *this library
holds films; a series put here will be read as a film the next time it is
scanned* — and let the user proceed. Keep the refusal only where it is not a
judgement call but a fact: the addon save rule, where nobody is watching and a
wrong choice would keep landing episodes in the wrong place, should stay a hard
error.

That keeps the type meaningful without making it a fence around the user's own
media.
