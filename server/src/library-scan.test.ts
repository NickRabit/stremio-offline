import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LibraryScan, type LibraryScanOpts, type ScanPauseReason } from "./library-scan.js";
import type { LibraryEpisodeRecord, LibraryMetaRecord, LibrarySuggestion, TitleUnit } from "./library-match.js";
import type { MetaItem } from "./types.js";

const movie = (key: string): TitleUnit => ({ key, kind: "movie", relative: key, sampleFiles: [`${key}/a.mkv`] });
const series = (key: string): TitleUnit => ({ key, kind: "series", relative: key, sampleFiles: [`${key}/a.mkv`] });
const TTL = 14 * 24 * 60 * 60_000;
const stale = () => new Date(Date.now() - TTL - 60_000).toISOString();
const hit = (name: string, id = "tt1"): MetaItem =>
  ({ id, type: "movie", name, releaseInfo: "2020", poster: "http://x/p.jpg", background: "http://x/b.jpg", description: "Plot" });

const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 2_000) => {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const harness = async (overrides: Partial<LibraryScanOpts> = {}) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "stremio-scan-"));
  const store: {
    meta: Record<string, LibraryMetaRecord>;
    suggestions: Record<string, LibrarySuggestion>;
    episodes: Record<string, LibraryEpisodeRecord>;
  } = { meta: {}, suggestions: {}, episodes: {} };
  const posters: string[] = [];
  const posterBackdrops: string[] = [];
  const backdrops: string[] = [];
  const deleted: string[] = [];
  const searches: string[] = [];
  const metas: string[] = [];
  const frames: string[] = [];
  let busy: ScanPauseReason | undefined;
  const opts: LibraryScanOpts = {
    dataDir,
    units: async () => [movie("Foo")],
    searchAll: async (_addons, query) => {
      searches.push(query);
      return { items: [hit(query)] };
    },
    metadata: async (_addons, type, id) => hit("Foo", id),
    addons: () => [],
    libraryMeta: () => store.meta,
    librarySuggestions: () => store.suggestions,
    updateMeta: async (mutator) => { mutator(store.meta, store.suggestions, store.episodes); },
    savePoster: (key, _url, backdrop) => { posters.push(key); if (backdrop) posterBackdrops.push(backdrop); },
    fillWideArtwork: (key) => { backdrops.push(key); },
    deleteGeneratedArt: async (key) => { deleted.push(key); },
    busy: () => busy,
    pathExists: async () => true,
    gapMs: 0,
    wakeMs: 20,
    ...overrides,
  };
  // The wrapper sits outside the overrides so a test that brings its own metadata
  // implementation still shows up in `metas`.
  const scan = new LibraryScan({
    ...opts,
    metadata: async (addons, type, id) => { metas.push(id); return opts.metadata(addons, type, id); },
  });
  return {
    dataDir, scan, store, posters, posterBackdrops, backdrops, deleted, searches, metas, frames,
    setBusy: (value: ScanPauseReason | undefined) => { busy = value; },
    close: async () => { await scan.stop(); await rm(dataDir, { recursive: true, force: true }); },
  };
};

test("a unique title auto-accepts, deletes hashed art and saves both catalog variants", async () => {
  const h = await harness();
  try {
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.scan.snapshot().matched, 1);
    assert.equal(h.store.meta.Foo?.id, "tt1");
    assert.equal(h.store.meta.Foo?.source, "scan");
    assert.equal(h.store.meta.Foo?.locked, false);
    assert.deepEqual(h.deleted, ["Foo"]);
    assert.deepEqual(h.posters, ["Foo"]);
    assert.deepEqual(h.posterBackdrops, ["http://x/b.jpg"], "the background of the match rides along");
    assert.deepEqual(h.frames, []);
  } finally { await h.close(); }
});

test("the run asks for the wide variant of every entry it walks, bound or not", async () => {
  const h = await harness({ units: async () => [movie("Foo"), movie("Bar")] });
  try {
    h.store.meta.Bar = { type: "movie", id: "tt9", source: "scan" };
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.scan.snapshot().matched, 1, "only the unbound title is matched again");
    assert.deepEqual([...h.backdrops].sort(), ["Bar", "Foo"]);
  } finally { await h.close(); }
});

test("a run held back by playback asks for the wide variants once it may work", async () => {
  const h = await harness();
  try {
    h.setBusy("playback");
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "paused");
    assert.deepEqual(h.backdrops, [], "nothing is generated while a video plays");
    h.setBusy(undefined);
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.deepEqual(h.backdrops, ["Foo"]);
  } finally { await h.close(); }
});

test("excluding a parent folder skips child title units", async () => {
  const h = await harness({
    units: async () => [movie("Movies/Title")],
  });
  try {
    h.store.meta.Movies = { type: "movie", id: "", source: "user", skipLookup: true };
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.scan.snapshot().total, 0);
    assert.equal(h.searches.length, 0);
  } finally { await h.close(); }
});

test("catalog lookup skipped on a title is not searched", async () => {
  const h = await harness({ gapMs: 200 });
  try {
    h.store.meta.Foo = { type: "movie", id: "", source: "user", skipLookup: true };
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.scan.snapshot().total, 0);
    assert.equal(h.scan.snapshot().matched, 0);
    assert.equal(h.searches.length, 0);
  } finally { await h.close(); }
});

test("a nameless search hit does not fail the unit", async () => {
  const h = await harness({
    searchAll: async () => ({ items: [{ id: "x", type: "movie" } as MetaItem, hit("Foo")] }),
  });
  try {
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.scan.snapshot().failed, 0);
    assert.equal(h.scan.snapshot().matched, 1);
  } finally { await h.close(); }
});

test("bound and locked units never enter the queue", async () => {
  const h = await harness({ gapMs: 200 });
  try {
    h.store.meta.Foo = { type: "movie", id: "tt1", source: "download", locked: true };
    const started = Date.now();
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.scan.snapshot().total, 0);
    assert.equal(h.scan.snapshot().matched, 0);
    assert.equal(h.searches.length, 0);
    assert.ok(Date.now() - started < 200);
  } finally { await h.close(); }
});

test("a user lock taken during search is not overwritten", async () => {
  const h = await harness({
    searchAll: async () => {
      h.store.meta.Foo = { type: "movie", id: "tt-user", source: "user", locked: true };
      return { items: [hit("Foo")] };
    },
  });
  try {
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.store.meta.Foo?.id, "tt-user");
    assert.equal(h.scan.snapshot().matched, 0);
    assert.equal(h.posters.length, 0);
  } finally { await h.close(); }
});

test("load retries the in-flight key still listed in remaining", async () => {
  const h = await harness({
    units: async () => [movie("Foo"), movie("Bar")],
    searchAll: async (_addons, query) => ({ items: [hit(query, query === "Foo" ? "tt-foo" : "tt-bar")] }),
  });
  try {
    await writeFile(path.join(h.dataDir, "library-scan.json"), JSON.stringify({
      status: "running", total: 2, done: 0, matched: 0, skipped: 0, failed: 0,
      remaining: ["Foo", "Bar"], current: "Foo",
    }));
    await h.scan.load();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.scan.snapshot().matched, 2);
    assert.equal(h.store.meta.Foo?.id, "tt-foo");
    assert.equal(h.store.meta.Bar?.id, "tt-bar");
  } finally { await h.close(); }
});

test("a scan state the upgrade left behind starts idle instead of skipping everything", async () => {
  const h = await harness({ units: async () => [movie("lib_aaaaaaaa/Foo"), movie("lib_aaaaaaaa/Bar")] });
  try {
    await writeFile(path.join(h.dataDir, "library-scan.json"), JSON.stringify({
      status: "running", total: 2, done: 1, matched: 0, skipped: 1, failed: 0,
      remaining: ["Foo"], current: "Foo",
    }));
    await h.scan.load();
    assert.equal(h.scan.snapshot().status, "idle", "the run is dropped rather than resumed against keys nobody has");
    assert.deepEqual(h.scan.snapshot().remaining, []);
    assert.deepEqual(h.searches, [], "and it asks the catalogues nothing on its own");
  } finally { await h.close(); }
});

test("start while running or paused returns the current snapshot", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = await harness({
    searchAll: async (_addons, query) => {
      await gate;
      return { items: [hit(query)] };
    },
  });
  try {
    const first = await h.scan.start();
    const second = await h.scan.start();
    assert.equal(first.status, "running");
    assert.equal(second.status, "running");
    assert.deepEqual(second.remaining, first.remaining);
    release();
    await waitFor(() => h.scan.snapshot().status === "completed");
  } finally { await h.close(); }
});

test("the scan pauses while busy and resumes when clear", async () => {
  const h = await harness();
  try {
    h.setBusy("playback");
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "paused");
    assert.equal(h.scan.snapshot().pauseReason, "playback");
    h.setBusy(undefined);
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.scan.snapshot().matched, 1);
  } finally { await h.close(); }
});

test("a second run of an already-matched library has nothing to do", async () => {
  const h = await harness();
  try {
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    const searches = h.searches.length;
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed" && h.scan.snapshot().total === 0);
    assert.equal(h.scan.snapshot().matched, 0);
    assert.equal(h.searches.length, searches);
  } finally { await h.close(); }
});

test("a unit searched in vain is remembered and skipped, until a forced rescan", async () => {
  const h = await harness({ searchAll: async (_addons, query) => { searches.push(query); return { items: [] }; } });
  const searches: string[] = [];
  try {
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(searches.length, 1);
    assert.ok(h.store.suggestions.Foo?.scannedAt);
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed" && h.scan.snapshot().total === 0);
    assert.equal(searches.length, 1);
    await h.scan.start({ force: true });
    await waitFor(() => h.scan.snapshot().status === "completed" && h.scan.snapshot().done === 1);
    assert.equal(searches.length, 2);
  } finally { await h.close(); }
});

test("a browsed series past the TTL is re-read, and keeps the binding it had", async () => {
  const h = await harness({
    units: async () => [series("lib_aaaaaaaa/Show")],
    browsed: () => new Set(["lib_aaaaaaaa"]),
    metaTtlMs: TTL,
    metadata: async (_addons, _type, id) => ({ id, type: "series", name: "Show, refreshed", releaseInfo: "1995" }),
  });
  const before = stale();
  try {
    h.store.meta["lib_aaaaaaaa/Show"] = { type: "series", id: "tt1", source: "user", locked: true, name: "Show", matchedAt: before, refreshedAt: before };
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    const record = h.store.meta["lib_aaaaaaaa/Show"]!;
    assert.deepEqual(h.metas, ["tt1"], "one metadata call, no search");
    assert.deepEqual(h.searches, []);
    assert.equal(record.name, "Show, refreshed");
    assert.equal(record.source, "user", "a refresh does not take the binding over");
    assert.equal(record.locked, true);
    assert.equal(record.matchedAt, before, "the match date stays the date it was matched");
    assert.notEqual(record.refreshedAt, before);
    assert.equal(h.scan.snapshot().matched, 0, "a refresh is not a new match");
    assert.deepEqual(h.deleted, [], "the poster the binding already has is left alone");
  } finally { await h.close(); }
});

test("a movie, a library nobody looked at and a switched-off TTL are left alone", async () => {
  const setup = async (overrides: Partial<LibraryScanOpts>, type: "movie" | "series") => {
    const h = await harness({ units: async () => [type === "movie" ? movie("lib_aaaaaaaa/Film") : series("lib_aaaaaaaa/Show")], ...overrides });
    const key = h.store.meta[type === "movie" ? "lib_aaaaaaaa/Film" : "lib_aaaaaaaa/Show"] = {
      type, id: "tt1", source: "scan", locked: false, name: "Title", year: "1995", description: "Plot", refreshedAt: stale(),
    } as never;
    return { h, key };
  };
  const browsed = () => new Set(["lib_aaaaaaaa"]);

  const movieCase = await setup({ browsed, metaTtlMs: TTL }, "movie");
  try {
    await movieCase.h.scan.start();
    await waitFor(() => movieCase.h.scan.snapshot().status === "completed");
    assert.deepEqual(movieCase.h.metas, [], "a movie binding carries all it will ever carry");
  } finally { await movieCase.h.close(); }

  const unbrowsed = await setup({ metaTtlMs: TTL, browsed: () => new Set() }, "series");
  try {
    await unbrowsed.h.scan.start();
    await waitFor(() => unbrowsed.h.scan.snapshot().status === "completed");
    assert.deepEqual(unbrowsed.h.metas, [], "a library nobody opened does not pay for the pass");
  } finally { await unbrowsed.h.close(); }

  const off = await setup({ browsed, metaTtlMs: 0 }, "series");
  try {
    await off.h.scan.start();
    await waitFor(() => off.h.scan.snapshot().status === "completed");
    assert.deepEqual(off.h.metas, [], "a zero TTL switches the pass off");
  } finally { await off.h.close(); }
});

test("IMDb in the path is an exact metadata lookup without search", async () => {
  const lookups: string[] = [];
  const h = await harness({
    units: async () => [movie("Show {imdb-tt123}")],
    pathExists: async () => true,
    metadata: async (_addons, type, id) => {
      lookups.push(`${type}:${id}`);
      return { id, type: "series", name: "Show", releaseInfo: "1995" };
    },
  });
  try {
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.searches.length, 0);
    assert.ok(lookups.some((item) => item.endsWith(":tt123")));
    assert.equal(h.scan.snapshot().matched, 1);
  } finally { await h.close(); }
});

test("missing paths skip and persist without an addon call", async () => {
  const h = await harness({ pathExists: async () => false });
  try {
    await h.scan.start();
    // The scan turns the status in memory before the save lands, so waiting on the
    // snapshot alone would read the file too early.
    const saved = async () => JSON.parse(await readFile(path.join(h.dataDir, "library-scan.json"), "utf8")) as { status: string; skipped: number };
    await waitFor(async () => h.scan.snapshot().status === "completed" && (await saved()).status === "completed");
    assert.equal(h.scan.snapshot().skipped, 1);
    assert.equal(h.searches.length, 0);
    assert.equal((await saved()).skipped, 1);
  } finally { await h.close(); }
});

test("a scan for one item leaves the rest of the library alone", async () => {
  const searches: string[] = [];
  const h = await harness({
    units: async () => [movie("Foo"), movie("Bar")],
    searchAll: async (_addons, query) => { searches.push(query); return { items: [] }; },
  });
  try {
    await h.scan.start({ path: "Bar" });
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.scan.snapshot().total, 1);
    assert.deepEqual(searches, ["Bar"]);
    // Asking for one item overrides the memory of an earlier fruitless search.
    await h.scan.start({ path: "Bar" });
    await waitFor(() => h.scan.snapshot().status === "completed" && h.scan.snapshot().done === 1);
    assert.deepEqual(searches, ["Bar", "Bar"]);
  } finally { await h.close(); }
});

test("a scan for one file covers the title unit that holds it", async () => {
  const searches: string[] = [];
  const h = await harness({
    searchAll: async (_addons, query) => { searches.push(query); return { items: [] }; },
  });
  try {
    await h.scan.start({ path: path.join("Foo", "a.mkv") });
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.deepEqual(searches, ["Foo"]);
  } finally { await h.close(); }
});
