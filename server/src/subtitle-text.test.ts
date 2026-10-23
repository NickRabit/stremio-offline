import assert from "node:assert/strict";
import test from "node:test";
import { decodeSubtitle, subtitleVtt } from "./subtitle-text.js";

const czech = "Příliš žluťoučký kůň úpěl ďábelské ódy";
/** The bytes a Czech subtitle saved on Windows actually holds. */
const cp1250 = Buffer.from([...czech].map((char) => ({
  ř: 0xf8, í: 0xed, š: 0x9a, ž: 0x9e, ť: 0x9d, č: 0xe8, ý: 0xfd, ů: 0xf9, ň: 0xf2, ú: 0xfa, ě: 0xec, ď: 0xef, á: 0xe1, é: 0xe9, ó: 0xf3, P: 0x50,
} as Record<string, number>)[char] ?? char.charCodeAt(0)));

test("a UTF-8 subtitle is read as it is, whatever language it claims", () => {
  assert.equal(decodeSubtitle(Buffer.from(czech, "utf8"), "cs"), czech);
  assert.equal(decodeSubtitle(Buffer.from(`﻿${czech}`, "utf8"), "en"), czech);
});

test("a subtitle that is not UTF-8 is read in its language's Windows code page", () => {
  assert.equal(decodeSubtitle(cp1250, "cs"), czech);
  assert.equal(decodeSubtitle(cp1250, "cze"), czech);
  assert.equal(decodeSubtitle(Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]), "ru"), "Привет");
  // No language to go by: the western page, which at least keeps every byte a character.
  assert.equal(decodeSubtitle(Buffer.from([0x63, 0x61, 0x66, 0xe9]), undefined), "café");
});

test("a UTF-16 subtitle is read by its byte-order mark", () => {
  const text = "1\n00:00:01,000 --> 00:00:02,000\nŽluť\n";
  assert.equal(decodeSubtitle(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")])), text);
  const be = Buffer.from(text, "utf16le").swap16();
  assert.equal(decodeSubtitle(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), text);
});

test("an SRT becomes WebVTT and a WebVTT stays as it is", () => {
  const srt = Buffer.concat([Buffer.from("1\r\n00:00:01,000 --> 00:00:02,000\r\n"), cp1250, Buffer.from("\r\n")]);
  assert.equal(subtitleVtt(srt, "cs"), `WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n${czech}\n`);
  assert.equal(subtitleVtt(Buffer.from("WEBVTT\n\n00:01.000 --> 00:02.000\nhi\n")), "WEBVTT\n\n00:01.000 --> 00:02.000\nhi\n");
});
