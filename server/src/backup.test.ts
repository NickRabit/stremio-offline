import assert from "node:assert/strict";
import test from "node:test";
import { createSettingsBackup, parseSettingsBackup, remapBackupLibraries } from "./backup.js";
import { defaultDownloadSettings } from "./naming.js";
import { defaultSettings } from "./store.js";
import type { LibraryRecord } from "./libraries.js";

const library = (over: Partial<LibraryRecord> & { id: string; root: string }): LibraryRecord => ({
  name: "Library", type: "mixed", enabled: true, order: 0, addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: true, ...over,
});

test("a backup keeps the settings, the order and the addon's sensitive URL", () => {
  const settings = { ...defaultSettings(), concurrentDownloads: 4, audioLanguage: "sk", realDebridToken: "rd-secret", libraryScanPauseOnDownload: true, catalogTileShape: "wide" as const, libraryTileShape: "wide" as const };
  const backup = createSettingsBackup(settings, [{
    key: "secret-key", manifestUrl: "https://example.com/token/abc/manifest.json", role: "source", enabled: false, globalSearch: false,
    addedAt: "2026-01-01T00:00:00.000Z", downloadSettings: defaultDownloadSettings(),
    manifest: { id: "one", name: "One", version: "1" },
  }]);
  assert.equal(backup.settings.concurrentDownloads, 4);
  assert.equal(backup.settings.realDebridToken, "rd-secret");
  assert.equal(parseSettingsBackup(backup).settings.libraryScanPauseOnDownload, true);
  assert.equal(parseSettingsBackup(backup).settings.catalogTileShape, "wide");
  assert.equal(parseSettingsBackup(backup).settings.libraryTileShape, "wide");
  assert.equal(backup.addons[0].manifestUrl, "https://example.com/token/abc/manifest.json");
  assert.equal(backup.addons[0].globalSearch, false);
  assert.equal("key" in backup.addons[0], false);
  assert.equal("manifest" in backup.addons[0], false);
  assert.deepEqual(parseSettingsBackup(backup).addons, backup.addons);
});

test("an import refuses a foreign format and normalises the values", () => {
  assert.throws(() => parseSettingsBackup({ format: "other", version: 1, settings: {}, addons: [] }), /not a Stremio Offline settings backup/);
  const parsed = parseSettingsBackup({
    format: "stremio-offline-settings", version: 1, settings: { concurrentDownloads: 99, artworkLocation: "elsewhere", downloadTitleLanguage: "sk-SK" },
    addons: [{ manifestUrl: "https://example.com/manifest.json", role: "both", enabled: true, downloadSettings: {} }],
  });
  assert.equal(parsed.settings.concurrentDownloads, 8);
  assert.equal("artworkLocation" in parsed.settings, false, "the retired global is not restored");
  assert.equal(parsed.settings.realDebridToken, "");
  assert.equal(parsed.settings.libraryScanPauseOnDownload, false);
  assert.equal(parsed.settings.catalogTileShape, "poster");
  assert.equal(parsed.settings.libraryTileShape, "poster");
  assert.equal(parsed.settings.downloadTitleLanguage, "sk");
  assert.deepEqual(parsed.addons[0].downloadSettings, defaultDownloadSettings());
  assert.equal(parsed.addons[0].globalSearch, true);

  const junk = parseSettingsBackup({
    format: "stremio-offline-settings", version: 2, settings: { catalogTileShape: "landscape", libraryTileShape: 7 },
    addons: [],
  });
  assert.equal(junk.settings.catalogTileShape, "poster");
  assert.equal(junk.settings.libraryTileShape, "poster");
});

test("a backup carries the libraries and a rule that names one survives a round trip", () => {
  const films = library({ id: "lib_11111111", name: "Films", type: "movie", root: "/downloads/Films" });
  const series = library({ id: "lib_22222222", name: "Series", type: "series", root: "/downloads/Series" });
  const settings = { ...defaultSettings(), defaultMovieLibrary: films.id, defaultSeriesLibrary: series.id };
  const addons = [{
    key: "key", manifestUrl: "https://example.com/manifest.json", role: "source" as const, enabled: true, globalSearch: true,
    addedAt: "2026-01-01T00:00:00.000Z", manifest: { id: "one", name: "One", version: "1" },
    downloadSettings: { movie: { subfolder: "", layout: "structured" as const, libraryId: films.id }, series: defaultDownloadSettings().series },
  }];

  const backup = createSettingsBackup(settings, addons, [films, series]);
  assert.equal(backup.version, 2);
  assert.deepEqual(backup.libraries, [
    { id: films.id, name: "Films", type: "movie", root: "/downloads/Films" },
    { id: series.id, name: "Series", type: "series", root: "/downloads/Series" },
  ]);

  const parsed = parseSettingsBackup(JSON.parse(JSON.stringify(backup)));
  const same = remapBackupLibraries(parsed, [films, series]);
  assert.deepEqual(same.remaps, []);
  assert.equal(same.settings.defaultMovieLibrary, films.id);
  assert.equal(same.addons[0]!.downloadSettings.movie.libraryId, films.id);
});

test("an imported backup points at this instance's libraries, by root then by name", () => {
  const localFilms = library({ id: "lib_aaaaaaa1", name: "Films", type: "movie", root: "/mnt/films" });
  const localSeries = library({ id: "lib_aaaaaaa2", name: "Series", type: "series", root: "/mnt/series" });
  const backup = {
    format: "stremio-offline-settings" as const,
    version: 2,
    settings: { ...defaultSettings(), defaultMovieLibrary: "lib_old0001", defaultSeriesLibrary: "lib_old0002" },
    libraries: [
      { id: "lib_old0001", name: "Films elsewhere", type: "movie" as const, root: "/mnt/films" },
      { id: "lib_old0002", name: "Series", type: "series" as const, root: "/mnt/other-series" },
    ],
    addons: [{
      manifestUrl: "https://example.com/manifest.json", role: "source" as const, enabled: true, globalSearch: true,
      addedAt: "2026-01-01T00:00:00.000Z",
      downloadSettings: {
        movie: { subfolder: "", layout: "structured" as const, libraryId: "lib_gone0000" },
        series: { subfolder: "", layout: "structured" as const, libraryId: "lib_old0001" },
      },
    }],
  };

  const remapped = remapBackupLibraries(backup, [localFilms, localSeries]);
  // The root is what identifies a library; the name is only the second guess.
  assert.equal(remapped.settings.defaultMovieLibrary, localFilms.id);
  assert.equal(remapped.settings.defaultSeriesLibrary, localSeries.id, "the same name and type finds it");
  assert.equal(remapped.addons[0]!.downloadSettings.series.libraryId, localFilms.id);
  assert.equal("libraryId" in remapped.addons[0]!.downloadSettings.movie, false, "a rule nobody can match is the default");
  assert.deepEqual(remapped.remaps, [
    { what: "defaultMovieLibrary", from: "lib_old0001", to: localFilms.id },
    { what: "defaultSeriesLibrary", from: "lib_old0002", to: localSeries.id },
    { what: "movie", addon: "example.com", from: "lib_gone0000" },
    { what: "series", addon: "example.com", from: "lib_old0001", to: localFilms.id },
  ]);
});

test("a version 1 backup still imports, with no libraries and no rules", () => {
  const parsed = parseSettingsBackup({
    format: "stremio-offline-settings", version: 1, settings: { concurrentDownloads: 2 },
    addons: [{ manifestUrl: "https://example.com/manifest.json", role: "both", enabled: true, downloadSettings: { movie: { subfolder: "Filmy" } } }],
  });
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.libraries, []);
  const remapped = remapBackupLibraries(parsed, []);
  assert.deepEqual(remapped.remaps, []);
  assert.equal(remapped.addons[0]!.downloadSettings.movie.subfolder, "Filmy", "the old rules are kept");
});
