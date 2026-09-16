import type { Addon, LibraryView, ProgressEntry } from "./types";

/** The shape a library id has on the wire. Anything else in the first segment is not one. */
const LIBRARY_ID = /^lib_[0-9a-f]{8}$/;

/** The local half of Continue watching: what the library row may draw. A file whose library
 *  turned the row off is dropped; one nobody owns -- an unqualified path, or a folder that is
 *  gone -- stays. The stored position is never touched, only the list. */
export function localResumeEntries(entries: ProgressEntry[], libraries: Pick<LibraryView, "id" | "showInContinueWatching">[]): ProgressEntry[] {
  return entries.filter((item) => {
    if (!item.key.startsWith("file:") || !item.path) return false;
    const owner = item.path.split("/")[0]!;
    if (!LIBRARY_ID.test(owner)) return true;
    return libraries.find((library) => library.id === owner)?.showInContinueWatching !== false;
  });
}

/** The catalogue half: titles that carry the addon they were started on. A row stored before
 *  the addon was recorded, or one whose addon is no longer installed, is left visible. */
export function catalogResumeEntries(entries: ProgressEntry[], addons: Pick<Addon, "key" | "showInContinueWatching">[]): ProgressEntry[] {
  return entries.filter((item) => !item.key.startsWith("file:") && addons.find((addon) => addon.key === item.addonKey)?.showInContinueWatching !== false);
}
