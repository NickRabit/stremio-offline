import { expect, it } from "vitest";
import { catalogResumeEntries, localResumeEntries } from "./resume-visibility";
import type { Addon, LibraryView, ProgressEntry } from "./types";

const library = (over: Partial<Pick<LibraryView, "id" | "showInContinueWatching">> = {}) => ({ id: "lib_ab12cd34", ...over });
const addon = (over: Partial<Pick<Addon, "key" | "showInContinueWatching">> = {}) => ({ key: "addon-a", ...over });
const entry = (over: Partial<ProgressEntry> & { key: string }): ProgressEntry => ({
  position: 120, duration: 2400, title: "Title", updatedAt: "2026-09-01T00:00:00.000Z", ...over,
});

it("draws a local row for a library that keeps its files in the list", () => {
  const visible = entry({ key: "file:lib_ab12cd34/Show/01.mkv", path: "lib_ab12cd34/Show/01.mkv" });
  const hidden = entry({ key: "file:lib_11111111/Show/01.mkv", path: "lib_11111111/Show/01.mkv", title: "Other" });
  expect(localResumeEntries([visible, hidden], [library(), library({ id: "lib_11111111", showInContinueWatching: false })]))
    .toEqual([visible]);
});

it("keeps a local row while the switch has never been written, and restores it when it goes back on", () => {
  const stored = entry({ key: "file:lib_ab12cd34/Show/01.mkv", path: "lib_ab12cd34/Show/01.mkv" });
  expect(localResumeEntries([stored], [library()])).toEqual([stored]);
  expect(localResumeEntries([stored], [library({ showInContinueWatching: true })])).toEqual([stored]);
});

it("leaves a local row nobody owns alone, and ignores the catalogue ones", () => {
  const unqualified = entry({ key: "file:Show/01.mkv", path: "Show/01.mkv", title: "Old" });
  const gone = entry({ key: "file:lib_99999999/Show/01.mkv", path: "lib_99999999/Show/01.mkv", title: "Removed" });
  const catalog = entry({ key: "movie:tt1", title: "Catalog" });
  expect(localResumeEntries([unqualified, gone, catalog], [library({ showInContinueWatching: false })]))
    .toEqual([unqualified, gone]);
});

it("drops a catalogue row only when the addon it names was turned off", () => {
  const fromAddon = entry({ key: "movie:tt1", title: "From the addon", addonKey: "addon-a" });
  const other = entry({ key: "movie:tt2", title: "Another addon", addonKey: "addon-b" });
  expect(catalogResumeEntries([fromAddon, other], [addon({ showInContinueWatching: false }), addon({ key: "addon-b" })]))
    .toEqual([other]);
  expect(catalogResumeEntries([fromAddon], [addon({ showInContinueWatching: true })])).toEqual([fromAddon]);
  expect(catalogResumeEntries([fromAddon], [addon()]), "an addon that never wrote the field is on").toEqual([fromAddon]);
});

it("keeps a catalogue row stored before the addon was recorded, or whose addon is gone", () => {
  const older = entry({ key: "movie:tt9", title: "Older row" });
  const uninstalled = entry({ key: "movie:tt8", title: "Uninstalled", addonKey: "addon-x" });
  expect(catalogResumeEntries([older, uninstalled], [addon({ showInContinueWatching: false })])).toEqual([older, uninstalled]);
});

it("never puts a local file into the catalogue list", () => {
  const file = entry({ key: "file:lib_ab12cd34/Show/01.mkv", path: "lib_ab12cd34/Show/01.mkv" });
  expect(catalogResumeEntries([file], [addon()])).toEqual([]);
});
