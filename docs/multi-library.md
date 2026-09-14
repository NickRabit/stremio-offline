# Multiple Libraries

| Field | Value |
| --- | --- |
| Author | Engineering |
| Date | 2026-09-13 |
| Status | Draft — specification for an implementing agent |
| Product | Stremio Offline |
| Related | `server/src/library.ts`, `server/src/library-match.ts`, `server/src/library-scan.ts`, `server/src/store.ts`, `server/src/naming.ts`, `server/src/artwork.ts`, `server/src/images.ts`, `server/src/index.ts`, `web/src/App.tsx`, [library-metadata.md](library-metadata.md), [downloads.md](downloads.md) |

## Progress

Implementation status. One line per slice; a slice is a commit on the task
branch and leaves the tree buildable and tested. A slice is verified with the
narrowest suites that cover it -- server unit tests, `tsc`, a single Playwright
spec. The full build, unit and e2e suites run before the branch is pushed and
again after every rebase onto `main`.

### PR 1 — Qualified paths, `libraries.ts`, migration

- [x] `libraries.ts`: ids, POSIX helpers, path parsing, carve-outs, `resolveLibraryPath`.
- [x] POSIX wire rule through `library.ts` and `library-match.ts`.
- [x] `schemaVersion`, `libraries` in state, `library-migrate.ts` and its unit tests.
- [x] `resolveLibraryPath` at every `index.ts` call site and in the download queue. The
      wire stays relative while one library is configured, so the interface is unchanged;
      `wirePath`/`libraryKey` are the only translation points.
- [x] Artwork re-keying in the same migration. Queue targets stay library-relative
      until per-library save rules land (PR 6); only keys in `state.json` are qualified.
- [x] Verification: `tsc`, 412 server tests, the Playwright suite, and the built image
      booted against a v1 `state.json` (migrated in place, backup kept, keys qualified,
      `/api/status` healthy). The fixture seeds a v1 `state.json`, so every end-to-end run
      boots through the migration; the dedicated assertion on the migrated result belongs
      with the library chrome (PR 4). The settings baseline no longer reads the run's own
      report count -- see the note under PR 4.
- [x] Review follow-up: `rekeyArtwork` maps and removes nothing while the library root
      is unreadable, because `listVideos` answers a missing mount with an empty tree and
      that would make every stored thumbnail look like an orphan. A test seeds an old
      thumbnail under an unreachable root. The redundant `EEXIST` guard around the
      `state.json` backup is gone; `copyFile` overwrites and never throws it.

### PR 2 — Metadata store split and cache policy

- [x] `LibraryMetaStore`: `data/library/<id>.json` with library-relative keys, the shared
      `episodes.json`, debounced atomic per-library writes, `forget`, and the memoised
      qualified view `index.ts` consumes.
- [x] The migration hands the match history over and `state.json` keeps none of it: a v1
      state after its key pass, and a state the libraries build already migrated, which
      carried the rows inline. `index.ts` reads and writes through the store; the scan's
      qualified mutator (`updateQualified`) lands in the file of the library it touched.
- [x] Artwork per library (`data/artwork/<id>/`), `data/artwork/index.json` written on
      save and on serve, `ARTWORK_CACHE_MB` eviction. The orphan sweep runs per library and
      skips one whose root cannot be read. The migration moves the files the earlier layouts
      left flat -- it used to delete the thumbnails it had just moved, which the freshness
      guard hid in the test and not on a real install.
- [x] `IMAGE_CACHE_TTL_DAYS` pass in `ImageProxy.evict()`: bytes of an image nobody
      looked at for that long go while the cache is still under its cap, the id and the
      address stay.
- [x] `docs/configuration.md`, `.env.example` and both compose files carry
      `ARTWORK_CACHE_MB` and `IMAGE_CACHE_TTL_DAYS`.
- [x] Verification: `tsc`, the server and web unit suites, and both Playwright suites in
      the CI image. The local Docker stack was rebuilt from the branch and boots against the
      live data directory, `/api/status` healthy.
- [ ] Moved to PR 3: `LIBRARY_META_TTL_DAYS` and `LibraryMetaRecord.refreshedAt`. §7 hangs
      the freshness pass on the scan job, "only for libraries browsed since the last run",
      and that is the library-scoped scan PR 3 builds -- the field and the pass it exists
      for belong in one commit.

### PR 3 — Library types, CRUD API, folder picker

- [x] `library-grants.ts`: `LIBRARY_ROOTS` with the download directory as its fallback, user
      grants, deduplication with the operator's grant winning, and containment
      (`grantingRoot`) that resolves symlinks on both sides and refuses a grant whose own
      root does not exist -- resolving a missing mount to its nearest existing ancestor
      would widen the grant to the directory above it.
- [x] `library-probe.ts`: `unreachable`/`readOnly` decided by writing and removing a
      dot-file, so a read-only mount, a wrong `PUID` and an ACL are told apart; every call
      bounded by a 2 s deadline, cached for 30 s, coalesced per root, and invalidated when
      an operation fails on I/O.
- [x] `titleUnits(files, type)` forces the kind for a typed library and leaves the unit
      boundaries alone. The scan hands the walk over to the host (`units()`), because the
      units of a typed library come from that library's file list; every unit key stays
      qualified, so they flow into `searchAll` and `scoreHit` as `expectedKind` unchanged.
- [x] Carve-outs: `listVideos`, `browseDirectory`, `listFolders`, `emptiedFolders` and
      `describePath` take an `exclude` set and every call site passes `carveOuts()`. The
      prune stopped at a folder that is, or holds, a carve-out: the parent no longer counts
      the child library's videos, so without the guard it would delete the folder the child
      lives in.
- [x] The walk (`libraryFiles`, `libraryEntries`, `libraryUnits`) covers every enabled and
      reachable library, each with its own carve-outs and its own type; `mediaPath` resolves
      through the library the key names and the wire keeps the unqualified form only for the
      first one. The autoscan keeps a fingerprint per library and starts a run for the one
      that moved (all of them when several did), a scan accepts `{ libraryId }`, and browse,
      the destination picker, the prune and the artwork sweep all run against the library
      the path names. The probe answers (`unreachable`, `readOnly`) gate the walk and the
      sweep; a root that is out of reach is skipped, never removed.
- [x] The single-library pass-through fails loudly instead of guessing: an unqualified path
      needs exactly one configured library (`singleLibrary()`), `libraryKey`/`libraryOfKey` go
      through it, and `wirePath` hands back the qualified key as soon as it cannot attribute a
      prefix. A forgotten call site in PR 4 throws rather than writing into the first library.
      `/api/status` reports free space for every library root, and folder artwork browses and
      frames the library its key names.
- [x] `writeArtwork`, `readOnly` and `unreachable` through the artwork sink and the walk.
      One decision point (`artworkBesideMedia`) replaced four copies of the global setting:
      a poster lands next to the media only when the user asked for it, the library allows
      writing and the root is neither read-only nor away. A write that fails there forgets
      the probe for that root, so the next `GET /api/libraries` asks the disk instead of
      trusting a cached verdict. The walk already skips a library that is disabled or away.
- [x] `data/library-scan.json`, spec step 5: `LibraryScan.load()` drops a run whose
      `remaining[]` names no item of any current library instead of resuming it. An upgrade
      qualifies the unit keys, and an interrupted run would otherwise skip the whole library
      one entry at a time. The guard sits in `load()` rather than in the migration, so it
      also covers an install whose state file was written by the libraries build.
- [x] `LIBRARY_META_TTL_DAYS` (default `14`) and `LibraryMetaRecord.refreshedAt`: a bound
      series older than the TTL is re-fetched by the scan, one `metadata()` call at the
      same pacing, only for libraries browsed since the last run. Carried over from PR 2.
      The pass goes through the id the binding already carries, so it never searches and
      never scores; the refresh keeps `source`, `locked` and `matchedAt`, merges the fields
      and the episode rows, counts as a skip rather than a match, and leaves the poster
      alone. A lookup that comes back empty leaves the binding exactly as it was. Only a
      binding on the item itself counts -- one inherited from the folder above is refreshed
      on the folder's own turn. The interface marks a library browsed in `/api/library/browse`
      and `/api/library/folders`; the merged listing deliberately does not, or every start
      would count as a browse of the whole tree.
- [x] `/api/libraries` (list, create, patch, delete), `/api/libraries/browse`, the grant
      endpoints, `/api/libraries/preview`, and the restricted-mode denials (`GET` of the
      picker and the grants, and every write, with `GET /api/libraries` kept readable but
      without `root`). `checkLibraryRoot`
      (`library-admin.ts`) is the one gate: absolute, inside a granted root, a folder, and not
      another library's root compared through `realpath`; a root inside another library's root
      stays legal. `create: true` creates only inside the grant, and the probe decides
      `writeArtwork`. `GET /libraries` probes each root through the 30 s cache and counts
      titles, files and bytes from the walks the listing already holds. `PATCH` clears a
      default picker the new type no longer serves. `DELETE` never touches media: `?forget=1`
      drops the match history, the artwork directory and the favourite and resume rows that
      pointed into it. The picker lists the grants when `path` is empty and their children
      otherwise, never lists a symlink out of a grant, and flags a row that is or sits inside
      a library. Revoking a user grant disables the libraries under it and deletes nothing --
      an operator grant is rebuilt from the environment, so it cannot be revoked. `preview`
      walks with a 20 000-file ceiling and a 5 s deadline, asks no addon, and reports
      `truncated`; it counts existing bindings only when the root already is a library.
- [ ] Follow-up for PR 6: `AddonDownloadSettings` carries no `libraryId` yet, so the delete
      path has no stored rule to fall back, and the queue has no job to pause with
      `pauseReason: "library"`. Both land with the per-library save rules.
- [x] No reachable path throws the single-library pass-through at a call site that cannot
      answer: `LibraryScanOpts.pathExists` is required and qualified, so the scan no longer
      builds one from `downloadDir` at module load, and a state holding two libraries boots
      instead of failing before the server listens. `GET /api/library/browse` with no path
      answers a translated "open one of them" while more than one library is configured.
      The root browse that lists them is PR 4's; this only stops it from being a 500.
- [x] Two defects the Docker pass and `e2e/tests/library-admin.spec.ts` found, not the unit
      suites: Express matches in registration order, so the parameterised
      `DELETE /api/libraries/:id` was swallowing `DELETE /api/libraries/grants` and a revoke
      answered "library not found" instead of disabling anything -- the item routes now come
      after every literal path. And Express 5 leaves `req.body` undefined when a request
      carries no body, so the grants revoke (path in the query) and a bodiless `PATCH` threw;
      every new handler reads `req.body?.`. The spec adds a grant, refuses a root nobody
      granted, previews, creates a library under the grant, revokes it and checks the library
      is disabled while its file stays put, then removes what it made.
- [x] A scan somebody asked for drops the in-memory walk first. `libraryFiles()` and
      `libraryUnits()` are held for half a minute, so a folder copied in and then rescanned
      was invisible to the run meant to find it; the e2e suite caught it once a spec that
      walks the library ran shortly before `library-identify.spec.ts` created its fixture
      folders.
- [x] `LIBRARY_ROOTS` and `LIBRARY_META_TTL_DAYS` in `.env.example`, both compose files and
      `docs/configuration.md`, next to a short section on what a granted root is and what
      removing a library does and does not do.
- [x] Verification: `tsc`, 453 server tests, 176 web tests, and both Playwright suites in the
      CI image on the rebased head (244 passed, 23 skipped; the fullscreen idle-hide case in
      `layout/player.spec.ts` is flaky there, exactly as it is on `main`). The local Docker
      stack was built and driven through the new endpoints: a library whose root is away comes
      up `unreachable`, is skipped by the walk and the sweep, and keeps its metadata and
      thumbnails -- the same backdated orphan, with the root back, is deleted by the very next
      sweep. A read-only mount is probed `readOnly`, keeps `writeArtwork` off and lands its
      thumbnail in `data/artwork/<id>/` even with the artwork setting on `media`, while a
      writable library under that setting writes the poster beside the media. Revoking a grant
      disables the library and leaves its metadata, artwork and media in place.
- [x] Follow-up found by using the feature: the picker can name a folder that does not exist
      yet. The name is taken inside the browsed folder, the selection becomes that path and the
      create request carries `create: true`, so `checkLibraryRoot` makes the folder inside the
      grant -- the option PR 3 already had and nothing sent. A cancelled flow leaves nothing on
      disk, and nothing is pre-created: the directory appears with the library. The estimate is
      skipped while the folder is pending, the library name defaults to it, a name with a slash
      is refused in the picker, and re-root keeps offering only folders that exist. The write
      goes through `POST /api/libraries`, so it is denied in restricted mode with the rest of
      the admin routes. Covered by `web/src/LibraryManager.test.tsx` (the request body, and the
      ordinary pick still sending no `create`) and by `e2e/tests/library-admin.spec.ts`, which
      asserts the folder is absent before the library is added and present after.
- [x] Follow-up found in use: the global `Settings.artworkLocation` is retired and
      `writeArtwork` is the one control for where a poster goes. `artworkBesideMedia` takes no
      setting, `PATCH /api/settings` ignores the old key, the backup no longer carries it, and
      the Storage section says where the switch moved instead of offering a second answer to
      the same question. `retireArtworkLocation` in `library-migrate.ts` reads the old value
      once, keyed on the key still being in the file, and turns a library's `writeArtwork` off
      unless the install had asked for `"media"`; the value then leaves the state, so the pass
      runs once. Covered by `library-migrate.test.ts` (both directions, and a second start
      doing nothing) plus the updated `artwork.test.ts` and `backup.test.ts`.

### PR 4 — Library manager, root browse, cross-library move

- [x] `GET /api/library/browse` with an empty path lists the configured libraries as
      `kind: "library"` rows while more than one is configured, and still passes through to
      the single configured library, so a one-library install is untouched. The row carries
      the id, name, type, enabled flag, counts, reachability and the root's poster. A
      library that is switched off or away stays listed and says so: configured is what
      counts, and a browse root that changed shape when a drive spun down would be worse
      than a row with a warning. A disabled library's row shows zero counts because the
      walk skips it; the media is still on disk. Counts come from the walks the library
      listing already holds, so opening the root does not walk the tree again. The
      `err.libraryRootAmbiguous` answer from PR 3 is gone, and so is the 500 an install
      with no library left would have raised.
- [x] The interface renders those `kind: "library"` rows: name, type, counts, a disabled
      or unreachable warning, the root's poster, and the open action. Clicking one opens it
      (a disabled row is not clickable). Breadcrumb segment zero is resolved through the
      library list, so an id is never shown. The sort, direction, favourite, tile and filter
      controls are hidden while the library list is on screen: none of them applies to a
      handful of rows. The root list, the breadcrumbs and the pass-through are covered in
      `e2e/tests/library-admin.spec.ts`; the layout baselines keep running against a
      single-library install, so they are unchanged.
- [x] The library manager: a settings section plus the same panel behind the library tools,
      with add, rename, type, enable, the artwork-writing switch, re-root, remove,
      remove-and-forget and scan this library. Add walks the granted roots, grants a folder
      typed by hand when the deployment has no native dialog, shows the estimate before
      anything is written and offers "scan metadata now". Re-root patches the root and lets
      the probe decide `writeArtwork` again. A user grant can be revoked from the picker;
      the libraries under it are disabled and nothing is deleted. An operator grant is not
      revocable from the interface, and `GET /api/libraries/browse` now says where each grant
      came from so a folder can be told apart from one an operator mounted. Restricted mode
      renders the list without a single control -- the API would refuse every one of them.
      Covered by `e2e/tests/library-admin.spec.ts` (manager dialog, picker, estimate, rename,
      the disabled row) and the settings part of `e2e/tests/restricted.spec.ts`.
- [x] The cross-library move (§10). `POST /api/library/move` takes a destination in another
      library: the type gate refuses a film into a `series` library and the reverse with
      `err.libraryTypeMismatch`, with the kind taken from the item's binding and otherwise from
      the source library's units; a `mixed` destination takes anything, and so does a unit
      nobody can type. `LibraryMetaStore.relocate` carries the bindings across, writing both
      files in one call, with the destination's own path winning on a collision. The thumbnails
      move between `data/artwork/<id>/` directories and the cache index follows them, so the
      ceiling keeps counting real bytes. `pruneEmptiedFolders` runs on the source library only.
      An existing name at the destination fails with `err.nameTaken` -- no `(2)` suffixing. The
      move dialog offers the libraries that take this kind of title and walks the picked one's
      own tree, and the browse rows now carry the bound kind so it can decide. Covered by the
      store and artwork-cache unit tests and by `e2e/tests/library-move.spec.ts`, which also
      checks the bytes on disk and that the emptied folder went with them.
- [x] Follow-up from PR 1: `e2e/tests/layout/screenshots.spec.ts` drops the diagnostics
      report chip before the settings screenshot. The chip is per-run noise inside a masked
      section, but its width decided whether the header wrapped at the narrow viewports, so
      the baseline used to match only when the recorded run happened to report three digits.
      The chip is removed from the DOM after the settings page settles and before the
      screenshot is taken; the diagnostics section remains masked as before.

### PR 5 — Operations queue and bulk selection

- [x] `LibraryOps`: durable serial jobs in `data/library-ops.json`, restart recovery,
      queued requests, per-item results, continue-on-error, cancellation after the current
      item, a 500-item cap and byte progress. Waiting is represented as `paused/queue`
      because the published state union has no separate queued status.
- [x] Safe transfer path: same-device moves use `rename`; copy and cross-device move write
      a sibling `.part` tree, fsync every file, rename it into place, and only then remove a
      move source. A failed attempt removes its staging tree and nested symbolic links are
      refused rather than followed outside the guarded library path.
- [x] `/api/library/ops` snapshot/start/cancel, `/api/library/folder`, copy, and shared
      implementations behind the existing single favorite, delete, match and move routes.
      Copy duplicates path metadata; move carries metadata and artwork as before. Jobs pause
      for affected playback, an active download writing under the destination, and an
      unavailable library. A running metadata scan pauses while an operation writes.
- [x] Browse selection mode with per-row controls and a sticky action bar for move, copy,
      delete, favorite, bind/unbind, lookup exclusion, artwork regeneration and clearing
      watched progress. The destination and identify dialogs accept a selection as one job.
      The library polls active work, shows item/byte progress, pause reason and cancel, and
      refreshes browse and progress state on completion. Folder creation is in library tools.
- [x] Unit coverage for durability, serial execution, failure continuation, unfinished-job
      retention, staged copies, same-device moves, metadata copies, bulk destination picking
      and bulk matching. `library-bulk.spec.ts` selects three files, removes one before submit,
      and proves the other two finish while the failed row is recorded.

### PR 6 — Per-library addon save rules, backup, documentation

- [x] `DownloadTargetSettings.libraryId` end to end: the editor offers the libraries that take
      the kind, with **Default** naming the library marked as that kind's default and the path
      preview showing the chosen library's own root instead of a hardcoded `/downloads`
      (desktop readiness). Validation is one place, `normalizeDownloadSettings(value,
      libraries)`: unknown id, a library that does not take the kind, or one that is switched
      off, read-only or away is an `AppError` with a catalogue key, thrown before anything is
      written.
- [x] The queue resolves the rule's library when a job starts and stores the **qualified**
      target, so the finished file, its metadata, its artwork and the interface's "show in
      library" all work off one kind of path. A library that cannot be written to right now
      **pauses** the job (`pauseReason: "library"`) instead of redirecting it, the queue keeps
      running the other jobs, and the paused ones resume by themselves when the library is
      back. A rule naming a library whose record is gone falls back to the default and logs
      one line -- see *When a library stops being available*.
- [x] Backup version 2 carries the libraries' names and roots and the import maps every
      reference -- the two defaults in the settings blob and each addon's rules -- by root
      first, then by name and type, clearing what it cannot match and reporting the count.
      Version 1 still imports.
- [x] The user documentation: [libraries.md](libraries.md) covers what a library is, the
      types, the per-library switches, what an unreachable or read-only root does, removing
      against disabling, where the state lives, and the split of the download directory --
      *split from inside* as the supported route and *re-root* with the warning that it moves
      no files. Linked from the README and from the configuration reference, which is where
      an operator looks for `LIBRARY_ROOTS`.
- [x] Review follow-up (LIBRARY_REVIEW.md point 2): a library removed without `forget` leaves
      `{ id, root, removedAt }` in `state.departed`, and a folder added again at the same root
      takes that id back, so the match history, the artwork and the favorite and resume rows
      are live again instead of stranded. Matching is `realpath` on both sides with the
      literal path as a fallback, the list keeps the newest 20 entries and drops anything
      older than 30 days, and `?forget=1` drops the note with the rest.

## Overview

Today the product has exactly one library: the tree under `DOWNLOAD_DIR`
(`/downloads`). Every stored identity — `libraryMeta`, `librarySuggestions`,
`favorites`, `progress`, artwork file names, download job targets, `file://`
stream URLs — is a path relative to that one root. Movie vs series is inferred
from directory structure, which is the right default for a mixed dump but wrong
for someone who keeps films and shows apart on purpose, and impossible for
someone whose media sits on two different disks.

This design introduces **libraries**: named roots with a declared type
(`movie`, `series`, `mixed`), managed from the interface, addressable in the API,
selectable per addon save rule, and able to hand items to one another. It also
does the groundwork that makes the rest of the feature affordable — a qualified
path format, library metadata out of `state.json`, bounded and expiring caches,
a durable operations queue for bulk work, and the small set of changes that keep
a future desktop build from needing a second rewrite.

This supersedes the *Plex-like separate movie / TV libraries* rejection in
[library-metadata.md](library-metadata.md#alternatives-considered). The reason
for that rejection — "the product is a filesystem browser, not a media server" —
still holds for **inference**: a `mixed` library keeps inferring exactly as it
does now, and a typed library declares its type instead of guessing. No media
server semantics (agents, per-library scanners, ratings) are introduced.

## Background & Motivation

### Current state

- `DOWNLOAD_DIR` is read once in `server/src/index.ts:607` and passed to every
  library call site. Roughly forty call sites in `index.ts` alone.
- A path is `string`, relative to that root, separated by `path.sep`, and is used
  as a **key**: `libraryMeta[relative]`, `favorites[]`, `progress["file:"+relative]`,
  `dataArtworkFile(relative)` / `dataArtworkFile("dir:"+relative)`, scan state,
  `file://<relative>` in `mediaResources`.
- Ancestor inheritance (`knownTitleOf`, `lookupSkipped`, `suggestionFor`,
  `pinInherited`) walks `relative.split(path.sep)` upwards and stops at the first
  segment.
- Kind is inferred per title unit by `titleUnits()` in `library-match.ts`
  (season-named children, a majority of `SxxExx` direct videos, unique
  non-extra titles).
- Addon save rules (`AddonDownloadSettings`) carry `{ subfolder, layout }` per
  `movie` / `series`. The subfolder is always relative to the one root.
- `libraryMeta`, `librarySuggestions` and `libraryEpisodes` live in `state.json`,
  which `Store.update()` re-serialises **in full** on every write.
- `data/artwork` is swept for orphans every ten minutes; it has no size cap and
  no age policy. `data/images` (the secure-mode proxy) has a byte cap with LRU
  eviction but no TTL.
- File operations are one item at a time, synchronous inside the request:
  rename, move into a folder, delete. There is no copy, no new folder, no
  multi-select.

### Pain

1. One root. Two mounts, or films and shows on different volumes, cannot be
   expressed at all.
2. Inference is the only classifier. A film folder with `01 serie` inside it
   becomes a series; a show whose episodes are loose files becomes a collection
   and is skipped by the scanner.
3. An addon cannot say "save this one somewhere else"; only a subfolder of the
   single root.
4. Moving a title between two parts of the tree is possible, but nothing knows
   the two parts mean different things.
5. `state.json` grows with the library and is rewritten whole on every
   favourite, every progress ping, every scan accept.
6. Thumbnails accumulate without a ceiling; the only pressure is the orphan
   sweep.
7. Bulk work (identify twenty folders, move a season, delete a batch) is a
   click-per-item loop that the browser drives.
8. Everything assumes Linux paths under `/downloads`, including copy in the
   client. A desktop build would have to touch every one of those places.

## Goals & Non-Goals

### Goals

- Several libraries, each with a name, a root, and a type (`movie`, `series`,
  `mixed`); managed from the interface, including under Docker.
- A root may be any granted location, including another disk. On desktop the
  grant comes from the OS folder picker, under Docker from the mounts.
- An existing media folder can be added as a library and have its metadata
  scanned, without a single file being moved, renamed or overwritten.
- Type drives classification, scan, and which addon rules may target it. `mixed`
  keeps today's inference exactly.
- Items move between libraries: mixed → movie, mixed → series, movie → mixed,
  series → mixed, and between two libraries of the same type. Metadata,
  favourites, progress and artwork travel with the item.
- Addon save rules pick a library per kind, offered only libraries of the
  matching type or `mixed`.
- Richer file and folder operations: create folder, copy, move, rename, delete —
  and the same set as a **bulk** operation over a multi-selection, run by a
  durable queue instead of the request thread.
- Library metadata out of `state.json`, one file per library.
- Thumbnail and image caches gain a ceiling and an expiry policy; a removed
  library drops its cached artwork in one step.
- The codebase stops assuming one Linux root, so a desktop build is a packaging
  job rather than a refactor.

### Non-Goals

- No media-server semantics: no per-library metadata agents, no ratings, no
  collections-as-entities, no watch-state sync.
- No second identity system. Metadata keeps coming from installed Stremio
  catalog/meta addons (Key Decision 1 of [library-metadata.md](library-metadata.md)).
- No network libraries beyond what the host already mounts. The server never
  mounts, unmounts, or speaks SMB/NFS itself.
- No pattern/batch **rename** in v1 (bulk rename is left out; the op shape
  allows adding it later).
- No per-library users or permissions. Profiles remain a separate roadmap item.
- The desktop build itself is not in scope — only the code changes that keep it
  from being blocked.

## Proposed Design

### 1. Vocabulary

- **Library** — a named root directory with a type. Identified by an opaque id.
- **Qualified path** — how every path is addressed on the wire and in storage:
  `<libraryId>/<relative>`, with `/` as the separator, `<libraryId>` alone
  meaning the library root.
- **Virtual path** — the existing `:favorites` / `:resume` pseudo-locations.
  They are unqualified and span libraries. Unchanged.
- **Title unit** — unchanged meaning from
  [library-metadata.md](library-metadata.md#title-units-what-gets-matched); the
  library type now constrains its kind.

### 2. Data model

New in `state.json`:

```ts
export type LibraryType = "movie" | "series" | "mixed";

export interface LibraryRecord {
  /** `lib_` + 8 lowercase hex. Never reused, never derived from the path. */
  id: string;
  name: string;
  type: LibraryType;
  /** Absolute path as the server sees it. Inside a granted root (see §4). */
  root: string;
  enabled: boolean;
  /** Display and pick order. */
  order: number;
  addedAt: string;
  /** Root was not writable at the last check. Excluded from save rules, move and
   *  copy destinations, and every ops job that writes. Never auto-removed. */
  readOnly?: boolean;
  /** May we drop poster.jpg next to the media here? Default true; forced false and
   *  locked in the UI when readOnly. The one control for this question (§6); the
   *  global `artworkLocation` it used to answer to is retired. */
  writeArtwork: boolean;
  /** Root could not be reached at the last check. Skipped by scan, sweep, autoscan
   *  and ops; metadata and artwork are kept untouched. */
  unreachable?: boolean;
}
```

and in `Settings`:

```ts
  /** Where a download lands when the addon rule names no library. Falls back to
   *  the first enabled library of the matching type, then to the first `mixed`. */
  defaultMovieLibrary: string;
  defaultSeriesLibrary: string;
```

`AddonDownloadSettings` gains a library per kind:

```ts
export interface DownloadTargetSettings { libraryId: string; subfolder: string; layout: DownloadLayout }
```

An empty `libraryId` means "use the default for this kind". That is also the
migration value, so an untouched addon keeps working.

### 3. Qualified paths and the POSIX wire rule

Add `server/src/libraries.ts`:

```ts
export const LIBRARY_ID = /^lib_[0-9a-f]{8}$/;

export interface ResolvedPath { library: LibraryRecord; relative: string; absolute: string }

/** "lib_ab12cd34/Show/01 serie/01.mkv" -> { libraryId, relative } (relative may be ""). */
export function parseLibraryPath(value: string): { libraryId: string; relative: string } | undefined;

/** The inverse. `relative` is POSIX; "" yields the library root path. */
export function libraryPath(libraryId: string, relative: string): string;

/** Resolve, guard, and return the absolute filesystem path.
 *  Refuses: unknown/disabled library, traversal out of the root, a dot segment,
 *  and (after realpath) a symlink pointing outside the root. */
export function resolveLibraryPath(libraries: LibraryRecord[], value: string): Promise<ResolvedPath | undefined>;

/** Relative paths inside `library` that are the root of another library (§4). */
export function carveOuts(libraries: LibraryRecord[], library: LibraryRecord): string[];

export function libraryFor(libraries: LibraryRecord[], id: string): LibraryRecord | undefined;
export function defaultLibrary(libraries: LibraryRecord[], settings: Settings, kind: "movie" | "episode"): LibraryRecord | undefined;
```

**The wire rule, and the single most important desktop-readiness change:**

> Every path that crosses a module boundary — an API payload, a state key, a log
> field, an artwork cache key — uses `/`. Conversion to and from `path.sep`
> happens only where the filesystem is actually touched.

Today `library.ts` and `library-match.ts` build keys with `path.join` and split
them with `path.sep`, so on Windows the stored key would contain `\` while the
client splits on `/`. Introduce and use two helpers in `libraries.ts`:

```ts
export const toPosix = (value: string) => value.split(path.sep).join("/");
export const toFs = (value: string) => value.split("/").join(path.sep);
```

Rewrite `library.ts` and `library-match.ts` to work in POSIX internally
(`split("/")`, `join("/")`), converting with `toFs` at each `readdir` / `stat` /
`rename` / `rm`. On Linux this is a no-op; it is what makes the desktop build a
packaging job.

**Why the library id is the first path segment.** Ancestor inheritance
(`knownTitleOf`, `lookupSkipped`, `suggestionFor`, `coveringKey`,
`pinInherited`), `isPathWithin`, `remapPath`, `remapKeyed` and `dropKeyed` all
walk or compare path segments. With the id as segment zero they keep working
unchanged, a binding never leaks across libraries, and a cross-library move is
the same `remapKeyed(from, to)` a same-library move already is. Do not invent a
second separator (`libId:relative`); it would fork every one of those functions.

### 4. Roots: where a library may point

A library root is any absolute path the deployment has **granted**. The grant
list is not a browsing convenience; it is the boundary of what this HTTP service
can read. Without it, "a root is any absolute path" plus an authenticated
session means the API can read anything on the host — today that is bounded by
`/downloads`, and the bound must survive.

Who may grant depends on the deployment; the enforcement does not:

| Deployment | Who grants | How |
| --- | --- | --- |
| Docker / server | the operator | `LIBRARY_ROOTS`, a comma-separated list of absolute paths (the mounts). Default: the value of `DOWNLOAD_DIR`. |
| Desktop | the person at the keyboard | the OS-native folder picker returns a path, which the app records in a persistent grant list. |

```ts
/** Operator-provided ∪ user-granted. A root must be inside one of these. */
export interface RootGrant { path: string; source: "env" | "user"; grantedAt: string }
```

`env` grants are rebuilt from `LIBRARY_ROOTS` on every boot and are not
persisted. `user` grants live in `state.json` and are revocable from the
interface; revoking one disables (never deletes) the libraries under it.

**Under Docker** the bases are the mounts, so the common case — several
libraries in one already-mounted tree — needs no compose change at all:

```
/downloads/Movies      -> library "Films"   (movie)
/downloads/Series      -> library "Shows"   (series)
/downloads             -> library "Inbox"   (mixed, legacy root)
```

A second disk is one more mount plus one more entry:

```yaml
volumes:
  - "${DOWNLOAD_PATH:-./downloads}:/downloads"
  - "${ARCHIVE_PATH:-./archive}:/libraries/archive"
environment:
  LIBRARY_ROOTS: "/downloads,/libraries/archive"
```

**On desktop** there is no env var to edit and no mount to add. The user picks
`D:\Media\Filmy` or `/Volumes/Archiv` in the native dialog; the app records the
grant and creates the library. A library may therefore sit on any disk, and two
libraries need not share anything. The API keeps refusing everything outside the
grant list, so a stolen session cookie or a hostile addon still cannot reach
`~/.ssh`.

**Picker API.** `GET /api/libraries/browse?path=` lists the granted roots when
`path` is empty, and the child directories of `path` when it is inside one. Per
row: name, absolute path, writable, and whether it already is (or is inside) a
library. It never follows a symlink out of a grant. `POST /api/libraries` may
`mkdir` a missing directory (`create: true`) inside a grant only.

This endpoint exists for deployments with no native dialog. A desktop build uses
the OS picker instead and never calls it — which is both better UX and less API
surface, since this is the one endpoint that discloses host directory names.
Deny it, and the grant endpoints, in restricted mode.

**Nesting.** Two libraries may not share a root, and a root may not be a file.
A root **may** sit inside another library's root; the child is then **carved
out** of the parent — the parent never walks, lists, matches, sweeps or prunes
it. This is what makes the legacy `/downloads` install splittable without moving
anything first, and it makes a split a plain `rename` on the same filesystem.

Carve-outs must be honoured in: `listVideos`, `browseDirectory`, `listFolders`,
`emptiedFolders`, `describePath`, `matchKeyFor`/`titleUnits` (they only see
carved file lists, so passing a filtered `FoundFile[]` is enough), and
`pruneEmptiedFolders`. Give `listVideos`, `browseDirectory`, `listFolders` and
`emptiedFolders` an `exclude?: ReadonlySet<string>` of POSIX-relative paths and
pass `carveOuts()` at every call site in `index.ts`.

### 5. Library types

`titleUnits(files, type)` gains the library type. Unit **boundaries** (grouping
folder recursion, collections, extras) do not change; only the **kind** does:

- `mixed` — today's behaviour verbatim. `classifyFolder` / `classifyVideosOnly`
  unchanged.
- `series` — every emitted unit is `series`. Season folders and `SxxExx` still
  drive episode numbering; they no longer drive the decision. A loose video at a
  container level is a `series` unit of one file.
- `movie` — every emitted unit is `movie`. A season-named child no longer turns
  a folder into a series; its files still belong to the folder's unit.

Consequences, all small:

- `LibraryScan` calls `searchAll(addons, query, type)` with the library type for
  a typed library (unchanged `undefined` for `mixed`), and passes the same value
  as `expectedKind` to `scoreHit`, so a cross-type hit is penalised and never
  auto-accepted. This is existing machinery (`library-match.ts`), not new code.
- `browseMeta` keeps deciding episode-vs-title from the **binding** type, not the
  library type, so a mis-typed library degrades to "no episode text", never to a
  wrong text.
- Identify may still bind a title whose type differs from the library's. The
  interface warns; it does not refuse. The user knows what they have.

### 6. Adding an existing folder

Pointing a library at a tree that already holds media is the common case, not an
edge one — [library-metadata.md](library-metadata.md) opens by observing that
`DOWNLOAD_PATH` usually points at exactly that. Adding a library differs from
today only in that the user chooses the tree instead of it being fixed.

**Nothing on disk is touched.** Adding writes a `LibraryRecord`. No move, no
rename, no reorganisation, ever — Key Decision 10 of
[library-metadata.md](library-metadata.md) ("Identify does not rename on disk")
extends to the whole add flow. The scan reads file *names*, never file contents.

**Estimate before committing.** `titleUnits()` over `listVideos()` is pure and
makes no addon call, so the add dialog reports "412 titles found, 0 identified"
before the user confirms. Cheap, and it is what makes the next point credible.

**Scan scoped to the library.** `LibraryScan.start({ path })` already narrows a
run to a subtree via `isPathWithin` (`server/src/library-scan.ts`). With
qualified paths the library id *is* that prefix, so `start({ libraryId })` is a
filter over the unit list, not new machinery. The add dialog offers **Scan
metadata now**, checked by default, and links to the running job.

**Say what it costs.** At the default `gapMs` of 3000 an unmatched title takes
about five seconds, so 200 titles is 10–20 minutes and a 2000-title archive is
two to three hours. The job is durable, resumable, pausable and cancellable, but
the dialog must state the estimate up front or it reads as a hang. Re-runs are
cheap: skips do not sleep, and `scannedRecently` remembers a fruitless search
for 30 days.

**Typing the library at add time is what makes the scan good.** An existing
`Films` tree added as `movie` searches movie catalogues only and penalises
series hits through the `expectedKind` argument `scoreHit` already takes. This
is the strongest practical argument for typed libraries: today's inference is at
its worst on exactly this input, a curated tree full of `01 serie` folders and
loose numbered files.

**Somebody else's curation wins.** `findArtwork` honours `POSTER_NAMES`, so a
folder maintained for Jellyfin keeps its `poster.jpg` and `folder.jpg` even
after a successful match. Reading `.nfo` sidecars stays deferred
([library-metadata.md](library-metadata.md#alternatives-considered)); do not let
the add dialog imply otherwise.

Three consequences that only surface once a tree can be added:

1. **The autoscan fingerprint must be per library.** `LibraryAutoScan` holds a
   single `this.fingerprint` over a global `libraryFiles()`. Adding a library
   would move that fingerprint and trigger a whole-tree scan; an unplugged disk
   would read as a mass deletion. Keep a fingerprint per library, check each
   independently, and **skip** — never rescan, never sweep — a library whose
   root is unreachable.
2. **A library may be one we must not write into.** An added tree can be a
   read-only mount, or simply one the user does not want us dropping
   `poster.jpg` into. `LibraryRecord` gains `writeArtwork: boolean` (default
   `true`, forced `false` and locked in the UI when the root is not writable):
   generated and catalogue artwork go to `data/artwork/<libraryId>/` instead of
   next to the media. It is the one control for that question — the global
   `artworkLocation` this slice still carried is retired under *Known gaps*. A
   `readOnly` library is also excluded from the addon save-rule picker,
   from the move/copy destination list, and from every ops job that writes.
3. **An unreachable root is normal operation, not an error.** With external
   disks in play this stops being an edge case. Such a library renders with a
   warning, is skipped by scan, sweep, autoscan and ops, and is **never**
   auto-removed; its metadata file and its artwork directory stay untouched
   until the user removes the library explicitly.

`readOnly` and `unreachable` are probed, not declared: on create, on re-root, at
the start of a scan, sweep or ops job, and on `GET /api/libraries`. Two
constraints make the probe its own small problem rather than a `stat` call:

- **It must not block.** `stat` on a dead NFS or SMB mount can hang for the mount
  timeout, and `GET /api/libraries` is on the browse path. Probe with an explicit
  timeout (2 s) and treat the timeout itself as `unreachable`.
- **It must be cached.** The library view polls; probing per request would stat a
  sick mount every couple of seconds. Cache the result for 30 s, and invalidate
  it when an operation against that library fails on I/O — a failing write is a
  better signal than the next scheduled probe.

Writability is checked the same way and with the same cache, by creating and
removing a dot-file rather than reading the mode bits, because a read-only mount,
a wrong `PUID`, and an ACL all fail differently.

### 7. Metadata storage

Move library-keyed maps out of `state.json` into `data/library/<libraryId>.json`:

```jsonc
{
  "version": 1,
  "meta":        { "<relative>": LibraryMetaRecord },
  "suggestions": { "<relative>": LibrarySuggestion }
}
```

Keys inside the file are **library-relative** (no `lib_…/` prefix), so a file
stays valid if a library is ever re-identified, and the file is readable on its
own. `LibraryMetaStore` re-qualifies on read.

`libraryEpisodes` is keyed by `type:id:season:episode`, not by path, so it is
shared across libraries: move it to `data/library/episodes.json`.

Rows orphaned by a deleted library are **kept**, deliberately. Nothing prunes
`libraryEpisodes` today either, the rows are small and capped per title
(`MAX_EPISODES`), and they are keyed by catalogue identity — so a library that is
removed and re-added, or a second library holding the same show, reuses them
instead of asking the addon again. Deleting a library therefore removes its
`data/library/<id>.json` and its artwork directory, and touches this file not at
all.

```ts
export class LibraryMetaStore {
  load(): Promise<void>;
  meta(libraryId: string): Record<string, LibraryMetaRecord>;        // relative keys
  suggestions(libraryId: string): Record<string, LibrarySuggestion>;
  episodes(): Record<string, LibraryEpisodeRecord>;
  /** Qualified-path view, what `index.ts` consumes today. */
  qualifiedMeta(): Record<string, LibraryMetaRecord>;
  update(libraryId: string, mutator): Promise<void>;   // debounced, atomic tmp+rename, per file
  forget(libraryId: string): Promise<void>;            // deletes the file
}
```

Rules:

- Writes are debounced (2 s, same shape as `ImageProxy.save()`), atomic
  (`tmp` + `rename`, mode `0o600`) and **per library**, so one accepted match no
  longer re-serialises the whole application state.
- `flush()` on shutdown, and before `GET /api/settings/export`.
- `qualifiedMeta()` is memoised and invalidated on write; it is called per browse
  row today (`attachBrowseMeta`), so it must not rebuild the map each time.
- `state.json` keeps `addons`, `settings`, `auth`, `favorites`, `watchlist`,
  `progress`, `libraries`. Those are bounded by user actions, not by library size.

**Metadata freshness.** `LibraryMetaRecord` keeps `backfilledAt` (fills missing
fields, 7-day TTL). Add:

```ts
  /** Last full refresh of the binding against the catalogue. */
  refreshedAt?: string;
```

A bound `series` whose `refreshedAt` is older than `LIBRARY_META_TTL_DAYS`
(default 14) is re-fetched by the scan job — one `metadata()` call, the same
`gapMs` pacing, only for libraries browsed since the last run. This is what
keeps episode titles current and is the plumbing *Follow show* will reuse. A
`movie` binding is refreshed only when fields are missing, as today.

### 8. Artwork and image caches

**Layout.** `data/artwork/<libraryId>/<sha1(relative or "dir:"+relative)>.jpg`.
Deleting a library becomes `rm -r data/artwork/<libraryId>`. `dataArtworkFile()`
takes the qualified path and splits it; nothing else changes.

**Ceiling and expiry.** `data/artwork` gets the same treatment `data/images`
already has:

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARTWORK_CACHE_MB` | `256` | Disk generated thumbnails may take before the least recently served are dropped. |
| `IMAGE_CACHE_TTL_DAYS` | `0` | Age at which a cached addon image is dropped even when the cache is under its cap. `0` keeps the current cap-only behaviour. |
| `LIBRARY_META_TTL_DAYS` | `14` | Age at which a bound series binding is refreshed by the scan. |

- Keep a small `data/artwork/index.json` (`{ file: { bytes, at } }`) updated when
  a thumbnail is written and when `/api/library/thumb` serves it (throttled: at
  most one index write per 2 s, same debounce as elsewhere).
- Eviction: oldest `at` first, down to 80 % of the cap — mirror
  `ImageProxy.evict()` rather than inventing a second policy.
- The orphan sweep stays as it is (it is correctness, not pressure), now scoped
  per library and skipping libraries that are disabled or whose root cannot be
  **read** — **never delete thumbnails because a mount is down**. Guard with an
  explicit root-readable check before sweeping a library.
  `readOnly` must **not** skip the sweep: it describes the media root, while the
  thumbnails being swept live in `data/artwork/<libraryId>/`, which is writable
  either way. A read-only root can still be enumerated, so `valid` is computable
  and the sweep is safe — and skipping it would let orphans grow without bound in
  exactly the common case, an added read-only archive.
- `writeArtwork: false` (§6) redirects everything that would land next to the
  media into `data/artwork/<libraryId>/`. That covers a read-only mount and a
  tree the user curates elsewhere. `savePosterFromUrl`, `saveFrame` and
  `writeCatalogPoster` all consult it, and it is the only control: the global
  `artworkLocation` is retired, its value read once by the migration.
- A poster that lives next to the media (`POSTER_NAMES`, and everything we
  generate where `writeArtwork` allows it) is never evicted and never counted.
  Key Decision 7 of [library-metadata.md](library-metadata.md) stands.
- `ImageProxy`: add the TTL pass to `evict()`; drop bytes only, keep the id → URL
  row, exactly as the current eviction does.

### 9. Operations: single and bulk

Add `server/src/library-ops.ts`, modelled closely on `LibraryScan` (durable,
serial, snapshot endpoint, resumes after restart):

```ts
export type LibraryOp =
  | { op: "move";      items: string[]; target: string }          // target: qualified folder
  | { op: "copy";      items: string[]; target: string }
  | { op: "delete";    items: string[] }
  | { op: "favorite";  items: string[]; favorite: boolean }
  | { op: "match";     items: string[]; type: string; id: string } // bulk bind
  | { op: "unmatch";   items: string[] }
  | { op: "skipLookup";items: string[]; skipLookup: boolean }
  | { op: "artwork";   items: string[] }                           // regenerate thumbnails
  | { op: "forget";    items: string[] };                          // clear watched state

export interface OpsState {
  id: string; op: LibraryOp["op"]; status: "running" | "paused" | "completed" | "failed" | "cancelled";
  total: number; done: number; failed: number; bytes: number; bytesTotal: number;
  current?: string; startedAt: string; finishedAt?: string;
  results: Array<{ path: string; ok: boolean; to?: string; error?: string; errorKey?: string }>;
}
```

Rules:

- One job at a time; further requests queue. A job survives a restart the way
  the scan does (`data/library-ops.json`).
- Cheap and instant operations stay synchronous on their existing endpoints
  (single rename, single delete, favourite, create folder). The queue is for
  anything that moves bytes or touches more than one item. Reuse the existing
  endpoints internally so there is one implementation per operation.
- **Continue on error.** A failed item is recorded and the job moves on; the
  summary says how many failed and why.
- Pause while the affected file is being played (`playbackBusy()` already
  exists), and while a download is writing into the destination folder.
- Progress is polled by the client on the existing cadence; the browse list
  refreshes when the job completes.
- Cap: 500 items per job. Above it, `err.tooManyItems`.
- Every item path goes through `resolveLibraryPath` — a job is not a shortcut
  past the traversal guard.

**Copy vs move.** Same filesystem (`stat().dev` equal) → `rename`, instant.
Different filesystem → stream copy to `<target>.part`, `fsync`, `rename`, then
unlink the source for a move. Report bytes so a 40 GB cross-mount move has a
progress bar instead of a spinner. Never delete the source before the
destination is fsynced and renamed.

**New operations to expose:** create folder (`POST /api/library/folder`), copy,
and "move to library" (§10). Rename stays single-item.

### 10. Moving between libraries

`POST /api/library/move` (and the `move` / `copy` ops) take a **qualified**
target, which may be another library's root or any folder inside it. Rules:

1. **Type gate.** A unit whose kind is `series` may not land in a `movie`
   library, and the reverse; `mixed` accepts anything, and anything accepts a
   unit from `mixed`. Kind comes from the binding when there is one, otherwise
   from the source library's `titleUnits`. Refusal is
   `err.libraryTypeMismatch`, and the move dialog does not offer the library in
   the first place — the server check is the backstop, not the UX.
2. **Identity travels.** `pinInherited()` is already the mechanism that turns an
   inherited binding into an owned one before a move; it works unchanged across
   libraries because the id is segment zero. Then `remapKeyed` /
   `remapPath` over `libraryMeta`, `librarySuggestions`, `favorites` and
   `progress`, exactly as `relocateLibraryPath` does today — but the metadata
   write now spans **two** files, so `relocateLibraryPath` moves into
   `LibraryMetaStore` as a single `relocate(from, to)` that writes both.
3. **Artwork travels.** `relocateArtwork` re-keys hashed thumbnails; with the
   per-library directory it also moves them between directories. A poster living
   next to the media moves with the folder for free.
4. **Emptied folders.** `pruneEmptiedFolders` runs on the source library only,
   honouring its carve-outs, and never deletes the library root itself.
5. **Collisions.** An existing name at the destination fails that item with
   `err.nameTaken`. No silent `(2)` suffixing for a move; the download queue's
   `joinTarget` copy counter is for new files, not for user moves.

### 11. Addon save rules

- `DownloadTargetSettings.libraryId` is offered in the addon storage editor as a
  select listing only libraries whose type matches the kind (`movie` rule →
  `movie` and `mixed` libraries; `series` rule → `series` and `mixed`), plus a
  "Default" entry meaning `""`. `readOnly`, disabled and unreachable libraries
  are not offered.
- The path preview stops hardcoding `/downloads` in `web/src/App.tsx` and shows
  the chosen library's name and root, which is also a desktop-readiness fix.
- `PATCH /api/addons/:key` validates: unknown id, disabled or `readOnly`
  library, or a type mismatch → `AppError` with a catalogue key. `normalizeDownloadSettings()` in
  `naming.ts` gains the library argument so validation lives in one place.
- **Backup import** is the lenient path: a rule naming a library this instance
  does not have falls back to `""` (default) and the response reports how many
  rules were remapped, so a backup from another machine restores instead of
  failing. Log one line per remap.
- `targetPath()` keeps returning a library-relative directory. The download
  queue resolves `libraryId` → root once, when the job starts, and stores the
  **qualified** target on the job so `rememberTitle` / `saveCatalogPoster` /
  `queue.onCompleted` keep working with one kind of path.

### 12. Interface

**Browse root.** `GET /api/library/browse?path=` with an empty path returns the
libraries as rows of `kind: "library"` carrying `{ libraryId, name, type,
fileCount, size, poster, unreachable? }`. Two exceptions that keep the common
case unchanged:

- With exactly one **configured** library the root browse transparently returns
  that library's contents, and the breadcrumb shows the library name instead of
  "Library". A single-library install must look and behave exactly as today —
  this is also what keeps the layout screenshots in
  `e2e/tests/layout/__screenshots__` meaningful.
  Configured, not enabled and not reachable: a second library that is switched
  off or whose disk is unplugged is still a deliberate part of the setup, and a
  browse root that silently changed shape when a drive spun down would be worse
  than one extra click. Two libraries means the list, always.
- `:favorites` and `:resume` span libraries and stay unqualified. Entries whose
  library is disabled or unreachable are **omitted** from those listings rather
  than rendered as dead rows — `describePath` cannot stat them anyway — and they
  come back when the library does. Nothing is removed from `favorites` or
  `progress`.
- A library whose root is unreachable (unplugged disk, dead mount) renders as a
  row with a warning and is skipped by scan, sweep and ops. It is never
  auto-removed and its metadata is never dropped.

**Breadcrumbs** resolve segment zero through the library list the client already
holds; they never show `lib_ab12cd34`.

**Library manager.** A new Settings section *Libraries*, and the same panel
reachable from the library tools menu. Per row: name, type badge, root, counts,
enabled switch, default-for-type markers, and a warning when the root is
unreachable or read-only. Actions: add, rename, change type, re-root, remove,
scan this library.

- **Add** picks a location (native dialog on desktop, the picker of §4 on a
  server), takes a name and a type, shows the pre-scan estimate and the scan
  cost, and offers **Scan metadata now** checked by default — the flow of §6.

- **Change type** is allowed at any time. Changing `mixed` → typed re-classifies
  units at the next scan; existing bindings of the wrong type are kept but
  flagged in the row ("N titles of another type"). Typed → `mixed` is always
  safe.
- **Remove** never deletes media. Ask what to do with the remembered metadata:
  keep the file for a later re-add (default) or forget it. Removing also drops
  `data/artwork/<libraryId>`.
- **Re-root** is a metadata edit plus an optional move job when the user asks for
  the content to follow.

**Selection and bulk actions.** A *Select* toggle in the browse tools bar turns
rows into checkboxes:

- click toggles, shift-click extends a range, a header checkbox selects the
  loaded page, Esc leaves selection mode.
- a sticky action bar shows the count and the applicable actions: move, copy,
  delete, favourite, identify, mark unwatched, regenerate thumbnails.
- selection is scoped to the current folder and cleared on navigation.
- while a job runs, the bar shows its progress and a cancel button.

**Strings.** Every new string goes into `web/src/i18n/en.ts` and `cs.ts`
(`cs.ts` is typed against `en.ts`, so a forgotten key fails the build). Server
messages carry English text plus an `AppError` catalogue key. New keys at least:
`library.libraries`, `library.addLibrary`, `library.libraryType*`,
`library.rootPicker*`, `library.selectMode`, `library.bulk*`, `library.copy`,
`library.newFolder`, `library.moveToLibrary`, `library.unreachable`,
`addons.saveTo`, `err.libraryTypeMismatch`, `err.libraryRootNested`,
`err.libraryRootOutsideBase`, `err.tooManyItems`, `err.opCancelled`.

### 13. Desktop readiness

The following are cheap now and expensive later. Each is a hard requirement of
this work, not a nice-to-have:

1. **POSIX on the wire, `path.sep` at the syscall** (§3).
2. **No hardcoded roots.** `/downloads` disappears from `web/src` entirely; the
   server reports roots. `DATA_DIR` and `DOWNLOAD_DIR` keep their defaults but
   are read in one place each.
3. **Case-insensitive filesystems.** A rename that changes only case must not be
   refused by the `fileExists(target)` guard in `POST /api/library/rename`:
   compare the resolved paths, and treat a case-only change as legal.
4. **Windows-hostile names.** `safeName()` already strips `<>:"/\|?*` and control
   characters; add the reserved device names (`CON`, `PRN`, `AUX`, `NUL`,
   `COM1`–`COM9`, `LPT1`–`LPT9`) and a trailing-dot/space trim.
5. **Drive-letter and UNC roots.** Grant parsing must not split on a colon (use
   the comma only), and `resolveInside` must keep working for `C:\Users\…` and
   `\\server\share`. Add unit tests with those shapes; they are pure string work
   and run fine on Linux CI.
6. **No `realpath` identity assumptions.** Keep the symlink check, but compare
   with the platform's case sensitivity.
7. **Grants, not a config file, are how a desktop root arrives.** The shell hands
   the path from the OS picker to `POST /api/libraries/grants`; nothing else
   about libraries differs between deployments. Build the grant list as a
   first-class concept now, not as a `LIBRARY_ROOTS` special case, or the desktop
   build inherits an env var nobody can edit.
8. **One transport.** A desktop shell runs the same HTTP server. Do not add an
   IPC or a direct-filesystem path for the client; the folder picker is an API
   endpoint precisely so the desktop build reuses it.

## API / Interface Changes

| Method | Path | Change |
| --- | --- | --- |
| `GET` | `/api/libraries` | **New.** The library list with counts, sizes, type, default flags, reachability. |
| `POST` | `/api/libraries` | **New.** Create `{ name, type, root, create?, writeArtwork? }`. Validates the grant, nesting and writability. |
| `PATCH` | `/api/libraries/:id` | **New.** `{ name?, type?, enabled?, root?, order? }`. |
| `DELETE` | `/api/libraries/:id` | **New.** `?forget=1` also drops remembered metadata and artwork. Never touches media. |
| `GET` | `/api/libraries/browse` | **New.** Folder picker over the granted roots. Server deployments only; a desktop build uses the OS dialog. Denied in restricted mode. |
| `GET` | `/api/libraries/grants` | **New.** The granted roots, each with its source (`env` / `user`) and writability. |
| `POST` | `/api/libraries/grants` | **New.** Record a user grant (desktop; the path comes from the native picker). Denied in restricted mode. |
| `DELETE` | `/api/libraries/grants` | **New.** Revoke a user grant; libraries under it are disabled, never deleted. Denied in restricted mode. |
| `POST` | `/api/libraries/preview` | **New.** `titleUnits` over a candidate root: title count and how many are already identified, with no addon call (§6). |
| `GET` | `/api/library/browse` | Empty `path` lists libraries, or passes through when exactly one library is **configured** (§12 — not one enabled, not one reachable). Items may be `kind: "library"`. |
| `GET` | `/api/library` | Summaries gain `libraryId`; keys are qualified. |
| `POST` | `/api/library/move` | `folder` becomes a qualified target; cross-library moves allowed subject to §10. |
| `POST` | `/api/library/folder` | **New.** Create a folder at a qualified path. |
| `POST` | `/api/library/ops` | **New.** Start a bulk job; returns `{ id }`. |
| `GET` | `/api/library/ops` | **New.** Snapshot of the running/last job. |
| `POST` | `/api/library/ops/:id/cancel` | **New.** |
| `POST` | `/api/library/scan` | Accepts `{ libraryId }` alongside `{ path, force }` — the id is a path prefix, so this is a filter over the unit list. Scan state gains `libraryId`. |
| `PATCH` | `/api/addons/:key` | `downloadSettings[kind].libraryId` validated against type. |
| `GET/POST` | `/api/settings(/export\|/import)` | `defaultMovieLibrary` / `defaultSeriesLibrary`; backup gains a `libraries` array (see below). |

Every other library endpoint (`favorite`, `item`, `rename`, `identity`,
`match`, `suggestion`, `thumb`, `source`, `next`/`previous`, `resume`,
`favorites`, `entry`, `device-download`) keeps its shape and takes a **qualified**
path. They all funnel through `resolveLibraryPath` instead of
`resolveInside(DOWNLOAD_DIR, …)`.

**Backup.** `SettingsBackup` gains `libraries: Array<{ name, type, root }>` (no
ids — a backup restored elsewhere must not claim another instance's ids) and
import maps them by root, then by name, and falls back to the default for
anything unmatched. Bump `BACKUP_VERSION` to `2` and keep reading `1`.

Import must remap **every** id it restores, not just the addon rules:
`Settings.defaultMovieLibrary` and `defaultSeriesLibrary` travel inside the
`settings` blob and would otherwise arrive pointing at another instance's
libraries. Run them through the same resolution, and clear to `""` when
unmatched. `parseSettings` in `server/src/backup.ts` is where that belongs, so a
v1 backup (which has neither field) also lands on valid values.

## Data Model Changes & Migration

An existing install must come up on the new build with its match history,
favourites, watch positions, queue and thumbnails intact, and must look exactly
as it did before — one library, same tree, same browse root (§12, the
single-library pass-through). **No file on disk is moved or renamed by the
migration**; it rewrites keys in `DATA_PATH` only.

### Fresh install

No `state.json` at all is not a migration. `initialState` gains one library
(`root: DOWNLOAD_DIR`, `type: "mixed"`, `writeArtwork: true`) and
`schemaVersion: 2`, so a new install never runs migration code.

### Upgrade

`state.json` gains `schemaVersion: 2`. A state without it migrates once, **before
anything else reads it** — specifically before `store` is handed to any consumer
and before `libraryScan.load()`, `queue.load()` and `images.load()`, all of which
would otherwise parse unqualified paths. Order it explicitly in `index.ts`; a
migration that runs second is a migration that runs against half-loaded state.

0. Copy `state.json` to `state.json.v1.bak` before touching anything (see
   *Rollback* below). Skip the copy if the backup already exists.
1. Create one library: `{ id: lib_<random>, name: basename(DOWNLOAD_DIR) or "Library", type: "mixed", root: DOWNLOAD_DIR, enabled: true, order: 0, writeArtwork: true }`.
   `type` is `mixed` because that is what the tree has been classified as until
   now — migrating to a typed library would silently re-interpret it.
   Probe the root once for writability and reachability and set `readOnly` /
   `unreachable` accordingly; an unreachable root at migration time is not an
   error, the library simply comes up flagged.
2. Prefix every stored path key with `<id>/`, converting `path.sep` to `/`:
   `libraryMeta`, `librarySuggestions`, `favorites`, `progress` (both the
   `file:` key and the `path` field). `watchlist` and title-keyed `progress`
   entries are untouched — they are catalogue ids, not paths.
3. Move `libraryMeta` / `librarySuggestions` into `data/library/<id>.json`
   (library-relative keys) and `libraryEpisodes` into
   `data/library/episodes.json`.
4. Re-key `data/artwork/*.jpg` into `data/artwork/<id>/`. The file name is
   `sha1(key).jpg` with no index (`dataArtworkFile` in `server/src/index.ts`), so
   the old name cannot be inverted — build the mapping forward instead, and build
   it from **exactly the key shapes `sweepArtwork` considers valid**, or live
   thumbnails will be dropped on the floor:

   | Source | Key shape |
   | --- | --- |
   | each library entry (`libraryEntries()`, i.e. a top-level folder or a root-level file) | `entry.key`, hashed bare |
   | each video from one `listVideos(DOWNLOAD_DIR)` walk | the file path, hashed bare |
   | every **ancestor prefix** of each of those file paths | `dir:<prefix>`, hashed |
   | each queued download job target, read from `data/downloads.json` | the same two shapes as a file path |

   The ancestor row is the one that is easy to miss and expensive to get wrong:
   folder thumbnails are keyed `dir:<path>` for paths that appear in no
   `libraryMeta` key and in no `listVideos` result, because a folder is not a
   file and need not be bound to anything. `sweepArtwork`'s `remember()` walks
   those prefixes for precisely this reason; mirror it rather than reimplementing
   it. Queued jobs matter for the same reason they do in the sweep: a poster is
   saved when the job is queued, before the file exists.

   Anything still sitting directly in `data/artwork/` once the map is applied is
   by construction referenced by nothing — the map covers every key the sweep
   would have called valid — so **delete it, under the sweep's own one-hour
   freshness guard**. The migration has to finish this: after it, the sweep only
   looks inside `data/artwork/<libraryId>/` (§8), so a file left at the old root
   would never be collected by anything again. A failure here is not fatal; a
   missing thumbnail regenerates. Log how many were mapped, how many removed.
5. Rewrite `data/library-scan.json` paths, or reset it to idle when it is not
   running — a mid-scan migration may simply start over.
6. `AddonDownloadSettings[kind].libraryId = ""` (the default), and
   `defaultMovieLibrary` / `defaultSeriesLibrary` = the new library id.
7. Rewrite the download queue's stored job targets to qualified paths. A job
   interrupted mid-transfer resumes by Range against the same absolute file, so
   rewriting the stored target is enough — but the queue must load *after* this.
8. Write `state.json` once, atomically, then continue.

Nothing needs to be done about the autoscan baseline. `LibraryAutoScan` keeps its
fingerprint in memory only (`server/src/library-autoscan.ts`) — `remember()` is
called after a manual scan and nothing persists it — so **every** restart already
starts without a baseline and runs one check, as the comment in `check()` says
outright. An upgrade is just another restart. The check is cheap on a migrated
install because bound units are skips and skips do not sleep; on an unmatched one
it does what the user would have asked for anyway. Per-library fingerprints (§6)
are in-memory in exactly the same way.

The migrated root needs no grant of its own: `LIBRARY_ROOTS` defaults to
`DOWNLOAD_DIR`, so the legacy library is inside a granted root by construction.

### When a library stops being available

Four events point references at a library that is gone or no longer eligible:
**delete**, **disable**, **change type**, and **revoking the grant** its root sits
under (which disables, never deletes). Validation on `PATCH /api/addons/:key`
only covers the moment a rule is written; every one of these events happens
afterwards. Resolve them the same way each time, at **use** rather than by
rewriting stored rows, so a library that comes back needs no repair:

| Reference | On delete | On disable / unreachable | On type change |
| --- | --- | --- | --- |
| `defaultMovieLibrary` / `defaultSeriesLibrary` | cleared to `""`; `defaultLibrary()` then falls back to the first enabled library of the kind, then the first `mixed` | left pointing at it; the same fallback applies while it is away | cleared if the new type no longer matches the kind |
| `AddonDownloadSettings[kind].libraryId` | rewritten to `""` (= default) and logged, one line per addon | left as it is; the download resolves through the fallback for now | left as it is if still eligible (`mixed` always is), else rewritten to `""` and logged |
| Queued download jobs | jobs whose target resolves into it are **paused** with `pauseReason: "library"`, never failed and never silently redirected | same | unaffected; the type gate applies to placement, not to a job already placed |
| Running ops job | cancelled at the current item; completed items keep their results | paused, resumed when the library returns | unaffected |
| `favorites`, `progress`, `libraryMeta` | kept unless `?forget=1`; the metadata file and artwork directory go only on an explicit forget | kept, hidden from listings (§12) | kept |

Two rules behind that table:

- **Nothing is destroyed by absence.** A pulled disk, a revoked grant and a
  switched-off library are all recoverable states. Only an explicit
  `DELETE /api/libraries/:id?forget=1` removes remembered data.
- **A paused download is honest; a redirected one is not.** Sending a job to the
  fallback library because its real target vanished would scatter a season across
  two roots. Pause, say why, and let the user decide.

`"library"` is a **new** `PauseReason`. Today the union is `"user" | "storage"`
in `server/src/downloads.ts` and is mirrored by hand in `web/src/types.ts`;
widen both, or the value is an illegal literal the compiler rejects. It also
needs a row in the queue UI and a key in `en.ts` / `cs.ts`
(`downloads.pausedLibrary`), and — unlike `"storage"` — it must **not** halt the
whole queue: only the jobs bound to that library stop, and they resume on their
own when it comes back, the way a `"storage"` pause resumes when space returns.

`defaultLibrary()` must therefore never assume its stored id resolves, and the
download path must handle "the rule names a library that is not available right
now" as a first-class outcome rather than an invariant violation.

### Rollback

Rolling an image tag back is a realistic thing for this project's users to do.
An older server reading a migrated `state.json` finds prefixed paths it cannot
resolve and no `libraryMeta` at all (it moved to `data/library/`), so the
library would come up unmatched — nothing destroyed, but nothing usable either.
`state.json.v1.bak` from step 0 makes that recoverable by copying one file back,
and the per-library metadata files are additive, so the old state file still
describes a complete v1 install. Say so in
[docs/troubleshooting.md](troubleshooting.md) rather than leaving it folklore.

### Verification

The migration is idempotent and guarded by `schemaVersion`. Write it in
`server/src/library-migrate.ts` with its own unit tests over a fixture state —
this is the one piece of the work where a bug loses a user's match history.
The e2e fixture (`e2e/fixtures/app-server.mjs`) seeds `state.json` directly; add
one spec that seeds a **v1** state and asserts the app comes up migrated, so the
upgrade path is covered by something that actually boots the server.

## Security & Privacy Considerations

- Every path goes through `resolveLibraryPath`, which keeps the existing
  guarantees (no traversal, no dot segments, no symlink escape via `realpath`)
  and adds "the library must exist and be enabled".
- The grant list is the only thing that widens the filesystem surface. A library
  cannot be created outside it, `POST /api/libraries` with `create: true` may only
  `mkdir` inside it, and the picker never lists or follows a symlink out of it.
  Enforcement is identical whether the grant came from `LIBRARY_ROOTS` or from a
  user picking a folder, so the desktop build is not a weaker deployment — it
  just has a different person filling the list.
- A user grant is a deliberate act at the keyboard, recorded with a timestamp and
  revocable. It is never inferred from a request: an API call may not grant
  itself a root, and the picker endpoint cannot widen the list.
- The picker exposes directory names on the host. That is the point, but it is
  also new information: deny it, and the grant endpoints, in restricted mode
  along with library CRUD.
- Nothing new goes outbound. Scan, identify and backfill keep talking only to
  addons the user installed, unchanged.
- Secure mode unchanged: thumbnails are local bytes through
  `/api/library/thumb`; addon artwork still passes `images.proxied`. CSP
  unchanged.
- Bulk delete is the most destructive thing the product can do. Require an
  explicit confirmation naming the count, never preselect, and log each deleted
  path at `INFO` with the job id.

**Restricted mode.** Keep today's parity (item rename/move/delete and match are
already allowed) and add to `ALLOWED_MUTATIONS` in `server/src/restricted.ts`:
`POST /library/folder`, `POST /library/ops`, `POST /library/ops/:id/cancel`.

Denying the reads takes an explicit list, not prose: `restrictedMiddleware` lets
every GET through unless it matches `DENIED_GETS`, so add there (paths are
Express-stripped of the `/api` mount):

```ts
{ method: "GET", pattern: /^\/libraries\/browse$/ },
{ method: "GET", pattern: /^\/libraries\/grants$/ },
```

and add the writes — `POST`/`PATCH`/`DELETE` on `/libraries`, `/libraries/:id`,
`/libraries/grants` and `/libraries/preview` — nowhere, since anything not in
`ALLOWED_MUTATIONS` is already refused.

`GET /api/libraries` itself stays **allowed**: the browse breadcrumbs and the
move dialog need the names. It must omit `root` from its payload in restricted
mode, though — a shared demo has no business learning the host's directory
layout, and the name and type are all the interface actually renders.

## Observability

- `INFO` on: library created / renamed / re-typed / re-rooted / removed (with id
  and root), migration summary (counts per map), ops job start and finish (op,
  items, failed, bytes, duration), cross-filesystem copy fallback, carve-out
  applied, artwork eviction (count, bytes), metadata refresh round.
- `WARN` on: unreachable library root (once per transition, not per browse),
  refused move (type mismatch), remapped addon rule on import, ops item failure.
- `GET /api/diagnostics` gains a `libraries` array (id, name, type, reachable,
  file count, bytes, free space of the root's filesystem) and the ops snapshot.
  `storage` already reports free space per path; report one row per library root.

## Alternatives Considered

### A separator other than a path segment (`lib_x:Show/01.mkv`)

Rejected. Every ancestor walk, `isPathWithin`, `remapPath`, `remapKeyed` and
`pinInherited` would need a second code path, and a cross-library move would
stop being the same operation as a same-library one.

### Keep bare relative paths for the first library, prefix only the others

Rejected. It avoids a migration and buys permanent ambiguity: a folder named
`lib_ab12cd34` is legal on disk, and every reader would need to guess which
scheme a key is in.

### Libraries as a list of roots with no type

Rejected. It solves the two-mounts problem and none of the classification
problem, which is half the request. The type is also what makes the addon save
rule selectable and the cross-library move checkable.

### Disallow nested roots outright

Rejected. It would force the legacy `/downloads` user to move every file before
they could create `/downloads/Movies`. Carve-outs make the split free, at the
cost of an `exclude` set in six walk functions.

### A library spanning several physical locations (Plex-style)

Rejected. It buys one merged row instead of two and costs the invariant the whole
matcher rests on. Two locations both holding `Sinners/` have no good answer:
merging puts one title's files on two disks, which breaks `entryDirectory`,
`emptiedFolders`, artwork next to the media and "one folder is one title";
shadowing makes a file silently vanish from the interface. Plex can do this
because locations are independent scan roots feeding a database and it never
renders a merged directory tree. We render the tree.

The failure mode decides it: with one root per library, an unplugged disk is a
visible, contained "this library is unreachable". With several, it is a
half-populated library whose other half disappeared without saying so. Two
libraries (`Films SSD`, `Films archive`) express the same setup more honestly,
and a title moves between them as a job with a progress bar (§10).

Additive later if a real case appears: a second location is a field on
`LibraryRecord`, and the carve-out machinery already knows how to say "this
subtree belongs to someone else".

### A fully virtual tree (folders and collections stored in metadata)

Rejected, and it is the one choice here that would not be reversible.

The physical path is functional, not merely where the bytes live: `nextVideoFile`
walks the real directory for the next/previous episode buttons,
`POST /api/library/source` reads the file's directory to pair `<stem>.cs.srt`
sidecars, `findArtwork` looks for `poster.jpg` beside the media,
`emptiedFolders` prunes, and `file://<relative>` is the stream address. A virtual
tree means two addressing schemes — virtual for browsing, physical for everything
else — which is the same "fork every function" cost that sinks the alternative
separator above.

The on-disk layout is also a product surface, not an implementation detail:
`artwork.ts` writes `poster.jpg` and `<video>.jpg` to Jellyfin's conventions and
`targetPath` builds `Show/01 serie/01 - Name.mkv` on purpose, so a media server
can read the same tree. Organisation living only in our metadata would waste
that. It would also create two sources of truth that drift — the entire
`LibraryAutoScan` / `watchLibrary` machinery exists because files arrive from
outside, and such a file has nowhere to appear in a virtual tree without an
"unfiled" bucket and a reconciliation story forever. And it would regress the
backup story: today `DATA_PATH` is a folder you copy and the media describes
itself.

What the idea reaches for is cheap by another route. "Put this title in Sci-fi
without moving files" is a **tag**, not a tree, and a path-keyed overlay already
exists twice over (`favorites`, `libraryMeta`). Tags are a small addition on top
of paths whenever they are wanted; they are not a reason to stop paths being the
identity.

### A separate scanner per library, running concurrently

Rejected for now. The scan is deliberately serial and paced (`gapMs`) because the
target is a Celeron talking to public addons. `LibraryScan` gains a
`libraryId` scope; it stays one job.

### A database (SQLite) for library metadata

Deferred, not rejected. One JSON file per library removes the actual pain (whole
state re-serialised per write) with no new dependency and no new backup story —
`DATA_PATH` stays a folder you can copy. Revisit if a single library's file
becomes large enough that the debounced write is felt; the `LibraryMetaStore`
interface is the seam that makes the swap local.

### Bulk operations driven by the client in a loop

Rejected. It is what exists today, one item per request. It cannot survive a
navigation, cannot report progress for a 40 GB move, cannot resume after a
restart, and hammers the server with N round trips.

### A desktop-specific filesystem bridge

Rejected. Enforcement is one grant list, and the desktop differs only in who
fills it — the OS picker instead of the operator. The picker *endpoint* is for
deployments with no native dialog and a desktop build simply never calls it. A
second transport would fork the security model for no gain.

## Key Decisions

1. **A path is `<libraryId>/<relative>`, POSIX-separated, everywhere outside the
   filesystem boundary.** The library id as segment zero is what keeps every
   existing ancestor-walking helper working unchanged.
2. **`mixed` is the default and preserves today's inference exactly.** A typed
   library declares its kind; it does not enable media-server behaviour.
3. **A library root must be inside a granted root, and the grant list is the
   security boundary.** The operator grants under Docker (`LIBRARY_ROOTS` = the
   mounts); the person at the keyboard grants on desktop, through the OS folder
   picker. One enforcement, two ways of filling the list, so a library can sit on
   any disk without the API becoming a filesystem read primitive.
4. **Nested roots are legal and the child is carved out of the parent.** It makes
   splitting a legacy install a rename rather than a migration.
5. **Library metadata leaves `state.json`**, one file per library, debounced and
   atomic. `state.json` keeps only what user actions bound.
6. **Caches get a ceiling and an expiry**, and a library's thumbnails live in
   their own directory so removal is one `rm -r`. Posters next to the media are
   never evicted — Key Decision 7 of [library-metadata.md](library-metadata.md)
   still stands.
7. **Anything that moves bytes or touches several items is a durable job**, not a
   request. One at a time, continue on error, resumable, cancellable.
8. **Cross-library moves are type-checked, and the check is enforced on the
   server** even though the dialog already filters the destinations.
9. **A move never deletes the source before the destination is fsynced and
   renamed**, and never silently renames on a collision.
10. **A single-library install must be indistinguishable from today**, root
    browse included. The feature is invisible until a second library exists.
11. **An unreachable root is never auto-removed and its metadata is never
    dropped.** A dead mount is a temporary condition, not a delete signal. With
    external disks this is ordinary operation, so scan, sweep, autoscan and ops
    all skip such a library rather than treating it as empty.
12. **One library is one location, and only the root of the tree is virtual.**
    The browse tree below a library mirrors the filesystem exactly. A library
    spanning several locations, and a fully virtual tree, are both declined in
    Alternatives; the first is additive later, the second is not wanted.
13. **Adding an existing folder never touches it.** Add is a record; the scan
    reads names, not contents; nothing is renamed or moved. Somebody else's
    `poster.jpg` keeps winning, and the add dialog states the scan estimate
    before the user commits.
14. **The autoscan fingerprint is per library**, or adding a library reads as a
    whole-tree change and an unplugged disk reads as a mass deletion.
15. **Backups carry libraries by root and name, never by id**, and import falls
    back to the default rather than failing.
16. **Desktop readiness is part of this work, not a follow-up**: POSIX wire
    paths, no hardcoded `/downloads` in the client, case-insensitive rename,
    Windows-reserved names, comma-only grant parsing, and a grant list the OS
    picker can fill.

## Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Migration loses match history or favourites | High | Dedicated module, fixture-based unit tests, idempotent, guarded by `schemaVersion`, `state.json` written once atomically at the end. Artwork re-keying may fail safely. |
| Migration runs against half-loaded state | High | It runs before `store` reaches any consumer and before `libraryScan.load()`, `queue.load()` and `images.load()`. Assert the order in a boot test. |
| A rolled-back image cannot read migrated state | Medium | `state.json.v1.bak` written before the first change; per-library metadata files are additive, so the v1 state file stays complete. Documented in troubleshooting. |
| Carve-outs missed in one walk function | High | The parent would list, match, and *prune* the child's files. Enumerate the six call sites in the PR description; an L0 test per function. |
| A cross-mount move interrupted mid-copy | High | Copy to `.part`, fsync, rename, then unlink. Never unlink first. A `.part` left behind is swept. |
| Bulk delete on the wrong selection | High | Explicit count in the confirmation, nothing preselected, per-path `INFO` log, no "select all libraries". |
| Unreachable mount triggers the orphan sweep | High | Explicit root-readable check before sweeping a library; skip and `WARN` instead. |
| `state.json` and the per-library files disagree after a crash | Medium | Both are tmp+rename; the per-library file is the source of truth for bindings and is re-read on load. A missing file is an empty map, not an error. |
| Two libraries pointed at the same tree through different mounts | Medium | Nesting check is `realpath`-based; identical roots refused. Distinct mounts of one share cannot be detected — document it. |
| Layout screenshots churn | Medium | Single-library pass-through keeps the existing shots valid; new shots only for the library manager and selection mode. |
| A granted root turns the API into a filesystem read primitive | High | A root must be inside a grant; grants come from the operator or from a deliberate pick at the keyboard, never from a request. Picker and grant endpoints denied in restricted mode. |
| Adding a large existing tree looks like a hang | Medium | Pre-scan estimate with no addon calls, the cost stated in the add dialog, progress chrome, and a job that pauses and resumes rather than blocking. |
| A scan writes `poster.jpg` into somebody's curated tree | Medium | `writeArtwork` defaults to true but is forced false on a non-writable root, and `POSTER_NAMES` already wins over anything we generate. |
| Ops queue starves the scan or vice versa | Low | They are separate serial queues; the scan already pauses on playback and downloads. Add: the scan pauses while an ops job is writing. |

## Testing

Per [testing.md](testing.md).

### L0 — `node:test` (`server/src/*.test.ts`)

`libraries.test.ts` (new)

- `parseLibraryPath` / `libraryPath` round-trip, including the root
  (`lib_ab12cd34` → relative `""`), a relative with spaces and `#`, and a
  rejected `lib_xx` / missing prefix / `..` segment.
- `toPosix` / `toFs` round-trip; a key built on a `\`-separator platform is read
  back identically.
- `resolveLibraryPath` refuses: unknown id, disabled library, `../` escape, a dot
  segment, a symlink out of the root.
- `carveOuts`: a child root is returned relative to the parent; siblings are not;
  a root equal to the parent is refused at creation, not carved.
- Grant parsing and enforcement: comma-separated `LIBRARY_ROOTS`, trims, ignores
  empties, accepts `C:\Media` and `\\server\share` without splitting on the
  colon; a user grant and an env grant enforce identically; a root outside every
  grant is refused; revoking a grant disables rather than deletes its libraries.
- Nesting validation: identical root refused; child accepted and carved; a root
  that is a file refused; a root outside every base refused.
- The reachability probe: a root whose `stat` never settles is reported
  `unreachable` after the timeout rather than hanging the call; a second probe
  inside the cache window does not touch the filesystem; an I/O failure against
  the library invalidates the cache early.

`library-references.test.ts` (new) — the table in *When a library stops being
available* is the spec:

- Deleting a library clears a default that named it and `defaultLibrary()` then
  returns the first enabled library of the kind, then the first `mixed`, then
  `undefined`.
- Deleting rewrites addon rules that named it to `""`; disabling does not.
- A queued job whose target resolves into a vanishing library is paused with
  `pauseReason: "library"` — never failed, never redirected to the fallback.
- That pause is per job, not a queue halt: jobs targeting other libraries keep
  running, and the paused ones resume by themselves when the library returns.
- Changing a `mixed` library to `movie` clears a `series` rule that named it and
  leaves a `movie` one alone.
- `?forget=1` removes the metadata file and artwork directory; without it both
  survive and a re-added library at the same root picks them up.

`library.test.ts` (extend)

- `listVideos`, `browseDirectory`, `listFolders`, `emptiedFolders` honour
  `exclude`: the carved-out subtree is absent from results, and
  `emptiedFolders` stops at a carve-out instead of proposing to delete it.

`library-match.test.ts` (extend)

- `titleUnits(files, "movie")`: a folder with `01 serie` inside is one `movie`
  unit; its files still belong to it.
- `titleUnits(files, "series")`: a folder of loose numbered videos is a `series`
  unit; a collection is still not a unit.
- `titleUnits(files, "mixed")` reproduces every existing case verbatim — keep the
  current assertions as the `mixed` suite.
- `remapKeyed` / `pinInherited` across two library prefixes: a binding inherited
  from a folder in library A becomes owned when the item lands in library B.

`library-migrate.test.ts` (new)

- A v1 fixture state with meta, suggestions, favorites, `file:` progress,
  title-keyed progress, watchlist, addons with save rules, and queued download
  jobs → asserts every key is prefixed once, watchlist and title progress
  untouched, addon rules get `""`, defaults and job targets point at the new
  library, `writeArtwork` is set, the autoscan fingerprint is seeded, and a
  second run changes nothing.
- `state.json.v1.bak` is written before the first mutation and is not overwritten
  on a second run.
- A state that already carries `schemaVersion: 2` is left byte-identical.
- A fresh install (no `state.json`) produces one library without running the
  migration path at all.
- Artwork mapping covers all four key shapes: a bound title's thumbnail, a loose
  file's thumbnail, a **folder** thumbnail whose path appears in no `libraryMeta`
  key (the ancestor case), and a poster saved for a job still in
  `data/downloads.json`. Each lands at its new hash under
  `data/artwork/<id>/`.
- After the run, `data/artwork/` holds no loose `*.jpg` — anything unmapped and
  older than the freshness guard is gone, anything newer is kept.

`library-autoscan.test.ts` (extend)

- A per-library fingerprint: adding a library queues a scan of that library only
  and leaves the others' fingerprints untouched; an unreachable root is skipped
  rather than read as an emptied tree.

`library-scan.test.ts` (extend)

- `start({ libraryId })` queues only units whose key carries that prefix, and
  leaves a running job for another library alone.
- A `movie` library passes `"movie"` to `searchAll` and as `expectedKind`; a
  series hit is penalised and never auto-accepted.

`library-ops.test.ts` (new)

- Serial execution, continue-on-error, per-item results, cancel mid-job, resume
  from a persisted state file, the 500-item cap, and the same-device `rename` vs
  cross-device copy branch (inject the `stat().dev` probe).

`naming.test.ts` (extend)

- `normalizeDownloadSettings` with a library argument: unknown id → `""`, type
  mismatch → throws with the catalogue key, `mixed` accepted for both kinds.
- `safeName` rejects Windows reserved device names and trailing dots/spaces.

`restricted.test.ts` (extend)

- `GET /libraries/browse` and `GET /libraries/grants` are refused via
  `DENIED_GETS`; `GET /libraries` is allowed and its payload carries no `root`.
- Library and grant writes are refused by the default-deny on mutations, while
  `POST /library/folder` and `POST /library/ops` are allowed.

`backup.test.ts` (extend)

- v1 backup still imports; v2 round-trips libraries; an unmatched library falls
  back to the default and is reported.
- `defaultMovieLibrary` / `defaultSeriesLibrary` inside the `settings` blob are
  remapped by root then name, and cleared to `""` when unmatched — a foreign id
  must never survive an import. A v1 backup, which carries neither field, lands
  on valid values.

### L1 — Vitest (`web/src`)

- The path helper the client uses to split a qualified path into
  `{ libraryName, crumbs }` — pure, and the thing every breadcrumb depends on.
- Selection-state reducer: toggle, shift-range over a rendered page, select-page,
  clear on navigation.
- Addon storage editor: the library select offers only matching types plus
  `mixed` plus Default (component test, network mocked with `msw`).

### L2 — Playwright (`e2e/tests`)

- `libraries.spec.ts`: create a second library from the picker, see it in the
  root browse, open it, move a title into it, confirm the title's poster and
  watched state survive, remove the library and confirm the media is still on
  disk.
- `library-bulk.spec.ts`: enter selection mode, select three items, move them,
  watch the job progress, confirm the result and that a failed item did not stop
  the rest.
- `libraries.spec.ts` also covers the pass-through boundary: one configured
  library browses straight into its contents, and adding a second — even left
  disabled — switches the root to the list and keeps it there.
- `library-types.spec.ts`: a `series` library classifies a folder of loose
  numbered files as a show; a `movie` library does not turn a folder with
  `01 serie` into one.
- Extend `e2e/fixtures/app-server.mjs` to seed two libraries under `e2e/.tmp`,
  and keep the existing single-library seed for every current spec.

### L3 — layout

- New shots: library manager, root browse with two libraries, selection action
  bar (desktop, tablet-landscape, mobile).
- Existing shots must keep passing **without their baselines being regenerated**
  in the single-library fixture — that is the assertion that the pass-through
  really is invisible. Not byte-identity: Playwright compares with a threshold,
  and demanding identical bytes would turn any unrelated antialiasing difference
  into a failure that says nothing about this feature.

## Rollout Plan / PR Plan

Each PR is independently shippable and leaves `main` working. Per `AGENTS.md`,
bump the patch version only in the PRs that ship user-facing behaviour, and take
the next patch after whatever is on `main` at rebase time.

### PR 1 — Qualified paths, `libraries.ts`, migration

`libraries.ts`, the POSIX wire rule through `library.ts` / `library-match.ts`,
`resolveLibraryPath` at every `index.ts` call site, `libraries` in state with
exactly one migrated entry, `library-migrate.ts` and its tests. No UI change, no
new capability — the app behaves exactly as before. No version bump.

### PR 2 — Metadata store split and cache policy

`LibraryMetaStore`, `data/library/*.json`, episodes file, artwork per-library
directory, `ARTWORK_CACHE_MB` eviction, `IMAGE_CACHE_TTL_DAYS`, the
root-readable guard on the sweep, `docs/configuration.md`. No version bump.

### PR 3 — Library types, CRUD API, folder picker

`LibraryType` through `titleUnits` and `LibraryScan`, `/api/libraries*`,
grants (`LIBRARY_ROOTS` plus user grants), nesting rules and carve-outs through
the walk functions, the add flow with its pre-scan estimate and library-scoped
scan, per-library autoscan fingerprints, `writeArtwork` / `readOnly` /
`unreachable` handling,
restricted-mode rules. API only. No version bump.

### PR 4 — Library manager, root browse, cross-library move

The Settings section and the tools-menu panel, `kind: "library"` rows, the
single-library pass-through, the move dialog's library picker and the type gate,
i18n, L2 and L3 coverage. **Version bump.**

### PR 5 — Operations queue and bulk selection

`library-ops.ts`, `/api/library/ops*`, copy and create-folder, selection mode and
the action bar, progress chrome, i18n, tests. **Version bump.**

### PR 6 — Per-library addon save rules, backup, documentation

`DownloadTargetSettings.libraryId` end to end, validation, backup v2 and lenient
import, the client's `/downloads` hardcodes removed, `docs/libraries.md` (user
documentation), `docs/downloads.md`, `docs/library-metadata.md` (supersede the
separate-libraries rejection), `docs/roadmap.md`. **Version bump.**

## Known gaps

Where the work stands, and what is left to do, is in
[multi-library-handoff.md](multi-library-handoff.md).

Found by using the feature once PR 1–4 were on `main`. Each is small, each has a
decision attached, and none of them needs the design revisited.

### The folder picker cannot create a folder

**Closed.** The picker offers **New folder**: the name is taken inside the browsed
folder, that path becomes the selection, and the create request carries
`create: true`, the option `POST /api/libraries` and
`requireLibraryRoot(value, { create })` had from the start. Nothing is created
before the library is, so a cancelled flow leaves no empty folder; the `mkdir`
still happens inside `checkLibraryRoot`, which refuses anything outside every
grant, and the route stays denied in restricted mode with the rest of
`/libraries`. Re-root is unchanged: it takes a folder that already exists.

### Retire `artworkLocation`

**Closed.** `Settings.artworkLocation` is gone and `writeArtwork` is the single
control, on by default, forced off and locked where the root is read-only — the
case the flag exists for. It also sits at the right level: whether to write into
a tree is a property of that tree, not of the installation.

The migration reads the old global once, when the key is still in `state.json`,
and takes it away with it: a library keeps its own answer only where the old
setting said `"media"`, so an install that wrote its posters into `DATA_PATH`
keeps them there and nobody's layout changes under them. A state that points
next to the media gets the flags it already had. The Storage section loses the
select and says where the switch went.

### No guided split of the download directory

Carve-outs make splitting `/downloads` into `/downloads/Films` and
`/downloads/Series` free, and §10 moves titles between them with their metadata —
but nothing tells the owner that. Today the two ways are:

1. **Split from inside.** Add the new libraries as folders under the existing
   root; the parent carves them out. Move titles across in the interface. No
   downtime, metadata travels, and on one volume each move is a `rename`.
2. **Re-root.** `PATCH /api/libraries/:id { root }` rewrites the record and
   **does not move anything**. To push a library one level down: stop the server,
   move the tree into the new folder on disk, start, then re-root onto it. Keys
   are `<libraryId>/<relative>` and the relatives do not change, so the whole
   match history survives. With the server running, a scan could observe the
   half-moved tree and read it as new unmatched titles.

Write (1) up in the user documentation as the supported route. A wizard that
offers it from the library manager is worth having; note that re-root moves no
files, since the name suggests otherwise.

**Written up** in [libraries.md](libraries.md), both routes, with the warning
that re-root moves no files. The wizard from the library manager is still open.

### Remembered metadata a re-add cannot find

**Closed.** `DELETE /api/libraries/:id` without `forget=1` keeps
`data/library/<id>.json` and `data/artwork/<id>/`, and the dialog promises that a
folder added again picks that up. It did not: `POST /api/libraries` minted a new
id, so the kept files and the favorite and resume rows keyed to the old one were
reachable by nothing.

The second of the two ways out was taken, the one that makes the promise true
rather than rewriting it: a removal without `forget` leaves `{ id, root,
removedAt }` in `state.departed`, and a library added again at the same root
takes the id back. Matching goes through `realpath` on both sides, the way the
root guard does, with the literal path as a fallback for a folder removed while
its disk was away. `activeDeparted` keeps the newest 20 entries and drops
anything older than 30 days, so add-and-remove cannot grow the state file, and
`?forget=1` drops the note together with everything else. The guide says this
plainly now instead of warning about it.

## Open Questions

1. **Default-library storage.** `Settings.defaultMovieLibrary` /
   `defaultSeriesLibrary` (chosen here) versus a flag on `LibraryRecord`. The
   settings field is simpler to validate on delete; revisit if a third kind ever
   appears.
2. ~~**Per-library settings beyond `writeArtwork`.**~~ **Answered in use.**
   Running the feature showed the opposite problem to the one this question
   anticipated: there are now *two* controls for where a poster goes, the global
   `Settings.artworkLocation` (`data` | `media`) and the per-library
   `writeArtwork`, and they said overlapping things. Global one retired; see
   *Retire `artworkLocation`* under Known gaps. The next per-library setting
   should be weighed the same way: does it describe the tree or the install?
3. **Bulk rename by pattern.** Deliberately out of v1. The `LibraryOp` union is
   shaped to take it without a migration.
4. **Follow show** ([roadmap.md](roadmap.md)) will want a per-library watch list
   and will reuse `refreshedAt` from §7. No decision needed here, but do not
   design `refreshedAt` in a way that assumes one library.
