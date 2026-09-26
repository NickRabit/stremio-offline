import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LibraryScan, type LibraryScanOpts, type ScanPauseReason } from "./library-scan.js";
import type { LibraryCandidate, LibraryCandidateSource } from "./library-candidates.js";
import { MATCH_RULE_VERSION, type LibraryEpisodeRecord, type LibraryMetaRecord, type LibrarySuggestion, type TitleUnit } from "./library-match.js";
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

/** The trusted search the scan is handed: only these candidates can ever be bound. */
type Search = (query: string, kind: "movie" | "series", year: number | undefined, extra?: string[]) => Promise<MetaItem[]>;

const harness = async (overrides: Partial<LibraryScanOpts> & { search?: Search; gallery?: (candidate: LibraryCandidate) => Promise<Array<{ url: string; kind: "poster" | "background" | "logo" }>> } = {}) => {
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
  const extraSearches: string[][] = [];
  const metas: string[] = [];
  const frames: string[] = [];
  const galleries: Array<{ key: string; pictures: Array<{ url: string; kind: string }> }> = [];
  let busy: ScanPauseReason | undefined;
  const search: Search = overrides.search ?? (async (query) => [hit(query)]);
  const candidates: LibraryCandidateSource = {
    searchLibraryCandidates: async (query, kind, year, _language, extra) => {
      searches.push(query);
      extraSearches.push(extra ?? []);
      return (await search(query, kind, year, extra)).map((item) => ({ item, provider: "cinemeta" as const }));
    },
    resolveSelected: async (candidate) => candidate.item,
    galleryOf: async (candidate) => (overrides.gallery ? overrides.gallery(candidate) : []),
  };
  const opts: LibraryScanOpts = {
    dataDir,
    units: async () => [movie("Foo")],
    candidates,
    metadata: async (_addons, type, id) => hit("Foo", id),
    addons: () => [],
    libraryMeta: () => store.meta,
    librarySuggestions: () => store.suggestions,
    updateMeta: async (mutator) => { mutator(store.meta, store.suggestions, store.episodes); },
    savePoster: (key, _url, backdrop) => { posters.push(key); if (backdrop) posterBackdrops.push(backdrop); },
    saveGallery: (key, pictures) => { galleries.push({ key, pictures: pictures.map((picture) => ({ url: picture.url, kind: picture.kind })) }); },
    fillWideArtwork: (key) => { backdrops.push(key); },
    deleteGeneratedArt: async (key) => { deleted.push(key); },
    busy: () => busy,
    pathExists: async () => true,
    automaticLibraryEnabled: () => true,
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
    dataDir, scan, store, posters, posterBackdrops, backdrops, deleted, searches, extraSearches, metas, frames, galleries,
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

test("the run asks for the wide variant only for entries it will reconsider", async () => {
  const h = await harness({ units: async () => [movie("Foo"), movie("Bar")] });
  try {
    h.store.meta.Bar = { type: "movie", id: "tt9", source: "scan" };
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.scan.snapshot().matched, 1, "only the unbound title is matched again");
    assert.deepEqual([...h.backdrops].sort(), ["Foo"]);
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
    search: async () => [{ id: "x", type: "movie" } as MetaItem, hit("Foo")],
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
    search: async () => {
      h.store.meta.Foo = { type: "movie", id: "tt-user", source: "user", locked: true };
      return [hit("Foo")];
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
    search: async (query) => [hit(query, query === "Foo" ? "tt-foo" : "tt-bar")],
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
    search: async (query) => {
      await gate;
      return [hit(query)];
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
  const h = await harness({ search: async (query) => { searches.push(query); return []; } });
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
    search: async (query) => { searches.push(query); return []; },
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
    search: async (query) => { searches.push(query); return []; },
  });
  try {
    await h.scan.start({ path: path.join("Foo", "a.mkv") });
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.deepEqual(searches, ["Foo"]);
  } finally { await h.close(); }
});

test("an automatic run asks only about the libraries it was given", async () => {
  const queries: string[] = [];
  const h = await harness({
    units: async () => [
      movie("lib_aaaaaaaa/Alpha"),
      series("lib_cccccccc/Omega"),
      movie("lib_cccccccc/Other"),
    ],
    browsed: () => new Set(["lib_aaaaaaaa", "lib_cccccccc"]),
    metaTtlMs: TTL,
    search: async (query) => { queries.push(query); return [hit(query, `tt-${query}`)]; },
  });
  const before = stale();
  const bound = h.store.meta["lib_cccccccc/Omega"] = {
    type: "series", id: "tt-cccc", source: "user", locked: true, name: "Omega", matchedAt: before, refreshedAt: before,
  };
  try {
    await h.scan.start({ automatic: true, libraryIds: ["lib_aaaaaaaa"] });
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.deepEqual(queries, ["Alpha"], "the library outside the ids is never searched");
    assert.deepEqual(h.metas, ["tt-Alpha"], "and its follow-up metadata is asked only for what is in scope");
    assert.equal(bound.name, "Omega", "the opted-out library's bound title was not refreshed");
    assert.equal(bound.refreshedAt, before);
    assert.equal(h.store.meta["lib_cccccccc/Other"], undefined, "and its unbound title was not looked up");

    // The same titles do get their turn once the run names that library: the filter is
    // what kept them out above, not the absence of anything to do.
    await h.scan.start({ automatic: true, libraryIds: ["lib_cccccccc"] });
    await waitFor(() => h.scan.snapshot().status === "completed" && h.scan.snapshot().done === 2);
    assert.ok(h.metas.includes("tt-cccc"), "a bound, browsed title due for a refresh is re-read when its library is in scope");
    assert.deepEqual(queries, ["Alpha", "Other"]);
  } finally { await h.close(); }
});

test("an automatic run with no ids scans nothing rather than the whole install", async () => {
  const h = await harness({ units: async () => [movie("lib_aaaaaaaa/Alpha")] });
  try {
    const state = await h.scan.start({ automatic: true, libraryIds: [] });
    assert.equal(state.status, "idle");
    assert.deepEqual(h.searches, []);
    assert.deepEqual(h.metas, []);
  } finally { await h.close(); }
});

test("a resumed automatic run skips a library switched off while the server was down", async () => {
  const h = await harness({
    units: async () => [movie("lib_aaaaaaaa/Alpha"), movie("lib_bbbbbbbb/Omega")],
    automaticLibraryEnabled: (libraryId) => libraryId !== "lib_bbbbbbbb",
  });
  try {
    await writeFile(path.join(h.dataDir, "library-scan.json"), JSON.stringify({
      status: "running", automatic: true, libraryIds: ["lib_aaaaaaaa", "lib_bbbbbbbb"],
      total: 2, done: 0, matched: 0, skipped: 0, failed: 0,
      remaining: ["lib_aaaaaaaa/Alpha", "lib_bbbbbbbb/Omega"], current: "lib_aaaaaaaa/Alpha",
    }));
    await h.scan.load();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.deepEqual(h.searches, ["Alpha"], "the queued item of the opted-out library is finished without a search");
    assert.equal(h.metas.length, 1, "one follow-up metadata call, for the library still in scope");
    assert.equal(h.scan.snapshot().skipped, 1);
    assert.equal(h.store.meta["lib_bbbbbbbb/Omega"], undefined);
  } finally { await h.close(); }
});

test("a manual run still searches a library whose automatic lookup is switched off", async () => {
  const h = await harness({
    units: async () => [movie("lib_aaaaaaaa/Alpha")],
    automaticLibraryEnabled: () => false,
  });
  try {
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.deepEqual(h.searches, ["Alpha"]);
    assert.equal(h.scan.snapshot().matched, 1);
  } finally { await h.close(); }
});

test("a library switched off mid-run finishes the item in flight and starts no other", async () => {
  let eligible = true;
  const queries: string[] = [];
  const h = await harness({
    units: async () => [movie("lib_aaaaaaaa/Alpha"), movie("lib_aaaaaaaa/Beta")],
    automaticLibraryEnabled: () => eligible,
    search: async (query) => {
      queries.push(query);
      if (query === "Alpha") eligible = false;
      return [hit(query, `tt-${query}`)];
    },
  });
  try {
    await h.scan.start({ automatic: true, libraryIds: ["lib_aaaaaaaa"] });
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.deepEqual(queries, ["Alpha"], "the item already being processed finished, the next was never asked");
    assert.deepEqual(h.metas, ["tt-Alpha"], "including the follow-up metadata request of the item in flight");
    assert.equal(h.scan.snapshot().skipped, 1, "the queued item that was dropped is counted as skipped");
    assert.equal(h.store.meta["lib_aaaaaaaa/Beta"], undefined);
  } finally { await h.close(); }
});

test("a same-name result the trusted providers did not offer cannot bind a title", async () => {
  // The row behind the wrong Flashdance binding came from a catalogue addon. The scan only
  // ever sees the trusted source, so what it cannot see it cannot bind.
  const h = await harness({ search: async () => [] });
  try {
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.scan.snapshot().matched, 0);
    assert.equal(h.store.meta.Foo, undefined);
    assert.ok(h.store.suggestions.Foo?.scannedAt, "the fruitless search is remembered");
  } finally { await h.close(); }
});

test("an exact trusted candidate binds, and its gallery is saved beside the two pictures", async () => {
  const h = await harness({
    search: async (query) => [hit(query, "tt-exact")],
    gallery: async () => [{ url: "https://image.tmdb.org/t/p/w500/alt.jpg", kind: "poster" }],
  });
  try {
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.store.meta.Foo?.id, "tt-exact");
    assert.deepEqual(h.posters, ["Foo"]);
    assert.deepEqual(h.galleries, [{ key: "Foo", pictures: [{ url: "https://image.tmdb.org/t/p/w500/alt.jpg", kind: "poster" }] }]);
  } finally { await h.close(); }
});

test("a provider that answers nothing leaves the title unbound and does not fail the run", async () => {
  const h = await harness({ search: async () => { throw new Error("Cinemeta is down"); } });
  try {
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.scan.snapshot().failed, 0);
    assert.equal(h.scan.snapshot().matched, 0);
    assert.equal(h.store.meta.Foo, undefined);
  } finally { await h.close(); }
});

test("a 100% name match with two same-name remakes stays an ambiguous proposal", async () => {
  const h = await harness({
    units: async () => [movie("Avengers")],
    search: async () => [
      { id: "tt0848228", type: "movie", name: "The Avengers", releaseInfo: "2012" },
      { id: "tt0118661", type: "movie", name: "The Avengers", releaseInfo: "1998" },
      { id: "tt2395427", type: "movie", name: "Avengers: Age of Ultron", releaseInfo: "2015" },
      { id: "tt4154796", type: "movie", name: "Avengers: Endgame", releaseInfo: "2019" },
    ],
  });
  try {
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.scan.snapshot().matched, 0, "100% of the name is not 100% of the identity");
    const proposal = h.store.suggestions.Avengers!;
    assert.equal(proposal.id, "tt0848228");
    assert.equal(proposal.score, 100);
    assert.equal(proposal.reason, "ambiguous");
  } finally { await h.close(); }
});

test("a poster the candidate carried travels with the proposal", async () => {
  const h = await harness({
    units: async () => [movie("Flashdance (1983)")],
    search: async () => [{ id: "tt0085549", type: "movie", name: "Flashdance", releaseInfo: "1985", poster: "https://art/a.jpg" }],
  });
  try {
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.scan.snapshot().matched, 0, "a year two off is a proposal, not a binding");
    assert.equal(h.store.suggestions["Flashdance (1983)"]?.poster, "https://art/a.jpg");
  } finally { await h.close(); }
});

test("a wrong kind or a year off by more than two is never auto-bound", async () => {
  const wrongKind = await harness({
    units: async () => [series("Foo")],
    search: async () => [hit("Foo", "tt-wrong")],
  });
  try {
    await wrongKind.scan.start();
    await waitFor(() => wrongKind.scan.snapshot().status === "completed");
    assert.equal(wrongKind.scan.snapshot().matched, 0, "a movie row does not name a series");
    assert.equal(wrongKind.store.meta.Foo, undefined);
  } finally { await wrongKind.close(); }

  const wrongYear = await harness({
    units: async () => [movie("Flashdance (1983)")],
    search: async () => [{ id: "tt-wrong", type: "movie", name: "Flashdance", releaseInfo: "2011" }],
  });
  try {
    await wrongYear.scan.start();
    await waitFor(() => wrongYear.scan.snapshot().status === "completed");
    assert.equal(wrongYear.scan.snapshot().matched, 0);
    assert.equal(wrongYear.store.meta["Flashdance (1983)"], undefined);
  } finally { await wrongYear.close(); }
});

test("a namesake series is bound when its episodes are the ones on disk", async () => {
  const blue = {
    key: "Blue",
    kind: "series" as const,
    relative: "Blue",
    sampleFiles: [
      "Blue/Season 1/Blue.S01E01.Magic.Xylophone.mkv",
      "Blue/Season 1/Blue.S01E02.Hospital.mkv",
    ],
  };
  const candidates = [
    { id: "tt-blue-1", type: "series", name: "Blue", voteCount: 3000 },
    { id: "tt-blue-2", type: "series", name: "Blue", voteCount: 3000 },
  ];
  const h = await harness({
    units: async () => [blue],
    search: async () => candidates,
    metadata: async (_addons, _type, id) => id === "tt-blue-1"
      ? { id, type: "series", name: "Blue", videos: [
        { season: 1, episode: 1, name: "Magic Xylophone" },
        { season: 1, episode: 2, name: "Hospital" },
      ] }
      : { id, type: "series", name: "Blue", videos: [
        { season: 1, episode: 1, name: "Unrelated" },
        { season: 1, episode: 2, name: "Something Else" },
      ] },
  });
  try {
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.scan.snapshot().matched, 1);
    assert.equal(h.store.meta.Blue?.id, "tt-blue-1");
    assert.equal(h.store.suggestions.Blue, undefined);
  } finally { await h.close(); }
});

test("a series proposal stays a proposal when the episode lists cannot be read", async () => {
  const blue = {
    key: "Blue",
    kind: "series" as const,
    relative: "Blue",
    sampleFiles: [
      "Blue/Season 1/Blue.S01E01.Magic.Xylophone.mkv",
      "Blue/Season 1/Blue.S01E02.Hospital.mkv",
    ],
  };
  const h = await harness({
    units: async () => [blue],
    search: async () => [
      { id: "tt-blue-1", type: "series", name: "Blue", voteCount: 3000 },
      { id: "tt-blue-2", type: "series", name: "Blue", voteCount: 3000 },
    ],
    metadata: async () => null,
  });
  try {
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.scan.snapshot().matched, 0);
    assert.equal(h.store.meta.Blue, undefined);
    assert.equal(h.store.suggestions.Blue?.id, "tt-blue-1", "the proposal remains the ranked first candidate");
  } finally { await h.close(); }
});

test("episode evidence is never asked for a movie", async () => {
  const h = await harness({
    units: async () => [movie("Blue")],
    search: async () => [
      { id: "tt-blue-1", type: "movie", name: "Blue", voteCount: 3000 },
      { id: "tt-blue-2", type: "movie", name: "Blue", voteCount: 3000 },
    ],
  });
  try {
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.store.suggestions.Blue?.reason, "ambiguous");
    assert.deepEqual(h.metas, [], "no metadata lookup happens for a movie proposal");
  } finally { await h.close(); }
});

test("a nameless namesake is settled by how long the file runs", async () => {
  const probed: string[] = [];
  const h = await harness({
    units: async () => [{
      key: "Lilo & Stitch",
      kind: "movie",
      relative: "Lilo & Stitch",
      sampleFiles: ["Lilo & Stitch/Lilo.and.Stitch.mkv"],
    }],
    // Two films of the one name, the remake better known than the original.
    search: async () => [
      { id: "tt-2002", type: "movie", name: "Lilo & Stitch", releaseInfo: "2002", voteCount: 4000 },
      { id: "tt-2025", type: "movie", name: "Lilo & Stitch", releaseInfo: "2025", voteCount: 9000 },
    ],
    metadata: async (_addons, _type, id) => (id === "tt-2002"
      ? { id, type: "movie", name: "Lilo & Stitch", releaseInfo: "2002", runtime: "85 min" }
      : { id, type: "movie", name: "Lilo & Stitch", releaseInfo: "2025", runtime: 108 }),
    durationOf: async (key) => { probed.push(key); return 5100; },
  });
  try {
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.scan.snapshot().matched, 1);
    assert.deepEqual(probed, ["Lilo & Stitch/Lilo.and.Stitch.mkv"], "the file is measured once");
    assert.equal(h.store.meta["Lilo & Stitch"]?.id, "tt-2002", "the file's 85 minutes are the original, not the remake");
    assert.equal(h.store.suggestions["Lilo & Stitch"], undefined);
  } finally { await h.close(); }
});

test("a namesake nobody can measure stays a proposal", async () => {
  const h = await harness({
    units: async () => [{
      key: "Lilo & Stitch",
      kind: "movie",
      relative: "Lilo & Stitch",
      sampleFiles: ["Lilo & Stitch/Lilo.and.Stitch.mkv"],
    }],
    search: async () => [
      { id: "tt-2002", type: "movie", name: "Lilo & Stitch", releaseInfo: "2002", voteCount: 4000 },
      { id: "tt-2025", type: "movie", name: "Lilo & Stitch", releaseInfo: "2025", voteCount: 9000 },
    ],
    metadata: async (_addons, _type, id) => (id === "tt-2002"
      ? { id, type: "movie", name: "Lilo & Stitch", releaseInfo: "2002", runtime: 85 }
      : { id, type: "movie", name: "Lilo & Stitch", releaseInfo: "2025", runtime: 108 }),
    durationOf: async () => undefined,
  });
  try {
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.scan.snapshot().matched, 0);
    assert.equal(h.store.meta["Lilo & Stitch"], undefined);
    assert.equal(h.store.suggestions["Lilo & Stitch"]?.reason, "ambiguous", "an unknown length settles nothing");
  } finally { await h.close(); }
});

test("a film in two CD halves is never measured against a namesake", async () => {
  const probed: string[] = [];
  const h = await harness({
    units: async () => [{
      key: "Lilo & Stitch",
      kind: "movie",
      relative: "Lilo & Stitch",
      sampleFiles: ["Lilo & Stitch/Lilo.and.Stitch.CD1.mkv", "Lilo & Stitch/Lilo.and.Stitch.CD2.mkv"],
    }],
    search: async () => [
      { id: "tt-2002", type: "movie", name: "Lilo & Stitch", releaseInfo: "2002", voteCount: 4000 },
      { id: "tt-2025", type: "movie", name: "Lilo & Stitch", releaseInfo: "2025", voteCount: 9000 },
    ],
    metadata: async (_addons, _type, id) => (id === "tt-2002"
      ? { id, type: "movie", name: "Lilo & Stitch", releaseInfo: "2002", runtime: 85 }
      : { id, type: "movie", name: "Lilo & Stitch", releaseInfo: "2025", runtime: 108 }),
    durationOf: async (key) => { probed.push(key); return 5100; },
  });
  try {
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.deepEqual(probed, [], "two halves are one identity already, and their length says nothing about it");
    assert.equal(h.store.meta["Lilo & Stitch"], undefined);
    assert.equal(h.store.suggestions["Lilo & Stitch"]?.reason, "ambiguous");
  } finally { await h.close(); }
});

test("a candidate that resolves to no metadata record is not bound", async () => {
  const h = await harness({
    units: async () => [movie("Foo")],
    search: async (query) => [hit(query, "tt-ghost")],
    metadata: async () => null,
  });
  try {
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.scan.snapshot().matched, 0);
    assert.equal(h.store.meta.Foo, undefined);
    assert.deepEqual(h.posters, []);
  } finally { await h.close(); }
});

test("a recheck proposes a correction without touching the binding it would replace", async () => {
  const h = await harness({
    units: async () => [movie("lib_aaaaaaaa/Flashdance")],
    search: async (query) => [hit(query, "tt-new")],
  });
  try {
    h.store.meta["lib_aaaaaaaa/Flashdance"] = { type: "movie", id: "tt-old", source: "scan", locked: false, name: "Flashdance", year: "1983" };
    await h.scan.start({ libraryId: "lib_aaaaaaaa", recheckScanBindings: true });
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.scan.snapshot().recheck, true);
    assert.equal(h.scan.snapshot().matched, 0, "a recheck binds nothing on its own");
    assert.equal(h.store.meta["lib_aaaaaaaa/Flashdance"]?.id, "tt-old", "the old binding is still the binding");
    const proposal = h.store.suggestions["lib_aaaaaaaa/Flashdance"]!;
    assert.equal(proposal.id, "tt-new");
    assert.equal(proposal.reason, "correction");
    assert.equal(proposal.replacesId, "tt-old");
    assert.equal(proposal.replacesName, "Flashdance");
    assert.equal(proposal.replacesYear, 1983);
  } finally { await h.close(); }
});

test("a recheck interrupted by restart resumes as a recheck", async () => {
  const key = "lib_aaaaaaaa/Flashdance";
  const h = await harness({
    units: async () => [movie(key)],
    search: async (query) => [hit(query, "tt-new")],
  });
  try {
    h.store.meta[key] = { type: "movie", id: "tt-old", source: "scan", locked: false, name: "Flashdance", year: "1983" };
    await writeFile(path.join(h.dataDir, "library-scan.json"), JSON.stringify({
      status: "running", recheck: true, libraryId: "lib_aaaaaaaa", total: 1, done: 0,
      matched: 0, skipped: 0, failed: 0, remaining: [key], current: key,
    }));
    await h.scan.load();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.store.meta[key]?.id, "tt-old");
    assert.equal(h.store.suggestions[key]?.replacesId, "tt-old");
    assert.equal(h.store.suggestions[key]?.id, "tt-new");
  } finally { await h.close(); }
});

test("a recheck leaves user, download, locked and ignored bindings alone", async () => {
  const h = await harness({
    units: async () => [movie("lib_aaaaaaaa/Film")],
    search: async (query) => [hit(query, "tt-new")],
  });
  try {
    for (const [source, locked] of [["user", true], ["download", true], ["scan", true]] as const) {
      h.store.meta["lib_aaaaaaaa/Film"] = { type: "movie", id: "tt-kept", source, locked };
      h.store.suggestions = {};
      await h.scan.start({ libraryId: "lib_aaaaaaaa", recheckScanBindings: true });
      await waitFor(() => h.scan.snapshot().status === "completed" && h.scan.snapshot().done >= 0);
      assert.equal(h.scan.snapshot().total, 0, `${source} is not rechecked`);
      assert.equal(h.scan.snapshot().done, 0);
      assert.equal(h.store.meta["lib_aaaaaaaa/Film"]?.id, "tt-kept");
      assert.deepEqual(h.store.suggestions, {});
    }
  } finally { await h.close(); }
});

test("a recheck that finds the same title changes nothing", async () => {
  const h = await harness({
    units: async () => [movie("lib_aaaaaaaa/Flashdance")],
    search: async (query) => [hit(query, "tt-same")],
  });
  try {
    h.store.meta["lib_aaaaaaaa/Flashdance"] = { type: "movie", id: "tt-same", source: "scan", locked: false };
    h.store.suggestions["lib_aaaaaaaa/Flashdance"] = {
      type: "movie", id: "tt-old-proposal", name: "Wrong old result", score: 92,
      reason: "correction", replacesId: "tt-same",
    };
    await h.scan.start({ libraryId: "lib_aaaaaaaa", recheckScanBindings: true });
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.store.meta["lib_aaaaaaaa/Flashdance"]?.id, "tt-same");
    assert.equal(h.store.suggestions["lib_aaaaaaaa/Flashdance"], undefined, "a fresh confirmation of the current match removes its stale correction");
  } finally { await h.close(); }
});

test("a recheck without a library rechecks nothing at all", async () => {
  const h = await harness({ units: async () => [movie("lib_aaaaaaaa/Flashdance")] });
  try {
    h.store.meta["lib_aaaaaaaa/Flashdance"] = { type: "movie", id: "tt-old", source: "scan", locked: false };
    const state = await h.scan.start({ recheckScanBindings: true });
    assert.equal(state.status, "idle");
    assert.deepEqual(h.searches, []);
  } finally { await h.close(); }
});

test("a plain scan walks past an automatic binding without proposing anything", async () => {
  const h = await harness({ units: async () => [movie("lib_aaaaaaaa/Flashdance")] });
  try {
    h.store.meta["lib_aaaaaaaa/Flashdance"] = { type: "movie", id: "tt-old", source: "scan", locked: false };
    await h.scan.start({ libraryId: "lib_aaaaaaaa" });
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.scan.snapshot().total, 0);
    assert.deepEqual(h.searches, []);
    assert.deepEqual(h.store.suggestions, {});
  } finally { await h.close(); }
});

test("the run summarizes accepted, proposed, missed and excluded units", async () => {
  const h = await harness({
    units: async () => [movie("Accept Me"), movie("Ambiguous"), movie("Nothing"), movie("Gone"), movie("Broken")],
    pathExists: async (key) => {
      if (key === "Gone") return false;
      if (key === "Broken") throw new Error("the disk went away");
      return true;
    },
    search: async (query) => {
      if (query === "Accept Me") return [{ id: "tt-a", type: "movie", name: "Accept Me", releaseInfo: "2020" }];
      if (query === "Ambiguous") return [
        { id: "tt-x", type: "movie", name: "Ambiguous", releaseInfo: "2020" },
        { id: "tt-y", type: "movie", name: "Ambiguous", releaseInfo: "1990" },
      ];
      return [];
    },
  });
  try {
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    const state = h.scan.snapshot();
    assert.equal(state.accepted, 1, "one title was bound");
    assert.equal(state.proposed, 1, "one title is waiting for a person");
    assert.equal(state.missed, 1, "one search found nothing");
    assert.equal(state.excluded, 1, "one queued unit was skipped");
    assert.equal(state.failed, 1, "a provider that broke is a failed unit, not a failed run");
    assert.equal(state.ruleVersion, MATCH_RULE_VERSION);
    assert.equal(state.matched, 1);
    assert.equal(state.skipped, 3, "proposed, missed and excluded all leave the binding alone");
  } finally { await h.close(); }
});

test("a diagnostic names the unit, provider, score and decision, and carries no secret", async () => {
  const h = await harness({
    units: async () => [movie("Ambiguous")],
    search: async () => [
      { id: "tt-x", type: "movie", name: "Ambiguous", releaseInfo: "2020" },
      { id: "tt-y", type: "movie", name: "Ambiguous", releaseInfo: "1990" },
    ],
  });
  try {
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    const [diagnostic] = h.scan.snapshot().diagnostics ?? [];
    assert.ok(diagnostic, "the run kept a diagnostic line");
    assert.equal(diagnostic!.unit, "Ambiguous");
    assert.equal(diagnostic!.decision, "proposed");
    assert.equal(diagnostic!.querySource, "search");
    assert.equal(diagnostic!.candidateId, "tt-x");
    assert.equal(diagnostic!.titleSimilarity, 100);
    assert.equal(diagnostic!.provider, "cinemeta");
    assert.ok((diagnostic!.alternatives?.length ?? 0) >= 1, "the alternatives are named");
    assert.equal(JSON.stringify(diagnostic).includes("apiKey"), false);
    assert.equal(JSON.stringify(diagnostic).includes("token"), false);
  } finally { await h.close(); }
});

test("a row written by older rules is reconsidered exactly once", async () => {
  const h = await harness({
    units: async () => [movie("Foo")],
    search: async () => [],
  });
  try {
    h.store.suggestions.Foo = { type: "movie", id: "", name: "", score: 0, scannedAt: new Date().toISOString(), rule: MATCH_RULE_VERSION - 1 };
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.deepEqual(h.searches, ["Foo"], "a stale remembered miss is searched again");
    assert.equal(h.store.suggestions.Foo?.rule, MATCH_RULE_VERSION);
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed" && h.scan.snapshot().total === 0);
    assert.deepEqual(h.searches, ["Foo"], "and not on every later startup");
  } finally { await h.close(); }
});

test("a dismissal survives a rule change and is never reconsidered", async () => {
  const h = await harness({
    units: async () => [movie("Foo")],
    search: async () => [],
  });
  try {
    h.store.suggestions.Foo = {
      type: "movie", id: "", name: "", score: 0, scannedAt: new Date().toISOString(),
      dismissed: true, rule: MATCH_RULE_VERSION - 1,
    };
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed" && h.scan.snapshot().total === 0);
    assert.deepEqual(h.searches, [], "a person's dismissal outranks a rule change");
  } finally { await h.close(); }
});

test("an existing explicit or locked binding is never touched by a reconsideration", async () => {
  const h = await harness({
    units: async () => [movie("Foo"), movie("Bar")],
    search: async () => [{ id: "tt-new", type: "movie", name: "Foo", releaseInfo: "2020" }],
  });
  try {
    h.store.meta.Foo = { type: "movie", id: "tt-user", source: "user", locked: true };
    h.store.meta.Bar = { type: "movie", id: "tt-locked", source: "scan", locked: true };
    h.store.suggestions.Foo = { type: "movie", id: "", name: "", score: 0, rule: MATCH_RULE_VERSION - 1 };
    h.store.suggestions.Bar = { type: "movie", id: "tt-old", name: "Old", score: 90, rule: MATCH_RULE_VERSION - 1 };
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.store.meta.Foo?.id, "tt-user");
    assert.equal(h.store.meta.Bar?.id, "tt-locked");
    assert.deepEqual(h.searches, []);
  } finally { await h.close(); }
});

test("an interrupted scan still picks stale rows up on its next run", async () => {
  const h = await harness({
    units: async () => [movie("Foo")],
    search: async () => [],
  });
  try {
    // A run wrote the current rule version before it was interrupted: its own row was never
    // reconsidered, so the row -- not the state file -- is what has to keep asking.
    h.store.suggestions.Foo = { type: "movie", id: "", name: "", score: 0, scannedAt: stale(), rule: MATCH_RULE_VERSION - 1 };
    await writeFile(path.join(h.dataDir, "library-scan.json"), JSON.stringify({
      status: "completed", total: 0, done: 0, matched: 0, skipped: 0, failed: 0, remaining: [], ruleVersion: MATCH_RULE_VERSION,
    }));
    await h.scan.load();
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.deepEqual(h.searches, ["Foo"], "the stale row is searched again");
    assert.equal(h.store.suggestions.Foo?.rule, MATCH_RULE_VERSION);
  } finally { await h.close(); }
});

test("a scan started by hand reconsiders stale rows even with no automatic pass", async () => {
  const h = await harness({
    units: async () => [movie("Foo")],
    search: async () => [],
  });
  try {
    h.store.suggestions.Foo = { type: "movie", id: "", name: "", score: 0, scannedAt: stale(), rule: MATCH_RULE_VERSION - 1 };
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.deepEqual(h.searches, ["Foo"], "the explicit scan picks the stale row up on its own");
  } finally { await h.close(); }
});

test("a scan does not enqueue artwork for current misses it does not reconsider", async () => {
  const h = await harness({
    units: async () => [movie("Foo"), movie("Bar")],
    search: async () => [],
  });
  try {
    const currentMiss = { type: "movie", id: "", name: "", score: 0, scannedAt: new Date().toISOString(), rule: MATCH_RULE_VERSION };
    h.store.suggestions.Foo = { ...currentMiss };
    h.store.suggestions.Bar = { ...currentMiss };
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.scan.snapshot().total, 0);
    assert.deepEqual(h.backdrops, [], "walking the tree alone does not queue wide artwork for every unit");
  } finally { await h.close(); }
});

test("a loose film in a collection is searched as the film; a film folder as the folder", async () => {
  const h = await harness({
    units: async () => [
      { key: "Collection/Heat (1995).mkv", kind: "movie", relative: "Collection/Heat (1995).mkv", sampleFiles: ["Collection/Heat (1995).mkv"] },
      { key: "Practical Magic (1998)", kind: "movie", relative: "Practical Magic (1998)", sampleFiles: ["Practical Magic (1998)/a.mkv", "Practical Magic (1998)/b.mkv"] },
    ],
    search: async (query) => [{ id: `tt-${query}`, type: "movie", name: query }],
  });
  try {
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.deepEqual(h.searches, ["Heat", "Practical Magic"], "the film's own name, and the folder's title for an encode set");
    assert.equal(h.store.meta["Collection/Heat (1995).mkv"]?.id, "tt-Heat", "the binding lands on the unit key");
    assert.equal(h.store.meta["Practical Magic (1998)"]?.id, "tt-Practical Magic");
  } finally { await h.close(); }
});

test("a bilingual unit is searched by its whole title, not the shortened query", async () => {
  const h = await harness({ units: async () => [movie("Jižanská pohostinnost-Southern Comfort")] });
  try {
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.deepEqual(h.searches, ["Jižanská pohostinnost-Southern Comfort"], "the search service gets the whole title and tries every form of it");
  } finally { await h.close(); }
});

test("a folder whose film is named differently is searched by the film's own name too", async () => {
  const h = await harness({
    units: async () => [{
      key: "Sherlock Holomes",
      kind: "movie",
      relative: "Sherlock Holomes",
      sampleFiles: ["Sherlock Holomes/Sherlock Holmes.mp4"],
    }],
    search: async (query, _kind, _year, extra) => {
      const asked = [query, ...(extra ?? [])];
      return asked.includes("Sherlock Holmes") ? [{ id: "tt-sherlock", type: "movie", name: "Sherlock Holmes" }] : [];
    },
  });
  try {
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.deepEqual(h.searches, ["Sherlock Holomes"], "the unit is searched as the folder names it");
    assert.deepEqual(h.extraSearches, [["Sherlock Holmes"]], "and the film inside it beside that name");
    assert.equal(h.store.meta["Sherlock Holomes"]?.id, "tt-sherlock",
      "the folder misspells the name the file carries, so the film binds");
    assert.equal(h.store.suggestions["Sherlock Holomes"], undefined);
  } finally { await h.close(); }
});
