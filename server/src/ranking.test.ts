import assert from "node:assert/strict";
import test from "node:test";
import { rankStreams, streamLanguages, streamSize, titleLanguage } from "./ranking.js";
import type { StreamItem } from "./types.js";

const stream = (parts: Partial<StreamItem>): StreamItem => ({ url: "https://a.test/x.mkv", ...parts });

test("the language comes from the bingeGroup when the text says nothing", () => {
  assert.deepEqual(streamLanguages(stream({ name: "FullHD", behaviorHints: { bingeGroup: "Webshare|CZ|1080p|" } })), ["cs"]);
});

test("quality, codec and release group fields are not languages", () => {
  assert.deepEqual(streamLanguages(stream({ name: "4K", behaviorHints: { bingeGroup: "torrentio|4k|BluRay REMUX|hevc|10bit|DV|HDR" } })), []);
  assert.deepEqual(streamLanguages(stream({ name: "2160p", behaviorHints: { bingeGroup: "com.aiostreams.viren070|realdebrid|false|2160p|BluRay|HEVC|Atmos|TrueHD|WhiteRhino" } })), []);
});

test("the infohash Torrentio falls back to is not a language", () => {
  assert.deepEqual(streamLanguages(stream({ name: "4K", behaviorHints: { bingeGroup: "torrentio|aba496ab7b4ccd69cd106585771ad411de048be3" } })), []);
});

test("what the text and the bingeGroup each say is merged", () => {
  assert.deepEqual(streamLanguages(stream({ title: "CZ dabing", behaviorHints: { bingeGroup: "Webshare|CZ,SK|720p|" } })).sort(), ["cs", "sk"]);
});

test("a source the addon marked only in the bingeGroup still ranks as preferred", () => {
  const czech = stream({ name: "czech", behaviorHints: { bingeGroup: "Webshare|CZ|1080p|", videoSize: 1e9 } });
  const english = stream({ name: "english", title: "English 1080p", behaviorHints: { videoSize: 20e9 } });
  assert.deepEqual(rankStreams([english, czech], "cs", new Map()).map((item) => item.name), ["czech", "english"]);
});

test("the title's language stands in where the addon left its field blank", () => {
  assert.deepEqual(streamLanguages(stream({ name: "SD", behaviorHints: { bingeGroup: "Webshare||480p|" } }), "cs"), ["cs"]);
});

test("a torrent listing that says nothing gets no stand-in", () => {
  assert.deepEqual(streamLanguages(stream({ name: "4K", behaviorHints: { bingeGroup: "torrentio|4k|x265|HDR" } }), "cs"), []);
  assert.deepEqual(streamLanguages(stream({ name: "4K" }), "cs"), []);
});

test("the stand-in never overrides what the addon did say", () => {
  assert.deepEqual(streamLanguages(stream({ name: "FullHD", behaviorHints: { bingeGroup: "Webshare|EN|1080p|" } }), "cs"), ["en"]);
});

test("a stood-in source outranks one the addon called English", () => {
  const blank = stream({ name: "blank", behaviorHints: { bingeGroup: "Webshare||1080p|", videoSize: 1e9 } });
  const english = stream({ name: "english", behaviorHints: { bingeGroup: "Webshare|EN|1080p|", videoSize: 20e9 } });
  assert.deepEqual(rankStreams([english, blank], "cs", new Map(), "cs").map((item) => item.name), ["blank", "english"]);
});

test("Cinemeta's language name maps onto a code", () => {
  assert.equal(titleLanguage("Czech"), "cs");
  assert.equal(titleLanguage("Czech, Slovak"), "cs");
  assert.equal(titleLanguage("Klingon"), undefined);
  assert.equal(titleLanguage(undefined), undefined);
});

test("the size Luna abbreviates is read, and the bitrate beside it is not", () => {
  assert.equal(streamSize(stream({ title: "2 Mb/s \u00b7 2:22:00 \u00b7 2.2G" })), 2.2e9);
  assert.equal(streamSize(stream({ title: "\u{1F4BE} 35.09 GB" })), 35_090_000_000);
  assert.equal(streamSize(stream({ title: "2 Mb/s" })), undefined);
  assert.equal(streamSize(stream({ title: "1500 kbps" })), undefined);
  assert.equal(streamSize(stream({ name: "4K", title: "HDR" })), undefined);
});
