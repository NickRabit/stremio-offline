import assert from "node:assert/strict";
import test from "node:test";
import { HOME_ROWS, HOME_ROW_LIMIT, boundCards, homeCatalogRowId, homeRowOrder, mergeResume, parseHomeCatalogRowId, parseResumeFilter, resumePage, type HomeCard, type ResumeCatalogueItem, type ResumeFileItem } from "./home.js";

const at = (day: number) => `2024-01-${String(day).padStart(2, "0")}T00:00:00.000Z`;

const forgetKeys = (card: HomeCard): string[] =>
  card.kind === "resume-file" || card.kind === "resume-catalogue" ? card.forgetKeys : [];

const file = (over: Partial<ResumeFileItem> & { key: string }): ResumeFileItem => ({
  updatedAt: at(1), title: "File", path: "Shows/01.mkv", progress: { position: 10, duration: 100 }, ...over,
});

const catalogue = (over: Partial<ResumeCatalogueItem> & { key: string }): ResumeCatalogueItem => ({
  updatedAt: at(1), title: "Catalogue", type: "series", id: "tt1", name: "Show", ...over,
});

test("two cards with the same verified series id merge into one", () => {
  const { items } = mergeResume({
    files: [file({ key: "file:a", identity: { type: "series", id: "tt1" }, updatedAt: at(2) })],
    catalogue: [catalogue({ key: "series:tt1:1:2", identity: { type: "series", id: "tt1" }, updatedAt: at(1) })],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "resume-file");
  assert.deepEqual(forgetKeys(items[0]!), ["file:a", "series:tt1:1:2"]);
});

test("unequal series ids stay as two cards", () => {
  const { items } = mergeResume({
    files: [file({ key: "file:a", identity: { type: "series", id: "tt1" } })],
    catalogue: [catalogue({ key: "series:tt2:1:1", identity: { type: "series", id: "tt2" } })],
  });
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.key).sort(), ["file:a", "series:tt2:1:1"]);
});

test("a card without a series id never merges", () => {
  const { items } = mergeResume({
    files: [],
    catalogue: [
      catalogue({ key: "movie:tt1", type: "movie", id: "tt1", updatedAt: at(2) }),
      catalogue({ key: "movie:tt2", type: "movie", id: "tt2", updatedAt: at(1) }),
    ],
  });
  assert.equal(items.length, 2);
});

test("when the times tie the library file wins, because it is playable now", () => {
  const { items } = mergeResume({
    files: [file({ key: "file:a", identity: { type: "series", id: "tt1" }, updatedAt: at(2) })],
    catalogue: [catalogue({ key: "series:tt1:1:2", identity: { type: "series", id: "tt1" }, updatedAt: at(2) })],
  });
  assert.equal(items[0]!.kind, "resume-file");
});

test("the newest candidate wins over the library file", () => {
  const { items } = mergeResume({
    files: [file({ key: "file:a", identity: { type: "series", id: "tt1" }, updatedAt: at(1) })],
    catalogue: [catalogue({ key: "series:tt1:1:2", identity: { type: "series", id: "tt1" }, updatedAt: at(3) })],
  });
  assert.equal(items[0]!.kind, "resume-catalogue");
});

test("a pending next episode is chosen only when the show has no playable candidate", () => {
  const alone = mergeResume({ files: [], catalogue: [catalogue({ key: "series:tt1:1:3", identity: { type: "series", id: "tt1" }, pending: true, updatedAt: at(5) })] });
  assert.equal(alone.items[0]!.kind, "resume-catalogue");
  assert.deepEqual((alone.items[0] as { pending?: true }).pending, true);
  assert.equal("progress" in alone.items[0]!, false, "a pending row carries no invented progress bar");

  const together = mergeResume({
    files: [file({ key: "file:a", identity: { type: "series", id: "tt1" }, updatedAt: at(1) })],
    catalogue: [catalogue({ key: "series:tt1:1:3", identity: { type: "series", id: "tt1" }, pending: true, updatedAt: at(5) })],
  });
  assert.equal(together.items[0]!.kind, "resume-file", "unfinished playback beats a later marker");
});

test("the winning card forgets every key the show stands for", () => {
  const { items } = mergeResume({
    files: [file({ key: "file:a", identity: { type: "series", id: "tt1" }, updatedAt: at(3) })],
    catalogue: [
      catalogue({ key: "series:tt1:1:2", identity: { type: "series", id: "tt1" }, updatedAt: at(1) }),
      catalogue({ key: "series:tt1:1:3", identity: { type: "series", id: "tt1" }, pending: true, updatedAt: at(2) }),
    ],
  });
  assert.deepEqual(forgetKeys(items[0]!), ["file:a", "series:tt1:1:2", "series:tt1:1:3"]);
});

test("a library film and its catalogue row merge into one card, whichever half is newer", () => {
  const fileHalf = file({ key: "file:a", identity: { type: "movie", id: "tt9" }, updatedAt: at(2) });
  const catalogueHalf = catalogue({ key: "movie:tt9", type: "movie", id: "tt9", identity: { type: "movie", id: "tt9" }, updatedAt: at(1) });

  const { items } = mergeResume({ files: [fileHalf], catalogue: [catalogueHalf] });
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "resume-file", "the playable file wins when it is the newer half");
  assert.deepEqual(forgetKeys(items[0]!), ["file:a", "movie:tt9"]);

  const newer = mergeResume({ files: [fileHalf], catalogue: [{ ...catalogueHalf, updatedAt: at(3) }] });
  assert.equal(newer.items.length, 1);
  assert.equal(newer.items[0]!.kind, "resume-catalogue");
  assert.deepEqual(forgetKeys(newer.items[0]!), ["file:a", "movie:tt9"]);

  const tie = mergeResume({ files: [fileHalf], catalogue: [{ ...catalogueHalf, updatedAt: at(2) }] });
  assert.equal(tie.items.length, 1);
  assert.equal(tie.items[0]!.kind, "resume-file");
});

test("a film and a series that share an id never merge, because the identity is typed", () => {
  const { items } = mergeResume({
    files: [],
    catalogue: [
      catalogue({ key: "movie:tt1", type: "movie", id: "tt1", identity: { type: "movie", id: "tt1" }, updatedAt: at(2) }),
      catalogue({ key: "series:tt1:1:1", identity: { type: "series", id: "tt1" }, updatedAt: at(1) }),
    ],
  });
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.key).sort(), ["movie:tt1", "series:tt1:1:1"]);
});

test("two library files bound to the same film merge into one card", () => {
  const { items } = mergeResume({
    files: [
      file({ key: "file:a", identity: { type: "movie", id: "tt9" }, updatedAt: at(1) }),
      file({ key: "file:b", identity: { type: "movie", id: "tt9" }, updatedAt: at(2) }),
    ],
    catalogue: [],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0]!.key, "file:b");
  assert.deepEqual(forgetKeys(items[0]!), ["file:a", "file:b"]);
});

test("an unbound file and a catalogue row of another title stay their own cards", () => {
  const { items } = mergeResume({
    files: [file({ key: "file:a", updatedAt: at(2) })],
    catalogue: [catalogue({ key: "movie:tt9", type: "movie", id: "tt9", identity: { type: "movie", id: "tt9" }, updatedAt: at(1) })],
  });
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.key).sort(), ["file:a", "movie:tt9"]);
});

test("a merged film answers both the library and the catalogue filter", () => {
  const sources = {
    files: [file({ key: "file:a", identity: { type: "movie", id: "tt9" }, updatedAt: at(1) })],
    // The newer marker wins the card; the film still has a local copy behind it.
    catalogue: [catalogue({ key: "movie:tt9", type: "movie", id: "tt9", identity: { type: "movie", id: "tt9" }, updatedAt: at(3) })],
  };
  assert.equal(resumePage(sources, {}).items[0]!.kind, "resume-catalogue");
  assert.deepEqual(resumePage(sources, { filter: "library" }).items.map((item) => item.key), ["movie:tt9"]);
  assert.equal(resumePage(sources, { filter: "library" }).total, 1);
  assert.deepEqual(resumePage(sources, { filter: "catalog" }).items.map((item) => item.key), ["movie:tt9"]);
  assert.equal(resumePage(sources, { filter: "catalog" }).total, 1);
});

test("cards are ordered newest first, cut to the row limit, and report hasMore", () => {
  const catalogue = Array.from({ length: HOME_ROW_LIMIT + 5 }, (_, index) =>
    ({ key: `movie:tt${index}`, updatedAt: at(index + 1), title: `T${index}`, type: "movie", id: `tt${index}`, name: `T${index}` }));
  const { items, hasMore } = mergeResume({ files: [], catalogue });
  assert.equal(items.length, HOME_ROW_LIMIT);
  assert.equal(hasMore, true);
  assert.equal(items[0]!.key, `movie:tt${HOME_ROW_LIMIT + 4}`);
  assert.equal(items.at(-1)!.key, `movie:tt5`);
});

test("exactly the limit is not reported as more", () => {
  const items = Array.from({ length: HOME_ROW_LIMIT }, (_, index) => index);
  assert.deepEqual(boundCards(items), { items, hasMore: false });
});

test("the winner of a merged show does not depend on the input order", () => {
  const sources = {
    files: [file({ key: "file:a", identity: { type: "series", id: "tt1" }, updatedAt: at(2) })],
    catalogue: [catalogue({ key: "series:tt1:1:2", identity: { type: "series", id: "tt1" }, updatedAt: at(3) })],
  };
  const forward = mergeResume(sources);
  const reversed = mergeResume({ files: [...sources.files].reverse(), catalogue: [...sources.catalogue].reverse() });
  assert.deepEqual(forward, reversed);
});

test("parseResumeFilter keeps the two card kinds and folds anything else into all", () => {
  assert.equal(parseResumeFilter("movies"), "movies");
  assert.equal(parseResumeFilter("series"), "series");
  assert.equal(parseResumeFilter("library"), "library");
  assert.equal(parseResumeFilter("catalog"), "catalog");
  assert.equal(parseResumeFilter("remote"), "remote");
  assert.equal(parseResumeFilter("all"), "all");
  assert.equal(parseResumeFilter(undefined), "all");
  assert.equal(parseResumeFilter("nope"), "all");
});

test("the two title filters read every kind of card", () => {
  const sources = {
    files: [
      file({ key: "file:film", identity: { type: "movie", id: "tt1" }, updatedAt: at(1) }),
      file({ key: "file:episode", identity: { type: "series", id: "tt5" }, season: 1, episode: 2, updatedAt: at(2) }),
      // An unbound file carries no title: its numbering is all it says about itself.
      file({ key: "file:numbered", season: 3, episode: 4, updatedAt: at(3) }),
      file({ key: "file:loose", updatedAt: at(4) }),
    ],
    catalogue: [
      catalogue({ key: "movie:tt9", type: "movie", id: "tt9", updatedAt: at(5) }),
      catalogue({ key: "series:tt6:1:1", type: "series", id: "tt6", name: "Show", updatedAt: at(6) }),
    ],
    remote: [
      { kind: "remote" as const, key: "remote:a", title: "Remote film", libraryId: "rlib_a", itemId: "1", provider: "jellyfin" as const, libraryName: "Server", itemType: "movie" as const, updatedAt: at(7) },
      { kind: "remote" as const, key: "remote:b", title: "Remote episode", libraryId: "rlib_a", itemId: "2", provider: "jellyfin" as const, libraryName: "Server", itemType: "episode" as const, season: 1, episode: 1, updatedAt: at(8) },
    ],
  };
  const keys = (filter: "movies" | "series") => resumePage(sources, { filter }).items.map((item) => item.key).sort();

  assert.deepEqual(keys("movies"), ["file:film", "file:loose", "movie:tt9", "remote:a"]);
  assert.deepEqual(keys("series"), ["file:episode", "file:numbered", "remote:b", "series:tt6:1:1"]);
});

test("the first page of resumePage is exactly Home's row", () => {
  const sources = {
    files: [file({ key: "file:a", identity: { type: "series", id: "tt1" }, updatedAt: at(1) })],
    catalogue: [
      catalogue({ key: "movie:tt2", type: "movie", id: "tt2", updatedAt: at(3) }),
      catalogue({ key: "series:tt1:1:2", identity: { type: "series", id: "tt1" }, updatedAt: at(2) }),
    ],
  };
  const row = mergeResume(sources);
  const page = resumePage(sources, { limit: HOME_ROW_LIMIT });
  assert.deepEqual(page.items.map((item) => item.key), row.items.map((item) => item.key));
  assert.equal(page.hasMore, row.hasMore);
});

test("a folded show that kept a local copy answers both filters, whichever card won", () => {
  const sources = {
    files: [file({ key: "file:a", identity: { type: "series", id: "tt1" }, updatedAt: at(1) })],
    // The newer marker wins the card, but the show still has a local copy behind it.
    catalogue: [catalogue({ key: "series:tt1:1:2", identity: { type: "series", id: "tt1" }, updatedAt: at(3) })],
  };
  assert.equal(resumePage(sources, {}).items[0]!.kind, "resume-catalogue");
  assert.deepEqual(resumePage(sources, { filter: "library" }).items.map((item) => item.key), ["series:tt1:1:2"]);
  assert.deepEqual(resumePage(sources, { filter: "catalog" }).items.map((item) => item.key), ["series:tt1:1:2"]);
});

test("a card with only one source answers only its own filter", () => {
  const local = { files: [file({ key: "file:a" })], catalogue: [] };
  const remote = { files: [], catalogue: [catalogue({ key: "movie:tt1", type: "movie", id: "tt1" })] };
  assert.deepEqual(resumePage(local, { filter: "library" }).items.map((item) => item.key), ["file:a"]);
  assert.deepEqual(resumePage(local, { filter: "catalog" }).items, []);
  assert.deepEqual(resumePage(remote, { filter: "library" }).items, []);
  assert.deepEqual(resumePage(remote, { filter: "catalog" }).items.map((item) => item.key), ["movie:tt1"]);
});

test("paging walks one stable, de-duplicated order past the Home bound", () => {
  const catalogue = Array.from({ length: HOME_ROW_LIMIT + 10 }, (_, index) =>
    ({ key: `movie:tt${index}`, updatedAt: at(index + 1), title: `T${index}`, type: "movie", id: `tt${index}`, name: `T${index}` }));
  const sources = { files: [], catalogue };
  const first = resumePage(sources, { skip: 0, limit: HOME_ROW_LIMIT });
  const second = resumePage(sources, { skip: HOME_ROW_LIMIT, limit: HOME_ROW_LIMIT });
  const whole = resumePage(sources, { skip: 0, limit: 200 });
  assert.equal(first.total, HOME_ROW_LIMIT + 10);
  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, false);
  assert.equal(first.items.length, HOME_ROW_LIMIT);
  assert.equal(second.items.length, 10);
  const seen = new Set([...first.items, ...second.items].map((item) => item.key));
  assert.equal(seen.size, HOME_ROW_LIMIT + 10, "no page repeats a card");
  assert.deepEqual([...first.items, ...second.items].map((item) => item.key), whole.items.map((item) => item.key));
});

test("a catalogue row id names its addon, type and catalogue back, even with colons inside", () => {
  assert.deepEqual(parseHomeCatalogRowId(homeCatalogRowId("key:1", "movie", "top/a b")), { addonKey: "key:1", type: "movie", id: "top/a b" });
  assert.equal(parseHomeCatalogRowId("resume"), undefined);
  assert.equal(parseHomeCatalogRowId("catalog:%E0:movie:top"), undefined);
});

test("homeRowOrder lists the seven built-ins in display order for an administrator", () => {
  assert.deepEqual(homeRowOrder(true, []), [
    { id: "resume" }, { id: "favorites" }, { id: "tonight" },
    { id: "episodes" }, { id: "completed" }, { id: "recent" }, { id: "confirm" },
  ]);
  assert.deepEqual(homeRowOrder(true, []).map((entry) => entry.id), [...HOME_ROWS]);
});

test("homeRowOrder leaves confirm out for an ordinary account", () => {
  const ids = homeRowOrder(false, []).map((entry) => entry.id);
  assert.deepEqual(ids, ["resume", "favorites", "tonight", "episodes", "completed", "recent"]);
  assert.equal(ids.includes("confirm"), false);
});

test("homeRowOrder copies catalogue entries between tonight and episodes, titles included", () => {
  const shelves = [
    { id: homeCatalogRowId("cinemeta", "movie", "top"), title: "Cinemeta · Top" },
    { id: homeCatalogRowId("cinemeta", "series", "top"), title: "Cinemeta · Top series" },
  ];
  const order = homeRowOrder(true, shelves);
  assert.deepEqual(order.map((entry) => entry.id), [
    "resume", "favorites", "tonight",
    ...shelves.map((entry) => entry.id),
    "episodes", "completed", "recent", "confirm",
  ]);
  assert.deepEqual(order.slice(3, 5), shelves);
  assert.equal("title" in order[0]!, false, "a built-in entry carries no title");
});
