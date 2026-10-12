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
  const settings = { ...defaultSettings(), concurrentDownloads: 4, audioLanguage: "sk", realDebridToken: "rd-secret", libraryScanPauseOnDownload: true, catalogTileShape: "wide" as const, libraryTileShape: "wide" as const, favoritesTileShape: "poster" as const, resumeTileShape: "wide" as const, followingTileShape: "poster" as const, homeTileShape: "poster" as const, startView: "home" as const, libraryShelf: "favorites" as const, homeLayout: { order: ["resume", "favorites"], hidden: ["recent"], feeds: [] } };
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
  assert.equal(parseSettingsBackup(backup).settings.favoritesTileShape, "poster");
  assert.equal(parseSettingsBackup(backup).settings.resumeTileShape, "wide");
  assert.equal(parseSettingsBackup(backup).settings.followingTileShape, "poster");
  assert.equal(parseSettingsBackup(backup).settings.homeTileShape, "poster", "the Home tile shape survives a backup round trip");
  assert.equal(parseSettingsBackup(backup).settings.startView, "home", "the start page survives a backup round trip");
  assert.equal(parseSettingsBackup(backup).settings.libraryShelf, "favorites", "the library shelf survives a backup round trip");
  assert.deepEqual(parseSettingsBackup(backup).settings.homeLayout, { order: ["resume", "favorites"], hidden: ["recent"], feeds: [] }, "the personal Home layout survives a backup round trip");
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
  assert.equal(parsed.settings.favoritesTileShape, "poster");
  assert.equal(parsed.settings.resumeTileShape, "poster");
  assert.equal(parsed.settings.followingTileShape, "poster");
  assert.equal(parsed.settings.homeTileShape, "wide");
  assert.equal(parsed.settings.startView, "catalog");
  assert.equal(parsed.settings.downloadTitleLanguage, "sk");
  assert.deepEqual(parsed.addons[0].downloadSettings, defaultDownloadSettings());
  assert.equal(parsed.addons[0].globalSearch, true);

  const junk = parseSettingsBackup({
    format: "stremio-offline-settings", version: 2, settings: { catalogTileShape: "landscape", libraryTileShape: 7 },
    addons: [],
  });
  assert.equal(junk.settings.catalogTileShape, "poster");
  assert.equal(junk.settings.libraryTileShape, "poster");
  assert.equal(junk.settings.favoritesTileShape, "poster");
  assert.equal(junk.settings.resumeTileShape, "poster");
  assert.equal(junk.settings.followingTileShape, "poster");
  assert.equal(junk.settings.homeTileShape, "wide");
  assert.equal(junk.settings.startView, "catalog");
  assert.equal(junk.settings.libraryShelf, "resume", "a shelf the backup never named falls back to Continue");
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
  assert.equal(backup.version, 3);
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

test("a version 3 backup carries the media-server metadata and strips everything else", () => {
  const connectionId = `mconn_${"1".repeat(32)}`;
  const mediaServers = {
    version: 1,
    connections: [{
      id: connectionId, provider: "jellyfin", name: "Home", baseUrl: "https://media.example",
      allowLan: false, allowLoopback: false, serverId: "server-1", accountId: "account-1",
      // A caller that hands a whole stored record in must not be able to smuggle these through.
      secretRef: `msecret_${"a".repeat(32)}`, enabled: true, generation: 4, grants: ["usr_00000001"],
      password: "hunter2", token: "token-value", username: "reader",
    }],
    libraries: [{
      id: `rlib_${"2".repeat(32)}`, connectionId, remoteId: "remote-1", name: "Films", type: "movie",
      order: 0, showOnHome: true, showInContinueWatching: false, enabled: true, allowedUsers: ["usr_00000001"],
    }],
  };
  const backup = createSettingsBackup(defaultSettings(), [], [], mediaServers);
  assert.equal(backup.version, 3);
  assert.deepEqual(Object.keys(backup.mediaServers!.connections[0]!).sort(),
    ["accountId", "allowLan", "allowLoopback", "baseUrl", "id", "name", "provider", "serverId"]);
  assert.deepEqual(Object.keys(backup.mediaServers!.libraries[0]!).sort(),
    ["connectionId", "id", "name", "order", "remoteId", "showInContinueWatching", "showOnHome", "type"]);
  const serialized = JSON.stringify(backup);
  for (const forbidden of ["secretRef", "msecret_", "hunter2", "token-value", "reader", "generation", "allowedUsers", "enabled"]) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} never reaches a backup`);
  }
  assert.deepEqual(parseSettingsBackup(JSON.parse(serialized)).mediaServers, backup.mediaServers, "the metadata survives a round trip");
});

test("a version 3 backup has to carry a media-server configuration that stands on its own", () => {
  const file = (mediaServers: unknown) => ({ format: "stremio-offline-settings", version: 3, settings: {}, addons: [], mediaServers });
  assert.throws(() => parseSettingsBackup(file(undefined)), /media servers in the backup are not valid/);
  assert.throws(() => parseSettingsBackup(file({ version: 2, connections: [], libraries: [] })), /media servers in the backup are not valid/);
  assert.throws(() => parseSettingsBackup(file({ version: 1, connections: [{ id: "not-a-handle", provider: "jellyfin", name: "x", baseUrl: "https://m.example", allowLan: false, allowLoopback: false, serverId: "s", accountId: "a" }], libraries: [] })), /media servers in the backup are not valid/);
  const dangling = { version: 1, connections: [], libraries: [{ id: `rlib_${"2".repeat(32)}`, connectionId: `mconn_${"1".repeat(32)}`, remoteId: "r", name: "Films", type: "movie", order: 0, showOnHome: true, showInContinueWatching: true }] };
  assert.throws(() => parseSettingsBackup(file(dangling)), /media servers in the backup are not valid/);
});

test("a version 1 or 2 backup carries no media-server configuration at all", () => {
  for (const version of [1, 2]) {
    const parsed = parseSettingsBackup({ format: "stremio-offline-settings", version, settings: {}, addons: [] });
    assert.equal("mediaServers" in parsed, false, `a version ${version} file leaves the remote configuration alone`);
  }
});
