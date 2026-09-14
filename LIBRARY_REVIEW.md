# `main` is red — fix this first

| Field | Value |
| --- | --- |
| Date | 2026-09-14 |
| `main` | `c8fa2fe`, `0.4.5`. #123–#130 all merged, no open PRs. |
| State | `check` green, **`e2e` failing on `main`**, confirmed on run `34850920648` against `c8fa2fe` — the same failure as on the two commits before it, so #127 did not introduce it and did not fix it. |

## The failure

```
[chromium] › e2e/tests/library-move.spec.ts:62 › a film moved into a shared folder keeps its own picture
Error: None of …/e2e/.tmp/data/artwork/lib_99167fb9/f928077f….jpg appeared.
```

Both attempts, so not a flake. It is #129's own test — the one guarding the bug
#129 fixed — and it passed on #129's branch. It fails on `main`.

## Why

The test waits for a thumbnail under `DATA_PATH/artwork/`. On `main` the poster
no longer goes there: it goes **next to the media**, and the surrounding log says
so out loud:

```
WARN The thumbnail could not be generated … rename '…/downloads/Přesun zdroj/poster.j…' ENOENT
WARN Artwork could not be written next to the media {"key":"lib_…/Přesun zdroj"}
```

That is #125's doing, and it is a behaviour change nobody declared:

| | before #125 | after #125 |
| --- | --- | --- |
| control | `Settings.artworkLocation`, default `"data"` | `LibraryRecord.writeArtwork`, default `true` |
| fresh install writes posters | into `DATA_PATH/artwork/` | **next to the media** |

An **upgrade** is safe — `retireArtworkLocation` reads the old global and carries
the old behaviour over, which I verified when reviewing it. A **fresh install**
is not: `initialState` seeds `writeArtwork: true`, `artworkBesideMedia` returns
true, and the default flips. The e2e fixture is a fresh install, which is exactly
why it broke and why it broke only once both PRs were on `main`.

The specification asked for "on by default", so this started with the design, not
with the implementation. It is still a default that changed without being called
a change.

## Decide, then fix

The owner has said posters beside the media are what they want, so the new
default is probably the one to keep — but that is a decision, and it has
consequences that the switch alone does not cover:

- a fresh install now writes into the media tree by default, which for someone
  who mounts a curated library read-only is the one thing `writeArtwork` exists
  to prevent. It is handled (`readOnly` forces it off), but only once the probe
  has run;
- `docs/configuration.md` and `docs/libraries.md` describe where posters land.
  Check both against whichever default survives.

Then make the test say what it means. It currently asserts *where the file is*,
which is why a change of default reads as a broken move. It should assert **which
picture the film ends up with** — the film's own bytes rather than the folder's —
and look wherever the artwork actually goes for that library. `waitForFile` with
a list of candidates is already close; give it both locations.

## Then

Re-run `e2e` on `main` and confirm it is green before anything else lands on top.

---

# What is left after that

## Known gaps, in order

1. **The artwork index never learns about deletions.** `ArtworkCache` has
   `written`, `moved` and `served`, but no removal hook, and neither
   `pruneEmptiedFolders` nor `sweepArtwork` tells it anything — they `rm` the file
   and leave the entry. Measured on the live install: 67 entries, **1 ghost**.
   Tiny now, and it grows with every delete. It matters because `evict()` sums
   `entry.bytes` to decide whether the cap is reached, so a drifted index evicts
   live thumbnails early. Add the hook and call it from both places.

2. **Decide delete-versus-pause for a queued download.** #126 pauses a job whose
   library is switched off, read-only or away, and falls back to the default when
   the library's **record is gone**. The reasoning was *a deleted library never
   comes back*. #127 makes it come back. So: remove a library, its jobs land in
   the default at once, add the folder back a minute later and the identity
   returns — but the files are already elsewhere, and only a log line said so.
   Neither behaviour is wrong alone; the pair does not line up. Pick one and
   write it down:
   - pause on delete too, and let the departed note revive the job — pair it with
     a queue row saying what it waits for and offering to cancel;
   - keep the fallback but let the retry window pass first;
   - keep it as it is and say so in `docs/libraries.md`.

3. **The reference table in `docs/multi-library.md`** still has two cells from
   before the pause landed, in the row for `AddonDownloadSettings[kind].libraryId`:
   *"the download resolves through the fallback for now"* under disable /
   unreachable, and *"the queue falls back while it is not"* under type change.
   The implementation pauses in the first case and does nothing in the second —
   `resolveLibrary` never consults the type. The row below is correct; only this
   one is stale.

## Not started — the last of the plan

**PR 6's remainder.** `docs/libraries.md` exists and the save rules landed, but
the plan's last item was user documentation *plus* the sweep of `/downloads` out
of `web/src`. Check whether any hardcoded path is left in the client now that
libraries own their roots; it is the last thing standing between this and a
desktop build that does not need a second pass.

**Desktop readiness, unverified.** §13 of the specification lists what has to
hold: POSIX paths on the wire, case-insensitive rename, Windows reserved names,
comma-only grant parsing. The code was written to it, but nothing has ever run on
a case-insensitive or Windows filesystem. A single unit test over the pure string
helpers with `C:\Media` and `\\server\share` shapes would cover most of it and
runs fine on Linux CI.

**`Follow show`** ([roadmap.md](docs/roadmap.md)) was always going to reuse
`refreshedAt` from the metadata freshness pass, which now exists. It is the next
feature-sized piece, and nothing in the library work blocks it.

## Two things worth not getting wrong

**Pass-through is on exactly one *configured* library** — not one enabled, not
one reachable. A library switched off or on an unplugged disk is still part of
the setup, and a browse root that changed shape when a drive spun down would be
worse than one extra click.

**Nothing is destroyed by absence.** A pulled disk, a revoked grant, a disabled
library and now a removed one are all recoverable. Only an explicit
`DELETE /api/libraries/:id?forget=1` removes remembered data. Every guard in the
scan, the sweep, the autoscan and the ops queue exists to keep that true.
