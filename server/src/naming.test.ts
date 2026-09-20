import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { AppError } from "./errors.js";
import { assertUsableName, deviceFilename, joinTarget, normalizeDownloadSettings, safeName, safeSubfolder, streamExtension, targetPath } from "./naming.js";
import type { LibraryRecord } from "./libraries.js";

test("a film goes into a folder of its own with the same name", () => {
  const { directory, base } = targetPath({ kind: "movie", title: "The Matrix" }, "cokoli", ".mkv");
  assert.equal(joinTarget(directory, base, ".mkv"), "The Matrix/The Matrix.mkv");
});

test("an episode goes into the series and season folders", () => {
  const { directory, base } = targetPath(
    { kind: "episode", title: "Simpsonovi", season: 1, episode: 7, episodeTitle: "Vánoce u Simpsonových" }, "x", ".mp4");
  assert.equal(joinTarget(directory, base, ".mp4"), "Simpsonovi/01 serie/07 - Vánoce u Simpsonových.mp4");
});

test("two-digit season and episode numbers are left as they are", () => {
  const { directory, base } = targetPath({ kind: "episode", title: "Seriál", season: 12, episode: 134, episodeTitle: "Díl" }, "x", ".mkv");
  assert.equal(joinTarget(directory, base, ".mkv"), "Seriál/12 serie/134 - Díl.mkv");
});

test("an episode with no name keeps at least its number", () => {
  const { directory, base } = targetPath({ kind: "episode", title: "Seriál", season: 2, episode: 3 }, "x", ".mkv");
  assert.equal(joinTarget(directory, base, ".mkv"), "Seriál/02 serie/03.mkv");
});

test("specials in season zero get a folder of their own", () => {
  const { directory } = targetPath({ kind: "episode", title: "Seriál", season: 0, episode: 1 }, "x", ".mkv");
  assert.equal(directory, "Seriál/00 serie");
});

test("with no season number the episode stays directly in the series folder", () => {
  const { directory, base } = targetPath({ kind: "episode", title: "Seriál", episode: 5, episodeTitle: "Díl" }, "x", ".mkv");
  assert.equal(joinTarget(directory, base, ".mkv"), "Seriál/05 - Díl.mkv");
});

test("with no show details the given name is used", () => {
  const { directory, base } = targetPath(undefined, "Nějaké video", ".avi");
  assert.equal(joinTarget(directory, base, ".avi"), "Nějaké video/Nějaké video.avi");
});

test("a copy gets a running number and the folder stays the same", () => {
  assert.equal(joinTarget("Film", "Film", ".mkv", 2), "Film/Film (2).mkv");
});

test("a name must not escape the target directory", () => {
  // What matters is that neither a path separator nor a bare ".." survives in the result.
  for (const attack of ["../../etc/passwd", "..", "..\\..\\windows", "a/../../b", "/etc/passwd"]) {
    const result = safeName(attack);
    assert.ok(!result.includes("/"), `a slash survived: ${result}`);
    assert.ok(!result.includes("\\"), `a backslash survived: ${result}`);
    assert.ok(!/(^|\s)\.\.($|\s)/.test(result), `".." survived: ${result}`);
  }
  assert.equal(safeName("../../etc/passwd"), "etc passwd");
  assert.equal(safeName(".."), "video");
  assert.equal(safeName("C:\\Windows\\system32"), "C Windows system32");
});

test("dots inside a name stay, trailing ones go", () => {
  assert.equal(safeName("S.W.A.T. 2017"), "S.W.A.T. 2017");
  assert.equal(safeName("Film."), "Film");
});

test("control characters and doubled spaces are stripped from a name", () => {
  assert.equal(safeName("Film\u0000\u001f  s   mezerami "), "Film s mezerami");
});

test("an empty or dots-only name does not throw", () => {
  assert.equal(safeName("   "), "video");
  assert.equal(safeName("..."), "video");
});

test("an over-long name is trimmed", () => {
  assert.ok(safeName("a".repeat(400)).length <= 150);
});

test("a name Windows refuses becomes one it accepts", () => {
  // Whatever follows it: `CON`, `CON.mkv` and `CON.txt` are all device names there.
  for (const reserved of ["CON", "con.mkv", "PRN", "AUX", "NUL", "COM1", "LPT9.txt"]) {
    assert.equal(safeName(reserved), `_${reserved}`, `${reserved} is a device name`);
  }
  // Only the whole stem counts, so an ordinary name that starts with one is left alone.
  assert.equal(safeName("CONcert.mkv"), "CONcert.mkv");
  assert.equal(safeName("Console"), "Console");
  // A trailing dot or space is refused there too, and already goes.
  assert.equal(safeName("Film. "), "Film");
});

test("a subfolder Windows could not use is refused", () => {
  for (const value of ["C:\\Windows", "\\\\server\\share\\Films", "\\Films", "Films\\..\\..\\etc"]) {
    assert.throws(() => safeSubfolder(value), `${value} must not become a subfolder`);
  }
  assert.equal(safeSubfolder("Films\\2024"), path.join("Films", "2024"), "a backslash inside is still a separator");
});

test("a film can be saved flat into the addon's subfolder", () => {
  const target = targetPath({ kind: "movie", title: "The Matrix" }, "x", ".mkv", { subfolder: "Webshare/Filmy", layout: "flat" });
  assert.equal(joinTarget(target.directory, target.base, ".mkv"), "Webshare/Filmy/The Matrix.mkv");
});

test("a series can be saved flat without episode names colliding", () => {
  const target = targetPath({ kind: "episode", title: "Simpsonovi", season: 1, episode: 7, episodeTitle: "Vánoce" }, "x", ".mkv", { subfolder: "Sosac", layout: "flat" });
  assert.equal(joinTarget(target.directory, target.base, ".mkv"), "Sosac/Simpsonovi - S01E07 - Vánoce.mkv");
});

test("structured saving puts the subfolder before the usual structure", () => {
  const target = targetPath({ kind: "episode", title: "Simpsonovi", season: 2, episode: 3, episodeTitle: "Díl" }, "x", ".mkv", { subfolder: "Streamy/Seriály", layout: "structured" });
  assert.equal(joinTarget(target.directory, target.base, ".mkv"), "Streamy/Seriály/Simpsonovi/02 serie/03 - Díl.mkv");
});

test("the default settings migrate to the base folder and structure", () => {
  assert.deepEqual(normalizeDownloadSettings(undefined), {
    movie: { subfolder: "", layout: "structured" }, series: { subfolder: "", layout: "structured" },
  });
});

test("a save rule may name a library, and only one that takes the kind", () => {
  const library = (over: Partial<LibraryRecord>): LibraryRecord => ({
    id: "lib_11111111", name: "Films", type: "movie", root: "/mnt/films", enabled: true, order: 0,
    addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: true, ...over,
  });
  const films = library({});
  const series = library({ id: "lib_22222222", name: "Series", type: "series" });
  const mixed = library({ id: "lib_33333333", name: "Mixed", type: "mixed" });
  const rule = (libraryId: string) => ({ movie: { subfolder: "", layout: "structured", libraryId }, series: {} });

  // Without the library list the id is kept: the queue resolves it when the job starts.
  assert.equal(normalizeDownloadSettings(rule(films.id)).movie.libraryId, films.id);
  assert.equal(normalizeDownloadSettings(rule(mixed.id), [films, mixed]).movie.libraryId, mixed.id, "mixed takes anything");
  assert.equal(normalizeDownloadSettings(rule(films.id), [films, series]).movie.libraryId, films.id, "the id survives the trip out and back");
  assert.equal("libraryId" in normalizeDownloadSettings({ movie: {}, series: {} }, [films]).movie, false, "no rule is the default");

  const refused = (value: unknown, libraries: LibraryRecord[], why: string) =>
    assert.throws(() => normalizeDownloadSettings(value, libraries), `refused: ${why}`);
  refused(rule("lib_99999999"), [films], "a library this instance does not have");
  refused(rule(series.id), [films, series], "a series library does not take films");
  refused(rule(films.id), [library({ enabled: false }), series], "a library that is switched off");
  refused(rule(films.id), [library({ readOnly: true }), series], "a library that cannot be written to");
  refused(rule(films.id), [library({ unreachable: true }), series], "a library whose disk is away");
});

test("a subfolder must not escape downloads", () => {
  for (const value of ["../tajne", "/etc", "C:\\Windows", "filmy/../../etc"]) assert.throws(() => safeSubfolder(value));
  assert.equal(safeSubfolder("Doplňky/Webshare"), "Doplňky/Webshare");
});

test("device downloads use the same filename as the library", () => {
  const stream = { url: "https://download.example/video?id=secret", behaviorHints: { filename: "release.mkv" } };
  const media = { kind: "episode" as const, title: "Seriál", season: 2, episode: 3, episodeTitle: "Díl" };
  const settings = { subfolder: "Provider/Seriály", layout: "structured" as const };
  assert.equal(streamExtension(stream), ".mkv");
  assert.equal(deviceFilename(stream, media, "fallback", settings), "03 - Díl.mkv");
});

test("URL extensions do not include the debrid query string", () => {
  assert.equal(streamExtension({ url: "https://download.example/Film.mp4?token=velmi-tajny" }), ".mp4");
});

test("a typed name that cannot be used as it stands is refused, not rewritten", () => {
  // `safeName` turns each of these into something else; a rename must say so rather than
  // quietly save the item under a name nobody asked for.
  for (const refused of ["../../Thief", "Heat/Ronin", "Film: Director's Cut", "Why?", "Film.", ".hidden", "CON", "...", "a".repeat(151)]) {
    assert.throws(() => assertUsableName(refused), (error: unknown) => error instanceof AppError, refused);
  }
  for (const empty of ["", "   "]) {
    assert.throws(() => assertUsableName(empty), (error: unknown) => error instanceof AppError && error.messageKey === "err.emptyName", JSON.stringify(empty));
  }
});

test("a usable typed name comes back tidied, not changed", () => {
  assert.equal(assertUsableName("  Heat  "), "Heat");
  assert.equal(assertUsableName("Heat   1995"), "Heat 1995");
  assert.equal(assertUsableName("S.W.A.T. 2017"), "S.W.A.T. 2017");
  assert.equal(assertUsableName("Amélie"), "Amélie");
});
