import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultInstanceSettings, defaultPrefs, publicSettings, Store } from "./store.js";
import type { AddonRecord } from "./types.js";
import { PERSONAL_SETTINGS } from "./users.js";
import { verifyPassword } from "./auth.js";

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
    // The personal keys have no account to live under yet, so the defaults answer.
    assert.equal(store.prefs(undefined).catalogTileSize, "medium");
    assert.equal(store.prefs(undefined).libraryTileSize, "medium");
    assert.equal(store.prefs(undefined).catalogTileShape, "poster");
    assert.equal(store.prefs(undefined).libraryTileShape, "poster");
    assert.equal(store.settings().realDebridToken, "");
    assert.equal(store.prefs(undefined).downloadTitleLanguage, "ui");
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

test("an install from before the interface was translated keeps Czech, personal keys and all", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-store-"));
  try {
    await writeFile(path.join(directory, "state.json"), JSON.stringify({
      addons: [], defaultsInstalled: true, settings: { concurrentDownloads: 2, audioLanguage: "cs" },
      auth: { username: "Ondra", passwordHash: "scrypt$aa$bb", secret: "tajemstvi" },
    }));
    const store = new Store(directory); await store.load();
    const [user] = store.users();
    // `migrate` runs before `migrateUsers`, so the Czech default lands on the flat settings
    // and travels into the account with the rest of the personal keys.
    assert.equal(store.prefs(user?.id).uiLanguage, "cs");
    assert.equal(store.prefs(user?.id).audioLanguage, "cs", "the value the state already had wins");
    assert.equal("uiLanguage" in store.settings(), false, "and nothing personal is left on the instance");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a fresh install starts in English", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-store-"));
  try {
    const store = new Store(directory); await store.load();
    assert.equal(store.users().length, 0);
    assert.equal(store.prefs(undefined).uiLanguage, "en");
    assert.equal(store.prefs(undefined).audioLanguage, "en");
    assert.equal(store.prefs(undefined).subtitleLanguage, "en");
    assert.equal(store.prefs(undefined).downloadTitleLanguage, "ui");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a stored language survives a reload", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-store-"));
  try {
    const first = new Store(directory); await first.load();
    await first.update((state) => {
      state.users = [{ id: "usr_00000001", username: "owner", passwordHash: "scrypt$aa$bb", secret: "tajemstvi", role: "admin", createdAt: "2026-01-01T00:00:00.000Z", permissions: { downloadToLibrary: true, downloadToDevice: true }, permissionsVersion: 0 }];
      state.userData = { usr_00000001: { prefs: {}, favorites: [], watchlist: {}, progress: {}, watchedSeries: {} } };
    });
    await first.update((state) => { state.userData!.usr_00000001!.prefs.uiLanguage = "cs"; });
    const second = new Store(directory); await second.load();
    assert.equal(second.prefs("usr_00000001").uiLanguage, "cs");
    assert.equal(second.prefs("usr_00000001").subtitleLanguage, "en", "the rest comes from the defaults");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a failed write does not stop the next one from reaching the disk", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-store-"));
  try {
    const store = new Store(directory); await store.load();
    // A directory where state.json.tmp belongs: the rename cannot happen, the write fails.
    await mkdir(path.join(directory, "state.json.tmp"));
    await assert.rejects(store.update((state) => { state.settings.logLevel = "DEBUG"; }));

    await rm(path.join(directory, "state.json.tmp"), { recursive: true });
    await store.update((state) => { state.settings.addonRefreshHours = 6; });

    const reloaded = new Store(directory); await reloaded.load();
    assert.equal(reloaded.settings().logLevel, "DEBUG", "the earlier change is in the state that was saved");
    assert.equal(reloaded.settings().addonRefreshHours, 6);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the personal settings are the keys PERSONAL_SETTINGS names, both ways round", () => {
  const prefs = defaultPrefs();
  const keys = Object.keys(prefs).sort();
  const listed = [...PERSONAL_SETTINGS].sort();
  assert.deepEqual(keys, listed);
  for (const key of PERSONAL_SETTINGS) {
    assert.ok(key in prefs, `${key} is treated as personal but has no default`);
    assert.equal(key in defaultInstanceSettings(), false, `${key} belongs to a person, not to the instance`);
  }
});

/** A realistic file from the release before this one: one account, the four personal maps
 *  beside it and every setting -- both halves -- in one flat object. */
const beforeAccounts = () => ({
  schemaVersion: 2,
  addons: [],
  defaultsInstalled: true,
  settings: {
    concurrentDownloads: 3, parallelPerProvider: 2, downloadSegments: 4,
    libraryAutoScan: false, libraryScanPauseOnDownload: true, secureMode: false, addonRefreshHours: 6,
    defaultMovieLibrary: "lib_00000001", defaultSeriesLibrary: "",
    realDebridToken: "rd-secret", tmdbApiKey: "tmdb-key",
    uiLanguage: "cs", audioLanguage: "cs", subtitleLanguage: "de", downloadTitleLanguage: "en",
    mergeByName: false, streamSort: "size-desc", trackProgress: false, showResumeRow: false,
    catalogTileSize: "large", libraryTileSize: "compact", catalogTileShape: "wide", libraryTileShape: "poster",
  },
  auth: { username: "Ondra", passwordHash: "scrypt$0f0f$1e1e", secret: "tajemstvi", isDefault: false, revoked: { sid1: 4102444800000 } },
  favorites: ["lib_00000001/Film.mkv"],
  watchlist: { "movie:tt2": { type: "movie", id: "tt2", name: "Watch", poster: "img:watch", addedAt: "2026-01-04T00:00:00.000Z" } },
  progress: {
    "file:lib_00000001/Film.mkv": {
      position: 120, duration: 600, title: "Film", path: "lib_00000001/Film.mkv", poster: "img:poster", addonKey: "cinemeta",
      series: { id: "tt1", name: "Show", season: 1, episode: 2 }, updatedAt: "2026-01-02T00:00:00.000Z",
    },
  },
  watchedSeries: { tt1: { name: "Show", poster: "img:show", addonKey: "cinemeta", season: 1, episode: 4, updatedAt: "2026-01-03T00:00:00.000Z" } },
});

test("a state from before the accounts shape migrates and the owner finds their data again", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-store-"));
  try {
    const file = path.join(directory, "state.json");
    await writeFile(file, JSON.stringify(beforeAccounts()));
    const store = new Store(directory); await store.load();
    assert.equal(store.users().length, 1, "the install still has exactly one account, the administrator");
    const user = store.users()[0]!;
    assert.equal(user.username, "Ondra");
    assert.equal(user.role, "admin");
    assert.deepEqual(user.permissions, { downloadToLibrary: true, downloadToDevice: true });
    assert.equal(user.passwordHash, "scrypt$0f0f$1e1e", "the password is carried over untouched");
    assert.equal(user.secret, "tajemstvi", "and so is the secret the sessions are signed with");
    assert.deepEqual(user.revoked, { sid1: 4102444800000 });
    // Read back through the accessors, not off the shape: this is what the interface sees.
    assert.deepEqual(store.userData(user.id).favorites, ["lib_00000001/Film.mkv"]);
    assert.deepEqual(store.userData(user.id).watchlist, beforeAccounts().watchlist);
    assert.deepEqual(store.userData(user.id).progress, beforeAccounts().progress);
    assert.deepEqual(store.userData(user.id).watchedSeries, beforeAccounts().watchedSeries);
    assert.equal(store.prefs(user.id).uiLanguage, "cs");
    assert.equal(store.prefs(user.id).audioLanguage, "cs");
    assert.equal(store.prefs(user.id).subtitleLanguage, "de");
    assert.equal(store.prefs(user.id).downloadTitleLanguage, "en");
    assert.equal(store.prefs(user.id).mergeByName, false);
    assert.equal(store.prefs(user.id).streamSort, "size-desc");
    assert.equal(store.prefs(user.id).trackProgress, false);
    assert.equal(store.prefs(user.id).showResumeRow, false);
    assert.equal(store.prefs(user.id).catalogTileSize, "large");
    assert.equal(store.prefs(user.id).libraryTileSize, "compact");
    assert.equal(store.prefs(user.id).catalogTileShape, "wide");
    assert.equal(store.prefs(user.id).libraryTileShape, "poster");
    // The instance keeps its own half exactly as it was.
    assert.deepEqual(store.settings(), {
      concurrentDownloads: 3, parallelPerProvider: 2, downloadSegments: 4,
      libraryAutoScan: false, libraryScanPauseOnDownload: true, secureMode: false, addonRefreshHours: 6,
      defaultMovieLibrary: "lib_00000001", defaultSeriesLibrary: "",
      realDebridToken: "rd-secret", tmdbApiKey: "tmdb-key",
    });
    // And the file is the new shape, with nothing of the old one left beside it.
    const saved = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    assert.equal(saved.schemaVersion, 3);
    assert.equal(saved.auth, undefined);
    assert.equal(saved.favorites, undefined);
    assert.equal(saved.progress, undefined);
    assert.equal(saved.watchlist, undefined);
    assert.equal(saved.watchedSeries, undefined);
    assert.equal((saved.users as Array<{ id: string }>)[0]?.id, user.id);
    assert.deepEqual(Object.keys(saved.userData as Record<string, unknown>), [user.id]);
    // Loading what the migration wrote changes nothing more.
    const written = await readFile(file, "utf8");
    const again = new Store(directory); await again.load();
    assert.equal(again.users().length, 1);
    assert.deepEqual(again.prefs(user.id), store.prefs(user.id));
    assert.deepEqual(again.userData(user.id).progress, store.userData(user.id).progress);
    assert.equal("uiLanguage" in again.settings(), false, "a migrated state does not read as a pre-i18n one");
    assert.equal(await readFile(file, "utf8"), written, "a migrated state is left byte for byte as it was");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the operator's password reset fires once and is inert on the next boot", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-store-"));
  try {
    const file = path.join(directory, "state.json");
    await writeFile(file, JSON.stringify({
      ...beforeAccounts(),
      settings: { concurrentDownloads: 1 },
    }));
    const first = new Store(directory); await first.load();
    const id = first.users()[0]!.id;
    const hashBefore = first.users()[0]!.passwordHash;

    const applied = await first.resetPasswordFromEnv("Ondra", "nove-heslo");
    assert.equal(applied?.id, id, "the reset answers the account it changed, which is what the boot logs");
    assert.ok(await verifyPassword("nove-heslo", first.users()[0]!.passwordHash));
    const rotated = first.users()[0]!.secret;
    assert.notEqual(rotated, "tajemstvi", "the secret is rotated, so every session signed before it stops working");
    assert.deepEqual(first.envReset()?.userId, id);
    assert.notEqual(first.users()[0]!.passwordHash, hashBefore);

    // The next boot reads the same variable and the same state: what it acted on is written
    // down, so nothing happens and the boot has nothing to log.
    const second = new Store(directory); await second.load();
    assert.equal(await second.resetPasswordFromEnv("Ondra", "nove-heslo"), undefined);
    assert.equal(second.users()[0]!.passwordHash, first.users()[0]!.passwordHash);
    assert.equal(second.users()[0]!.secret, rotated);

    // A different value is a new reset.
    const third = new Store(directory); await third.load();
    assert.equal((await third.resetPasswordFromEnv("Ondra", "jine-heslo"))?.id, id);
    assert.ok(await verifyPassword("jine-heslo", third.users()[0]!.passwordHash));

    // A name nobody has resets nothing, however the variable is set.
    const fourth = new Store(directory); await fourth.load();
    assert.equal(await fourth.resetPasswordFromEnv("nikdo", "dalsi-heslo"), undefined);
    assert.equal(fourth.users()[0]!.passwordHash, third.users()[0]!.passwordHash);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an environment install keeps the history and the language it already had", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "store-env-claim-"));
  // An install configured only with the variables never had an `auth` block, so `migrateUsers`
  // has nothing to migrate and leaves everything at the top level in the shape that predates
  // accounts. Without a claim the account is created beside it and reads none of it: the
  // history comes back empty and the interface reverts to the built-in English.
  await writeFile(path.join(dir, "state.json"), JSON.stringify({
    settings: { uiLanguage: "cs", audioLanguage: "cs", concurrentDownloads: 4 },
    favorites: ["lib_1/Film"],
    watchlist: { "movie:tt1": { type: "movie", id: "tt1" } },
    progress: { "file:lib_1/Film.mkv": { position: 12, duration: 100 } },
    watchedSeries: { "tt2": { name: "Show" } },
    addons: [], libraries: [],
  }), "utf8");

  const store = new Store(dir, path.join(dir, "downloads"));
  await store.load();
  const adopted = (await store.adoptEnvCredentials({ username: "ondra", password: "tajneheslo" }))!;
  assert.ok(adopted);

  const data = store.userData(adopted.id);
  assert.deepEqual(data.favorites, ["lib_1/Film"]);
  assert.deepEqual(Object.keys(data.watchlist), ["movie:tt1"]);
  assert.deepEqual(Object.keys(data.progress), ["file:lib_1/Film.mkv"]);
  assert.deepEqual(Object.keys(data.watchedSeries), ["tt2"]);
  assert.equal(store.prefs(adopted.id).uiLanguage, "cs");
  assert.equal(store.prefs(adopted.id).audioLanguage, "cs");
  // The personal half leaves the instance half behind, as it does in the other migration.
  assert.equal("uiLanguage" in store.settings(), false);
  assert.equal(store.settings().concurrentDownloads, 4);
});

test("an install running only on the environment credentials gets a real administrator", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "store-env-adopt-"));
  const store = new Store(dir, path.join(dir, "downloads"));
  await store.load();
  assert.deepEqual(store.users(), [], "nothing is stored before the credentials are adopted");

  const adopted = await store.adoptEnvCredentials({ username: "ondra", password: "tajneheslo" });
  assert.ok(adopted, "the credentials become an account");
  assert.equal(adopted.role, "admin");
  assert.ok(await verifyPassword("tajneheslo", adopted.passwordHash));
  assert.equal(store.envReset(), undefined, "adoption tracks no reset: that is a different variable");

  // A second boot must not mint a second administrator.
  const again = new Store(dir, path.join(dir, "downloads"));
  await again.load();
  assert.equal(again.users().length, 1);
  assert.equal(await again.adoptEnvCredentials({ username: "ondra", password: "tajneheslo" }), undefined);
  assert.equal(again.users().length, 1);
  assert.equal(again.users()[0].id, adopted.id, "the account keeps the id rows are filed under");
});
