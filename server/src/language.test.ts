import assert from "node:assert/strict";
import { test } from "node:test";
import { detectLanguage, normalizeLanguage, pickByLanguage } from "./language.js";

test("different spellings of one language give the same code", () => {
  for (const value of ["cs", "cz", "cze", "ces", "Czech", "čeština", "CS"]) assert.equal(normalizeLanguage(value), "cs");
  for (const value of ["en", "eng", "English"]) assert.equal(normalizeLanguage(value), "en");
});

test("a code with a region is shortened to the language", () => {
  assert.equal(normalizeLanguage("en-US"), "en");
  assert.equal(normalizeLanguage("pt_BR"), "pt");
});

test("unknown and empty input does not throw", () => {
  assert.equal(normalizeLanguage(undefined), undefined);
  assert.equal(normalizeLanguage(""), undefined);
  assert.equal(normalizeLanguage("klingon"), undefined);
});

test("the language can be read from the track title", () => {
  assert.equal(detectLanguage("CZ dabing 5.1"), "cs");
  assert.equal(detectLanguage("English commentary"), "en");
  assert.equal(detectLanguage("Czech AC3"), "cs");
  assert.equal(detectLanguage("SK"), "sk");
});

test("ordinary words do not pass for a language", () => {
  // "no" is the code for Norwegian and "it" for Italian, but in a sentence they are ordinary words.
  assert.equal(detectLanguage("There is no commentary"), undefined);
  assert.equal(detectLanguage("Play it again"), undefined);
  assert.equal(detectLanguage("Director notes"), undefined);
});

test("picks the preferred language, then English, then the default track", () => {
  const tracks = [{ language: "de" }, { language: "en" }, { language: "cs" }];
  assert.equal(pickByLanguage(tracks, "cs"), 2);
  assert.equal(pickByLanguage(tracks, "fr"), 1, "falls back to English");
  assert.equal(pickByLanguage([{ language: "de" }, { language: "pl", default: true }], "fr"), 1);
  assert.equal(pickByLanguage([], "cs"), -1);
});

test("a long run of separators before a line break is cut in linear time", () => {
  const started = performance.now();
  assert.equal(normalizeLanguage(`${"-".repeat(200_000)}\nx`), undefined);
  assert.ok(performance.now() - started < 1000);
});
