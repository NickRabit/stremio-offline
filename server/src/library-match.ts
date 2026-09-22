import { isPathWithin, isVideo, numberedEpisode, parseSeason, remapPath, type FoundFile } from "./library.js";
import { posixBase, type LibraryType } from "./libraries.js";
import { parseMediaPath, type ParsedMedia } from "./library-parse.js";
import type { MetaItem } from "./types.js";

export type TitleKind = "movie" | "series";

export interface TitleUnit {
  key: string;
  kind: TitleKind;
  relative: string;
  sampleFiles: string[];
}

export interface ScoredHit {
  item: MetaItem;
  score: number;
  titleSimilarity: number;
  yearDelta?: number;
  autoEligible: boolean;
}

/** A scan result for one title unit. An entry without an id is the memory of a
 *  search that found nothing, so the next scan does not repeat it. */
export interface LibrarySuggestion {
  type: string;
  id: string;
  name: string;
  year?: number;
  score: number;
  scannedAt?: string;
}

export interface LibraryMetaRecord {
  type: string;
  id: string;
  source?: "download" | "user" | "scan";
  locked?: boolean;
  skipLookup?: boolean;
  skipMosaic?: boolean;
  name?: string;
  year?: string;
  description?: string;
  /** The language the three cached fields above are in, from the meta that filled them.
   *  A record from before this existed has none, which reads as "unknown". */
  metaLanguage?: string;
  matchedAt?: string;
  /** Last time the catalogue was asked to fill the fields above, successful or not. */
  backfilledAt?: string;
  /** Last full refresh of the binding against the catalogue. Older than the library
   *  metadata TTL, a bound series is asked about again so its episode titles stay
   *  current; a movie is refreshed only while fields are missing. */
  refreshedAt?: string;
  /** Set when the binding names one episode instead of a whole title. */
  season?: number;
  episode?: number;
  /** What the title's stored gallery holds, slot by slot. The pictures themselves live in the
   *  generated-artwork store under the item's key; this says what each one is, so the interface
   *  can name them without keeping a translated label on disk. */
  gallery?: GalleryEntry[];
}

/** One picture of a title's gallery. `kind` is named, not translated: the interface has the
 *  catalogue's wording for all four already. */
export interface GalleryEntry {
  kind: "poster" | "background" | "logo" | "still";
  shape: "poster" | "wide";
}

/** One episode of a bound series, keyed by title and numbering rather than by path,
 *  so a rename or a second copy of the same episode reuses it. */
export interface LibraryEpisodeRecord {
  season: number;
  episode: number;
  name?: string;
  description?: string;
  released?: string;
  thumbnail?: string;
}

export interface ViewedMeta {
  type: string;
  id: string;
  source: "download" | "user" | "scan";
  locked: boolean;
}

const EXTRA_TOKENS = new Set(["trailer", "sample", "extra", "bonus"]);
const ARTICLES = /^(the|a|an)\s+/;

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const prev = new Array<number>(cols);
  const cur = new Array<number>(cols);
  for (let j = 0; j < cols; j += 1) prev[j] = j;
  for (let i = 1; i < rows; i += 1) {
    cur[0] = i;
    for (let j = 1; j < cols; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j < cols; j += 1) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
}

export function normalizeTitle(value: string | undefined): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(ARTICLES, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tokensOf(value: string): Set<string> {
  return new Set(normalizeTitle(value).split(" ").filter(Boolean));
}

function dice(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return (2 * overlap) / (a.size + b.size);
}

export function yearFromMeta(item: MetaItem): number | undefined {
  const raw = String(item.releaseInfo ?? item.year ?? "").slice(0, 4);
  if (!/^(19|20)\d{2}$/.test(raw)) return undefined;
  return Number(raw);
}

export function scoreHit(parsed: ParsedMedia, item: MetaItem, expectedKind?: TitleKind): ScoredHit {
  if (!item.name) return { item, score: 0, titleSimilarity: 0, autoEligible: false };
  const left = normalizeTitle(parsed.query || parsed.title);
  const right = normalizeTitle(item.name);
  const maxLen = Math.max(left.length, right.length);
  const edit = maxLen === 0 ? 1 : 1 - levenshtein(left, right) / maxLen;
  const titleSimilarity = 0.7 * dice(tokensOf(left), tokensOf(right)) + 0.3 * edit;
  let score = 100 - Math.round((1 - titleSimilarity) * 50);
  let autoEligible = true;
  const parsedYear = parsed.year;
  const itemYear = yearFromMeta(item);
  let yearDelta: number | undefined;
  if (parsedYear != null && itemYear != null) {
    yearDelta = Math.abs(parsedYear - itemYear);
    if (yearDelta === 0) { /* no penalty */ }
    else if (yearDelta === 1) score -= 10;
    else if (yearDelta === 2) score -= 20;
    else {
      score -= 40;
      autoEligible = false;
    }
  }
  if (expectedKind && item.type && item.type !== expectedKind) {
    score -= 25;
    autoEligible = false;
  }
  score = Math.max(0, Math.min(100, score));
  return { item, score, titleSimilarity, yearDelta, autoEligible };
}

export function autoAccept(hits: ScoredHit[], nowYear = new Date().getFullYear()): ScoredHit | undefined {
  const ranked = hits.filter((hit) => hit.autoEligible).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (yearFromMeta(b.item) ?? 0) - (yearFromMeta(a.item) ?? 0);
  });
  const top = ranked[0];
  if (!top || top.score < 85 || top.titleSimilarity < 0.90) return undefined;
  const close = ranked.filter((hit) => top.score - hit.score < 15 && hit.titleSimilarity >= 0.90);
  const topName = normalizeTitle(top.item.name);
  if (close.some((hit) => normalizeTitle(hit.item.name) !== topName)) return undefined;
  const years = close.map((hit) => yearFromMeta(hit.item)).filter((year): year is number => year != null);
  const distinct = new Set(years);
  if (distinct.size <= 1) return top;
  return Math.max(...years) >= nowYear - 2 ? top : undefined;
}

/** Below this the best hit is noise -- offering it would only teach the user to distrust the list. */
export const SUGGESTION_MIN_SCORE = 60;

export function pickSuggestion(hits: ScoredHit[], minScore = SUGGESTION_MIN_SCORE): LibrarySuggestion | undefined {
  const top = [...hits].sort((a, b) => b.score - a.score)[0];
  if (!top || top.score < minScore) return undefined;
  const year = yearFromMeta(top.item);
  return {
    type: top.item.type,
    id: top.item.id,
    name: top.item.name,
    score: top.score,
    ...(year != null ? { year } : {}),
  };
}

/** Remembers that the unit was searched for and nothing usable came back. */
export const scanMiss = (kind: TitleKind, at = new Date().toISOString()): LibrarySuggestion =>
  ({ type: kind, id: "", name: "", score: 0, scannedAt: at });

export const SCAN_MEMORY_MS = 30 * 24 * 60 * 60 * 1000;

export function scannedRecently(suggestion: LibrarySuggestion | undefined, maxAgeMs = SCAN_MEMORY_MS, now = Date.now()): boolean {
  const at = suggestion?.scannedAt ? Date.parse(suggestion.scannedAt) : NaN;
  return Number.isFinite(at) && now - at < maxAgeMs;
}

export function viewMeta(raw?: LibraryMetaRecord): ViewedMeta | undefined {
  if (!raw) return undefined;
  const source = raw.source ?? "download";
  const locked = raw.locked ?? (source === "download" || source === "user");
  return { type: raw.type, id: raw.id, source, locked };
}

/** Why the scanner should skip this key. Bound titles and those with catalog lookup off. */
export function scanSkipReason(raw?: LibraryMetaRecord): "bound" | "ignored" | undefined {
  if (raw?.skipLookup) return "ignored";
  if (viewMeta(raw)?.id) return "bound";
  return undefined;
}

export function lookupSkipped(relative: string, records: Record<string, LibraryMetaRecord>): boolean {
  const parts = relative.split("/");
  for (let depth = parts.length; depth >= 1; depth -= 1) {
    const key = parts.slice(0, depth).join("/");
    if (records[key]?.skipLookup) return true;
  }
  return false;
}

export function mosaicSkipped(relative: string, records: Record<string, LibraryMetaRecord>): boolean {
  const parts = relative.split("/");
  for (let depth = parts.length; depth >= 1; depth -= 1) {
    const key = parts.slice(0, depth).join("/");
    if (records[key]?.skipMosaic) return true;
  }
  return false;
}

export type MatchStatus = "unmatched" | "matched" | "suggested" | "rejected";

const DESCRIPTION_MAX = 1200;
const EPISODE_DESCRIPTION_MAX = 600;
const MAX_EPISODES = 1000;
const BACKFILL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The binding that covers this path, together with the path it is stored at. */
export function knownTitleEntry(
  relative: string,
  records: Record<string, LibraryMetaRecord>,
): { key: string; record: LibraryMetaRecord } | undefined {
  const parts = relative.split("/");
  for (let depth = parts.length; depth >= 1; depth -= 1) {
    const key = parts.slice(0, depth).join("/");
    const found = records[key];
    if (!found) continue;
    return viewMeta(found)?.id ? { key, record: found } : undefined;
  }
  return undefined;
}

export function knownTitleOf(relative: string, records: Record<string, LibraryMetaRecord>): LibraryMetaRecord | undefined {
  return knownTitleEntry(relative, records)?.record;
}

/** Clear the binding on this path only. A path that still inherits one from a matched
 *  folder gets a sentinel, so siblings keep the parent while this one comes loose. */
export function unmatchAt(records: Record<string, LibraryMetaRecord>, relative: string): Record<string, LibraryMetaRecord> {
  const next = { ...records };
  const previous = next[relative];
  delete next[relative];
  const inherited = knownTitleOf(relative, next);
  if (inherited?.id) {
    next[relative] = { type: inherited.type, id: "", source: "user", ...(previous?.skipLookup ? { skipLookup: true } : {}) };
  } else if (previous?.skipLookup) {
    next[relative] = { type: previous.type, id: "", source: previous.source ?? "user", skipLookup: true };
  }
  return next;
}

/** The scan result covering this path, ignoring the memory of a fruitless search. */
export function suggestionFor(relative: string, suggestions: Record<string, LibrarySuggestion>): LibrarySuggestion | undefined {
  const parts = relative.split("/");
  for (let depth = parts.length; depth >= 1; depth -= 1) {
    const found = suggestions[parts.slice(0, depth).join("/")];
    if (found?.id) return found;
  }
  return undefined;
}

export function matchStatus(
  relative: string,
  records: Record<string, LibraryMetaRecord>,
  suggestions: Record<string, LibrarySuggestion> = {},
): MatchStatus {
  if (knownTitleOf(relative, records)?.id) return "matched";
  if (lookupSkipped(relative, records)) return "rejected";
  return suggestionFor(relative, suggestions) ? "suggested" : "unmatched";
}

/** The keys the scan proposed and nobody confirmed: a suggestion with an id, on a
 *  title that is not already bound and whose lookup was not skipped. Qualified keys,
 *  the form `metaStore.qualifiedSuggestions()` hands out. */
export function pendingSuggestionKeys(
  records: Record<string, LibraryMetaRecord>,
  suggestions: Record<string, LibrarySuggestion>,
): string[] {
  return Object.entries(suggestions)
    .filter(([key, suggestion]) => Boolean(suggestion.id) && !knownTitleOf(key, records)?.id && !lookupSkipped(key, records))
    .map(([key]) => key);
}

/** Cut on a word boundary. The stored text is what the detail view shows, so a
 *  hard slice would lose the rest of the sentence for good. */
export function clipText(value: string, max: number): string {
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function cacheFieldsFromMeta(meta: MetaItem | null | undefined):
  { name?: string; year?: string; description?: string; metaLanguage?: string } {
  if (!meta) return {};
  const year = yearFromMeta(meta);
  const description = typeof meta.description === "string" && meta.description.trim()
    ? clipText(meta.description, DESCRIPTION_MAX) : undefined;
  const metaLanguage = typeof meta.nameLanguage === "string" && meta.nameLanguage ? meta.nameLanguage : undefined;
  return {
    ...(meta.name ? { name: meta.name } : {}),
    ...(year != null ? { year: String(year) } : {}),
    ...(description ? { description } : {}),
    ...(metaLanguage ? { metaLanguage } : {}),
  };
}

const number = (value: unknown): number | undefined => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

export const episodeKey = (type: string, id: string, season: number, episode: number) => `${type}:${id}:${season}:${episode}`;

/** Episode rows of a series meta. A catalogue that answers with hundreds of them
 *  would otherwise blow up the state file, hence the cap. */
export function episodesFromMeta(meta: MetaItem | null | undefined, limit = MAX_EPISODES): Record<string, LibraryEpisodeRecord> {
  const out: Record<string, LibraryEpisodeRecord> = {};
  if (!meta?.id || !Array.isArray(meta.videos)) return out;
  const type = meta.type || "series";
  for (const video of meta.videos.slice(0, limit)) {
    const season = number(video.season);
    const episode = number(video.episode ?? video.number);
    if (season == null || episode == null) continue;
    const name = text(video.name ?? video.title);
    const description = text(video.overview ?? video.description);
    const released = text(video.released ?? video.firstAired);
    const thumbnail = text(video.thumbnail);
    out[episodeKey(type, meta.id, season, episode)] = {
      season, episode,
      ...(name ? { name } : {}),
      ...(description ? { description: clipText(description, EPISODE_DESCRIPTION_MAX) } : {}),
      ...(released ? { released } : {}),
      ...(thumbnail ? { thumbnail } : {}),
    };
  }
  return out;
}

/** Which episode a file holds: an explicit binding wins, then S01E02 in the name,
 *  then a plain number inside a season folder. */
export function episodeNumberOf(relative: string, record?: LibraryMetaRecord): { season: number; episode: number } | undefined {
  if (record?.episode != null) return { season: record.season ?? 1, episode: record.episode };
  return numberedEpisode(relative);
}

/** A bound series nobody re-read for the TTL. Only series: their episode list is what
 *  goes stale, while a movie binding carries everything it will ever carry. */
export function needsRefresh(raw: LibraryMetaRecord | undefined, ttlMs: number, now = Date.now()): boolean {
  const viewed = viewMeta(raw);
  if (!viewed?.id || viewed.type !== "series") return false;
  const at = raw?.refreshedAt ? Date.parse(raw.refreshedAt) : NaN;
  return !Number.isFinite(at) || now - at >= ttlMs;
}

export function needsBackfill(raw?: LibraryMetaRecord, now = Date.now(), wantedLanguage?: string): boolean {
  const viewed = viewMeta(raw);
  if (!viewed?.id) return false;
  const tried = raw?.backfilledAt ? Date.parse(raw.backfilledAt) : NaN;
  if (Number.isFinite(tried) && now - tried < BACKFILL_TTL_MS) return false;
  if (wantedLanguage && raw?.metaLanguage !== wantedLanguage) return true;
  return !raw?.name || !raw.year || !raw.description;
}

/** A bound series whose episode rows are not cached yet. */
export function needsEpisodes(
  record: LibraryMetaRecord | undefined,
  numbers: { season: number; episode: number } | undefined,
  episodes: Record<string, LibraryEpisodeRecord>,
): boolean {
  if (!record?.id || record.type !== "series" || !numbers) return false;
  return !episodes[episodeKey(record.type, record.id, numbers.season, numbers.episode)];
}

export interface BrowseMetaView {
  match: MatchStatus;
  year?: string;
  description?: string;
  catalogName?: string;
  skipLookup?: boolean;
  skipMosaic?: boolean;
  season?: number;
  episode?: number;
  suggestion?: LibrarySuggestion;
  /** How many pictures the title's stored gallery holds. Absent where it holds none. */
  gallery?: number;
}

export function browseMeta(
  relative: string,
  label: string,
  records: Record<string, LibraryMetaRecord>,
  suggestions: Record<string, LibrarySuggestion> = {},
  episodes: Record<string, LibraryEpisodeRecord> = {},
): BrowseMetaView {
  const match = matchStatus(relative, records, suggestions);
  const skipLookup = Boolean(records[relative]?.skipLookup);
  const skipMosaic = Boolean(records[relative]?.skipMosaic);
  // How many pictures the row can show, so a tile offers the button only where there is
  // something behind it. The pictures themselves are asked for when it is pressed.
  const gallery = records[relative]?.gallery?.length;
  const base: BrowseMetaView = { match, ...(skipLookup ? { skipLookup } : {}), ...(skipMosaic ? { skipMosaic } : {}), ...(gallery ? { gallery } : {}) };
  if (match === "suggested") {
    const suggestion = suggestionFor(relative, suggestions);
    return suggestion ? { ...base, suggestion } : base;
  }
  if (match !== "matched") return base;
  const entry = knownTitleEntry(relative, records);
  if (!entry) return base;
  const known = entry.record;
  const named = (value?: string) => (value && normalizeTitle(value) !== normalizeTitle(label) ? value : undefined);

  if (known.type === "series" && isVideo(posixBase(relative))) {
    const numbers = episodeNumberOf(relative, records[relative]?.id ? records[relative] : undefined);
    // Without the episode text the series plot would repeat on every row, which
    // says nothing about the file in front of the user.
    const found = numbers ? episodes[episodeKey(known.type, known.id, numbers.season, numbers.episode)] : undefined;
    const catalogName = named(found?.name);
    return {
      ...base,
      ...(numbers ? { season: numbers.season, episode: numbers.episode } : {}),
      ...(found?.released?.slice(0, 4).match(/^(19|20)\d{2}$/) ? { year: found.released.slice(0, 4) } : {}),
      ...(found?.description ? { description: found.description } : {}),
      ...(catalogName ? { catalogName } : {}),
    };
  }
  // A season folder sits under the series that already carries the plot.
  if (known.type === "series" && entry.key !== relative) return base;

  const catalogName = named(known.name);
  return {
    ...base,
    ...(known.year ? { year: known.year } : {}),
    ...(known.description ? { description: known.description } : {}),
    ...(catalogName ? { catalogName } : {}),
  };
}

/** The ancestor key whose row covers this path, `accept` deciding what counts as cover. */
function coveringKey<T>(records: Record<string, T>, relative: string, accept: (value: T) => boolean): string | undefined {
  const parts = relative.split("/");
  for (let depth = parts.length; depth >= 1; depth -= 1) {
    const key = parts.slice(0, depth).join("/");
    const found = records[key];
    if (found !== undefined && accept(found)) return key;
  }
  return undefined;
}

/** A binding is inherited from the folders above, so moving an item to another folder would
 *  hand it the destination's title and strip the one it was showing. What covered it from
 *  above is written onto its own path first, so the identity travels with the item -- unless
 *  the same ancestor covers the destination too, where the inheritance already holds. */
export function pinInherited(
  meta: Record<string, LibraryMetaRecord>,
  suggestions: Record<string, LibrarySuggestion>,
  relative: string,
  nextRelative: string,
): { meta: Record<string, LibraryMetaRecord>; suggestions: Record<string, LibrarySuggestion> } {
  const stillCovers = (key: string | undefined) => key !== undefined && (key === relative || isPathWithin(nextRelative, key));

  const nextMeta = { ...meta };
  const bound = knownTitleEntry(relative, meta);
  if (bound && !stillCovers(bound.key)) nextMeta[relative] = { ...bound.record };
  // Catalogue lookup switched off on a folder is a decision about the item too.
  const ignored = coveringKey(meta, relative, (record) => Boolean(record.skipLookup));
  if (ignored && !stillCovers(ignored)) {
    const own = nextMeta[relative] ?? meta[relative] ?? { type: meta[ignored]!.type, id: "", source: "user" as const };
    nextMeta[relative] = { ...own, skipLookup: true };
  }
  // So is being kept out of the mosaic.
  const hidden = coveringKey(meta, relative, (record) => Boolean(record.skipMosaic));
  if (hidden && !stillCovers(hidden)) {
    const own = nextMeta[relative] ?? meta[relative] ?? { type: meta[hidden]!.type, id: "", source: "user" as const };
    nextMeta[relative] = { ...own, skipMosaic: true };
  }

  const nextSuggestions = { ...suggestions };
  const suggested = coveringKey(suggestions, relative, (suggestion) => Boolean(suggestion.id));
  if (suggested && !stillCovers(suggested)) nextSuggestions[relative] = { ...suggestions[suggested]! };

  return { meta: nextMeta, suggestions: nextSuggestions };
}

export function remapKeyed<T>(records: Record<string, T>, from: string, to: string): Record<string, T> {
  return Object.fromEntries(Object.entries(records).map(([key, value]) => [remapPath(key, from, to), value]));
}

export function dropKeyed<T>(records: Record<string, T>, relative: string): Record<string, T> {
  return Object.fromEntries(Object.entries(records).filter(([key]) => !isPathWithin(key, relative)));
}

function parentOf(relative: string): string {
  const index = relative.lastIndexOf("/");
  return index < 0 ? "" : relative.slice(0, index);
}

function isTaggedEpisode(filename: string): boolean {
  return /s\d{1,3}[\s._-]*e\d{1,4}/i.test(filename);
}

export function isExtraName(filename: string): boolean {
  const title = parseMediaPath(filename).title.toLowerCase();
  return title.split(/[\s-]+/).filter(Boolean).some((token) => EXTRA_TOKENS.has(token));
}

function comparableTitle(filename: string): string {
  return normalizeTitle(parseMediaPath(filename).title).replace(/\s+\d+$/, "").trim();
}

interface DirIndex {
  videos: Map<string, FoundFile[]>;
  children: Map<string, Set<string>>;
  all: FoundFile[];
}

function indexFiles(files: FoundFile[]): DirIndex {
  const videos = new Map<string, FoundFile[]>();
  const children = new Map<string, Set<string>>();
  const addChild = (parent: string, child: string) => {
    const set = children.get(parent) ?? new Set<string>();
    set.add(child);
    children.set(parent, set);
  };
  for (const file of files) {
    const parts = file.relative.split("/");
    let acc = "";
    for (let i = 0; i < parts.length - 1; i += 1) {
      const dir = acc ? `${acc}/${parts[i]}` : parts[i]!;
      addChild(acc, dir);
      acc = dir;
    }
    const parent = parentOf(file.relative);
    const list = videos.get(parent) ?? [];
    list.push(file);
    videos.set(parent, list);
  }
  return { videos, children, all: files };
}

function filesUnder(index: DirIndex, dir: string): string[] {
  if (!dir) return index.all.map((file) => file.relative);
  const prefix = `${dir}/`;
  return index.all.filter((file) => file.relative.startsWith(prefix)).map((file) => file.relative);
}

function uniqueNonExtraTitles(videos: FoundFile[]): Set<string> {
  const titles = new Set<string>();
  for (const file of videos) {
    if (isExtraName(posixBase(file.relative))) continue;
    const title = comparableTitle(posixBase(file.relative));
    if (title) titles.add(title);
  }
  return titles;
}

function isCollection(index: DirIndex, dir: string): boolean {
  return uniqueNonExtraTitles(index.videos.get(dir) ?? []).size >= 2;
}

function emit(out: TitleUnit[], key: string, kind: TitleKind, samples: string[]) {
  out.push({ key, kind, relative: key, sampleFiles: samples });
}

function classifyVideosOnly(index: DirIndex, dir: string, videos: FoundFile[], out: TitleUnit[]) {
  const nonExtra = videos.filter((file) => !isExtraName(posixBase(file.relative)));
  if (!nonExtra.length) return;
  const tagged = videos.filter((file) => isTaggedEpisode(posixBase(file.relative)));
  if (tagged.length * 2 > videos.length) {
    emit(out, dir, "series", videos.map((file) => file.relative));
    return;
  }
  if (nonExtra.length === 1 || uniqueNonExtraTitles(videos).size === 1) {
    emit(out, dir, "movie", videos.map((file) => file.relative));
  }
}

function classifyFolder(index: DirIndex, dir: string, out: TitleUnit[]) {
  const videos = index.videos.get(dir) ?? [];
  const children = [...(index.children.get(dir) ?? [])];
  if (children.some((child) => parseSeason(posixBase(child)) != null)) {
    emit(out, dir, "series", filesUnder(index, dir));
    return;
  }
  if (isCollection(index, dir)) return;
  if (children.length) {
    walkContainer(index, dir, out);
    return;
  }
  classifyVideosOnly(index, dir, videos, out);
}

function walkContainer(index: DirIndex, dir: string, out: TitleUnit[]) {
  for (const video of index.videos.get(dir) ?? []) {
    emit(out, video.relative, "movie", [video.relative]);
  }
  for (const child of index.children.get(dir) ?? []) classifyFolder(index, child, out);
}

/** Unit boundaries never depend on the library type -- only the kind does. A tree
 *  typed `movie` keeps every unit, including one holding a season folder, and a tree
 *  typed `series` emits no movie at all; `mixed` is the structure-driven default. */
export function titleUnits(files: FoundFile[], type: LibraryType = "mixed"): TitleUnit[] {
  const out: TitleUnit[] = [];
  walkContainer(indexFiles(files), "", out);
  if (type === "mixed") return out;
  return out.map((unit) => ({ ...unit, kind: type }));
}

export function matchKeyFor(relative: string, files: FoundFile[]): string {
  const units = titleUnits(files);
  const covering = units.filter((unit) => relative === unit.key || isPathWithin(relative, unit.key));
  if (covering.length) return covering.sort((a, b) => b.key.length - a.key.length)[0]!.key;

  if (isVideo(relative)) {
    const parent = parentOf(relative);
    if (!parent) return relative;
    const siblings = files.filter((file) => parentOf(file.relative) === parent);
    const nested = files.filter((file) => file.relative.startsWith(`${parent}/`) && parentOf(file.relative) !== parent);
    if (nested.length) {
      const sameFolder = files.filter((file) => parentOf(file.relative) === parent);
      if (sameFolder.length === 1 || uniqueNonExtraTitles(sameFolder).size <= 1) return parent;
      return relative;
    }
    if (isCollection({ videos: new Map([[parent, siblings]]), children: new Map(), all: siblings }, parent)) return relative;
    if (siblings.length) return parent;
    return relative;
  }
  return relative;
}
