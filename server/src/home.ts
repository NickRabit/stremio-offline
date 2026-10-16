/** The Home page's domain shapes and the pure builders behind them. Nothing here touches
 *  a request, the store or an addon: the route gathers already-permission-filtered inputs
 *  and this module merges, orders and bounds them. */

export const HOME_ROW_LIMIT = 20;
export const HOME_CANDIDATES = 30;
export const HOME_MARKER_LIMIT = 20;
export const HOME_LOOKUP_DEADLINE_MS = 1500;
export const HOME_FORGET_LIMIT = 50;
/** How many part-watched library files the merged Continue watching list reads before it
 *  pages them. The public `/api/library/resume` keeps its own, smaller ceiling. */
export const HOME_RESUME_FILE_LIMIT = 2000;
/** How many row ids and extra feeds one personal layout may name. A body over either is refused. */
export const HOME_LAYOUT_ROW_LIMIT = 200;
export const HOME_LAYOUT_FEED_LIMIT = 50;

export type BuiltinHomeRowId = "resume" | "completed" | "favorites" | "recent" | "episodes" | "tonight" | "confirm";
export type HomeRowId = BuiltinHomeRowId | `catalog:${string}:${string}:${string}`;

/** Every shelf the page draws, in the page's order. `confirm` is a count in the heading, not a shelf. */
export const HOME_ROWS = ["resume", "favorites", "tonight", "episodes", "completed", "recent", "confirm"] as const satisfies readonly BuiltinHomeRowId[];

export interface HomeOrderEntry { id: HomeRowId; title?: string }

/** The rows one account's Home shows, in display order: addon carousels sit before `episodes`,
 *  `confirm` only for an administrator. */
export function homeRowOrder(admin: boolean, catalogRows: readonly HomeOrderEntry[]): HomeOrderEntry[] {
  const fixed: readonly BuiltinHomeRowId[] = admin ? HOME_ROWS : HOME_ROWS.filter((row) => row !== "confirm");
  const at = fixed.indexOf("episodes");
  return [
    ...fixed.slice(0, at).map((id) => ({ id })),
    ...catalogRows.map((entry) => ({ ...entry })),
    ...fixed.slice(at).map((id) => ({ id })),
  ];
}

export const HOME_BUILTIN_ROWS: readonly BuiltinHomeRowId[] = ["resume", "completed", "favorites", "recent", "episodes", "tonight", "confirm"];
export const homeCatalogSelectionKey = (type: string, id: string) => `${encodeURIComponent(type)}:${encodeURIComponent(id)}`;
export const homeCatalogRowId = (addonKey: string, type: string, id: string): HomeRowId =>
  `catalog:${encodeURIComponent(addonKey)}:${encodeURIComponent(type)}:${encodeURIComponent(id)}`;

/** The catalogue feed key a personal `homeLayout.feeds` entry stores: the addon and the
 *  catalogue it names, each part encoded the way `homeCatalogSelectionKey` encodes its own. */
export const homeFeedSelectionKey = (addonKey: string, type: string, id: string) =>
  `${encodeURIComponent(addonKey)}:${encodeURIComponent(type)}:${encodeURIComponent(id)}`;

/** The i18n key a built-in row's arrangement label shows. */
export const HOME_BUILTIN_LABELS: Record<BuiltinHomeRowId, string> = {
  resume: "home.continue",
  favorites: "home.favorites",
  tonight: "home.tonight",
  episodes: "home.newEpisodes",
  completed: "home.readyToPlay",
  recent: "home.recent",
  confirm: "home.toConfirm",
};

/** One account's arrangement of its Home: the row order it placed, the rows it hid and the
 *  extra feeds it added for itself. */
export interface HomeLayout { order: string[]; hidden: string[]; feeds: string[] }

const stringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value as string[] : undefined;

/** Reads a stored or submitted `homeLayout`. A shape that is not the three string arrays is
 *  refused (`undefined`); a well-formed shape that names rows this request does not offer is
 *  kept here and dropped where the offer set is known. */
export function parseHomeLayout(value: unknown): HomeLayout | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const order = stringArray(record.order);
  const hidden = stringArray(record.hidden);
  const feeds = stringArray(record.feeds);
  if (!order || !hidden || !feeds) return undefined;
  return { order, hidden, feeds };
}

/** The account's arrangement over the rows a request offers: the ids it placed come first in
 *  its own order, and every row it never placed is inserted at its default position, next to
 *  the default neighbours it still has. Hidden rows stay in the order, so showing them again
 *  puts them back where they were; the caller drops them from what it draws. */
export function arrangeHomeRows(defaultOrder: readonly HomeRowId[], layout: HomeLayout | undefined): { order: HomeRowId[]; hidden: Set<HomeRowId> } {
  if (!layout) return { order: [...defaultOrder], hidden: new Set() };
  const offered = new Set(defaultOrder);
  const hidden = new Set(layout.hidden.filter((id): id is HomeRowId => offered.has(id as HomeRowId)) as HomeRowId[]);
  const placed: HomeRowId[] = [];
  for (const id of layout.order) {
    if (!offered.has(id as HomeRowId) || placed.includes(id as HomeRowId)) continue;
    placed.push(id as HomeRowId);
  }
  for (const id of defaultOrder) {
    if (placed.includes(id)) continue;
    const index = defaultOrder.indexOf(id);
    let at = -1;
    for (let i = index - 1; i >= 0; i -= 1) {
      const anchor = placed.indexOf(defaultOrder[i]!);
      if (anchor >= 0) { at = anchor + 1; break; }
    }
    if (at < 0) {
      for (let i = index + 1; i < defaultOrder.length; i += 1) {
        const anchor = placed.indexOf(defaultOrder[i]!);
        if (anchor >= 0) { at = anchor; break; }
      }
    }
    if (at < 0) placed.push(id); else placed.splice(at, 0, id);
  }
  return { order: placed, hidden };
}

/** The addon catalogue a Home row reads, or nothing for a built-in row. */
export function parseHomeCatalogRowId(row: string): { addonKey: string; type: string; id: string } | undefined {
  const parts = row.split(":");
  if (parts.length !== 4 || parts[0] !== "catalog") return undefined;
  try {
    const [addonKey, type, id] = parts.slice(1).map(decodeURIComponent) as [string, string, string];
    return { addonKey, type, id };
  } catch {
    return undefined;
  }
}

export interface HomeProgress { position: number; duration: number }

export interface RemoteHomeCard {
  kind: "remote";
  key: string;
  title: string;
  provider: "jellyfin" | "emby";
  libraryId: string;
  libraryName: string;
  itemId: string;
  itemType: "movie" | "series" | "episode";
  mediaSourceId?: string;
  season?: number;
  episode?: number;
  poster?: string;
  wide?: string;
  progress?: HomeProgress;
  /** The catalogue title the item stands for, when the provider named one: the card merges with
   *  the same title's library and catalogue rows in the one Continue watching list. */
  identity?: ResumeIdentity;
  /** The local keys this card stands for, when it won a merged group: forgetting the card has to
   *  forget the library files and catalogue rows behind it too. */
  forgetKeys?: string[];
  updatedAt: string;
}

export type HomeCard =
  | RemoteHomeCard
  | { kind: "resume-file"; key: string; title: string; subtitle?: string; poster?: string; wide?: string;
      path: string; progress: HomeProgress; season?: number; episode?: number;
      updatedAt: string; forgetKeys: string[];
      /** The catalogue title the file is bound to, when it is: its detail is one click away.
       *  Named `identity` because the card's `title` is the label it draws. */
      identity?: ResumeIdentity }
  | { kind: "resume-catalogue"; key: string; title: string; poster?: string; wide?: string;
      type: string; id: string; name: string; season?: number; episode?: number;
      progress?: HomeProgress; pending?: true; addonKey?: string;
      /** The wire path of the library file that wrote the row, when it is a video: the card plays
       *  that file the way a library card plays its own. */
      path?: string;
      updatedAt: string; forgetKeys: string[] }
  | { kind: "completed"; key: string; title: string; poster?: string; wide?: string;
      path: string; completedAt: string; season?: number; episode?: number }
  | { kind: "favorite"; key: string; path: string; itemKind: "file" | "folder"; label: string;
      poster?: string; wide?: string; title?: { type: "movie" | "series"; id: string } }
  | { kind: "favorite-catalogue"; key: string; type: string; id: string; name: string;
      poster?: string; wide?: string; year?: string }
  | { kind: "recent"; key: string; path: string; label: string; poster?: string; wide?: string;
      addedAt: string; libraryId: string; season?: number; episode?: number }
  | { kind: "episode"; key: string; followId: string; type: string; metaId: string; name: string;
      poster?: string; wide?: string; season: number; episode: number; title?: string; released: string }
  | { kind: "discovery"; key: string; type: string; id: string; name: string; title: string;
      poster?: string; wide?: string; year?: string }
  | { kind: "tonight"; key: string; path: string; itemKind: "file" | "folder"; label: string;
      year?: string; poster?: string; wide?: string; libraryId: string;
      /** The catalogue title the library record names, when it names one: OK opens that title's
       *  detail instead of the folder the card stands for. */
      title?: { type: "movie" | "series"; id: string } }
  | { kind: "confirm"; key: string; libraryId: string; library: string; label: string;
      path: string; candidate: { name: string; year?: string; poster?: string }; wide?: string };

export interface HomeRowError { error: string; code?: string; messageKey?: string }

export interface HomeRow {
  status: "ok" | "error";
  error?: HomeRowError;
  items: HomeCard[];
  hasMore: boolean;
  /** Only `confirm` computes this: its list is built in memory, so the count is exact. */
  total?: number;
  /** True when an addon lookup timed out and a card may be missing. */
  partial?: boolean;
}

export interface HomeResponse { generatedAt: string; order: HomeOrderEntry[]; rows: Partial<Record<HomeRowId, HomeRow>> }

/** One row the settings screen can arrange. `shown` is whether it is on Home right now;
 *  `added` is whether it is part of the arrangement at all, so an unconfigured catalogue the
 *  account could add is told apart from a feed it hid. */
export interface HomeLayoutEntry {
  id: HomeRowId;
  kind: "builtin" | "feed";
  label: string;
  shown: boolean;
  position: number;
  added: boolean;
}

export interface HomeLayoutResponse { rows: HomeLayoutEntry[]; layout: HomeLayout }

/** The catalogue title a Continue watching candidate belongs to. The type is part of the
 *  identity, so a film and a series that share an id never merge. */
export interface ResumeIdentity { type: "movie" | "series"; id: string }

/** One library file with a stored position, already filtered by permission and shaped by
 *  the caller of the builder. `identity` is the catalogue title the file or folder is
 *  bound to. */
export interface ResumeFileItem {
  key: string;
  updatedAt: string;
  title: string;
  subtitle?: string;
  poster?: string;
  wide?: string;
  path: string;
  progress: HomeProgress;
  season?: number;
  episode?: number;
  identity?: ResumeIdentity;
}

/** One catalogue progress row, stored or the pending next episode a finished one left. */
export interface ResumeCatalogueItem {
  key: string;
  updatedAt: string;
  title: string;
  poster?: string;
  wide?: string;
  type: string;
  id: string;
  name: string;
  season?: number;
  episode?: number;
  progress?: HomeProgress;
  pending?: true;
  addonKey?: string;
  identity?: ResumeIdentity;
  /** The wire path of the library file that wrote the row, when that file is a video the caller
   *  may see: the card plays it the way a library file plays. */
  path?: string;
}

/** One input per source, already permission-filtered by the caller of the builder. */
export interface ResumeSources {
  catalogue: ResumeCatalogueItem[];
  files: ResumeFileItem[];
  remote?: RemoteHomeCard[];
}

export function boundCards<T>(items: T[], limit: number = HOME_ROW_LIMIT): { items: T[]; hasMore: boolean } {
  return { items: items.slice(0, limit), hasMore: items.length > limit };
}

type ResumeCandidate =
  | { source: "file"; identity?: string; item: ResumeFileItem }
  | { source: "catalogue"; identity?: string; item: ResumeCatalogueItem }
  | { source: "remote"; identity?: string; item: RemoteHomeCard };

const isPending = (candidate: ResumeCandidate) => candidate.source === "catalogue" && candidate.item.pending === true;

/** Which card speaks for a group when the times tie: the library file first, because it is
 *  playable right now, then the catalogue row, then the media server's own version. */
const sourceRank = (candidate: ResumeCandidate) =>
  candidate.source === "file" ? 0 : candidate.source === "catalogue" ? 1 : 2;

/** Newest marker first, and the rank above when they tie. */
const compareCandidates = (left: ResumeCandidate, right: ResumeCandidate) =>
  right.item.updatedAt.localeCompare(left.item.updatedAt)
  || sourceRank(left) - sourceRank(right)
  || left.item.key.localeCompare(right.item.key);

function cardFor(candidates: ResumeCandidate[]): ResumeCard {
  // What the card itself stands for: the library files and catalogue rows of the group. A remote
  // version is forgotten through its own state, so it never joins these keys.
  const forgetKeys = [...new Set(candidates.filter((candidate) => candidate.source !== "remote").map((candidate) => candidate.item.key))].sort();
  const playable = candidates.filter((candidate) => !isPending(candidate));
  const winner = [...(playable.length ? playable : candidates)].sort(compareCandidates)[0]!;
  if (winner.source === "remote") {
    return { ...winner.item, ...(forgetKeys.length ? { forgetKeys } : {}) };
  }
  if (winner.source === "file") {
    const item = winner.item;
    return {
      kind: "resume-file", key: item.key, title: item.title,
      ...(item.subtitle ? { subtitle: item.subtitle } : {}),
      ...(item.poster ? { poster: item.poster } : {}),
      ...(item.wide ? { wide: item.wide } : {}),
      path: item.path, progress: item.progress,
      ...(item.season !== undefined ? { season: item.season } : {}),
      ...(item.episode !== undefined ? { episode: item.episode } : {}),
      ...(item.identity ? { identity: item.identity } : {}),
      updatedAt: item.updatedAt, forgetKeys,
    };
  }
  const item = winner.item;
  return {
    kind: "resume-catalogue", key: item.key, title: item.title,
    ...(item.poster ? { poster: item.poster } : {}),
    ...(item.wide ? { wide: item.wide } : {}),
    type: item.type, id: item.id, name: item.name,
    ...(item.season !== undefined ? { season: item.season } : {}),
    ...(item.episode !== undefined ? { episode: item.episode } : {}),
    ...(item.path ? { path: item.path } : {}),
    ...(item.pending ? { pending: true as const } : item.progress ? { progress: item.progress } : {}),
    ...(item.addonKey ? { addonKey: item.addonKey } : {}),
    updatedAt: item.updatedAt, forgetKeys,
  };
}

/** Merge the two Continue watching sources into one card per title. Only equal identities
 *  merge; an unknown identity stays its own card. */
function resumeGroups(sources: ResumeSources): ResumeGroup[] {
  const candidates: ResumeCandidate[] = [
    ...sources.files.map((item): ResumeCandidate => ({ source: "file", identity: item.identity ? `${item.identity.type}:${item.identity.id}` : undefined, item })),
    ...sources.catalogue.map((item): ResumeCandidate => ({ source: "catalogue", identity: item.identity ? `${item.identity.type}:${item.identity.id}` : undefined, item })),
    // A media-server card joins the title it stands for; one nothing can name stays its own card.
    ...(sources.remote ?? []).map((card): ResumeCandidate => ({ source: "remote", identity: card.identity ? `${card.identity.type}:${card.identity.id}` : undefined, item: card })),
  ];
  const groups = new Map<string, ResumeCandidate[]>();
  const singles: ResumeCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.identity) { singles.push(candidate); continue; }
    const bucket = groups.get(candidate.identity);
    if (bucket) bucket.push(candidate); else groups.set(candidate.identity, [candidate]);
  }
  return [...groups.values(), ...singles.map((candidate) => [candidate])]
    .map((bucket) => ({
      card: cardFor(bucket),
      file: bucket.some((candidate) => candidate.source === "file"),
      catalogue: bucket.some((candidate) => candidate.source === "catalogue"),
      remote: bucket.some((candidate) => candidate.source === "remote"),
    }))
    .sort((a, b) => b.card.updatedAt.localeCompare(a.card.updatedAt) || a.card.key.localeCompare(b.card.key));
}

/** Merge the two Continue watching sources into one card per title, cut to the row. */
export function mergeResume(sources: ResumeSources, limit: number = HOME_ROW_LIMIT): { items: HomeCard[]; hasMore: boolean } {
  return boundCards(resumeGroups(sources).map((group) => group.card), limit);
}

export type ResumeFilter = "all" | "movies" | "series" | "library" | "catalog" | "remote";

/** The filter a Continue watching request asks for: anything but a known one means all. The two
 *  title filters are what the interface offers; the card kinds are kept for older clients. */
export const parseResumeFilter = (value: unknown): ResumeFilter =>
  value === "movies" || value === "series" || value === "library" || value === "catalog" || value === "remote" ? value : "all";

/** One merged card and the sources it stands for. A folded title that kept a local copy
 *  counts under both filters, whichever kind won the card. */
interface ResumeGroup { card: ResumeCard; file: boolean; catalogue: boolean; remote: boolean }

export type ResumeCard = Extract<HomeCard, { kind: "resume-file" | "resume-catalogue" | "remote" }>;

/** One page of the same merged list Home draws, filtered by card kind. `total` counts every
 *  card the filter keeps, so paging past the Home bound stays stable. */
export function resumePage(sources: ResumeSources, options: { filter?: ResumeFilter; skip?: number; limit?: number } = {}):
  { items: ResumeCard[]; total: number; hasMore: boolean } {
  const filter = options.filter ?? "all";
  const kept = resumeGroups(sources).filter((group) => {
    if (filter === "all") return true;
    if (filter === "library") return group.file;
    if (filter === "catalog") return group.catalogue;
    if (filter === "remote") return group.remote;
    return cardWantedByTitle(group.card, filter === "movies" ? "movie" : "series");
  });
  const cards = kept.map((group) => group.card);
  const skip = Math.max(0, options.skip ?? 0);
  const limit = Math.max(1, options.limit ?? HOME_ROW_LIMIT);
  return { items: cards.slice(skip, skip + limit), total: cards.length, hasMore: skip + limit < cards.length };
}

/** Whether one card is a film or a show: a bound file answers with the title it plays as, an
 *  unbound file only by the numbering it carries, a catalogue row by its own type, and a
 *  media-server card by the kind of item it stands for. */
function cardWantedByTitle(card: ResumeCard, wanted: "movie" | "series"): boolean {
  if (card.kind === "resume-file") {
    if (card.identity) return card.identity.type === wanted;
    return wanted === "movie" ? card.season === undefined : card.season !== undefined;
  }
  if (card.kind === "resume-catalogue") return card.type === wanted;
  return wanted === "series" ? card.itemType === "series" || card.itemType === "episode" : card.itemType === "movie";
}
