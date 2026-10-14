import assert from "node:assert/strict";
import { test } from "node:test";
import type { LibraryRecord } from "./libraries.js";
import { defaultRemoteCopyLibraryId, takesRemoteCopy } from "./media-server-download.js";
import type { RemoteLibraryRecord } from "./media-server-types.js";

const library = (id: string, type: "movie" | "series" | "mixed", over: Partial<LibraryRecord> = {}): LibraryRecord => ({
  id, name: id, type, root: `/downloads/${id}`, enabled: true, order: 0,
  addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: false, ...over,
});

const remote = (
  type: "movie" | "series" | "mixed",
  over: Partial<Pick<RemoteLibraryRecord, "downloadLibraryId">> = {},
): Pick<RemoteLibraryRecord, "type" | "downloadLibraryId"> => ({ type, ...over });

test("a configured destination wins over every rule, and is never swapped for another", () => {
  const films = library("lib_a1b2c3d4", "movie");
  const settings = { defaultMovieLibrary: films.id };
  // Even a handle this install cannot use is handed back as it stands: refusing it is the
  // admission's business, substituting another library never is.
  assert.equal(defaultRemoteCopyLibraryId(remote("movie", { downloadLibraryId: "lib_00000000" }), [films], settings, "movie"), "lib_00000000");
  assert.equal(defaultRemoteCopyLibraryId(remote("movie", { downloadLibraryId: "lib_00000000" }), [], {}, "movie"), "lib_00000000");
});

test("a movie or series remote library follows the default for its kind of content", () => {
  const films = library("lib_a1b2c3d4", "movie", { order: 2 });
  const firstFilm = library("lib_b2c3d4e5", "movie", { order: 1 });
  const shows = library("lib_c3d4e5f6", "series");
  const box = library("lib_d4e5f6a7", "mixed");
  const all = [box, shows, films, firstFilm];

  assert.equal(defaultRemoteCopyLibraryId(remote("movie"), all, { defaultMovieLibrary: films.id }, "movie"), films.id);
  assert.equal(defaultRemoteCopyLibraryId(remote("series"), all, { defaultSeriesLibrary: shows.id }, "series"), shows.id);
  // With no default named, the first library of the kind by order, then the first mixed one.
  assert.equal(defaultRemoteCopyLibraryId(remote("movie"), all, {}, "movie"), firstFilm.id);
  assert.equal(defaultRemoteCopyLibraryId(remote("series"), [box], {}, "series"), box.id);
  assert.equal(defaultRemoteCopyLibraryId(remote("movie"), [], {}, "movie"), undefined);
});

test("a mixed remote library prefers the first writable mixed library, whatever the kind default is", () => {
  const films = library("lib_a1b2c3d4", "movie");
  const later = library("lib_b2c3d4e5", "mixed", { order: 4 });
  const earlier = library("lib_c3d4e5f6", "mixed", { order: 2 });
  const settings = { defaultSeriesLibrary: films.id };

  assert.equal(defaultRemoteCopyLibraryId(remote("mixed"), [later, earlier], settings, "series"), earlier.id, "order decides, not the array's");
  // A mixed remote library falls back to the kind's own rule only when there is no mixed one.
  assert.equal(defaultRemoteCopyLibraryId(remote("mixed"), [films, later], settings, "series"), later.id);
  assert.equal(defaultRemoteCopyLibraryId(remote("mixed"), [films], { defaultMovieLibrary: films.id }, "movie"), films.id);
});

test("a destination a copy could not be written to is passed over when one is derived", () => {
  const off = library("lib_a1b2c3d4", "movie", { enabled: false });
  const readOnly = library("lib_b2c3d4e5", "movie", { readOnly: true });
  const away = library("lib_c3d4e5f6", "movie", { unreachable: true });
  const usable = library("lib_d4e5f6a7", "movie", { order: 9 });
  const all = [off, readOnly, away, usable];

  // The named default is read-only here, so the rule falls back the way the queue already does.
  assert.equal(defaultRemoteCopyLibraryId(remote("movie"), all, { defaultMovieLibrary: readOnly.id }, "movie"), usable.id);
  assert.equal(defaultRemoteCopyLibraryId(remote("movie"), [off, readOnly, away], {}, "movie"), undefined);

  const box = library("lib_e5f6a7b8", "mixed");
  assert.equal(takesRemoteCopy("mixed", box), true);
  assert.equal(takesRemoteCopy("movie", usable), true);
  assert.equal(takesRemoteCopy("movie", readOnly), false);
  assert.equal(takesRemoteCopy("mixed", usable), false, "a mixed remote library never lands in a movie one");
  assert.equal(takesRemoteCopy("series", library("lib_f6a7b8c9", "movie")), false);
});

test("a typed remote library keeps its own default even without trustworthy media kind", () => {
  const films = library("lib_a1b2c3d4", "movie");
  const shows = library("lib_b2c3d4e5", "series");
  const settings = { defaultMovieLibrary: films.id, defaultSeriesLibrary: shows.id };
  assert.equal(defaultRemoteCopyLibraryId(remote("series"), [films, shows], settings, "movie"), shows.id);
  assert.equal(defaultRemoteCopyLibraryId(remote("movie"), [films, shows], settings, "series"), films.id);
});
