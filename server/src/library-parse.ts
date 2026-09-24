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

/** Physical segments of one film: "CD1", "Disc 2". Two of them are still one film. */
const SEGMENT_WORDS = ["cd", "disc", "disk"];
/** Installments of a series: "Part 2", "Vol 1", the Czech `část`/`díl` in both spellings.
 *  Two of them are two films. */
const INSTALLMENT_WORDS = ["part", "pt", "vol", "volume", "chap", "chapter", "ch", "část", "části", "cast", "díl", "dílu", "dil"];
const MARKERS = [...SEGMENT_WORDS, ...INSTALLMENT_WORDS].sort((a, b) => b.length - a.length);
/** One token, e.g. "cd1", "part2". Group one is the word, group two its number. */
const MARKER_FUSED = new RegExp(`^(${MARKERS.join("|")})([0-9]{1,2}|[ivx]{1,4})$`, "i");
/** A fused token split apart by punctuation, e.g. "cd" then "1". */
const MARKER_WORD_ONLY = new RegExp(`^(?:${MARKERS.join("|")})$`, "i");
/** What may follow a marker word: a plain number or a Roman numeral. */
const PART_NUMBER = /^(?:[0-9]{1,2}|[ivx]{1,4})$/i;
const ROMAN = /^[ivx]{1,4}$/i;
const ROMAN_VALUE: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
const BARE_NUMBER = /^([0-9]{1,2})$/;
/** "Obsession (2)" is a second encode of one film, not a part. */
const PAREN_TAIL = /\s*\(\s*[0-9]{1,3}\s*\)\s*$/;

type MarkerKind = "segment" | "installment";

interface PartMarker {
  kind: MarkerKind;
  number: number;
}

/** Release and edition words may trail a title without changing which film it is, so a part
 *  number in front of them is still the final marker of the title. Longest phrase first. */
const EDITION_PHRASES = [
  "directors s cut", "director s cut", "directors cut", "director cut", "final cut",
  "imax", "dc", "edition", "extended", "remastered", "remaster", "unrated", "theatrical",
  "proper", "repack", "redux", "special",
].sort((a, b) => b.length - a.length);
const TRAILING_EDITION = new RegExp(`\\s+(?:${EDITION_PHRASES.join("|")})\\s*$`, "i");

/** A title with the release/edition words at its end removed. They say how a copy was made,
 *  not which film it is, so "Saw III IMAX" and "Saw III" have to compare as the same film. */
function dropTrailingEditions(value: string): string {
  let next = value;
  for (;;) {
    const stripped = next.replace(TRAILING_EDITION, "");
    if (stripped === next) return next;
    next = stripped;
  }
}

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

const romanPart = (token: string): number | undefined => ROMAN_VALUE[token.toLowerCase()];

const markerKind = (word: string): MarkerKind => (SEGMENT_WORDS.includes(word.toLowerCase()) ? "segment" : "installment");
const markerNumber = (token: string): number | undefined =>
  /^\d{1,2}$/.test(token) ? Number(token) : romanPart(token);

/** The words of one title, lowercased, with the trailing edition wording removed. */
function markerTokens(value: string): string[] {
  const collapsed = collapse(value.replace(PAREN_TAIL, " ").replace(/['’]/g, " ")).toLowerCase();
  return dropTrailingEditions(collapsed).split(" ").filter(Boolean);
}

/** The markers of one title. An explicit one ("Part 2", "CD1") always counts; a lone
 *  trailing Roman numeral counts too, and a lone trailing number ("Toy Story 2") only when
 *  the caller asked for it, because "Obsession (2)" is a second encode of one film while
 *  "Toy Story 2" is another film. */
function partMarkers(value: string, bare: boolean): PartMarker[] {
  const tokens = markerTokens(value);
  const found: PartMarker[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const fused = MARKER_FUSED.exec(token);
    if (fused) {
      const number = markerNumber(fused[2]!);
      if (number != null) { found.push({ kind: markerKind(fused[1]!), number }); continue; }
    }
    if (MARKER_WORD_ONLY.test(token)) {
      const next = tokens[index + 1];
      const number = next == null ? undefined : markerNumber(next);
      if (number != null) { found.push({ kind: markerKind(token), number }); index += 1; continue; }
    }
    if (index === tokens.length - 1 && ROMAN.test(token)) {
      const number = romanPart(token);
      if (number != null) found.push({ kind: "installment", number });
    }
  }
  if (!found.length && bare && tokens.length > 1) {
    const last = tokens[tokens.length - 1]!;
    const bareMatch = BARE_NUMBER.exec(last);
    if (bareMatch) {
      const number = Number(bareMatch[1]);
      if (number >= 1 && number <= 29) found.push({ kind: "installment", number });
    }
  }
  return found;
}

/** The installment marker of one title, as a canonical string, or "". Arabic and Roman
 *  spellings of one number produce the same string, and a physical segment ("CD2") is no
 *  installment at all. */
export function partSignature(value: string | undefined, bare = false): string {
  return partMarkers(String(value ?? ""), bare)
    .filter((marker) => marker.kind === "installment")
    .map((marker) => `part:${marker.number}`)
    .join("+");
}

/** The indexes of the tokens a title drops: the markers a filter accepts, and a final
 *  installment written as a bare number when the caller asked for one. */
function droppedMarkers(tokens: string[], accept: (kind: MarkerKind) => boolean, bareNumeral: boolean): Set<number> {
  const dropped = new Set<number>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const fused = MARKER_FUSED.exec(token);
    if (fused) {
      if (accept(markerKind(fused[1]!))) dropped.add(index);
      continue;
    }
    if (MARKER_WORD_ONLY.test(token) && accept(markerKind(token))) {
      const next = tokens[index + 1];
      if (next != null && PART_NUMBER.test(next)) { dropped.add(index); dropped.add(index + 1); index += 1; }
    }
  }
  if (!bareNumeral || tokens.length < 2) return dropped;
  const lastIndex = tokens.length - 1;
  if (dropped.has(lastIndex)) return dropped;
  const last = tokens[lastIndex]!;
  const bare = BARE_NUMBER.exec(last);
  if (ROMAN.test(last) || (bare != null && Number(bare[1]) >= 1 && Number(bare[1]) <= 29)) dropped.add(lastIndex);
  return dropped;
}

/** The words of one title with the markers a filter accepts left out. */
function stripMarkers(normalized: string, accept: (kind: MarkerKind) => boolean, bareNumeral: boolean): string {
  const tokens = markerTokens(normalized);
  const dropped = droppedMarkers(tokens, accept, bareNumeral);
  return tokens.filter((_token, index) => !dropped.has(index)).join(" ");
}

/** Drops the part, volume and segment tokens from a normalized title, so the halves of a
 *  multipart film and the installments of one name compare on the film's own words. */
export function stripPartMarkers(normalized: string): string {
  return stripMarkers(normalized, () => true, true);
}

/** Drops only the physical-segment tokens, so the halves of one film compare equal while
 *  two installments ("Part 1" and "Part 2") keep their own names. */
export function stripSegmentMarkers(normalized: string): string {
  return stripMarkers(normalized, (kind) => kind === "segment", false);
}

/** One file or folder name, parsed on its own. Unlike `parseMediaPath` it does not reach for
 *  a parent folder: a name that a caller already knows is the subject is read as it stands. */
export function parseMediaName(name: string): ParsedMedia {
  const original = name;
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

export function parseMediaPath(relative: string): ParsedMedia {
  return parseMediaName(subjectName(relative));
}
