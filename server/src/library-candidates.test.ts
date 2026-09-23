import assert from "node:assert/strict";
import test from "node:test";
import { LibraryCandidates, type LibraryCandidate } from "./library-candidates.js";
import type { AddonRecord, MetaItem } from "./types.js";
import type { TmdbConfig } from "./tmdb.js";

const addon = (id: string, name: string, enabled = true): AddonRecord => ({
  key: id, manifestUrl: `https://${id}/manifest.json`, role: "catalog", enabled, globalSearch: false,
  addedAt: "2024-01-01T00:00:00.000Z", manifest: { id, name, version: "1", resources: ["catalog"], catalogs: [] },
  downloadSettings: { movie: { subfolder: "", layout: "structured" }, series: { subfolder: "", layout: "structured" } },
});

const cinemeta = addon("com.linvo.cinemeta", "Cinemeta");
const pornhub = addon("org.pornhub", "Pornhub");

const meta = (over: Partial<MetaItem> & { id: string; name: string }): MetaItem => ({ type: "movie", ...over });

const config: TmdbConfig = { apiKey: "key", language: "en" };

interface Calls { tmdb: string[]; cinemeta: string[]; external: number[]; gallery: string[]; logs: Array<{ level: string; message: string; fields: Record<string, unknown> }> }

const service = (options: {
  tmdb?: TmdbConfig | undefined;
  addons?: AddonRecord[];
  tmdbItems?: (query: string) => MetaItem[];
  cinemetaItems?: (query: string, kind: string) => MetaItem[];
  externalId?: string | null | ((kind: string, id: number) => string | null);
  gallery?: Array<{ url: string; kind: "poster" | "background" | "logo" }>;
  throwTmdb?: boolean;
  throwCinemeta?: boolean;
} = {}) => {
  const calls: Calls = { tmdb: [], cinemeta: [], external: [], gallery: [], logs: [] };
  const candidates = new LibraryCandidates({
    tmdb: () => options.tmdb,
    addons: () => options.addons ?? [cinemeta, pornhub],
    searchTmdb: async (_kind, query, _config: TmdbConfig) => {
      calls.tmdb.push(query);
      if (options.throwTmdb) throw new Error("TMDB is down");
      return options.tmdbItems?.(query) ?? [];
    },
    searchCinemeta: async (_addons, query, kind) => {
      calls.cinemeta.push(query);
      if (options.throwCinemeta) throw new Error("Cinemeta is down");
      return options.cinemetaItems?.(query, kind) ?? [];
    },
    externalId: async (_kind, id) => {
      calls.external.push(id);
      return typeof options.externalId === "function" ? options.externalId("movie", id) : options.externalId ?? null;
    },
    gallery: async (_kind, id) => { calls.gallery.push(id); return options.gallery ?? []; },
    log: (level, message, fields) => { calls.logs.push({ level, message, fields: fields ?? {} }); },
  });
  return { candidates, calls };
};

test("a configured TMDB key takes the title search, and Cinemeta is not asked", async () => {
  const { candidates, calls } = service({
    tmdb: config,
    tmdbItems: () => [meta({ id: "tmdb:1", name: "Flashdance", releaseInfo: "1983" })],
    cinemetaItems: () => [meta({ id: "tt0085549", name: "Flashdance" })],
  });
  const found = await candidates.searchLibraryCandidates("Flashdance", "movie", 1983, "cs");
  assert.deepEqual(found.map((entry) => [entry.provider, entry.item.id]), [["tmdb", "tmdb:1"]]);
  assert.deepEqual(calls.tmdb, ["Flashdance"]);
  assert.deepEqual(calls.cinemeta, [], "the fallback is not asked when the first provider answered");
});

test("an addon that is neither TMDB nor Cinemeta is never searched", async () => {
  // The row a scan bound "Flashdance" to came from a catalogue addon. It is not a candidate
  // any more: only Cinemeta may answer when TMDB has no key.
  const { candidates, calls } = service({
    cinemetaItems: (query) => [meta({ id: `tt-${query}`, name: query })],
  });
  const found = await candidates.searchLibraryCandidates("Flashdance", "movie", undefined, "en");
  assert.deepEqual(found.map((entry) => entry.provider), ["cinemeta"]);
  assert.equal(calls.cinemeta.length, 1);
  assert.deepEqual(calls.tmdb, []);
});

test("a TMDB answer with nothing plausible falls through to Cinemeta", async () => {
  const { candidates, calls } = service({
    tmdb: config,
    tmdbItems: () => [meta({ id: "tmdb:77", name: "Something else entirely" })],
    cinemetaItems: () => [meta({ id: "tt0085549", name: "Flashdance", releaseInfo: "1983" })],
  });
  const found = await candidates.searchLibraryCandidates("Flashdance", "movie", 1983, "en");
  assert.deepEqual(found.map((entry) => [entry.provider, entry.item.id]), [["cinemeta", "tt0085549"]]);
  assert.deepEqual(calls.cinemeta, ["Flashdance"]);
});

test("a refused or broken TMDB search falls through to Cinemeta without logging the key", async () => {
  const refused = service({ tmdb: config, throwTmdb: true, cinemetaItems: () => [meta({ id: "tt1", name: "Flashdance" })] });
  const found = await refused.candidates.searchLibraryCandidates("Flashdance", "movie", undefined, "en");
  assert.deepEqual(found.map((entry) => entry.item.id), ["tt1"]);
  assert.equal(JSON.stringify(refused.calls.logs).includes("key"), false);

  const empty = service({ tmdb: config, tmdbItems: () => [], cinemetaItems: () => [] });
  assert.deepEqual(await empty.candidates.searchLibraryCandidates("Flashdance", "movie", undefined, "en"), []);
});

test("a Cinemeta failure is reported and answers nothing rather than throwing", async () => {
  const { candidates, calls } = service({ throwCinemeta: true });
  assert.deepEqual(await candidates.searchLibraryCandidates("Flashdance", "movie", undefined, "en"), []);
  assert.equal(calls.logs.some((entry) => entry.level === "WARN" && entry.message.includes("Cinemeta")), true);
});

test("a missing Cinemeta addon is not an error, it is an empty list", async () => {
  const { candidates } = service({ addons: [pornhub], cinemetaItems: () => [meta({ id: "tt1", name: "Flashdance" })] });
  assert.deepEqual(await candidates.searchLibraryCandidates("Flashdance", "movie", undefined, "en"), []);
});

test("a disabled Cinemeta addon is not asked", async () => {
  const { candidates, calls } = service({ addons: [addon("com.linvo.cinemeta", "Cinemeta", false)], cinemetaItems: () => [meta({ id: "tt1", name: "x" })] });
  assert.deepEqual(await candidates.searchLibraryCandidates("Flashdance", "movie", undefined, "en"), []);
  assert.deepEqual(calls.cinemeta, []);
});

test("the chosen candidate becomes an IMDb id when TMDB has one, and keeps its TMDB id when it has not", async () => {
  const resolved = service({ tmdb: config, externalId: "tt0085549" });
  const candidate: LibraryCandidate = { item: meta({ id: "tmdb:1", name: "Flashdance" }), provider: "tmdb" };
  const chosen = await resolved.candidates.resolveSelected(candidate, "movie", "en");
  assert.equal(chosen.id, "tt0085549");
  assert.equal(chosen.tmdbId, "tmdb:1");
  assert.deepEqual(resolved.calls.external, [1]);

  const absent = service({ tmdb: config, externalId: null });
  assert.equal((await absent.candidates.resolveSelected(candidate, "movie", "en")).id, "tmdb:1");
  assert.equal((await absent.candidates.resolveSelected({ ...candidate, provider: "cinemeta" }, "movie", "en")).id, "tmdb:1");
  assert.deepEqual(absent.calls.external, [1], "the resolution is asked only for a TMDB candidate");
});

test("alternate artwork is asked for the chosen candidate only, and never without TMDB", async () => {
  const { candidates, calls } = service({
    tmdb: config,
    gallery: [{ url: "https://image.tmdb.org/t/p/w500/alt.jpg", kind: "poster" }],
  });
  const candidate: LibraryCandidate = { item: meta({ id: "tmdb:1", name: "Flashdance" }), provider: "tmdb" };
  assert.deepEqual(await candidates.galleryOf(candidate, "movie", "en"), [{ url: "https://image.tmdb.org/t/p/w500/alt.jpg", kind: "poster" }]);
  assert.deepEqual(calls.gallery, ["tmdb:1"]);
  assert.deepEqual(await candidates.galleryOf({ ...candidate, provider: "cinemeta" }, "movie", "en"), []);

  const keyless = service({ gallery: [{ url: "https://image.tmdb.org/t/p/w500/alt.jpg", kind: "poster" }] });
  assert.deepEqual(await keyless.candidates.galleryOf(candidate, "movie", "en"), []);
});

test("an empty query is answered without reaching any provider", async () => {
  const { candidates, calls } = service({ tmdb: config });
  assert.deepEqual(await candidates.searchLibraryCandidates("   ", "movie", undefined, "en"), []);
  assert.deepEqual(calls.tmdb, []);
  assert.deepEqual(calls.cinemeta, []);
});
