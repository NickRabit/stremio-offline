import { normalizeLanguage } from "./language.js";

/** The code page a subtitle in this language was saved in when it is not Unicode: subtitle
 *  sites and the tools people make them with still write the Windows page of the language. */
const LEGACY_PAGE: Record<string, string> = {
  cs: "windows-1250", sk: "windows-1250", pl: "windows-1250", hu: "windows-1250",
  ro: "windows-1250", hr: "windows-1250", sr: "windows-1250", sl: "windows-1250", bs: "windows-1250",
  ru: "windows-1251", uk: "windows-1251", bg: "windows-1251", be: "windows-1251", mk: "windows-1251",
  el: "windows-1253", tr: "windows-1254", he: "windows-1255", ar: "windows-1256", fa: "windows-1256",
  lt: "windows-1257", lv: "windows-1257", et: "windows-1257", vi: "windows-1258", th: "windows-874",
};

/** A subtitle's text. Unicode is recognised by its byte-order mark or by being valid UTF-8;
 *  anything else is read in the code page of its language, the western one when that is
 *  not known, which keeps every byte a character rather than a replacement mark. */
export function decodeSubtitle(bytes: Uint8Array, language?: string): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    const code = normalizeLanguage(language);
    return new TextDecoder((code && LEGACY_PAGE[code]) ?? "windows-1252").decode(bytes);
  }
}

/** SRT to WebVTT: commas in the timings become points and the cue numbers go. */
export function toWebVtt(text: string): string {
  if (text.trimStart().startsWith("WEBVTT")) return text;
  return `WEBVTT\n\n${text.replace(/^﻿/, "").replace(/\r/g, "").replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2").replace(/^\d+\n(?=\d{2}:\d{2}:\d{2}[.,]\d{3} -->)/gm, "")}`;
}

export const subtitleVtt = (bytes: Uint8Array, language?: string): string => toWebVtt(decodeSubtitle(bytes, language));
