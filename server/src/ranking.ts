import type { StreamItem } from "./types.js";

/** The server-side twin of the interface's "Recommended" order: the preferred language, then
 *  addon priority by position, then size from largest. The download queue uses it when it has
 *  to pick a source for an episode on its own. */

/** Everything the addon wrote about the source. It sends neither language nor size as data; they tend to be in here. */
const streamText = (stream: StreamItem) =>
  [stream.name, stream.title, stream.description, stream.behaviorHints?.filename].filter(Boolean).join(" ");

const UNITS: Record<string, number> = { tb: 1e12, gb: 1e9, mb: 1e6, kb: 1e3, t: 1e12, g: 1e9 };
// Torrentio does not send the size in behaviorHints at all, only in the text as "💾 35.09 GB",
// and Luna abbreviates it to "2.2G". The bitrate sits in the same line ("2 Mb/s"), one unit away
// from a megabyte, and taking it for the size turned a 2.2 GB film into 2 MB.
const SIZE = /(\d+(?:[.,]\d+)?)\s*(TB|GB|MB|KB|T|G)\b(?!\s*(?:\/\s*s|ps|it)\b)/gi;

export function streamSize(stream: StreamItem): number | undefined {
  const hinted = stream.behaviorHints?.videoSize;
  if (typeof hinted === "number" && hinted > 0) return hinted;
  const matches = [...streamText(stream).matchAll(SIZE)];
  const match = matches[matches.length - 1];
  if (!match) return undefined;
  const value = Number(match[1].replace(",", "."));
  const unit = UNITS[match[2].toLowerCase()];
  return Number.isFinite(value) && unit ? Math.round(value * unit) : undefined;
}

/** Addons do not send the language as data; they put it in the stream name as a word or a flag. */
const FLAGS: Record<string, string> = {
  "\u{1F1E8}\u{1F1FF}": "cs", "\u{1F1F8}\u{1F1F0}": "sk", "\u{1F1EC}\u{1F1E7}": "en", "\u{1F1FA}\u{1F1F8}": "en",
  "\u{1F1E9}\u{1F1EA}": "de", "\u{1F1F5}\u{1F1F1}": "pl", "\u{1F1ED}\u{1F1FA}": "hu", "\u{1F1EB}\u{1F1F7}": "fr",
  "\u{1F1EA}\u{1F1F8}": "es", "\u{1F1EE}\u{1F1F9}": "it", "\u{1F1F7}\u{1F1FA}": "ru", "\u{1F1FA}\u{1F1E6}": "uk",
};
const WORDS: Array<[RegExp, string]> = [
  [/\b(czech|cesky|česky|čeština|cestina|cz|cze|ces)\b/i, "cs"],
  [/\b(slovak|slovensky|slovenčina|sk|slk)\b/i, "sk"],
  [/\b(english|eng|en)\b/i, "en"],
  [/\b(german|deutsch|ger|deu)\b/i, "de"],
  [/\b(polish|polski|pol)\b/i, "pl"],
  [/\b(hungarian|magyar|hun)\b/i, "hu"],
];

/** Some addons state the language as a field of the bingeGroup, e.g. "Webshare|CZ,SK|720p|" or
 *  "com.aiostreams.viren070|realdebrid|false|2160p|BluRay|Dubbed|English|Russian". Only a whole
 *  field counts, so a resolution, a release group or the infohash Torrentio falls back to
 *  ("torrentio|aba496ab...411de048be3") never passes for a language. */
const BINGE_CODES: Record<string, string> = {
  cz: "cs", cs: "cs", cze: "cs", ces: "cs", czech: "cs",
  sk: "sk", slk: "sk", slovak: "sk",
  en: "en", eng: "en", english: "en",
  de: "de", ger: "de", deu: "de", german: "de",
  pl: "pl", pol: "pl", polish: "pl",
  hu: "hu", hun: "hu", hungarian: "hu",
};

/** Cinemeta states the language of some titles by its English name ("Czech"), occasionally several. */
const LANGUAGE_NAMES: Record<string, string> = {
  czech: "cs", slovak: "sk", english: "en", german: "de", polish: "pl", hungarian: "hu",
  french: "fr", spanish: "es", italian: "it", russian: "ru", ukrainian: "uk",
};

export function titleLanguage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  for (const part of value.split(/[,/]/)) {
    const code = LANGUAGE_NAMES[part.trim().toLowerCase()];
    if (code) return code;
  }
  return undefined;
}

/** An addon whose bingeGroup has a field it left blank -- Cineshare sends "Webshare||1080p|" when it
 *  found no language -- looked and came up empty, so the title's own language is the best guess left.
 *  A torrent listing names every audio track a release carries and has no such field, so its silence
 *  is not an admission of ignorance and earns no guess. */
const leavesLanguageBlank = (bingeGroup?: string) =>
  !!bingeGroup && bingeGroup.includes("|") && bingeGroup.split("|").includes("");

/** `titleLanguage` stands in only for a source whose addon admitted it found no language. */
export function streamLanguages(stream: StreamItem, titleLanguage?: string): string[] {
  const text = streamText(stream);
  const found = new Set<string>();
  for (const [flag, code] of Object.entries(FLAGS)) if (text.includes(flag)) found.add(code);
  for (const [pattern, code] of WORDS) if (pattern.test(text)) found.add(code);
  for (const token of (stream.behaviorHints?.bingeGroup ?? "").split(/[|,/\s]+/)) {
    const code = BINGE_CODES[token.toLowerCase()];
    if (code) found.add(code);
  }
  if (!found.size && titleLanguage && leavesLanguageBlank(stream.behaviorHints?.bingeGroup)) found.add(titleLanguage);
  return [...found];
}

export function rankStreams(streams: StreamItem[], preferredLanguage: string, priority: Map<string, number>, titleLanguage?: string): StreamItem[] {
  const size = new Map(streams.map((stream) => [stream, streamSize(stream)]));
  const rank = (stream: StreamItem) => priority.get(stream.addonKey ?? "") ?? Number.MAX_SAFE_INTEGER;
  const decorated = streams.map((stream, index) => ({ stream, index }));
  decorated.sort((a, b) => {
    const preferred = (stream: StreamItem) => streamLanguages(stream, titleLanguage).includes(preferredLanguage) ? 0 : 1;
    const byLanguage = preferred(a.stream) - preferred(b.stream);
    if (byLanguage) return byLanguage;
    const byPriority = rank(a.stream) - rank(b.stream);
    if (byPriority) return byPriority;
    const left = size.get(a.stream), right = size.get(b.stream);
    if (left === undefined || right === undefined) {
      if (left !== right) return left === undefined ? 1 : -1;
    } else if (left !== right) return right - left;
    return a.index - b.index;
  });
  return decorated.map((item) => item.stream);
}
