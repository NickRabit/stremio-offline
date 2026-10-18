import assert from "node:assert/strict";
import { test } from "node:test";
import { enoughMatched, relevance, searchTokens } from "./search-relevance.js";

test("a whole phrase beats a one-word loose match", () => {
  const whole = relevance("yes minister", { title: "Yes Minister S1E1 (Open government)" });
  const loose = relevance("yes minister", { title: "Yessica Bunny" });
  assert.ok(whole.score > loose.score);
  assert.deepEqual(
    [loose.matched, loose.total],
    [1, 2],
  );
});

test("diacritics, punctuation and file separators normalise to the same tokens", () => {
  const title = relevance("jiste pane ministre", { title: "Jistě, pane ministře" });
  assert.equal(title.matched, 3);
  assert.equal(title.total, 3);
  const file = relevance("jistě, pane ministře", {
    title: "jiste.pane.ministre.1x01.celem.k.volicum.dvb",
  });
  assert.equal(file.matched, 3);
  assert.equal(file.total, 3);
});

test("parent titles match at a lower attribute than titles", () => {
  const parent = relevance("simpsonovi", {
    title: "Homerland",
    parentTitle: "Simpsonovi",
  });
  const title = relevance("simpsonovi", { title: "Simpsonovi" });
  assert.equal(parent.matched, 1);
  assert.ok(parent.score > 0);
  assert.ok(parent.score < title.score);
});

test("fuzzy matching allows one typo from five characters and two from nine", () => {
  assert.equal(relevance("simpsnovi", { title: "Simpsonovi" }).matched, 1);
  assert.equal(relevance("simpsnovo", { title: "Simpsonovi" }).matched, 1);
  assert.equal(relevance("mtrx", { title: "Matrix" }).matched, 0);
  assert.equal(relevance("adventur", { title: "Adventure" }).matched, 1);
});

test("a leading article does not count against an exact title, and a shorter title wins", () => {
  const matrix = relevance("matrix", { title: "The Matrix" });
  const plain = relevance("matrix", { title: "Matrix" });
  const reloaded = relevance("matrix", { title: "Matrix Reloaded" });
  const resurrections = relevance("matrix", { title: "The Matrix Resurrections" });
  assert.equal(matrix.score, plain.score);
  assert.ok(matrix.score > reloaded.score);
  assert.equal(reloaded.score, resurrections.score, "two sequels are equally close; the rating decides");
});

test("a library row needs every word of a short query and all but one of a longer one", () => {
  assert.equal(enoughMatched(relevance("yes minister", { title: "Yessica Bunny" })), false);
  assert.equal(enoughMatched(relevance("yes minister", { title: "Yes Minister S1E1 (Open government)" })), true);
  assert.equal(enoughMatched(relevance("jiste pane ministre premier", { title: "Jistě, pane ministře" })), true);
  assert.equal(enoughMatched(relevance("jiste pane ministre premier", { title: "Pane ministře" })), false);
  assert.equal(enoughMatched(relevance("simpsnovi", { title: "Simpsonovi" })), true);
});

test("season and episode markers are ignored", () => {
  assert.deepEqual(searchTokens("S01E03 1x03 s1 E3 Minister"), ["minister"]);
  const result = relevance("Minister S01E03", { title: "Minister" });
  assert.deepEqual([result.matched, result.total], [1, 1]);
});

test("ampersands become the word and articles stay in the query", () => {
  assert.deepEqual(searchTokens("Rizzoli & Isles The"), ["rizzoli", "and", "isles", "the"]);
});
