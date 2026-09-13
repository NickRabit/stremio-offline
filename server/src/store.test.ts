import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publicSettings, Store } from "./store.js";
import type { AddonRecord } from "./types.js";

const legacyAddon = () => ({
  key: "provider-1", manifestUrl: "https://example.com/manifest.json", role: "source" as const,
  enabled: true, addedAt: "2026-01-01T00:00:00.000Z", manifest: { id: "test", name: "Test", version: "1" },
});

const addon = (downloadSettings: AddonRecord["downloadSettings"]): AddonRecord => ({
  ...legacyAddon(), globalSearch: true, downloadSettings,
});

test("an old addon state migrates to the default save rules", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-store-"));
  try {
    await writeFile(path.join(directory, "state.json"), JSON.stringify({ addons: [legacyAddon()], defaultsInstalled: true, settings: {} }));
    const store = new Store(directory); await store.load();
    assert.deepEqual(store.addons()[0].downloadSettings, {
      movie: { subfolder: "", layout: "structured" }, series: { subfolder: "", layout: "structured" },
    });
    assert.equal(store.settings().catalogTileSize, "medium");
    assert.equal(store.settings().libraryTileSize, "medium");
    assert.equal(store.settings().realDebridToken, "");
    assert.equal(store.settings().downloadTitleLanguage, "ui");
    assert.equal(store.addons()[0].globalSearch, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an addon's own rules survive a save and a reload", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-store-"));
  try {
    const first = new Store(directory); await first.load();
    await first.update((state) => state.addons.push(addon({
      movie: { subfolder: "Webshare/Filmy", layout: "flat" },
      series: { subfolder: "Webshare/Seriály", layout: "structured" },
    })));
    const second = new Store(directory); await second.load();
    assert.deepEqual(second.addons()[0].downloadSettings, {
      movie: { subfolder: "Webshare/Filmy", layout: "flat" },
      series: { subfolder: "Webshare/Seriály", layout: "structured" },
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the Real-Debrid token stays on disk and is stripped from the public view", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-store-"));
  try {
    const first = new Store(directory); await first.load();
    await first.update((state) => { state.settings.realDebridToken = "rd-secret"; });
    const second = new Store(directory); await second.load();
    assert.equal(second.settings().realDebridToken, "rd-secret");
    const published = publicSettings(second.settings());
    assert.equal(published.realDebridConfigured, true);
    assert.equal("realDebridToken" in published, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an install from before the interface was translated keeps Czech", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-store-"));
  try {
    await writeFile(path.join(directory, "state.json"), JSON.stringify({ addons: [], defaultsInstalled: true, settings: { concurrentDownloads: 2, audioLanguage: "cs" } }));
    const store = new Store(directory); await store.load();
    assert.equal(store.settings().uiLanguage, "cs");
    assert.equal(store.settings().audioLanguage, "cs");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a fresh install starts in English", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-store-"));
  try {
    const store = new Store(directory); await store.load();
    assert.equal(store.settings().uiLanguage, "en");
    assert.equal(store.settings().audioLanguage, "en");
    assert.equal(store.settings().subtitleLanguage, "en");
    assert.equal(store.settings().downloadTitleLanguage, "ui");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a stored language survives a reload", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-store-"));
  try {
    const first = new Store(directory); await first.load();
    await first.update((state) => { state.settings.uiLanguage = "cs"; });
    const second = new Store(directory); await second.load();
    assert.equal(second.settings().uiLanguage, "cs");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
