# Libraries

A **library** is one folder on disk the app reads: a root, a type and its own
scan. A fresh install has exactly one, the download directory, and it looks and
behaves the way it always has. Add more when your media does not all live in
that one tree — an archive on another disk, films and series kept apart, a
friend's folder mounted read-only.

Everything else in the app spans all of them: Continue watching, favorites,
search, the metadata scan and the queue.

## Adding a library

**Settings → Libraries → Add library**, or the library tools menu in the
Library view. The picker walks the folders this install is allowed to read.

- **Granted roots.** Under Docker the operator grants them with `LIBRARY_ROOTS`
  (see [configuration.md](configuration.md)); a folder outside every grant is
  refused with *"outside every granted root"*, however it is typed. A root you
  grant from the picker itself can be revoked there again — the libraries under
  it are switched off, and nothing on disk is deleted.
- **New folder.** The picker names a folder that does not exist yet and the
  library brings it into being, inside the granted root, when you add it. A flow
  you cancel leaves nothing behind.
- **Name and type.** The type decides how the files inside are read as titles:

| Type | What it means |
| --- | --- |
| Movies | Every file or folder is one film, whatever its name suggests. |
| Series | Files are episodes; season and episode numbers come from the names. |
| Mixed | The app decides per folder, the way it does for the download directory. |

- **Estimate.** Before anything is written, the picker counts the titles and
  files the scan would look at, and how many of them are already identified.
  A huge folder stops counting early and says so.
- **Automatically look up metadata** is on by default. Turn it off for a library
  whose titles are not in your catalogues; scheduled scans then skip it. You can
  still run **Scan this library** or find metadata for one item manually.
- **Scan metadata now** is a separate, one-time choice and is on by default:
  the new library is matched against your catalogues straight away. Untick it
  and the scan waits for an automatic run only when automatic lookup is enabled
  for that library; otherwise it waits for a manual scan.

Where a download lands is a property of the addon that offered the stream: each
stream addon sets a library and a subfolder for films and for series, and the
library switched to **Default for movies** or **Default for series** in its row
is what a rule that says *Default* means (see
[downloads.md](downloads.md#where-files-are-saved)). The queue resolves that
choice when a job starts, so a library that is switched off, read-only or on a
disk that has gone pauses the job rather than sending the file somewhere else.

## The library row

Each card in **Settings → Libraries** summarizes the name, type, root and
counts. **Edit library** opens the settings dialog. Changes to the name, type,
availability, defaults and presentation are staged until **Save changes**;
closing the dialog without saving discards them. Scan, folder-change and removal
are separate actions. The cards also let you reorder libraries.

The dialog contains these controls:

| Control | What it does |
| --- | --- |
| Type | Change it at any time. A `mixed` library that becomes typed is re-read at the next scan, and titles that no longer fit keep their match but are flagged. |
| Enabled | A switched-off library keeps its place, its metadata and its row. It is skipped by the scan, and it does not open. |
| Automatically look up metadata | Whether startup, periodic and filesystem-triggered scans search this library. Off skips automatic lookups and metadata refreshes; manual scans and item identification still work. The instance-wide automatic scan setting and `LIBRARY_AUTO_SCAN=0` also apply. |
| Default for movies / Default for series | Where that kind lands when a save rule says *Default*. One library holds each kind, so switching it on here takes it from whoever had it, and switching it off leaves the kind to the fallback: the first enabled library of that type, then the first `mixed` one. The switch is locked on a library the kind cannot land in, and a type change that narrows the library out of a kind gives that default up. |
| Write artwork next to the media | Where a poster or thumbnail we generate goes: beside the video, or under `DATA_PATH/artwork/<library id>/`. Off by default — a new library often points at a tree somebody else keeps, and a `poster.jpg` written into it cannot be taken back. Turn it on per library, for instance so a media server scanning the same folder finds the posters. Forced off and locked where the root cannot be written. A `poster.jpg` that is already in the folder is never touched or overwritten. |
| Name | The name in the app. Nothing on disk moves. |
| Show a mosaic of covers | Uses up to five title covers for the library card. Off uses plain folder artwork. Individual titles or folders can also be kept out of the mosaic from their item menu or a bulk selection. |
| Show in Continue watching | Hides or shows this library in resume lists; stored playback positions are kept. |
| Scan this library | Matches this one library now instead of waiting for the automatic scan. |
| Change folder | Choose whether to point at another folder only or move the content along — see below. |
| Remove / Remove and forget | See *Removing a library*. |

The browse root follows a simple rule: with exactly one **configured** library
the Library view opens straight into it, and with two or more it lists them
first. A library that is switched off or whose disk is unplugged is still a
configured library, and still counts.

Sorting, the favourites-only filter and the grid/list layout are remembered per
library and per account, so one person's choice does not follow another's.

Continue watching groups episodes into one tile per series. A catalogue series
that finishes an episode can offer **Next episode** with that episode
preselected; this uses the addon's available episode list, not a subscription
to future releases. Libraries and addons each have their own **Show in Continue
watching** switch. Hiding a source preserves its resume positions.

### Stored artwork galleries

A title's gallery button opens saved pictures with arrows and thumbnails.
Downloads retain catalogue galleries; identification can add TMDB pictures.
Galleries live under `DATA_PATH/artwork/<library id>/`, follow moves/copies and
are cleaned up with the title. They are never written beside media.

## Types, moves and the queue

Kinds are enforced where a mistake would be expensive. Moving a film into a
`series` library (or an episode into a `movie` one) is refused; a `mixed`
library takes anything. Moving or copying a title between libraries carries its
match, its episode rows and its thumbnails across, so nothing is identified
twice, and on one volume a move is an ordinary `rename` — instant, no matter how
large the file.

One item and a selection of five hundred take the same road: move, copy and
delete all run in the queue. The dialog is out of the way as soon as the job is
accepted, the strip under the toolbar shows its progress and its **Cancel**
stops it, and the guards that apply to a bulk operation apply to a single file
too — it waits for playback, for a download writing into the destination, and
for a disk that is away. Two operations cannot work on one path at the same
time: a job that is still running covers every item it was given, and the file
inside a folder it holds, so a second move, rename or delete of any of them is
refused rather than racing it.

A move or copy survives the server stopping halfway. Before the bytes move, the
queue writes down where the item is going; on the next start it looks at both
places and finishes what is left: the match, the favourites, the resume positions
and the thumbnails follow a file that already arrived, and a file that never left
is moved again. When the bytes turn out to be in both places, both are kept and
the item counts as moved with its source left behind, the same as when the
source cannot be deleted. When they are in neither, the item fails and nothing
is changed.

## When a root is away or read-only

A pulled disk, an unmounted share and a revoked grant are ordinary states, not
errors:

- The row says **not reachable** and stays where it is. The library is skipped
  by the scan, by the thumbnail sweep and by bulk operations. Its metadata file
  and thumbnails stay in `DATA_PATH`, and the media is untouched. A download
  bound for it — an addon's save rule names it — waits in the queue and says so,
  rather than landing in another library where nobody expects it. Plug the disk
  back in and everything is there again, the download included.
- A root that cannot be written (a read-only mount, a wrong `PUID`) is flagged
  **read-only**. Nothing is written into it: posters and thumbnails go to
  `DATA_PATH/artwork/<library id>/` instead, and the artwork switch is locked
  off. Moves and copies into it are refused.

Nothing is ever destroyed because something is absent. Only an explicit
**Remove and forget** drops remembered data.

## Removing a library

The last configured library cannot be removed; change its folder instead.
With several libraries, the dialog offers two removal actions.

Both actions leave every file on disk alone; the app never deletes media as a
side effect of a library edit.

- **Remove** takes the library out of the app and leaves its stored metadata and
  thumbnails in `DATA_PATH`. The folder keeps its identity for a month: add the
  same folder again — the same path, however it is mounted — and it is the same
  library, with its match history, its thumbnails, its favorites and its resume
  positions exactly where they were. Twenty removed folders are remembered at
  once; add *and* remove more than that and the oldest note is forgotten.
- **Remove and forget** also drops that stored metadata, the thumbnails under
  `DATA_PATH/artwork/<library id>/`, and the favorites and resume rows that
  pointed into it. The media itself still stays.

To take a disk out of service without losing anything, *disable* the library
instead: the row stays, the counts stay, and re-enabling it restores it exactly.

A download that was already queued for a library you remove waits for it rather
than landing somewhere else — the same rule as a disk that is unplugged. Add the
folder back and the job continues into it. If the library never comes back, the
job takes the default for its kind after half an hour and the log says so.

## Splitting the download directory

The common case: `/downloads` has grown into a mixture of films and series, and
you want them as two libraries — `/downloads/Films` and `/downloads/Series` —
without moving anything and without losing a single match.

### Split from inside (recommended)

A library may sit inside another library's root; the parent stops counting what
the child owns.

1. **Settings → Libraries → Add library**, browse into `downloads` (or
   `DOWNLOAD_PATH`), and use **New folder** to make `Films`. Name it, set the
   type to *Movies*, and add it.
2. Do the same for `Series`, with the type *Series*.
3. Open the parent library in the Library view, turn on **Select items** (or use
   a single title's menu), pick what belongs to the new library, press
   **Move**, choose the new library in the destination dialog and confirm.

There is no downtime, each move carries the metadata with it, and on a single
volume every move is a `rename` — the file never changes place on disk. Nothing
is ever copied twice, and the parent's own listing shrinks as it should.

### Re-root

**Change folder** offers two choices:

- **Only point at the new folder** (default): move no media; use after relocating
  the tree yourself. Relative metadata and resume paths keep working when the
  folder layout stays the same.
- **Move the content along**: queue the transfer, then switch the root after
  every item arrives. Progress and cancellation appear in the operation strip.

A content move refuses nested libraries, overlapping source/destination paths,
colliding names and an empty source. Failure or cancellation keeps the old root,
but does not roll back files already moved; check both folders before retrying.

For manual relocation, stop the server, move the whole tree, restart and choose
**Only point at the new folder**.

## Where the state lives

Nothing about a library is hidden in a database:

| Path | Holds |
| --- | --- |
| `DATA_PATH/state.json` | The library records and the grants made from the picker. |
| `DATA_PATH/library/<library id>.json` | The match history of one library, keyed relative to its root. |
| `DATA_PATH/library/episodes.json` | Episode titles and stills, shared across libraries. |
| `DATA_PATH/artwork/<library id>/` | The thumbnails the server generated for that library. |
| `DATA_PATH/library-scan.json`, `library-ops.json` | An interrupted scan or bulk job, so it resumes instead of restarting. |

Back up `DATA_PATH` and you have the accounts, the addons, the libraries and what
they remember. The media is a separate question. What to copy, what to leave
out and how to restore is in [Backing up and restoring](backup.md).

With more than one account, a library is also something an administrator grants:
it is visible only to the accounts ticked for it, and one that was not granted
answers exactly as one that does not exist. See [Accounts](users.md).

## Related

- [configuration.md](configuration.md) — `LIBRARY_ROOTS`, `ARTWORK_CACHE_MB`,
  `LIBRARY_META_TTL_DAYS`.
- [library-metadata.md](library-metadata.md) — how folders become titles.
- [users.md](users.md) — accounts and which libraries each of them sees.
