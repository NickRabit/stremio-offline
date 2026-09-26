import assert from "node:assert/strict";
import test from "node:test";
import { catalogue, cs, en } from "./i18n.js";

test("both catalogues hold the same keys and every value is a sentence", () => {
  assert.deepEqual(Object.keys(en), Object.keys(cs));
  for (const value of [...Object.values(en), ...Object.values(cs)]) assert.equal(typeof value === "string" && value.length > 0, true, value);
});

test("the Czech catalogue is translated", () => {
  assert.notEqual(en["window.thisMac"], cs["window.thisMac"]);
});

test("the locale picks the catalogue", () => {
  assert.equal(catalogue("cs"), cs);
  assert.equal(catalogue("en"), en);
});
