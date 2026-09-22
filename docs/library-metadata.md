# Library identification

Point a library at a folder that arrived from somewhere else — a NAS dump, an
archive on another disk — and most titles have no poster and no description.
The scan reads the folder names, guesses which catalogue title each one is, and
binds it, so the grid fills in. A title that already came through the download
queue keeps the identity it already had.

Identification never changes a file or a folder name: the path is the identity
that favourites and resume positions are keyed to. It only decides what to show
above the path.

## What gets matched

The unit is a **title**, not a file. A folder with season folders inside it is
one series; a folder holding a single film is one film; a loose video at the top
of the library is its own film. Grouping folders that exist only to sort the
tree — `Webshare`, `Movies`, `Films` — are walked through rather than matched.

Concretely:

- **A series** is a folder with a season folder inside it (`01 serie`,
  `Season 2`, `S03`), or a folder whose files are mostly named `S01E07`. Its
  episodes are not matched one by one; the show is the unit.
- **A film** is a folder holding one video — or one video plus extras, where an
  extra is a file whose name contains the word `trailer`, `sample`, `extra` or
  `bonus` as a whole word. `Obsession/Obsession.mkv` and
  `Obsession/Obsession (2).mkv` are one film, not two.
- **A loose file** at the root of a library, or next to title folders inside a
  grouping folder, is a film of its own. It is not swallowed by the folder it
  happens to sit beside.
- **A collection** — a folder of unrelated videos with no structure — is left
  alone and not recursed into. Sending a dump of unrelated names to a metadata
  provider is noise, and the scan does not do it. Identify still works on any
  one item inside it.

Names are cleaned before the search: quality and release tags come off, a
trailing year is kept as a search hint, and `SxxExx` is read as a season and
episode. A folder whose own name carries an episode number (`Show/06 - Title.mkv`
inside a flat folder) still resolves to the show.

## The scan

**Settings → Libraries → Scan this library** matches one library now. The row
shows progress and can be stopped; a scan that is interrupted — the container
restarts, the NAS goes down — resumes where it stopped rather than starting the
tree again. A single item can be matched from its three-dot menu with **Find
metadata**.

The scan runs **on its own** too (`LIBRARY_AUTO_SCAN`, both in Settings and in
the environment):

- every six hours, plus one check two minutes after start-up, it compares the
  tree against the last one it acted on — file count, total size and newest
  modification time. An unchanged tree asks the catalogues nothing;
- a filesystem watch makes that prompt where the platform delivers events. It is
  an accelerator, never the guarantee: an SMB or NFS share sends none, and Linux
  has no recursive watch. When the watch is inactive the periodic check carries
  the feature alone.

A scan yields to playback and downloads rather than competing with them. A
catalogue that does not answer leaves its titles unmatched and is retried later.

A title the scan asked about and could not place is remembered for thirty days,
so a repeated scan does not ask the same question again. **Find metadata** on one
item ignores that memory; a full rescan can be forced.

## Suggestions and Identify

The scan binds only at high confidence. A plausible but uncertain hit is offered
instead: a banner above the grid counts the waiting titles, and **Review** opens
the list with **Confirm**, **Identify** and **Dismiss** on each row. The same
suggestion appears on the tile's own menu, and the toolbar carries an
**Awaiting confirmation only** filter beside the favourites one while the banner
has something to count. It narrows the listing to the titles the scan is still
asking about, at any depth below the folder you are in. The filter is not
remembered between visits, unlike the favourites one: an empty library left
filtered would look broken rather than finished.

A match the scan made is never final. From the three-dot menu on a folder or a
file:

| The item is | The menu offers |
| --- | --- |
| matched | **Fix match…** and **Unmatch** |
| unmatched, or waiting as a suggestion | **Identify…** |

**Identify** searches the catalogues with the name and year filled in from the
path, and lets you pick the title, the type — film or series — and, for an
episode file, which episode it holds so its own name and plot are shown. The
choice is locked: a later scan leaves it alone. **Unmatch** records that the
title has no catalogue identity and stops the scan from suggesting one again;
**Identify** reverses it.

## Where the matches live

| Path | Holds |
| --- | --- |
| `DATA_PATH/library/<library id>.json` | That library's matches and waiting suggestions, keyed relative to its root. |
| `DATA_PATH/library/episodes.json` | Episode titles and stills, shared across libraries. |
| `DATA_PATH/library-scan.json` | An interrupted scan, so it resumes instead of restarting. |

All of it sits under `DATA_PATH`, so copying that folder keeps the work. The
settings backup does **not** carry it — see
[Addons and downloads](downloads.md#backing-up-the-configuration).

Cinemeta names every title the library matches against, so it is treated as
essential: it cannot be removed, switched off, or demoted to a stream-only
addon. Any other catalogue addon that declares metadata is used as well, and
stays fully removable.

## Related

- [libraries.md](libraries.md) — roots, types, per-library switches, removal.
- [configuration.md](configuration.md#library-metadata) — the scan's environment
  variables.
- [troubleshooting.md](troubleshooting.md#when-a-title-is-missing-its-links) —
  when the external links, rather than the match, are missing.
