import { isPathWithin, isVideo, numberedEpisode, parseSeason, remapPath, type FoundFile } from "./library.js";
import { LIBRARY_ID, parseLibraryPath, posixBase, type LibraryType } from "./libraries.js";
import { isPackagingFolderName, parseMediaName, parseMediaPath, partSignature, stripPartMarkers, titleSides, titleVariants, type ParsedMedia } from "./library-parse.js";
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
  /** The file and the candidate disagree about a sequel/part marker, so this is a
   *  different film rather than a different cut of the same one. */
  partConflict?: boolean;
  /** The best name match came from one half of a spaced split, never from the whole name. */
  sideMatch?: boolean;
}

/** A scan result for one title unit. An entry without an id is the memory of a
 *  search that found nothing, so the next scan does not repeat it. */
export interface LibrarySuggestion {
  type: string;
  id: string;
  name: string;
  year?: number;
  score: number;
  /** Name-only similarity, as an integer percentage. Older persisted suggestions lack it. */
  titleSimilarity?: number;
  scannedAt?: string;
  /** Why a high score still wants a look. Absent when nothing about the match is
   *  worth explaining. */
  reason?: SuggestionReason;
  /** The competing candidates a person needs to tell apart. Bounded: only the identity,
   *  a name and the two scores, never a provider payload or an image address. */
  alternatives?: SuggestionAlternative[];
  /** The candidate's own poster, as the provider gave it. The route proxies it before
   *  the browser ever sees the address. */
  poster?: string;
  /** Set on a correction: the automatic binding this proposal would replace. */
  replacesId?: string;
  replacesName?: string;
  replacesYear?: number;
  /** The matching rules that produced this row. A row written by older rules is
   *  reconsidered once instead of on every startup. */
  rule?: number;
  /** Set when a person dismissed the proposal: the rules stop asking about it. */
  dismissed?: boolean;
}

/** The short explanation a proposal carries when a high score is not the whole story. */
export type SuggestionReason = "ambiguous" | "year" | "part" | "correction";

/** One competing candidate of a proposal, just enough for a person to tell them apart. */
export interface SuggestionAlternative {
  type: string;
  id: string;
  name: string;
  year?: number;
  score: number;
  titleSimilarity: number;
}

export interface LibraryMetaRecord {
  type: string;
  id: string;
  source?: "download" | "user" | "scan";
  locked?: boolean;
  skipLookup?: boolean;
  skipMosaic?: boolean;
  /** A binding this path deliberately does not take, while the folders above keep theirs.
   *  Only `unmatchAt` writes it; a row without an identity that carries no flag at all
   *  predates the marker and means the same. */
  unmatched?: boolean;
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

const EXTRA_TOKENS = new Set(["trailer", "sample", "extra", "bonus", "deleted", "featurette"]);
const ARTICLES = /^(the|a|an)\s+/;
/** The matching rules that wrote a suggestion or a remembered miss. Bumped whenever a
 *  decision changes meaning, so old rows are reconsidered exactly once. */
export const MATCH_RULE_VERSION = 6;

/** The lowest score a single candidate can carry and still be bound without a person's word. */
export const AUTO_ACCEPT_MIN_SCORE = 85;

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
    // Every script keeps its own letters: "नरसिंहा Avatar" is not the name "Avatar".
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
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

/** How many people know the candidate, when the provider says. Nobody knows it otherwise. */
function votesOf(item: MetaItem): number {
  const count = item.voteCount;
  return typeof count === "number" && Number.isFinite(count) ? count : 0;
}

/** A candidate nobody could have watched yet: the file in front of the user is not it. */
function releasedInFuture(item: MetaItem, now = Date.now()): boolean {
  const released = item.released;
  if (typeof released !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(released)) return false;
  return released > new Date(now).toISOString().slice(0, 10);
}

/** Every name a candidate is known by: the localized one and the original the provider
 *  kept beside it. A Czech file and an English catalogue entry still meet here. */
export function candidateTitles(item: MetaItem): string[] {
  const titles = [item.name, typeof item.originalTitle === "string" ? item.originalTitle : undefined]
    .filter((value): value is string => Boolean(value && value.trim()));
  return titles.length ? titles : [""];
}

/** The candidate title that reads closest to the file's own words. */
export function bestCandidateTitle(left: string, item: MetaItem): string {
  let best = candidateTitles(item)[0]!;
  let bestScore = -1;
  for (const candidate of candidateTitles(item)) {
    const score = titleSimilarityOf(normalizeTitle(left), normalizeTitle(candidate));
    if (score > bestScore) { bestScore = score; best = candidate; }
  }
  return best;
}

function titleSimilarityOf(left: string, right: string): number {
  const maxLen = Math.max(left.length, right.length);
  const edit = maxLen === 0 ? 1 : 1 - levenshtein(left, right) / maxLen;
  const similarity = 0.7 * dice(tokensOf(left), tokensOf(right)) + 0.3 * edit;
  // "Spiderman" and "Spider-Man" are the one name written with and without a space.
  if (similarity < 1 && left.replace(/\s+/g, "") === right.replace(/\s+/g, "")) return 1;
  return similarity;
}

/** Normalised name similarity for callers that compare whole titles, such as episode names. */
export function titleSimilarity(left: string, right: string): number {
  return titleSimilarityOf(normalizeTitle(left), normalizeTitle(right));
}

/** Whether one normalized title appears whole inside the other. A shared word is not
 *  evidence -- "WALL-E" and "Eton Wall Game" share one -- a shared phrase is. */
function phraseEvidence(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.replace(/\s+/g, "") === right.replace(/\s+/g, "")) return true;
  const haystack = ` ${left} `;
  const needle = ` ${right} `;
  return haystack.includes(needle) || needle.includes(haystack);
}

/** A title with its part markers removed, so "Second Film Part 1" and "Part 2", or "Rocky 3"
 *  and "Rocky III", compare as the same film and only the marker tells them apart. */
function matchTitle(value: string): string {
  const normalized = normalizeTitle(value);
  return stripPartMarkers(normalized) || normalized;
}

/** Whether two names are the same one: the words agree, or the spelling does. A folder
 *  "Hanební parchanti" holds "Hanebný pancharti.mkv", the name with two letters off. */
function sameName(left: string, right: string): boolean {
  const a = matchTitle(left);
  const b = matchTitle(right);
  if (!a || !b) return false;
  if (titleSimilarityOf(a, b) >= 0.75) return true;
  const length = Math.max(a.length, b.length);
  return 1 - levenshtein(a, b) / length >= 0.75;
}

/** A candidate name whose subtitle carries no weight: "Borat Subsequent Moviefilm:
 *  Delivery of ..." is the film the file names as "Borat Subsequent Moviefilm". Only a
 *  head of at least two words counts, so "Alita: Battle Angel" is not read as "Alita". */
function candidateHead(title: string): string | undefined {
  const head = title.split(":")[0]!.trim();
  if (head === title) return undefined;
  return normalizeTitle(head).split(" ").filter(Boolean).length >= 2 ? head : undefined;
}

export function scoreHit(parsed: ParsedMedia, item: MetaItem, expectedKind?: TitleKind): ScoredHit {
  if (!item.name) return { item, score: 0, titleSimilarity: 0, autoEligible: false };
  let titleSimilarity = 0;
  let evidence = false;
  let bestSide = false;
  let bestName = "";
  let bestVariant = "";
  const rights = candidateTitles(item).flatMap((title) => {
    const head = candidateHead(title);
    return head ? [{ text: title, head: false }, { text: head, head: true }] : [{ text: title, head: false }];
  });
  for (const variant of titleVariants(parsed)) {
    const left = matchTitle(variant.text);
    for (const candidate of rights) {
      const right = matchTitle(candidate.text);
      const similarity = titleSimilarityOf(left, right);
      const side = variant.side || candidate.head;
      // On a tie the whole name wins: "Toy Story 3" matches the original title and the head of
      // "Toy Story 3: Příběh hraček" alike, and it is the whole-name match that counts.
      if (similarity > titleSimilarity || (similarity === titleSimilarity && bestSide && !side)) {
        titleSimilarity = similarity;
        bestSide = side;
        bestName = candidate.text;
        bestVariant = variant.text;
      }
      if (phraseEvidence(left, right)) evidence = true;
    }
  }
  // Both halves of a bilingual name naming the candidate is stronger evidence than either half
  // alone: "Blockers - Kazisuci" meets "Kazišuci" and its original "Blockers" at once, which is
  // not the weaker guess one half of a name on its own would be.
  const sides = titleSides(parsed.title).map((side) => side.trim()).filter(Boolean);
  if (sides.length === 2) {
    const names = candidateTitles(item);
    const matching = (side: string) => names.reduce(
      (top, name) => Math.max(top, titleSimilarityOf(matchTitle(side), matchTitle(name))), 0,
    );
    const [first, second] = sides as [string, string];
    const left = matching(first);
    const right = matching(second);
    if (left >= 0.9 && right >= 0.9) {
      titleSimilarity = Math.max(titleSimilarity, Math.min(left, right));
      bestSide = false;
    }
  }
  // A folder that misspells the film inside it is not one half of a name: the file names the
  // film, and the folder names the same one badly. Both the folder and the candidate have to
  // say the same name, and either the year the file wrote agrees with the candidate's or the
  // file repeats the folder's own name.
  if (bestSide && bestName && parsed.fileTitle && bestVariant === parsed.fileTitle.trim()
    && sameName(parsed.title, bestName)
    && ((parsed.year != null && yearFromMeta(item) === parsed.year) || sameName(parsed.title, parsed.fileTitle))) {
    bestSide = false;
  }
  let score = 100 - Math.round((1 - titleSimilarity) * 50);
  let autoEligible = true;
  // A candidate that shares no phrase with the file is not evidence of anything: the
  // name-only score it would carry is noise, and offering it teaches distrust.
  if (!evidence) score = Math.min(score, SUGGESTION_MIN_SCORE - 1);
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
  if (releasedInFuture(item)) autoEligible = false;
  // The part marker is read from the file's whole title, not the search query: a suffix such
  // as "Nymfomanka - část 2" is dropped from a bilingual query, and losing it there would
  // hide exactly the disagreement this check exists to catch. The file agrees with a
  // candidate when it agrees with the first part the candidate's names state ("Doba ledová 4"
  // beside "Ice Age: Continental Drift") or with the name it matched best ("Trolls Band
  // Together" beside "Trollové 3").
  const partConflict = partConflictBetween(parsed.title, candidatePart(item))
    && partConflictBetween(parsed.title, partSignature(bestName, true));
  if (partConflict) autoEligible = false;
  score = Math.max(0, Math.min(100, score));
  return {
    item, score, titleSimilarity, yearDelta, autoEligible,
    ...(partConflict ? { partConflict: true } : {}),
    ...(bestSide ? { sideMatch: true } : {}),
  };
}

const ROMAN_SPELLING: Record<number, string> = {
  1: "i", 2: "ii", 3: "iii", 4: "iv", 5: "v", 6: "vi", 7: "vii", 8: "viii", 9: "ix", 10: "x",
};

/** Whether the file's own name states the number a candidate's `part:N` names, in either
 *  spelling. "Hotel Transylvania 3 Summer Vacation" writes the part without a marker. */
function statesPart(fileTitle: string, part: string): boolean {
  const match = /^part:(\d+)$/.exec(part);
  if (!match) return false;
  const number = Number(match[1]);
  const wanted = new Set([String(number)]);
  const roman = ROMAN_SPELLING[number];
  if (roman) wanted.add(roman);
  // "Jackass 3D" writes part three as the number the 3D copy is named after.
  return fileTitle.toLowerCase().split(/[^a-z0-9]+/).some((token) => wanted.has(token) || wanted.has(token.replace(/d$/, "")));
}

/** The part a candidate states: the first non-empty signature among its names. */
function candidatePart(item: MetaItem): string {
  for (const name of candidateTitles(item)) {
    const part = partSignature(name, true);
    if (part) return part;
  }
  return "";
}

function partConflictBetween(fileTitle: string, candPart: string): boolean {
  const filePart = partSignature(fileTitle, true);
  if (filePart === candPart) return false;
  // The first film is seldom numbered: "Transformers I" is "Transformers".
  if ((filePart === "part:1" && candPart === "") || (filePart === "" && candPart === "part:1")) return false;
  // A file that writes the number down without a marker still names the part.
  if (filePart === "" && statesPart(fileTitle, candPart)) return false;
  return true;
}

/** The file and the candidate disagree about which part of a franchise this is. */
export function titlePartConflict(fileTitle: string, candidateTitle: string): boolean {
  return partConflictBetween(fileTitle, partSignature(candidateTitle, true));
}

/** How well known a namesake has to be before it wins without a person's word, and by how
 *  much it has to beat the other name of the same title. */
const NAMESAKE_MIN_VOTES = 50;
const NAMESAKE_DOMINANCE = 10;

/** `nowYear` stays for callers that pass it: which film is newer no longer decides anything. */
export function autoAccept(
  hits: ScoredHit[],
  nowYear = new Date().getFullYear(),
  options: { country?: string } = {},
): ScoredHit | undefined {
  const ranked = hits.filter((hit) => hit.autoEligible).sort((a, b) =>
    b.score - a.score || Number(Boolean(a.sideMatch)) - Number(Boolean(b.sideMatch)) || votesOf(b.item) - votesOf(a.item));
  const top = ranked[0];
  if (!top || top.score < AUTO_ACCEPT_MIN_SCORE || top.titleSimilarity < 0.90) return undefined;
  if (top.partConflict || top.sideMatch) return undefined;
  const close = ranked.filter((hit) => top.score - hit.score < 15 && hit.titleSimilarity >= 0.90);
  // A rival that only half of a name explains is weaker evidence than the whole-name match on
  // top, so it does not stand in its way.
  const rivals = close.filter((hit) => hit.item.id !== top.item.id && !hit.sideMatch && !foreignCountry(hit.item, options.country));
  if (!rivals.length) return top;
  // Two namesakes are told apart by how many people know them, never by which one is newer:
  // the title the file means is the one with an audience, the other ten times smaller.
  const votes = votesOf(top.item);
  const rivalVotes = Math.max(...rivals.map((hit) => votesOf(hit.item)));
  return votes >= NAMESAKE_MIN_VOTES && votes >= NAMESAKE_DOMINANCE * rivalVotes ? top : undefined;
}

/** A known origin that does not contain the country the file names is another production,
 *  so it is no rival of this one. An unknown origin proves nothing either way. */
function foreignCountry(item: MetaItem, country: string | undefined): boolean {
  if (!country) return false;
  const origins = item.originCountry;
  if (!Array.isArray(origins) || !origins.length) return false;
  const wanted = country.toUpperCase() === "UK" ? "GB" : country.toUpperCase();
  return !origins.some((origin) => {
    const code = String(origin).toUpperCase();
    return (code === "UK" ? "GB" : code) === wanted;
  });
}

/** Below this the best hit is noise -- offering it would only teach the user to distrust the list. */
export const SUGGESTION_MIN_SCORE = 60;

/** The hits a proposal is argued from, most trusted first: the ones worth showing, a whole
 *  name on a tie ahead of a half of it, and among equals the better known one. */
function rankedHits(hits: ScoredHit[]): ScoredHit[] {
  return hits.filter((hit) => hit.autoEligible || hit.partConflict || releasedInFuture(hit.item))
    .sort((a, b) =>
      b.score - a.score || Number(Boolean(a.sideMatch)) - Number(Boolean(b.sideMatch)) || votesOf(b.item) - votesOf(a.item));
}

/** A title and a distinct identity of its own that the file could equally mean. Either a
 *  close-scoring namesake or the same title with a different year -- two remakes of one name
 *  are as ambiguous to a nameless file as two different titles. */
export function competingHits(ranked: ScoredHit[]): ScoredHit[] {
  const top = ranked[0];
  if (!top) return [];
  const topName = normalizeTitle(top.item.name);
  return ranked.filter((hit) => {
    if (hit === top || hit.item.id === top.item.id) return false;
    const namesake = normalizeTitle(hit.item.name) === topName && yearFromMeta(hit.item) !== yearFromMeta(top.item);
    return namesake || (top.score - hit.score < 15 && hit.titleSimilarity >= 0.90);
  });
}

/** The candidates whose own length could tell a proposal's nameless namesakes apart: the best
 *  hit and the ones it competes with, distinct and bounded. */
export function runtimeRivals(hits: ScoredHit[], limit = 4): ScoredHit[] {
  const ranked = rankedHits(hits);
  const top = ranked[0];
  if (!top) return [];
  const out = [top];
  const seen = new Set([`${top.item.type}:${top.item.id}`]);
  for (const hit of competingHits(ranked)) {
    const key = `${hit.item.type}:${hit.item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
    if (out.length >= limit) break;
  }
  return out;
}

/** The other candidates a person needs to tell this one apart from. Bounded in size and
 *  in content: identity, name and scores only, never a provider payload or an image URL. */
function alternativesOf(ranked: ScoredHit[], top: ScoredHit, minScore: number, limit = 3): SuggestionAlternative[] {
  const seen = new Set<string>([`${top.item.type}:${top.item.id}`]);
  const out: SuggestionAlternative[] = [];
  for (const hit of ranked) {
    if (out.length >= limit) break;
    if (hit === top || hit.score < minScore || !hit.item.name) continue;
    const key = `${hit.item.type}:${hit.item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const year = yearFromMeta(hit.item);
    out.push({
      type: hit.item.type, id: hit.item.id, name: hit.item.name,
      score: hit.score, titleSimilarity: Math.round(hit.titleSimilarity * 100),
      ...(year != null ? { year } : {}),
    });
  }
  return out;
}

export function pickSuggestion(hits: ScoredHit[], minScore = SUGGESTION_MIN_SCORE): LibrarySuggestion | undefined {
  // A wrong type or a year off by more than two is not a safe match and is not offered as
  // if it were: the proposal list is where a person decides, and a bad row wastes that.
  // A part conflict is the exception: it is worth a person's look, just never a binding.
  // On a tie the whole name beats a half of it, and among equals the better known one wins.
  // A half of the name or a sequel that disagrees is not a binding, but it is still worth a
  // person's look; so is a title that is not out yet, which the scan would otherwise forget
  // as a miss for a month.
  const ranked = rankedHits(hits);
  const top = ranked[0];
  if (!top || top.score < minScore) return undefined;
  const year = yearFromMeta(top.item);
  // The number beside a proposal is title-name similarity, so everything that is not in
  // that number gets said out loud instead of hiding behind 100%.
  const reason: SuggestionReason | undefined = competingHits(ranked).length
    ? "ambiguous"
    : top.partConflict
      ? "part"
      // Only a year the file actually states can disagree: a missing file year is not a
      // conflict, it is just a title whose release the file never wrote down.
      : ranked.some((hit) => (hit.yearDelta ?? 0) > 0) ? "year" : undefined;
  const alternatives = alternativesOf(ranked, top, minScore);
  const poster = typeof top.item.poster === "string" && top.item.poster ? top.item.poster : undefined;
  return {
    type: top.item.type,
    id: top.item.id,
    name: top.item.name,
    score: top.score,
    titleSimilarity: Math.round(top.titleSimilarity * 100),
    rule: MATCH_RULE_VERSION,
    ...(year != null ? { year } : {}),
    ...(reason ? { reason } : {}),
    ...(alternatives.length ? { alternatives } : {}),
    ...(poster ? { poster } : {}),
  };
}

/** Remembers that the unit was searched for and nothing usable came back. A dismissal is
 *  the same memory plus a mark, so a later rule change does not undo the person's answer. */
export const scanMiss = (kind: TitleKind, at = new Date().toISOString(), dismissed = false): LibrarySuggestion =>
  ({ type: kind, id: "", name: "", score: 0, scannedAt: at, rule: MATCH_RULE_VERSION, ...(dismissed ? { dismissed: true } : {}) });

/** Whether a remembered row was written by rules that no longer apply. A row somebody
 *  dismissed is never stale: the decision was theirs, not the rules'. */
export function needsReevaluation(suggestion: LibrarySuggestion | undefined): boolean {
  if (!suggestion || suggestion.dismissed) return false;
  return suggestion.rule !== MATCH_RULE_VERSION;
}

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

/** Whether the row takes the folders' binding away from one path instead of standing for an
 *  identity of its own. A flag beside no identity is an exclusion -- the path is kept out of
 *  matching or the mosaic but keeps the title it is shown under -- while a row like that
 *  without any flag is a binding deliberately dropped. */
function isUnmatched(record: LibraryMetaRecord | undefined): boolean {
  if (!record || record.id) return false;
  if (record.unmatched === true) return true;
  return !record.skipLookup && !record.skipMosaic;
}

/** The binding that covers this path, together with the path it is stored at. An exclusion
 *  is passed over, so the row below it still answers with the identity it inherited. */
export function knownTitleEntry(
  relative: string,
  records: Record<string, LibraryMetaRecord>,
): { key: string; record: LibraryMetaRecord } | undefined {
  const parts = relative.split("/");
  for (let depth = parts.length; depth >= 1; depth -= 1) {
    const key = parts.slice(0, depth).join("/");
    const found = records[key];
    if (!found) continue;
    if (found.id) return { key, record: found };
    if (isUnmatched(found)) return undefined;
  }
  return undefined;
}

export function knownTitleOf(relative: string, records: Record<string, LibraryMetaRecord>): LibraryMetaRecord | undefined {
  return knownTitleEntry(relative, records)?.record;
}

/** The binding of a unit, with the key it is stored at. A caller holding a concrete file of
 *  the unit passes it as `file`: what that file says about itself beats what the folder unit
 *  says, and an unmatch on the file keeps the folder's binding away from it. A file kept out
 *  of matching or the mosaic is not one of those: the exclusion is respected, the identity
 *  is still the unit's, and the key that supplied it stays the unit's, so the row keeps the
 *  folder's picture. Files that say nothing about themselves keep the unit's binding too, so
 *  siblings and same-title copies stay covered. A loose movie in a collection is its own
 *  unit and owns its identity already: it must not inherit the collection folder's binding. */
export function knownEntryForUnit(
  unit: TitleUnit | string | undefined,
  records: Record<string, LibraryMetaRecord>,
  file?: string,
): { key: string; record: LibraryMetaRecord } | undefined {
  const unitKey = typeof unit === "string" ? unit : unit?.key;
  if (!unitKey) return undefined;
  const path = file && file !== unitKey ? file : unitKey;
  if (path !== unitKey) {
    const own = records[path];
    if (own?.id) return { key: path, record: own };
    if (own && isUnmatched(own)) return undefined;
    if (!isVideo(posixBase(path))) return knownTitleEntry(path, records);
    return knownTitleEntry(unitKey, records);
  }
  if (isVideo(posixBase(path))) {
    if (records[path]?.id) return { key: path, record: records[path]! };
    const inherited = knownTitleEntry(path, records);
    if (!inherited || normalizeTitle(parseMediaPath(posixBase(path)).title) !== normalizeTitle(parseMediaPath(posixBase(inherited.key)).title)) return undefined;
    return inherited;
  }
  return knownTitleEntry(path, records);
}

export function knownTitleForUnit(
  unit: TitleUnit | string | undefined,
  records: Record<string, LibraryMetaRecord>,
  file?: string,
): LibraryMetaRecord | undefined {
  return knownEntryForUnit(unit, records, file)?.record;
}

/** Clear the binding on this path only. A path that still inherits one from a matched
 *  folder gets a sentinel, so siblings keep the parent while this one comes loose. The
 *  marker is what tells that sentinel from a row that only carries a flag. */
export function unmatchAt(records: Record<string, LibraryMetaRecord>, relative: string): Record<string, LibraryMetaRecord> {
  const next = { ...records };
  const previous = next[relative];
  delete next[relative];
  const inherited = knownTitleOf(relative, next);
  if (inherited?.id) {
    next[relative] = {
      type: inherited.type, id: "", source: "user", unmatched: true,
      ...(previous?.skipLookup ? { skipLookup: true } : {}),
      ...(previous?.skipMosaic ? { skipMosaic: true } : {}),
    };
  } else if (previous?.skipLookup) {
    next[relative] = { type: previous.type, id: "", source: previous.source ?? "user", skipLookup: true, unmatched: true };
  }
  return next;
}

/** Turns one path's "keep out of matching" or "keep out of the mosaic" flag on and off. A
 *  flag says nothing about which film a path is, so a row written for one leaves an inherited
 *  binding where it is -- the row is an exclusion, not an identity of its own -- and an
 *  unmatch keeps its marker, which no flag turns back into a binding. */
export function withSkipFlag(
  records: Record<string, LibraryMetaRecord>,
  relative: string,
  name: "skipLookup" | "skipMosaic",
  value: boolean,
): Record<string, LibraryMetaRecord> {
  const next = { ...records };
  const current = next[relative];
  if (value) {
    const record: LibraryMetaRecord = {
      type: current?.type ?? "movie",
      id: current?.id ?? "",
      source: current?.source ?? "user",
      ...(current?.locked != null ? { locked: current.locked } : {}),
      ...(current && isUnmatched(current) ? { unmatched: true } : {}),
      ...(current?.name ? { name: current.name } : {}),
      ...(current?.year ? { year: current.year } : {}),
      ...(current?.description ? { description: current.description } : {}),
      ...(current?.matchedAt ? { matchedAt: current.matchedAt } : {}),
      ...(current?.skipLookup ? { skipLookup: true } : {}),
      ...(current?.skipMosaic ? { skipMosaic: true } : {}),
    };
    if (name === "skipLookup") record.skipLookup = true; else record.skipMosaic = true;
    next[relative] = record;
    return next;
  }
  if (!current) return next;
  const kept: LibraryMetaRecord = { ...current };
  if (name === "skipLookup") delete kept.skipLookup; else delete kept.skipMosaic;
  if (kept.id || kept.skipLookup || kept.skipMosaic || kept.unmatched || isUnmatched(current)) next[relative] = kept;
  else delete next[relative];
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

/** The proposal covering a unit, and for a caller holding one concrete file of the unit that
 *  file's own proposal first: the same precedence a binding has over the folder unit. */
export function suggestionForUnit(
  unit: TitleUnit | undefined,
  suggestions: Record<string, LibrarySuggestion>,
  file?: string,
): LibrarySuggestion | undefined {
  const unitKey = unit?.key;
  if (!unitKey) return undefined;
  const path = file && file !== unitKey ? file : unitKey;
  if (path !== unitKey) {
    if (suggestions[path]?.id) return suggestions[path];
    if (!isVideo(posixBase(path))) return suggestionFor(path, suggestions);
    return suggestionFor(unitKey, suggestions);
  }
  if (isVideo(posixBase(path))) {
    if (suggestions[path]?.id) return suggestions[path];
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (normalizeTitle(parseMediaPath(posixBase(path)).title) !== normalizeTitle(parseMediaPath(posixBase(parent)).title)) return undefined;
    return suggestions[parent]?.id ? suggestions[parent] : undefined;
  }
  return suggestionFor(path, suggestions);
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
 *  title that is not already bound and whose lookup was not skipped. A correction of an
 *  unlocked automatic binding is one of them: it names the id it would replace, and the
 *  ordinary proposal for a title that is already bound stays out. Qualified keys, the
 *  form `metaStore.qualifiedSuggestions()` hands out. */
export function pendingSuggestionKeys(
  records: Record<string, LibraryMetaRecord>,
  suggestions: Record<string, LibrarySuggestion>,
): string[] {
  return Object.entries(suggestions)
    .filter(([key, suggestion]) => {
      if (!suggestion.id || lookupSkipped(key, records)) return false;
      const bound = knownTitleOf(key, records);
      if (!bound?.id) return true;
      return Boolean(suggestion.replacesId) && suggestion.replacesId === bound.id
        && suggestion.id !== bound.id && bound.source === "scan" && bound.locked !== true;
    })
    .map(([key]) => key);
}

/** The saved proposals a finished scan may drop: their library is here now, and no title
 *  unit covers the key any more. A library that is away keeps its rows, so an unplugged
 *  disk never reads as a library that lost everything. */
export function staleSuggestionKeys(
  suggestions: Record<string, LibrarySuggestion>,
  units: TitleUnit[],
  reachableLibraryIds: ReadonlySet<string>,
): string[] {
  return Object.keys(suggestions).filter((key) => {
    const libraryId = parseLibraryPath(key)?.libraryId;
    if (!libraryId || !reachableLibraryIds.has(libraryId)) return false;
    return !units.some((unit) => isPathWithin(key, unit.key));
  });
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
  unit?: TitleUnit,
  mosaicFolder = false,
): BrowseMetaView {
  // A row that is one file of its unit answers with what that file says about itself first.
  const file = isVideo(posixBase(relative)) ? relative : undefined;
  const knownEntry = knownEntryForUnit(unit, records, file);
  const knownForRow = knownEntry?.record;
  const proposedForRow = suggestionForUnit(unit, suggestions, file);
  // The title the row inherited wins over its own exclusion, and the exclusion is read from
  // the row's own path: a file kept out of matching is still the film the folder names.
  const match = mosaicFolder ? "unmatched" : unit
    ? knownForRow?.id ? "matched" : lookupSkipped(relative, records) ? "rejected" : proposedForRow ? "suggested" : "unmatched"
    : matchStatus(relative, records, suggestions);
  const skipLookup = Boolean(records[relative]?.skipLookup);
  const skipMosaic = Boolean(records[relative]?.skipMosaic);
  // How many pictures the row can show, so a tile offers the button only where there is
  // something behind it. The pictures themselves are asked for when it is pressed.
  const gallery = records[relative]?.gallery?.length;
  const base: BrowseMetaView = { match, ...(skipLookup ? { skipLookup } : {}), ...(skipMosaic ? { skipMosaic } : {}), ...(gallery ? { gallery } : {}) };
  if (match === "suggested") {
    const suggestion = unit ? proposedForRow : suggestionFor(relative, suggestions);
    return suggestion ? { ...base, suggestion } : base;
  }
  if (match !== "matched") return base;
  const entry = mosaicFolder ? undefined : unit ? knownEntry : knownTitleEntry(relative, records);
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
  if (bound && !stillCovers(bound.key)) {
    // Whatever the item itself kept out of matching or the mosaic travels with it.
    const own = meta[relative];
    nextMeta[relative] = {
      ...bound.record,
      ...(own?.skipLookup ? { skipLookup: true } : {}),
      ...(own?.skipMosaic ? { skipMosaic: true } : {}),
    };
  }
  // Catalogue lookup switched off on a folder is a decision about the item too.
  const ignored = coveringKey(meta, relative, (record) => Boolean(record.skipLookup));
  if (ignored && !stillCovers(ignored)) {
    const previous = meta[relative];
    const own = nextMeta[relative] ?? previous ?? { type: meta[ignored]!.type, id: "", source: "user" as const };
    nextMeta[relative] = { ...own, ...(previous && isUnmatched(previous) ? { unmatched: true } : {}), skipLookup: true };
  }
  // So is being kept out of the mosaic.
  const hidden = coveringKey(meta, relative, (record) => Boolean(record.skipMosaic));
  if (hidden && !stillCovers(hidden)) {
    const previous = meta[relative];
    const own = nextMeta[relative] ?? previous ?? { type: meta[hidden]!.type, id: "", source: "user" as const };
    nextMeta[relative] = { ...own, ...(previous && isUnmatched(previous) ? { unmatched: true } : {}), skipMosaic: true };
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

/** The identity one film keeps across its encodes, its CD halves and its single file. A
 *  physical segment is dropped, because the halves belong to one identity, and the
 *  installment is written the canonical way the matcher compares titles, so "Saw 3",
 *  "Saw III" and "Saw III CD1" are one film while "Saw" and "Saw IV" are their own. */
function comparableTitle(filename: string): string {
  // "Obsession (2)" is a second encode of one film, so the parenthesised copy number goes.
  const title = parseMediaPath(filename).title.replace(/\(\s*\d{1,3}\s*\)\s*$/, "");
  const normalized = normalizeTitle(title);
  const base = stripPartMarkers(normalized) || normalized;
  const part = partSignature(title, true);
  return part ? `${base} ${part}` : base;
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

function emit(out: TitleUnit[], key: string, kind: TitleKind, samples: string[]) {
  out.push({ key, kind, relative: key, sampleFiles: samples });
}

/** "Navstevnici.01" is an episode of one series; a plain "Toy Story 2" is a film of its own. */
const LOOSE_EPISODE_TAIL = /[\s._-](?:(\d{2,})|(?:e|ep|dil|díl|epizoda|episode)[\s._-]*\d{1,4})$/i;

function looseEpisodeTitle(filename: string): string | undefined {
  const stem = filename.replace(/\.[^.]+$/, "");
  const match = LOOSE_EPISODE_TAIL.exec(stem);
  if (!match || (match[1] && /^(?:19|20)\d{2}$/.test(match[1]))) return undefined;
  const title = normalizeTitle(stem.slice(0, match.index));
  return title || undefined;
}

function hasSharedLooseEpisodes(videos: FoundFile[]): boolean {
  const groups = new Map<string, number>();
  for (const file of videos) {
    if (isExtraName(posixBase(file.relative))) continue;
    const title = looseEpisodeTitle(posixBase(file.relative));
    if (!title) continue;
    const count = (groups.get(title) ?? 0) + 1;
    groups.set(title, count);
    if (count >= 2 && count * 2 > videos.length) return true;
  }
  return false;
}

/** A folder of loose files: one film when its non-extra files reduce to one identity,
 *  otherwise one unit per distinct film so every identity is exposed on its own name. */
function classifyVideosOnly(dir: string, videos: FoundFile[], out: TitleUnit[]) {
  const nonExtra = videos.filter((file) => !isExtraName(posixBase(file.relative)));
  if (!nonExtra.length) return;
  const tagged = videos.filter((file) => isTaggedEpisode(posixBase(file.relative)));
  if (tagged.length * 2 > videos.length) {
    emit(out, dir, "series", videos.map((file) => file.relative));
    return;
  }
  if (hasSharedLooseEpisodes(videos)) {
    emit(out, dir, "series", videos.map((file) => file.relative));
    return;
  }
  if (uniqueNonExtraTitles(videos).size === 1) {
    // Alternate encodes, CD1/CD2 halves and extras share the one identity of the folder.
    emit(out, dir, "movie", videos.map((file) => file.relative));
    return;
  }
  // Several films in one folder: each is its own unit under its own file name, and an
  // extra joins the film it names rather than standing on its own.
  const groups = new Map<string, FoundFile[]>();
  for (const file of videos) {
    const key = comparableTitle(posixBase(file.relative));
    if (!key) continue;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(file);
  }
  for (const group of groups.values()) {
    if (!group.some((file) => !isExtraName(posixBase(file.relative)))) continue;
    const samples = group.map((file) => file.relative).sort();
    emit(out, samples[0]!, "movie", samples);
  }
}

function classifyFolder(index: DirIndex, dir: string, out: TitleUnit[]) {
  const videos = index.videos.get(dir) ?? [];
  const children = [...(index.children.get(dir) ?? [])];
  // A folder that only holds one packaging folder is named by its parent: the release group
  // says who packed the file, not what it is, and the parent is the name a person wrote.
  if (!videos.length && children.length === 1 && dir && !LIBRARY_ID.test(posixBase(dir))) {
    const child = children[0]!;
    if (!(index.children.get(child)?.size ?? 0) && isPackagingFolderName(posixBase(child))) {
      const temp: TitleUnit[] = [];
      classifyVideosOnly(child, index.videos.get(child) ?? [], temp);
      if (temp.length === 1 && temp[0]!.key === child) {
        emit(out, dir, temp[0]!.kind, temp[0]!.sampleFiles);
      } else {
        out.push(...temp);
      }
      return;
    }
  }
  if (children.some((child) => parseSeason(posixBase(child)) != null)) {
    emit(out, dir, "series", filesUnder(index, dir));
    return;
  }
  if (children.length) {
    walkContainer(index, dir, out);
    return;
  }
  classifyVideosOnly(dir, videos, out);
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

/** The unit a path belongs to: the one it is a sample file of, then the narrowest unit that
 *  covers it. Every sample file of a unit answers with that unit, so an alternate encode or
 *  a CD half is identified with the film it belongs to rather than on its own path. */
export function unitFor(relative: string, units: TitleUnit[]): TitleUnit | undefined {
  const sampled = units.find((unit) => unit.key === relative || unit.sampleFiles.includes(relative));
  if (sampled) return sampled;
  const covering = units.filter((unit) => isPathWithin(relative, unit.key));
  return covering.sort((a, b) => b.key.length - a.key.length)[0];
}

export function matchKeyFor(relative: string, files: FoundFile[], units = titleUnits(files)): string {
  // Nothing covers it: the file stands for itself.
  return unitFor(relative, units)?.key ?? relative;
}

/** How a unit is searched for: a unit keyed by a video file is read from that file's own
 *  name, so a loose film inside a collection is not searched as the collection folder; a
 *  folder unit is read from the folder's name. The file extension goes with the name.
 *  A folder holding exactly one film adds what that film's own name states and the folder
 *  does not -- its year, or a title the folder misspells. */
export function parseUnit(unit: TitleUnit): ParsedMedia {
  const parsed = parseMediaPath(posixBase(unit.key));
  if (unit.kind !== "movie" || isVideo(posixBase(unit.key))) return parsed;
  if (unit.sampleFiles.length !== 1) return parsed;
  const sample = unit.sampleFiles[0]!;
  if (isExtraName(posixBase(sample))) return parsed;
  const file = parseMediaName(posixBase(sample).replace(/\.[^.]+$/, ""));
  const result: ParsedMedia = { ...parsed };
  if (parsed.year == null && file.year != null) result.year = file.year;
  // A release group's folder name is not a title the film carries, and a name too short to
  // be one ("Up") would only add noise to the search.
  const stem = posixBase(sample).replace(/\.[^.]+$/, "");
  if (file.title && normalizeTitle(file.title).length >= 3 && !isPackagingFolderName(stem)
    && normalizeTitle(file.title) !== normalizeTitle(parsed.title)) result.fileTitle = file.title;
  return result;
}

/** The distinct movie identities a folder stands for, one representative unit each, bounded.
 *  Two encodes or two folders that resolved to the same catalogue title collapse to one; a
 *  unit excluded from the mosaic is left out; a unit with no binding stays its own identity.
 *  A folder holding one film or a series contributes nothing, so it keeps its own poster. */
export function folderMosaicUnits(
  units: TitleUnit[],
  folderKey: string,
  records: Record<string, LibraryMetaRecord>,
  suggestions: Record<string, LibrarySuggestion> = {},
  limit = 5,
): TitleUnit[] {
  const seen = new Set<string>();
  const out: TitleUnit[] = [];
  for (const unit of units) {
    if (unit.kind !== "movie" || !isPathWithin(unit.key, folderKey)) continue;
    if (mosaicSkipped(unit.key, records)) continue;
    const record = knownTitleForUnit(unit, records);
    const suggestion = suggestionForUnit(unit, suggestions);
    const id = record?.id ?? suggestion?.id;
    const identity = id ? `${record?.type ?? suggestion?.type ?? "movie"}:${id}` : `path:${unit.key}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push(unit);
    if (out.length >= limit) break;
  }
  return out;
}

/** One poster per distinct film for a collection mosaic, in the order the caller ranked
 *  them and bounded. Two encodes or two folders that resolved to the same catalogue title
 *  contribute one picture, and an unbound folder stands for itself. */
export function mosaicIdentities<T extends { key: string; meta?: { type: string; id: string } }>(
  entries: T[], limit = 5,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const entry of entries) {
    const identity = entry.meta?.id ? `${entry.meta.type}:${entry.meta.id}` : `path:${entry.key}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
}
