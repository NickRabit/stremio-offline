import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  bingeGroupLanguages,
  guessLanguages,
  leavesLanguageBlank,
  sourceLanguages,
  sourceSize,
  sourceText,
  titleLanguage,
  type ListedSource,
} from "./index.js";

interface LanguageVector {
  name: string;
  source: ListedSource;
  titleLanguage?: string;
  expected: {
    text: string;
    guessLanguages: string[];
    bingeGroupLanguages: string[];
    leavesLanguageBlank: boolean;
    sourceLanguages: string[];
  };
}

interface SizeVector {
  name: string;
  source: ListedSource;
  expected: number | null;
}

interface TitleLanguageVector {
  name: string;
  value: unknown;
  expected: string | null;
}

interface Vectors {
  languageCases: LanguageVector[];
  sizeCases: SizeVector[];
  titleLanguageCases: TitleLanguageVector[];
}

const vectors = JSON.parse(await readFile(new URL("../vectors.json", import.meta.url), "utf8")) as Vectors;

for (const vector of vectors.languageCases) {
  test(`language vector: ${vector.name}`, () => {
    const bingeGroup = vector.source.behaviorHints?.bingeGroup;
    assert.equal(sourceText(vector.source), vector.expected.text);
    assert.deepEqual(guessLanguages(vector.expected.text), vector.expected.guessLanguages);
    assert.deepEqual(bingeGroupLanguages(bingeGroup), vector.expected.bingeGroupLanguages);
    assert.equal(leavesLanguageBlank(bingeGroup), vector.expected.leavesLanguageBlank);
    assert.deepEqual(sourceLanguages(vector.source, vector.titleLanguage), vector.expected.sourceLanguages);
  });
}

for (const vector of vectors.sizeCases) {
  test(`size vector: ${vector.name}`, () => {
    assert.equal(sourceSize(vector.source), vector.expected === null ? undefined : vector.expected);
  });
}

for (const vector of vectors.titleLanguageCases) {
  test(`title language vector: ${vector.name}`, () => {
    assert.equal(titleLanguage(vector.value), vector.expected === null ? undefined : vector.expected);
  });
}
