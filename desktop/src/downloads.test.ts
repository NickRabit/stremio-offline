import assert from "node:assert/strict";
import test from "node:test";
import { downloadProgressPercent, isDeviceTicketDownload } from "./downloads.js";

const SERVER = "http://192.168.1.20:8090";
const ticket = (path: string, server = SERVER) => `${server}${path}`;

test("a ticket of the active server handed to its own page is recognized", () => {
  const accepted = [
    ticket("/api/device-download/Az09_-"),
    ticket(`/api/device-download/${"a".repeat(64)}`),
    ticket("/api/device-download/1"),
  ];
  for (const url of accepted) assert.equal(isDeviceTicketDownload(url, SERVER, SERVER), true, url);
});

test("another host or port is not the active server", () => {
  const rejected = [
    ticket("/api/device-download/abc", "http://192.168.1.21:8090"),
    ticket("/api/device-download/abc", "http://192.168.1.20:8091"),
    ticket("/api/device-download/abc", "https://192.168.1.20:8090"),
    ticket("/api/device-download/abc", "http://nas.local:8090"),
  ];
  for (const url of rejected) assert.equal(isDeviceTicketDownload(url, SERVER, SERVER), false, url);
});

test("a page that is not the active server cannot start the download", () => {
  const url = ticket("/api/device-download/abc");
  assert.equal(isDeviceTicketDownload(url, "https://evil.example", SERVER), false);
  assert.equal(isDeviceTicketDownload(url, "http://192.168.1.20:8091", SERVER), false);
  assert.equal(isDeviceTicketDownload(url, "", SERVER), false);
  assert.equal(isDeviceTicketDownload(url, "null", SERVER), false);
});

test("only the exact ticket path is a ticket", () => {
  const rejected = [
    ticket("/api/device-download"),
    ticket("/api/device-download/"),
    ticket("/api/device-download/abc/"),
    ticket("/api/device-download/abc/def"),
    ticket("/api/device-downloads/abc"),
    ticket("/api/device-download/ab%20cd"),
    ticket("/api/device-download/abc%2Fdef"),
    ticket("/API/device-download/abc"),
    ticket("/api/Device-Download/abc"),
    ticket("/api/logs"),
    ticket("/api/settings/export"),
    ticket("/api/library/download/abc"),
    ticket("/addons/example/manifest.json"),
    ticket("/api/device-download/.."),
    ticket("/api/device-download/abc?ticket=1"),
    ticket("/api/device-download/abc#part"),
    "http://user:pass@192.168.1.20:8090/api/device-download/abc",
  ];
  for (const url of rejected) assert.equal(isDeviceTicketDownload(url, SERVER, SERVER), false, url);
});

test("a URL that is not this server's shape is refused", () => {
  const rejected = [
    "blob:http://192.168.1.20:8090/2f8c-1a",
    "blob:null/2f8c-1a",
    "data:text/plain,hello",
    "file:///Users/someone/film.mkv",
    "javascript:alert(1)",
    "/api/device-download/abc",
    "",
    "not a url",
  ];
  for (const url of rejected) assert.equal(isDeviceTicketDownload(url, SERVER, SERVER), false, url);
  assert.equal(isDeviceTicketDownload(ticket("/api/device-download/abc"), SERVER, "not an origin"), false);
});

test("an unknown or negative total has no percentage", () => {
  assert.equal(downloadProgressPercent(0, 0), null);
  assert.equal(downloadProgressPercent(10, -1), null);
  assert.equal(downloadProgressPercent(10, Number.NaN), null);
  assert.equal(downloadProgressPercent(10, Number.POSITIVE_INFINITY), null);
});

test("a known total is rounded to whole percent", () => {
  assert.equal(downloadProgressPercent(0, 100), 0);
  assert.equal(downloadProgressPercent(10, 100), 10);
  assert.equal(downloadProgressPercent(1, 3), 33);
  assert.equal(downloadProgressPercent(2, 3), 67);
  assert.equal(downloadProgressPercent(999, 1000), 100);
  assert.equal(downloadProgressPercent(5242880, 10485760), 50);
});

test("the percentage stays between zero and a hundred", () => {
  assert.equal(downloadProgressPercent(-10, 100), 0);
  assert.equal(downloadProgressPercent(0, 100), 0);
  assert.equal(downloadProgressPercent(100, 100), 100);
  assert.equal(downloadProgressPercent(150, 100), 100);
});
