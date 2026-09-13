import assert from "node:assert/strict";
import test from "node:test";
import { createSettingsBackup, parseSettingsBackup } from "./backup.js";
import { defaultDownloadSettings } from "./naming.js";
import { defaultSettings } from "./store.js";

test("a backup keeps the settings, the order and the addon's sensitive URL", () => {
  const settings = { ...defaultSettings(), concurrentDownloads: 4, audioLanguage: "sk", realDebridToken: "rd-secret", libraryScanPauseOnDownload: true };
  const backup = createSettingsBackup(settings, [{
    key: "secret-key", manifestUrl: "https://example.com/token/abc/manifest.json", role: "source", enabled: false, globalSearch: false,
    addedAt: "2026-01-01T00:00:00.000Z", downloadSettings: defaultDownloadSettings(),
    manifest: { id: "one", name: "One", version: "1" },
  }]);
  assert.equal(backup.settings.concurrentDownloads, 4);
  assert.equal(backup.settings.realDebridToken, "rd-secret");
  assert.equal(parseSettingsBackup(backup).settings.libraryScanPauseOnDownload, true);
  assert.equal(backup.addons[0].manifestUrl, "https://example.com/token/abc/manifest.json");
  assert.equal(backup.addons[0].globalSearch, false);
  assert.equal("key" in backup.addons[0], false);
  assert.equal("manifest" in backup.addons[0], false);
  assert.deepEqual(parseSettingsBackup(backup).addons, backup.addons);
});

test("an import refuses a foreign format and normalises the values", () => {
  assert.throws(() => parseSettingsBackup({ format: "other", version: 1, settings: {}, addons: [] }), /not a Stremio Offline settings backup/);
  const parsed = parseSettingsBackup({
    format: "stremio-offline-settings", version: 1, settings: { concurrentDownloads: 99, artworkLocation: "elsewhere" },
    addons: [{ manifestUrl: "https://example.com/manifest.json", role: "both", enabled: true, downloadSettings: {} }],
  });
  assert.equal(parsed.settings.concurrentDownloads, 8);
  assert.equal(parsed.settings.artworkLocation, "data");
  assert.equal(parsed.settings.realDebridToken, "");
  assert.equal(parsed.settings.libraryScanPauseOnDownload, false);
  assert.deepEqual(parsed.addons[0].downloadSettings, defaultDownloadSettings());
  assert.equal(parsed.addons[0].globalSearch, true);
});
