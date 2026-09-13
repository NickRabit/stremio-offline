import assert from "node:assert/strict";
import { test } from "node:test";
import { autoRefreshEnabled, manifestChanged, normalizeRefreshHours, refreshDue, refreshManifests } from "./addon-refresh.js";
import type { AddonRecord, StremioManifest } from "./types.js";
import { defaultDownloadSettings } from "./naming.js";

const manifest = (over: Partial<StremioManifest> = {}): StremioManifest =>
  ({ id: "org.example", name: "Example", version: "1.0.0", resources: ["stream"], types: ["movie"], ...over }) as StremioManifest;

const record = (over: Partial<AddonRecord> = {}): AddonRecord => ({
  key: "a", manifestUrl: "https://example.test/manifest.json", role: "both", enabled: true, globalSearch: true,
  addedAt: "2024-01-01T00:00:00.000Z", manifest: manifest(), downloadSettings: defaultDownloadSettings(), ...over,
});

test("a newer manifest is reported as changed and handed back", async () => {
  const addon = record();
  const outcomes = await refreshManifests([addon], async () => record({ manifest: manifest({ version: "1.1.0" }) }));
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].changed, true);
  assert.equal(outcomes[0].previousVersion, "1.0.0");
  assert.equal(outcomes[0].version, "1.1.0");
  assert.equal(outcomes[0].manifest?.version, "1.1.0");
});

test("an identical manifest is not a change", async () => {
  const outcomes = await refreshManifests([record()], async () => record());
  assert.equal(outcomes[0].changed, false);
  assert.equal(outcomes[0].error, undefined);
});

test("a catalogue added by the provider counts as a change", async () => {
  const grown = manifest({ catalogs: [{ type: "movie", id: "top" }] });
  const outcomes = await refreshManifests([record()], async () => record({ manifest: grown }));
  assert.equal(outcomes[0].changed, true);
  assert.deepEqual(outcomes[0].manifest?.catalogs, [{ type: "movie", id: "top" }]);
});

test("a provider that fails keeps the manifest we already have", async () => {
  const outcomes = await refreshManifests([record()], async () => { throw new Error("HTTP 503"); });
  assert.equal(outcomes[0].changed, false);
  assert.equal(outcomes[0].manifest, undefined);
  assert.equal(outcomes[0].version, "1.0.0");
  assert.match(String(outcomes[0].error), /503/);
});

test("one failure does not stop the addons behind it", async () => {
  const asked: string[] = [];
  const targets = [record({ key: "a" }), record({ key: "b", manifestUrl: "https://second.test/manifest.json" })];
  const outcomes = await refreshManifests(targets, async (url) => {
    asked.push(url);
    if (url.includes("example")) throw new Error("down");
    return record({ manifest: manifest({ version: "2.0.0" }) });
  });
  assert.deepEqual(asked, ["https://example.test/manifest.json", "https://second.test/manifest.json"]);
  assert.equal(outcomes[0].error !== undefined, true);
  assert.equal(outcomes[1].changed, true);
});

test("the role of the stored record is what the manifest is fetched as", async () => {
  const roles: string[] = [];
  await refreshManifests([record({ role: "catalog" })], async (_url, role) => { roles.push(role); return record(); });
  assert.deepEqual(roles, ["catalog"]);
});

test("manifestChanged ignores nothing but equality", () => {
  assert.equal(manifestChanged(manifest(), manifest()), false);
  assert.equal(manifestChanged(manifest(), manifest({ description: "new" })), true);
});

test("an unknown interval falls back to a day, and nothing else is accepted", () => {
  assert.equal(normalizeRefreshHours(undefined), 24);
  assert.equal(normalizeRefreshHours("nonsense"), 24);
  assert.equal(normalizeRefreshHours(7), 24);
  assert.equal(normalizeRefreshHours(-6), 24);
  assert.equal(normalizeRefreshHours(0), 0);
  assert.equal(normalizeRefreshHours("6"), 6);
  assert.equal(normalizeRefreshHours(168), 168);
});

test("a round is due when the interval has passed, never when it is off", () => {
  const now = Date.parse("2026-01-02T00:00:00.000Z");
  assert.equal(refreshDue(undefined, 24, now), true);
  assert.equal(refreshDue(undefined, 0, now), false);
  assert.equal(refreshDue("2026-01-01T00:00:00.000Z", 24, now), true);
  assert.equal(refreshDue("2026-01-01T00:00:01.000Z", 24, now), false);
  assert.equal(refreshDue("2026-01-01T18:00:00.000Z", 6, now), true);
  assert.equal(refreshDue("not a date", 24, now), true);
  assert.equal(refreshDue("2026-01-01T00:00:00.000Z", 0, now), false);
});

test("the environment can switch the automatic round off entirely", (t) => {
  const previous = process.env.ADDON_AUTO_REFRESH;
  t.after(() => { if (previous === undefined) delete process.env.ADDON_AUTO_REFRESH; else process.env.ADDON_AUTO_REFRESH = previous; });
  delete process.env.ADDON_AUTO_REFRESH;
  assert.equal(autoRefreshEnabled(), true);
  process.env.ADDON_AUTO_REFRESH = "1";
  assert.equal(autoRefreshEnabled(), true);
  process.env.ADDON_AUTO_REFRESH = "0";
  assert.equal(autoRefreshEnabled(), false);
});
