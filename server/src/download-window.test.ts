import assert from "node:assert/strict";
import test from "node:test";
import {
  DOWNLOAD_WINDOW_TIME,
  localMinuteOfDay,
  parseDownloadWindow,
  serverTimeZone,
  windowOpen,
} from "./download-window.js";

const at = (iso: string) => Date.parse(iso);

test("a download window accepts wall-clock times and normalises browser seconds", () => {
  assert.equal(DOWNLOAD_WINDOW_TIME.test("01:00"), true);
  assert.deepEqual(parseDownloadWindow({ start: "01:00", end: "07:00", extra: true }), { start: "01:00", end: "07:00" });
  assert.deepEqual(parseDownloadWindow({ start: "22:00:00", end: "06:00:00" }), { start: "22:00", end: "06:00" });
  assert.equal(parseDownloadWindow(null), undefined);
  assert.equal(parseDownloadWindow(undefined), undefined);
});

test("a malformed download window is invalid", () => {
  for (const value of [
    {},
    { start: "01:00" },
    { start: "7:00", end: "07:00" },
    { start: "24:00", end: "07:00" },
    { start: "01:00", end: "01:00" },
    { start: "01:00:01", end: "07:00:00" },
    [],
    "01:00-07:00",
  ]) {
    assert.equal(parseDownloadWindow(value), "invalid", JSON.stringify(value));
  }
});

test("same-day windows include their start and exclude their end", () => {
  const window = { start: "01:00", end: "07:00" };
  assert.equal(windowOpen(window, at("2026-01-01T00:59:59Z"), "UTC"), false);
  assert.equal(windowOpen(window, at("2026-01-01T01:00:00Z"), "UTC"), true);
  assert.equal(windowOpen(window, at("2026-01-01T06:59:59Z"), "UTC"), true);
  assert.equal(windowOpen(window, at("2026-01-01T07:00:00Z"), "UTC"), false);
});

test("overnight windows span local midnight", () => {
  const window = { start: "22:00", end: "06:00" };
  assert.equal(windowOpen(window, at("2026-01-01T21:59:00Z"), "UTC"), false);
  assert.equal(windowOpen(window, at("2026-01-01T22:00:00Z"), "UTC"), true);
  assert.equal(windowOpen(window, at("2026-01-02T05:59:00Z"), "UTC"), true);
  assert.equal(windowOpen(window, at("2026-01-02T06:00:00Z"), "UTC"), false);
  assert.equal(windowOpen(window, at("2026-01-02T12:00:00Z"), "UTC"), false);
});

test("the time zone parameter decides the local minute", () => {
  const instant = at("2026-01-01T23:30:00Z");
  assert.equal(localMinuteOfDay(instant, "UTC"), 23 * 60 + 30);
  assert.equal(localMinuteOfDay(instant, "Europe/Prague"), 30);
  assert.equal(windowOpen({ start: "22:00", end: "06:00" }, instant, "UTC"), true);
  assert.equal(windowOpen({ start: "22:00", end: "06:00" }, instant, "Europe/Prague"), true);
  assert.equal(windowOpen({ start: "00:30", end: "01:00" }, instant, "UTC"), false);
  assert.equal(windowOpen({ start: "00:30", end: "01:00" }, instant, "Europe/Prague"), true, "23:30Z is 00:30 in Prague");
});

test("Prague daylight-saving changes keep the wall-clock window", () => {
  const window = { start: "01:00", end: "07:00" };
  assert.equal(windowOpen(window, at("2026-03-28T23:59:59Z"), "Europe/Prague"), false);
  assert.equal(windowOpen(window, at("2026-03-29T00:00:00Z"), "Europe/Prague"), true, "01:00 CET");
  assert.equal(windowOpen(window, at("2026-03-29T00:30:00Z"), "Europe/Prague"), true, "01:30 CET");
  assert.equal(windowOpen(window, at("2026-03-29T01:30:00Z"), "Europe/Prague"), true, "03:30 CEST after the jump");
  assert.equal(windowOpen(window, at("2026-03-29T04:59:59Z"), "Europe/Prague"), true, "06:59 CEST");
  assert.equal(windowOpen(window, at("2026-03-29T05:00:00Z"), "Europe/Prague"), false, "07:00 CEST");

  assert.equal(windowOpen(window, at("2026-10-25T00:30:00Z"), "Europe/Prague"), true, "first 02:30 CEST");
  assert.equal(windowOpen(window, at("2026-10-25T01:30:00Z"), "Europe/Prague"), true, "second 02:30 CET");
  assert.equal(windowOpen(window, at("2026-10-25T05:59:59Z"), "Europe/Prague"), true, "06:59 CET");
  assert.equal(windowOpen(window, at("2026-10-25T06:00:00Z"), "Europe/Prague"), false, "07:00 CET");
});

test("the server time zone is an IANA zone name", () => {
  const zone = serverTimeZone();
  assert.equal(typeof zone, "string");
  assert.doesNotThrow(() => new Intl.DateTimeFormat("en", { timeZone: zone }));
});
