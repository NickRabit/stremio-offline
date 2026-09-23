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

### Where the answers come from

Only trusted providers may name a title on their own, and they are asked one at
a time rather than every catalogue addon at once:

1. **TMDB**, when an API key is configured. A title search runs first; its
   request has a five-second deadline, and a `429` is honoured through its
   `Retry-After` instead of being retried for every title in the tree.
2. **Cinemeta**, when TMDB has no key, fails, or answers with nothing that
   scores like the file's name.

No other catalogue addon — including one with its global search switched off —
can create an automatic match. That is what bound a file to a same-named row
from an unrelated catalogue. The general catalogue search is still there for a
person: **Identify…** offers **Search other addons** as a second, explicit step.

A name is not an identity. A candidate is bound automatically only when it is
unique, its year is within two years of the year in the file name (and a missing
year is never read as agreement), its type matches, and the provider still
returns a metadata record for it. If a TMDB result wins the search, the scan
resolves `/movie/{id}/external_ids` or `/tv/{id}/external_ids` and binds the
IMDb id when TMDB has one, so every addon that speaks IMDb can be asked about
the title afterwards. When it has none, the `tmdb:` id is kept as before.

### Rechecking automatic matches

**Library tools → Recheck automatic matches** looks at one library's titles the
scan bound on its own — the ones that are unlocked and carry `source: "scan"`.
It never rewrites them silently: a title that now reads differently comes back
as a correction in the suggestions list, showing the current binding beside the
proposed one. Confirming it updates the binding and its artwork; dismissing it
keeps what was there. Bindings a person or a download made, locked records and
items excluded from matching are never touched.

The scan runs **on its own** too (`LIBRARY_AUTO_SCAN`, both in Settings and in
the environment), for each enabled library whose **Automatically look up
metadata** switch is on. Turn that switch off when the catalogue addons will
not find the library's titles. Manual scans and **Find metadata** still work.
The instance-wide switch in Settings or `LIBRARY_AUTO_SCAN=0` can disable all
automatic scans:

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
the list with **Confirm**, **Identify** and **Dismiss** on each row. Every row
names the library and the folder inside it, carries a portrait thumbnail of the
candidate the row is about — its own poster, never the local file's artwork —
and says what the number beside it means: it is title-name similarity, not
overall certainty. A name that matches 100% still shows why it wants a look
(more than one title may match, the release year is missing or wrong, or a
different binding is already there), and a correction shows both identities.
A proposal is only listed while its file is still in the tree and its library is
reachable; an unplugged disk hides its rows from the count without losing them.
The same suggestion appears on the tile's own menu, and the toolbar carries an
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

**Identify** searches the trusted providers with the name and year filled in from
the path, and lets you pick the title, the type — film or series — and, for an
episode file, which episode it holds so its own name and plot are shown. The
choice is locked: a later scan leaves it alone. **Unmatch** records that the
title has no catalogue identity and stops the scan from suggesting one again;
**Identify** reverses it.

### Artwork

Binding a title asks TMDB for its detail with artwork on, and saves its
`poster_path` as the portrait variant and `backdrop_path` as the landscape one.
A separate, bounded gallery request (`/movie/{id}/images` or `/tv/{id}/images`,
in the interface language plus `en` and `null`) fills the alternate posters,
backdrops and logos — at most eighteen, deduplicated. Neither request is made
while searching: only a title that was chosen pays for them. Where TMDB has no
picture the catalogue's artwork is used, and where neither has one the existing
frame generation runs. Artwork that is already saved is replaced only when the
artwork is regenerated explicitly or a correction is confirmed.

## Where the matches live

| Path | Holds |
| --- | --- |
| `DATA_PATH/library/<library id>.json` | That library's matches and waiting suggestions, keyed relative to its root. |
| `DATA_PATH/library/episodes.json` | Episode titles and stills, shared across libraries. |
| `DATA_PATH/library-scan.json` | An interrupted scan, so it resumes instead of restarting. |

All of it sits under `DATA_PATH`, so copying that folder keeps the work. The
settings backup does **not** carry it — see
[Addons and downloads](downloads.md#backing-up-the-configuration).

Cinemeta names every title the library matches against when TMDB cannot, so it
is treated as essential: it cannot be removed, switched off, or demoted to a
stream-only addon. Any other catalogue addon that declares metadata is used as
well for browsing and for an explicit search, and stays fully removable — but it
is never evidence for an automatic binding.

## Related

- [libraries.md](libraries.md) — roots, types, per-library switches, removal.
- [configuration.md](configuration.md#library-metadata) — the scan's environment
  variables.
- [troubleshooting.md](troubleshooting.md#when-a-title-is-missing-its-links) —
  when the external links, rather than the match, are missing.
