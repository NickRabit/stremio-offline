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
  assert.equal(catalogue("cs", "darwin"), cs);
  assert.equal(catalogue("en", "darwin"), en);
});

test("on Windows every string about a Mac is said for a PC", () => {
  for (const locale of ["en", "cs"] as const) {
    const strings = catalogue(locale, "win32");
    assert.deepEqual(Object.keys(strings), Object.keys(en), locale);
    for (const [key, value] of Object.entries(strings)) {
      assert.equal(/\bMac/i.test(value), false, `${locale} ${key}: ${value}`);
    }
  }
  assert.equal(catalogue("en", "win32")["window.thisMac"], "This PC");
  assert.equal(catalogue("cs", "win32")["window.thisMac"], "Tento počítač");
  assert.equal(catalogue("en", "win32")["quit.detail"].includes("this PC"), true);
  assert.equal(catalogue("cs", "win32")["quit.detail"].includes("tomto počítači"), true);
  assert.equal(catalogue("en", "win32")["reset.title"], "Reset this PC?");
  assert.equal(catalogue("cs", "win32")["reset.title"], "Obnovit tento počítač?");
});

test("on Windows the reset moves its data to the Recycle Bin, which is still the Koš in Czech", () => {
  assert.equal(catalogue("en", "win32")["reset.detailDownloads"], "The download folder {dir} moves to the Recycle Bin too.");
  assert.equal(catalogue("en", "win32")["reset.detail"].includes("the Recycle Bin"), true);
  assert.equal(catalogue("cs", "win32")["reset.detailDownloads"].includes("Koše"), true);
  assert.equal(catalogue("cs", "win32")["reset.detail"].includes("Koše"), true);
});

test("the tray and menu words are there on both platforms", () => {
  for (const locale of ["en", "cs"] as const) {
    for (const platform of ["darwin", "win32"] as const) {
      const strings = catalogue(locale, platform);
      for (const key of ["menu.file", "menu.exit", "menu.help", "window.thisPC", "tray.open", "tray.settings", "tray.quit",
        "tray.stillRunningTitle", "tray.stillRunningBody"] as const) {
        assert.equal(strings[key].length > 0, true, `${locale} ${platform} ${key}`);
      }
    }
  }
});
