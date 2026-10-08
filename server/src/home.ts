/** The Home page's domain shapes and the pure builders behind them. Nothing here touches
 *  a request, the store or an addon: the route gathers already-permission-filtered inputs
 *  and this module merges, orders and bounds them. */

export const HOME_ROW_LIMIT = 20;
export const HOME_CANDIDATES = 30;
export const HOME_MARKER_LIMIT = 20;
export const HOME_LOOKUP_DEADLINE_MS = 1500;
export const HOME_FORGET_LIMIT = 50;

export type HomeRowId = "resume" | "completed" | "favorites" | "recent" | "episodes" | "tonight" | "confirm";

export interface HomeProgress { position: number; duration: number }

export type HomeCard =
  | { kind: "resume-file"; key: string; title: string; subtitle?: string; poster?: string; wide?: string;
      path: string; progress: HomeProgress; season?: number; episode?: number;
      updatedAt: string; forgetKeys: string[] }
  | { kind: "resume-catalogue"; key: string; title: string; poster?: string; wide?: string;
      type: string; id: string; name: string; season?: number; episode?: number;
      progress?: HomeProgress; pending?: true; addonKey?: string;
      updatedAt: string; forgetKeys: string[] }
  | { kind: "completed"; key: string; title: string; poster?: string; wide?: string;
      path: string; completedAt: string; season?: number; episode?: number }
  | { kind: "favorite"; key: string; path: string; itemKind: "file" | "folder"; label: string;
      poster?: string; wide?: string }
  | { kind: "recent"; key: string; path: string; label: string; poster?: string; wide?: string;
      addedAt: string; libraryId: string; season?: number; episode?: number }
  | { kind: "episode"; key: string; followId: string; type: string; metaId: string; name: string;
      poster?: string; season: number; episode: number; title?: string; released: string }
  | { kind: "tonight"; key: string; path: string; itemKind: "file" | "folder"; label: string;
      year?: string; poster?: string; wide?: string; libraryId: string }
  | { kind: "confirm"; key: string; libraryId: string; library: string; label: string;
      path: string; candidate: { name: string; year?: string; poster?: string } };

export interface HomeRowError { error: string; code?: string; messageKey?: string }

/** The rows and cards the client draws today; `episode`, `tonight` and `confirm` follow. */
export type MediaRowId = "resume" | "completed" | "favorites";
export type MediaHomeCard = Extract<HomeCard, { kind: "resume-file" | "resume-catalogue" | "completed" | "favorite" }>;

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

export interface HomeResponse { generatedAt: string; rows: Partial<Record<HomeRowId, HomeRow>> }

/** One library file with a stored position, already filtered by permission and shaped by
 *  the caller of the builder. `seriesId` is the catalogue title the folder is bound to. */
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
  seriesId?: string;
  seriesType?: string;
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
  seriesId?: string;
  seriesType?: string;
}

/** One input per source, already permission-filtered by the caller of the builder. */
export interface ResumeSources {
  catalogue: ResumeCatalogueItem[];
  files: ResumeFileItem[];
}

export function boundCards<T>(items: T[], limit: number = HOME_ROW_LIMIT): { items: T[]; hasMore: boolean } {
  return { items: items.slice(0, limit), hasMore: items.length > limit };
}

type ResumeCandidate =
  | { source: "file"; identity?: string; item: ResumeFileItem }
  | { source: "catalogue"; identity?: string; item: ResumeCatalogueItem };

const isPending = (candidate: ResumeCandidate) => candidate.source === "catalogue" && candidate.item.pending === true;

/** Newest marker first; a tie goes to the library file because it is playable right now. */
const compareCandidates = (left: ResumeCandidate, right: ResumeCandidate) =>
  right.item.updatedAt.localeCompare(left.item.updatedAt)
  || (left.source === right.source ? 0 : left.source === "file" ? -1 : 1)
  || left.item.key.localeCompare(right.item.key);

function cardFor(candidates: ResumeCandidate[]): Extract<HomeCard, { kind: "resume-file" | "resume-catalogue" }> {
  const forgetKeys = [...new Set(candidates.map((candidate) => candidate.item.key))].sort();
  const playable = candidates.filter((candidate) => !isPending(candidate));
  const winner = [...(playable.length ? playable : candidates)].sort(compareCandidates)[0]!;
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
    ...(item.pending ? { pending: true as const } : item.progress ? { progress: item.progress } : {}),
    ...(item.addonKey ? { addonKey: item.addonKey } : {}),
    updatedAt: item.updatedAt, forgetKeys,
  };
}

/** Merge the two Continue watching sources into one card per verified show. Only equal,
 *  non-empty series ids merge; an unknown identity stays its own card. */
export function mergeResume(sources: ResumeSources, limit: number = HOME_ROW_LIMIT): { items: HomeCard[]; hasMore: boolean } {
  const candidates: ResumeCandidate[] = [
    ...sources.files.map((item): ResumeCandidate => ({ source: "file", identity: item.seriesId || undefined, item })),
    ...sources.catalogue.map((item): ResumeCandidate => ({ source: "catalogue", identity: item.seriesId || undefined, item })),
  ];
  const groups = new Map<string, ResumeCandidate[]>();
  const singles: ResumeCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.identity) { singles.push(candidate); continue; }
    const bucket = groups.get(candidate.identity);
    if (bucket) bucket.push(candidate); else groups.set(candidate.identity, [candidate]);
  }
  const cards = [...groups.values(), ...singles.map((candidate) => [candidate])].map(cardFor);
  cards.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key));
  return boundCards(cards, limit);
}
