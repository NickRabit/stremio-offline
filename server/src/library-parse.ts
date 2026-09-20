import { isVideo } from "./library.js";
import { LIBRARY_ID } from "./libraries.js";

export const QUALITY_TOKENS = [
  "2160p", "1080p", "720p", "576p", "480p", "4k", "uhd",
  "hdr", "hdr10", "hdr10+", "hdrplus", "dv",
  "web-dl", "webrip", "hdtv", "bdrip", "bluray", "blu-ray", "remux",
  "dvdrip", "dvdscr",
  "proper", "repack", "unrated", "extended", "theatrical", "remastered",
  "czdab", "dabing",
  "ac3", "eac3", "ddp", "dts", "dtshd", "truehd", "atmos", "aac", "mp3", "flac", "opus",
  "x264", "x265", "h264", "h265", "hevc", "avc", "xvid", "divx",
  "10bit", "8bit", "hires",
] as const;

/** Longest first. Never split into `cut`, `vision`, `audio`. */
export const QUALITY_PHRASES = [
  "dolby vision",
  "directors cut",
  "dual audio",
  "cz dabing",
] as const;

/** End-of-string only, after the year has been removed. */
export const CZECH_GENRE_TOKENS = [
  "akční", "akcni", "animovaný", "animovany",
  "dobrodružný", "dobrodruzny", "dokumentární", "dokumentarni",
  "drama", "fantasy", "horor", "komedie", "krimi",
  "muzikál", "muzikal", "rodinný", "rodinny",
  "sci-fi", "scifi", "thriller",
  "válečný", "valecny", "western",
  "životopisný", "zivotopisny",
] as const;

export interface ParsedMedia {
  title: string;
  query: string;
  year?: number;
  season?: number;
  episode?: number;
  providerHints?: { imdb?: string; tmdb?: string; tvdb?: string };
}

const QUALITY = new Set(QUALITY_TOKENS.map((token) => token.toLowerCase()));
const GENRES = new Set(CZECH_GENRE_TOKENS.map((token) => token.toLowerCase()));
const PHRASES = [...QUALITY_PHRASES].sort((a, b) => b.length - a.length);
const YEAR_TOKEN = /^(19|20)\d{2}$/;
const PAREN_YEAR = /\((19|20)\d{2}\)/;
const TAGGED_EPISODE = /\bS(\d{1,3})E(\d{1,4})\b/i;
const X_EPISODE = /\b(\d{1,2})x(\d{1,4})\b/i;
const CHANNEL = /\b[57]\.1\b/gi;
const RELEASE_GROUP = /-[A-Za-z0-9]{2,15}$/;

const phrasePattern = (phrase: string) =>
  new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "[\\s._]+"), "gi");

/** Folder name or root filename; a trailing video file uses its parent folder.
 *  The library id of a qualified key is not a folder anybody named, so a file
 *  sitting in the library root falls back to its own name. */
function subjectName(relative: string): string {
  const parts = relative.split(/[/\\]/).filter(Boolean);
  const last = parts.at(-1) ?? relative;
  if (!isVideo(last)) return last;
  if (parts.length > 2 || (parts.length === 2 && !LIBRARY_ID.test(parts[0]!))) return parts[parts.length - 2]!;
  return last.replace(/\.[^.]+$/, "");
}

function imdbId(digits: string): string {
  return `tt${digits.replace(/^tt/i, "")}`;
}

function extractHints(input: string): { rest: string; hints: NonNullable<ParsedMedia["providerHints"]> } {
  const hints: NonNullable<ParsedMedia["providerHints"]> = {};
  let rest = input;
  rest = rest.replace(/\{imdb-(tt)?(\d+)\}/gi, (_all, _tt, digits: string) => {
    hints.imdb = imdbId(digits);
    return " ";
  });
  rest = rest.replace(/\{tmdb-(\d+)\}/gi, (_all, id: string) => {
    hints.tmdb = id;
    return " ";
  });
  rest = rest.replace(/\{tvdb-(\d+)\}/gi, (_all, id: string) => {
    hints.tvdb = id;
    return " ";
  });
  rest = rest.replace(/\[imdbid-(tt)?(\d+)\]/gi, (_all, _tt, digits: string) => {
    hints.imdb = imdbId(digits);
    return " ";
  });
  rest = rest.replace(/\[tmdbid-(\d+)\]/gi, (_all, id: string) => {
    hints.tmdb = id;
    return " ";
  });
  rest = rest.replace(/\[tvdbid-(\d+)\]/gi, (_all, id: string) => {
    hints.tvdb = id;
    return " ";
  });
  rest = rest.replace(/\bimdb-(tt)?(\d+)\b/gi, (_all, _tt, digits: string) => {
    hints.imdb = imdbId(digits);
    return " ";
  });
  return { rest, hints };
}

function removeWholePart(source: string, part: string): string {
  const escaped = part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.replace(new RegExp(`(^|[.\\s_])${escaped}(?=$|[.\\s_])`), "$1");
}

function isYearPart(part: string): boolean {
  if (!YEAR_TOKEN.test(part)) return false;
  if (QUALITY.has(part.toLowerCase())) return false;
  if (/^s\d/i.test(part) || /e\d+$/i.test(part)) return false;
  return true;
}

function takeYear(source: string): { year?: number; rest: string } {
  const paren = PAREN_YEAR.exec(source);
  if (paren) {
    return {
      year: Number(paren[0].slice(1, -1)),
      rest: `${source.slice(0, paren.index)} ${source.slice(paren.index + paren[0].length)}`,
    };
  }
  for (const part of source.split(/[.\s_]+/).filter(Boolean)) {
    if (!isYearPart(part)) continue;
    return { year: Number(part), rest: removeWholePart(source, part) };
  }
  return { rest: source };
}

function stripPhrases(source: string): string {
  let next = source;
  for (const phrase of PHRASES) next = next.replace(phrasePattern(phrase), " ");
  return next;
}

function stripDottedQuality(source: string): string {
  let next = stripPhrases(source.replace(CHANNEL, " "));
  const kept: string[] = [];
  for (const part of next.split(/[.\s_]+/).filter(Boolean)) {
    const lower = part.toLowerCase();
    if (QUALITY.has(lower)) continue;
    const hyphen = part.lastIndexOf("-");
    if (hyphen > 0 && QUALITY.has(part.slice(0, hyphen).toLowerCase())) continue;
    kept.push(part);
  }
  return kept.join(" ");
}

function dropQualityTokens(tokens: string[]): string[] {
  return tokens.filter((token) => !QUALITY.has(token.toLowerCase()));
}

function dropTrailingGenres(tokens: string[]): string[] {
  const next = [...tokens];
  while (next.length && GENRES.has(next[next.length - 1]!.toLowerCase())) next.pop();
  return next;
}

function collapse(value: string): string {
  return value.replace(/[._]/g, " ").replace(/\s+/g, " ").trim().normalize("NFC");
}

function hasDiacritics(value: string): boolean {
  return /\p{M}/u.test(value.normalize("NFD"));
}

function mostlyLatin(value: string): boolean {
  const compact = value.replace(/\s+/g, "");
  if (!compact) return false;
  const latin = compact.replace(/[^A-Za-z0-9]/g, "").length;
  return latin / compact.length >= 0.7 && !hasDiacritics(value);
}

function pickLatinSide(sides: string[]): string | undefined {
  const trimmed = sides.map((side) => side.trim()).filter(Boolean);
  if (trimmed.length < 2) return undefined;
  const latin = trimmed.filter(mostlyLatin);
  const marked = trimmed.filter(hasDiacritics);
  if (latin.length === 1 && marked.length >= 1) return latin[0];
  return undefined;
}

function bilingualQuery(title: string): string {
  for (const separator of [" / ", " | ", " - "]) {
    if (!title.includes(separator)) continue;
    const picked = pickLatinSide(title.split(separator));
    if (picked) return picked;
  }
  if (title.includes("-")) {
    const picked = pickLatinSide(title.split("-"));
    if (picked) return picked;
  }
  return title;
}

export function parseMediaPath(relative: string): ParsedMedia {
  const original = subjectName(relative);
  const releaseGroup = original.match(RELEASE_GROUP)?.[0].slice(1);
  const { rest: withoutHints, hints } = extractHints(original);

  let year: number | undefined;
  const firstYear = takeYear(withoutHints);
  year = firstYear.year;
  let working = firstYear.rest;

  working = stripDottedQuality(working);
  if (year == null) {
    const again = takeYear(working);
    year = again.year;
    working = again.rest;
  }

  working = collapse(working);
  if (year == null) {
    const again = takeYear(working);
    year = again.year;
    working = collapse(again.rest);
  }

  let tokens = working.split(" ").filter(Boolean);
  for (let round = 0; round < 8; round += 1) {
    const before = tokens.join(" ");
    let joined = stripPhrases(before);
    tokens = dropQualityTokens(joined.split(" ").filter(Boolean));
    if (releaseGroup && tokens.length > 1 && tokens[tokens.length - 1]!.toLowerCase() === releaseGroup.toLowerCase()) {
      tokens = tokens.slice(0, -1);
    }
    if (tokens.join(" ") === before) break;
  }

  tokens = dropTrailingGenres(tokens);

  let title = tokens.join(" ").trim();
  let season: number | undefined;
  let episode: number | undefined;
  title = title.replace(TAGGED_EPISODE, (_all, s: string, e: string) => {
    season = Number(s);
    episode = Number(e);
    return " ";
  });
  if (season == null) {
    title = title.replace(X_EPISODE, (_all, s: string, e: string) => {
      season = Number(s);
      episode = Number(e);
      return " ";
    });
  }
  title = collapse(title);
  const query = bilingualQuery(title);
  const result: ParsedMedia = { title, query };
  if (year != null) result.year = year;
  if (season != null) result.season = season;
  if (episode != null) result.episode = episode;
  if (hints.imdb || hints.tmdb || hints.tvdb) result.providerHints = hints;
  return result;
}
