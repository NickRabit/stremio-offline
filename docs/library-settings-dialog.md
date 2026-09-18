# Library settings dialog specification

## Purpose

The Libraries section in Settings currently exposes every setting as an
always-visible control on every library card. This is difficult to scan once a
user has more than one library and makes a simple action, such as renaming a
library, feel disconnected from the settings it describes.

Replace the inline editor with a compact library summary and a single **Edit
library** dialog. The dialog owns the library's editable settings, including
its name. This is a front-end refactor: the existing library API already
supports the required fields.

## Scope

- Keep **Add library** and **Refresh** at the top of the Settings section.
- Turn each Settings library card into a summary with one primary **Edit
  library** action.
- Stage normal settings in a dialog and persist them with one explicit save.
- Replace the browser rename prompt with an in-dialog name field.
- Keep folder selection, scanning, ordering, and removal available without
  changing their existing server semantics.

This does not change library discovery, the library data model, or the API. It
also does not change renaming of files and folders inside a library.

## Settings list

Each card should show information useful for choosing the library, but no
editable switches or type select:

- name and root path;
- title, file, and storage counts;
- badges for type, disabled state, default movie/series destinations,
  unreachable state, and read-only state where applicable;
- order arrows, when there is more than one library;
- an **Edit library** button.

This retains the current responsive two-column layout for the cards. The
primary action should use the normal secondary button treatment, so it does not
compete with **Add library**. A settings/sliders icon is appropriate; it should
not look like an extra destructive action.

In restricted mode, cards remain read-only summaries: do not render Edit,
order, scan, folder, or removal actions.

## Edit library dialog

Add a `LibraryEditDialog` alongside `LibraryManagerDialog`. It opens from a
card and contains a local draft cloned from the selected `LibraryView`. The
dialog uses the existing modal conventions, closes with its close button,
Escape, or backdrop, and warns neither saves nor applies changes on Cancel.

The dialog is divided into the following sections.

### Identity and location

- **Name** is a text input prefilled from `library.name`. Trim it before save;
  it must not be empty.
- **Type** is the existing movie, series, and mixed select.
- **Folder** shows the current root and offers **Change folder**. It opens the
  existing `RootPicker`; users must not type a raw root path in the edit
  dialog.

The folder action remains immediate because rerooting may invoke the existing
move-content confirmation and `api.rerootLibrary` flow. After it completes,
reload the library and refresh the dialog draft. It must not be bundled into a
normal settings save.

### Availability and defaults

- **Enabled** switch.
- A **Default download destinations** group with separate switches for movies
  and series.

Defaults incompatible with the selected type are disabled and displayed off.
Changing a type from mixed to movie or series clears the incompatible draft
default before save. The existing server-side final-state validation remains
the authority and continues to clear an incompatible saved default.

### Artwork and presentation

- **Write artwork next to media** switch, disabled for a read-only library as
  it is today.
- **Show cover mosaic** switch.
- **Show in Continue Watching** switch.

### Actions

- **Scan this library** calls the existing `api.startLibraryScan({ libraryId })`
  immediately. It is disabled while the request is pending and leaves the
  dialog open after showing the existing notification.
- The existing removal choices stay in a visually separated danger section:
  remove while retaining metadata, and remove and forget metadata. Their
  confirmations and behavior do not change.

The footer has **Cancel** and **Save changes**. Save is disabled while there is
no dirty draft or while a request is pending.

## Data flow

Normal dialog edits must not patch the server per toggle. On Save, compute a
patch containing only changed fields and call the existing
`api.updateLibrary(library.id, patch)` once. The possible fields already match
the dialog:

`name`, `type`, `enabled`, `writeArtwork`, `mosaic`,
`showInContinueWatching`, `defaultMovie`, and `defaultSeries`.

On success, close the dialog, call the existing `onChanged` refresh callback,
and emit the existing success notification. On failure, retain the draft and
surface the existing error callback so the user can correct or retry it.

If an external refresh changes the selected library while the dialog is open,
do not overwrite an unsaved dirty draft. The normal post-save or post-reroot
refresh may replace a clean draft with the returned library state.

## Rename behaviour

Library rename is simply the `name` field in the save patch. Remove the native
`prompt()` path used by `LibraryManager`; it provides no validation or context
and is not suitable for the settings UI. Do not alter `api.renameLibraryItem`,
which serves a different feature: renaming a media file or folder.

## Implementation notes

- Keep `RootPicker` as the shared add/reroot component. Add a callback or
  reload boundary so an edit dialog sees a successful reroot.
- Keep `LibraryManagerDialog` for its current library-page shortcut. It can
  reuse the same compact cards and edit dialog rather than maintaining a
  second editor layout.
- Replace the large `library-admin-controls` card styles with compact summary
  styles and dialog section styles. Reuse existing form controls and modal
  dimensions where possible.
- Add all visible labels, descriptions, validation, and notifications to both
  `web/src/i18n/en.ts` and `web/src/i18n/cs.ts`. Remove unused prompt-specific
  library keys only if nothing else references them.

## Planned tests

Update `web/src/LibraryManager.test.tsx` when implementing the refactor:

- settings cards render summaries and an Edit action instead of inline
  switches;
- Edit opens a populated draft; Cancel sends no request;
- changing multiple normal controls makes exactly one `updateLibrary` call on
  Save, including an inline name change;
- type changes correctly disable/clear incompatible default destinations;
- reroot still goes through the existing picker/API flow;
- scan and both removal actions retain their current behavior;
- restricted mode exposes no mutation controls.

Run the existing web test suite and add a focused responsive visual/e2e check
only if the current test setup already covers Settings dialogs.

## Acceptance criteria

1. A Settings card no longer contains the current grid of persistent toggles.
2. All current per-library settings can be found in one Edit library dialog.
3. A library can be renamed from that dialog without a native browser prompt.
4. Cancel never changes a normal library setting; Save performs one settings
   update request.
5. Folder changes, scans, order changes, defaults, read-only behavior, and
   removal retain their existing semantics.
6. The layout remains usable at narrow viewport widths.
