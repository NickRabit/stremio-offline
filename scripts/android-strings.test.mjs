import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertKeys,
  escapeAndroid,
  placeholderPositions,
  renderEntry,
  resourceName,
  substitute,
} from "./android-strings.mjs";

test("turns a catalogue key into an Android resource name", () => {
  assert.equal(resourceName("tv.navSearch"), "tv_nav_search");
  assert.equal(resourceName("auth.signedInAs"), "auth_signed_in_as");
  assert.equal(resourceName("tv.errBadCredentials"), "tv_err_bad_credentials");
  assert.equal(resourceName("tv.offlineTitle"), "tv_offline_title");
});

test("numbers placeholders by their first appearance in English", () => {
  const positions = placeholderPositions("Try again in {seconds} s.");
  assert.deepEqual([...positions], [["seconds", 1]]);
  const two = placeholderPositions("{a} then {b} then {a}");
  assert.deepEqual([...two], [["a", 1], ["b", 2]]);
});

test("lets a locale reorder the English placeholders", () => {
  assert.equal(
    renderEntry("tv_example", "{first} before {second}", "{second} před {first}"),
    "  <string name=\"tv_example\">%2$s před %1$s</string>",
  );
});

test("renders a plural entry as <plurals>", () => {
  assert.equal(
    renderEntry("addons_refresh_all_failed", { one: "1 addon did not answer.", other: "{count} addons did not answer." },
      { one: "1 doplněk neodpověděl.", few: "{count} doplňky neodpověděly.", other: "{count} doplňků neodpovědělo." }),
    "  <plurals name=\"addons_refresh_all_failed\">\n"
      + "    <item quantity=\"one\">1 doplněk neodpověděl.</item>\n"
      + "    <item quantity=\"few\">%1$s doplňky neodpověděly.</item>\n"
      + "    <item quantity=\"other\">%1$s doplňků neodpovědělo.</item>\n"
      + "  </plurals>",
  );
});

test("escapes apostrophes, quotes, entities and leading markers", () => {
  assert.equal(escapeAndroid("It's"), "It\\'s");
  assert.equal(escapeAndroid('say "hi"'), 'say \\"hi\\"');
  assert.equal(escapeAndroid("a & b"), "a &amp; b");
  assert.equal(escapeAndroid("a < b > c"), "a &lt; b &gt; c");
  assert.equal(escapeAndroid("@string/x"), "\\@string/x");
  assert.equal(escapeAndroid("?attr/x"), "\\?attr/x");
});

test("doubles a literal percent but keeps generated placeholders", () => {
  assert.equal(escapeAndroid("50% off"), "50%% off");
  assert.equal(escapeAndroid(substitute("Try again in {seconds} s.", placeholderPositions("Try again in {seconds} s."))),
    "Try again in %1$s s.");
});

test("refuses a key the English catalogue does not carry", () => {
  assert.throws(() => assertKeys(["tv.missing"], { "tv.other": "x" }), /tv\.missing/);
});

test("refuses a locale placeholder the English text never used", () => {
  const positions = placeholderPositions("Hello {name}");
  assert.throws(() => substitute("Ahoj {nickname}", positions), /nickname/);
});
