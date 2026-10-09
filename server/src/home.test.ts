import assert from "node:assert/strict";
import test from "node:test";
import { HOME_ROW_LIMIT, boundCards, homeCatalogRowId, mergeResume, parseHomeCatalogRowId, type HomeCard, type ResumeCatalogueItem, type ResumeFileItem } from "./home.js";

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
    files: [file({ key: "file:a", seriesId: "tt1", updatedAt: at(2) })],
    catalogue: [catalogue({ key: "series:tt1:1:2", seriesId: "tt1", updatedAt: at(1) })],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "resume-file");
  assert.deepEqual(forgetKeys(items[0]!), ["file:a", "series:tt1:1:2"]);
});

test("unequal series ids stay as two cards", () => {
  const { items } = mergeResume({
    files: [file({ key: "file:a", seriesId: "tt1" })],
    catalogue: [catalogue({ key: "series:tt2:1:1", seriesId: "tt2" })],
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
    files: [file({ key: "file:a", seriesId: "tt1", updatedAt: at(2) })],
    catalogue: [catalogue({ key: "series:tt1:1:2", seriesId: "tt1", updatedAt: at(2) })],
  });
  assert.equal(items[0]!.kind, "resume-file");
});

test("the newest candidate wins over the library file", () => {
  const { items } = mergeResume({
    files: [file({ key: "file:a", seriesId: "tt1", updatedAt: at(1) })],
    catalogue: [catalogue({ key: "series:tt1:1:2", seriesId: "tt1", updatedAt: at(3) })],
  });
  assert.equal(items[0]!.kind, "resume-catalogue");
});

test("a pending next episode is chosen only when the show has no playable candidate", () => {
  const alone = mergeResume({ files: [], catalogue: [catalogue({ key: "series:tt1:1:3", seriesId: "tt1", pending: true, updatedAt: at(5) })] });
  assert.equal(alone.items[0]!.kind, "resume-catalogue");
  assert.deepEqual((alone.items[0] as { pending?: true }).pending, true);
  assert.equal("progress" in alone.items[0]!, false, "a pending row carries no invented progress bar");

  const together = mergeResume({
    files: [file({ key: "file:a", seriesId: "tt1", updatedAt: at(1) })],
    catalogue: [catalogue({ key: "series:tt1:1:3", seriesId: "tt1", pending: true, updatedAt: at(5) })],
  });
  assert.equal(together.items[0]!.kind, "resume-file", "unfinished playback beats a later marker");
});

test("the winning card forgets every key the show stands for", () => {
  const { items } = mergeResume({
    files: [file({ key: "file:a", seriesId: "tt1", updatedAt: at(3) })],
    catalogue: [
      catalogue({ key: "series:tt1:1:2", seriesId: "tt1", updatedAt: at(1) }),
      catalogue({ key: "series:tt1:1:3", seriesId: "tt1", pending: true, updatedAt: at(2) }),
    ],
  });
  assert.deepEqual(forgetKeys(items[0]!), ["file:a", "series:tt1:1:2", "series:tt1:1:3"]);
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
    files: [file({ key: "file:a", seriesId: "tt1", updatedAt: at(2) })],
    catalogue: [catalogue({ key: "series:tt1:1:2", seriesId: "tt1", updatedAt: at(3) })],
  };
  const forward = mergeResume(sources);
  const reversed = mergeResume({ files: [...sources.files].reverse(), catalogue: [...sources.catalogue].reverse() });
  assert.deepEqual(forward, reversed);
});

test("a catalogue row id names its addon, type and catalogue back, even with colons inside", () => {
  assert.deepEqual(parseHomeCatalogRowId(homeCatalogRowId("key:1", "movie", "top/a b")), { addonKey: "key:1", type: "movie", id: "top/a b" });
  assert.equal(parseHomeCatalogRowId("resume"), undefined);
  assert.equal(parseHomeCatalogRowId("catalog:%E0:movie:top"), undefined);
});
