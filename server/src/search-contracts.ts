import { AppError } from "./errors.js";

export const SEARCH_LIMITS = {
  catalogJobsPerSession: 8,
  localJobsPerSession: 1,
  remoteJobsPerSession: 8,
  remoteJobsPerPool: 2,
  jobsServerWide: 32,
  targetsPerSession: 60,
  recordsPerSession: 1200,
  recordsPerPage: 20,
  recordBytesPerSession: 4 * 1024 * 1024,
  sessionsPerBrowserSession: 2,
  sessionsServerWide: 50,
  idleExpiryMs: 300_000,
  firstSnapshotMs: 300,
  pollWaitMs: 500,
  sourceHardLimitMs: 60_000,
  noProgressPagesToStall: 3,
  retryMinIntervalMs: 1000,
  tombstoneTtlMs: 600_000,
  tombstoneMax: 256,
  aliasesMax: 256,
  membersPerPage: 100,
  memberPageBytes: 512 * 1024,
  sweepIntervalMs: 30_000,
  queryMaxCodePoints: 200,
  queryMaxUtf16: 256,
  titleMaxCodePoints: 300,
  labelMaxCodePoints: 120,
  descriptionMaxCodePoints: 1000,
  idMaxLength: 2048,
} as const;

export type SearchSourceClass = "catalog" | "local" | "remote";
export type SearchKind = "movie" | "series" | "episode" | "season" | "folder" | "file";
export type SearchKindFilter = "all" | "movie" | "series";
export type SearchSourceState =
  | "queued"
  | "loading"
  | "ready"
  | "exhausted"
  | "stalled"
  | "failed"
  | "timedOut"
  | "indexing"
  | "unavailable";
export type StrongIds = { imdb?: string; tmdb?: string; tvdb?: string };

export interface SearchStartRequest {
  query: string;
  kind: SearchKindFilter;
  sources: SearchSourceClass[];
  slotId: string;
  generation: number;
  scope?: {
    addonKey: string;
    catalogType?: string;
    catalogId?: string;
  };
  library?: {
    libraryId: string;
    path?: string;
    parentId?: string;
  };
}

export type SearchLocator =
  | { kind: "catalog"; addonKey: string; type: string; id: string; catalogId?: string }
  | { kind: "local"; key: string; libraryId: string; itemKind: "file" | "folder" }
  | { kind: "remote"; libraryId: string; itemId: string; itemType: string; provider?: "jellyfin" | "emby" };

export interface RawSearchRecord {
  itemKey: string;
  kind: SearchKind;
  title: string;
  originalTitle?: string;
  year?: number;
  description?: string;
  poster?: string;
  background?: string;
  ids?: StrongIds;
  opaque?: string;
  parentRef?: string;
  parentIds?: StrongIds;
  season?: number;
  episode?: number;
  episodeEnd?: number;
  searchText?: {
    parentTitle?: string;
    path?: string;
  };
  rating?: number;
  sourcePosition?: number;
  itemCount?: number;
  /** Built from another row (a series named by its episodes); never replaces a real row. */
  derived?: boolean;
  locator: SearchLocator;
}

export interface SearchSourceView {
  id: string;
  sourceClass: SearchSourceClass;
  label: string;
  state: SearchSourceState;
  loaded: number;
  hasMore: boolean;
  continuation: "supported" | "unsupported" | "blocked";
  stale?: boolean;
  retryable: boolean;
  errorCode?: string;
  dropped?: number;
}

export interface SearchClusterView {
  key: string;
  kind: SearchKind;
  title: string;
  originalTitle?: string;
  year?: number;
  poster?: string;
  background?: string;
  sourceLabels: string[];
  hasLocal: boolean;
  hasRemote: boolean;
  memberCount: number;
  primaryMemberKey: string;
  memberKeys: string[];
  rank: number;
  score: number;
  rating?: number;
  episodeCount?: number;
  itemCount?: number;
}

export interface SearchSnapshot {
  revision: number;
  state: "partial" | "complete" | "failed";
  sources: SearchSourceView[];
  clusters: SearchClusterView[];
  unidentified: SearchClusterView[];
  aliases: { retired: string; current: string }[];
  limitReached: boolean;
}

export interface SearchMember {
  memberKey: string;
  sourceId: string;
  sourceClass: SearchSourceClass;
  sourceLabel: string;
  kind: SearchKind;
  title: string;
  year?: number;
  poster?: string;
  description?: string;
  parentIds?: StrongIds;
  season?: number;
  episode?: number;
  episodeEnd?: number;
  conflict?: boolean;
  locator: SearchLocator;
}

export interface SearchMemberPage {
  clusterKey: string;
  members: SearchMember[];
  nextFrom?: number;
  truncated: boolean;
  canonical?: { type: "movie" | "series"; id: string; name: string; poster?: string };
}

export type SearchErrorCode =
  | "search-invalid-request"
  | "search-not-found"
  | "search-restart-required"
  | "search-session-limit"
  | "search-capacity-limit"
  | "search-retry-limited"
  | "search-too-broad"
  | "search-generation-conflict"
  | "search-not-retryable";

const ERROR_META: Record<SearchErrorCode, { message: string; messageKey: string; status: number }> = {
  "search-invalid-request": {
    message: "The search request is not valid.",
    messageKey: "err.searchInvalidRequest",
    status: 400,
  },
  "search-not-found": {
    message: "The search was not found.",
    messageKey: "err.searchNotFound",
    status: 404,
  },
  "search-restart-required": {
    message: "The search must be started again.",
    messageKey: "err.searchRestartRequired",
    status: 410,
  },
  "search-session-limit": {
    message: "Too many searches are open in this browser session.",
    messageKey: "err.searchSessionLimit",
    status: 429,
  },
  "search-capacity-limit": {
    message: "The server has no capacity for another search.",
    messageKey: "err.searchCapacityLimit",
    status: 503,
  },
  "search-retry-limited": {
    message: "This source was retried too recently.",
    messageKey: "err.searchRetryLimited",
    status: 429,
  },
  "search-too-broad": {
    message: "The search has too many sources.",
    messageKey: "err.searchTooBroad",
    status: 422,
  },
  "search-generation-conflict": {
    message: "The search generation is already in use.",
    messageKey: "err.searchGenerationConflict",
    status: 409,
  },
  "search-not-retryable": {
    message: "This search source cannot be retried.",
    messageKey: "err.searchNotRetryable",
    status: 409,
  },
};

export class SearchError extends AppError {
  readonly code: SearchErrorCode;
  readonly details?: Record<string, number>;

  constructor(code: SearchErrorCode, status: number, details?: Record<string, number>) {
    const meta = ERROR_META[code];
    super(meta.message, meta.messageKey, status);
    this.name = "SearchError";
    this.code = code;
    this.details = details === undefined ? undefined : { ...details };
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};

const invalidRequest = (): never => {
  throw new SearchError("search-invalid-request", 400);
};

export function parseStartRequest(body: unknown): SearchStartRequest {
  if (
    !isPlainObject(body)
    || !hasExactKeys(
      body,
      [
        "query", "kind", "sources", "slotId", "generation",
        ...(body.scope === undefined ? [] : ["scope"]),
        ...(body.library === undefined ? [] : ["library"]),
      ],
    )
  ) {
    return invalidRequest();
  }
  if (typeof body.query !== "string") return invalidRequest();
  const query = body.query.trim();
  if (
    Array.from(query).length < 1
    || Array.from(query).length > SEARCH_LIMITS.queryMaxCodePoints
    || query.length > SEARCH_LIMITS.queryMaxUtf16
  ) {
    return invalidRequest();
  }
  if (body.kind !== "all" && body.kind !== "movie" && body.kind !== "series") return invalidRequest();
  if (
    !Array.isArray(body.sources)
    || body.sources.length < 1
    || body.sources.length > 3
  ) {
    return invalidRequest();
  }
  const sources = body.sources;
  for (let index = 0; index < sources.length; index += 1) {
    if (
      !Object.hasOwn(sources, index)
      || (sources[index] !== "catalog" && sources[index] !== "local" && sources[index] !== "remote")
    ) {
      return invalidRequest();
    }
  }
  if (new Set(sources).size !== sources.length) return invalidRequest();
  if (typeof body.slotId !== "string" || !/^[A-Za-z0-9_-]{8,64}$(?![\s\S])/.test(body.slotId)) return invalidRequest();
  if (!Number.isSafeInteger(body.generation) || (body.generation as number) < 0) return invalidRequest();
  const result: SearchStartRequest = {
    query,
    kind: body.kind,
    sources: sources as SearchSourceClass[],
    slotId: body.slotId,
    generation: body.generation as number,
  };
  if (body.scope !== undefined) {
    if (!isPlainObject(body.scope)) return invalidRequest();
    const hasCatalog = body.scope.catalogType !== undefined || body.scope.catalogId !== undefined;
    if (
      !hasExactKeys(
        body.scope,
        hasCatalog
          ? ["addonKey", "catalogType", "catalogId"]
          : ["addonKey"],
      )
    ) {
      return invalidRequest();
    }
    const addonKey = typeof body.scope.addonKey === "string" ? body.scope.addonKey.trim() : "";
    if (!/^[A-Za-z0-9_.:-]{1,100}$(?![\s\S])/.test(addonKey)) return invalidRequest();
    if (hasCatalog) {
      if (typeof body.scope.catalogType !== "string" || typeof body.scope.catalogId !== "string") {
        return invalidRequest();
      }
      const catalogType = body.scope.catalogType.trim();
      const catalogId = body.scope.catalogId.trim();
      if (
        catalogType === ""
        || catalogId === ""
        || Array.from(catalogType).length > 200
        || Array.from(catalogId).length > 200
      ) {
        return invalidRequest();
      }
      result.scope = { addonKey, catalogType, catalogId };
    } else {
      result.scope = { addonKey };
    }
  }
  if (body.library !== undefined) {
    if (!isPlainObject(body.library)) return invalidRequest();
    if (
      !hasExactKeys(body.library, ["libraryId", "path"])
      && !hasExactKeys(body.library, ["libraryId", "parentId"])
      && !hasExactKeys(body.library, ["libraryId"])
    ) {
      return invalidRequest();
    }
    const libraryId = typeof body.library.libraryId === "string" ? body.library.libraryId.trim() : "";
    if (!/^[A-Za-z0-9_.:-]{1,200}$(?![\s\S])/.test(libraryId)) return invalidRequest();
    const local = body.sources.length === 1 && body.sources[0] === "local";
    const remote = body.sources.length === 1 && body.sources[0] === "remote";
    if ((!local && !remote) || body.scope !== undefined) return invalidRequest();
    if (body.library.path !== undefined) {
      if (!local || typeof body.library.path !== "string") return invalidRequest();
      const path = body.library.path.trim();
      if (
        path.startsWith("/")
        || path.includes("\0")
        || Array.from(path).length > 1000
        || path.split("/").some((segment) => segment === "..")
      ) {
        return invalidRequest();
      }
      result.library = { libraryId, path };
    } else if (body.library.parentId !== undefined) {
      if (!remote || typeof body.library.parentId !== "string") return invalidRequest();
      const parentId = body.library.parentId.trim();
      if (!/^[A-Za-z0-9_.:-]{1,200}$(?![\s\S])/.test(parentId)) return invalidRequest();
      result.library = { libraryId, parentId };
    } else {
      result.library = { libraryId };
    }
  }
  return result;
}

export function parseRevision(body: unknown): number {
  if (!isPlainObject(body) || !hasExactKeys(body, ["revision"])) return invalidRequest();
  if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 0) return invalidRequest();
  return body.revision as number;
}

export const isOpaqueId = (value: string): boolean => /^[A-Za-z0-9_-]{1,64}$(?![\s\S])/.test(value);

const cut = (value: string, maximum: number): string => {
  const trimmed = value.trim();
  const points = Array.from(trimmed);
  return points.length <= maximum ? trimmed : points.slice(0, maximum).join("");
};

const optionalCut = (value: unknown, maximum: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const result = cut(value, maximum);
  return result === "" ? undefined : result;
};

const bounded = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result.length > SEARCH_LIMITS.idMaxLength ? undefined : result;
};

const projectIds = (value: unknown): StrongIds | undefined => {
  if (!isPlainObject(value)) return undefined;
  const result: StrongIds = {};
  for (const key of ["imdb", "tmdb", "tvdb"] as const) {
    if (typeof value[key] === "string") result[key] = value[key].trim();
  }
  return Object.keys(result).length === 0 ? undefined : result;
};

const projectLocator = (locator: SearchLocator): SearchLocator | undefined => {
  if (!isPlainObject(locator)) return undefined;
  if (locator.kind === "catalog") {
    const addonKey = bounded(locator.addonKey);
    const type = bounded(locator.type);
    const id = bounded(locator.id);
    if (addonKey === undefined || type === undefined || id === undefined) return undefined;
    const result: SearchLocator = { kind: "catalog", addonKey, type, id };
    if (locator.catalogId !== undefined) {
      const catalogId = bounded(locator.catalogId);
      if (catalogId === undefined) return undefined;
      result.catalogId = catalogId;
    }
    return result;
  }
  if (locator.kind === "local") {
    const key = bounded(locator.key);
    const libraryId = bounded(locator.libraryId);
    if (key === undefined || libraryId === undefined) return undefined;
    if (locator.itemKind !== "file" && locator.itemKind !== "folder") return undefined;
    return { kind: "local", key, libraryId, itemKind: locator.itemKind };
  }
  if (locator.kind === "remote") {
    const libraryId = bounded(locator.libraryId);
    const itemId = bounded(locator.itemId);
    const itemType = bounded(locator.itemType);
    if (libraryId === undefined || itemId === undefined || itemType === undefined) return undefined;
    if (
      locator.provider !== undefined
      && locator.provider !== "jellyfin"
      && locator.provider !== "emby"
    ) {
      return undefined;
    }
    return {
      kind: "remote",
      libraryId,
      itemId,
      itemType,
      ...(locator.provider === undefined ? {} : { provider: locator.provider }),
    };
  }
  return undefined;
};

const nonNegativeInteger = (value: unknown): number | undefined =>
  Number.isInteger(value) && (value as number) >= 0 ? value as number : undefined;

const projectSearchText = (value: unknown): RawSearchRecord["searchText"] | undefined => {
  if (!isPlainObject(value)) return undefined;
  const parentTitle = optionalCut(value.parentTitle, SEARCH_LIMITS.titleMaxCodePoints);
  const path = optionalCut(value.path, 2048);
  if (parentTitle === undefined && path === undefined) return undefined;
  return {
    ...(parentTitle === undefined ? {} : { parentTitle }),
    ...(path === undefined ? {} : { path }),
  };
};

export function projectRecord(raw: RawSearchRecord): RawSearchRecord | undefined {
  if (!isPlainObject(raw)) return undefined;
  const itemKey = bounded(raw.itemKey);
  const title = typeof raw.title === "string" ? cut(raw.title, SEARCH_LIMITS.titleMaxCodePoints) : "";
  if (itemKey === undefined || title === "") return undefined;
  if (
    typeof raw.kind !== "string"
    || !["movie", "series", "episode", "season", "folder", "file"].includes(raw.kind)
  ) {
    return undefined;
  }
  const locator = projectLocator(raw.locator);
  if (locator === undefined) return undefined;

  const result: RawSearchRecord = {
    itemKey,
    kind: raw.kind,
    title,
    locator,
  };
  const originalTitle = optionalCut(raw.originalTitle, SEARCH_LIMITS.titleMaxCodePoints);
  if (originalTitle !== undefined) result.originalTitle = originalTitle;
  if (Number.isInteger(raw.year) && (raw.year as number) >= 1800 && (raw.year as number) <= 2200) {
    result.year = raw.year;
  }
  const description = optionalCut(raw.description, SEARCH_LIMITS.descriptionMaxCodePoints);
  if (description !== undefined) result.description = description;

  for (const key of ["poster", "background", "opaque", "parentRef"] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    const projected = bounded(value);
    if (projected === undefined) return undefined;
    if (projected !== "") result[key] = projected;
  }
  const ids = projectIds(raw.ids);
  if (ids !== undefined) result.ids = ids;
  const parentIds = projectIds(raw.parentIds);
  if (parentIds !== undefined) result.parentIds = parentIds;
  const searchText = projectSearchText(raw.searchText);
  if (searchText !== undefined) result.searchText = searchText;
  if (typeof raw.rating === "number" && Number.isFinite(raw.rating) && raw.rating >= 0 && raw.rating <= 10) {
    result.rating = raw.rating;
  }
  if (raw.derived === true) result.derived = true;
  if (Number.isSafeInteger(raw.sourcePosition) && (raw.sourcePosition as number) >= 0) {
    result.sourcePosition = raw.sourcePosition as number;
  }
  if (Number.isSafeInteger(raw.itemCount) && (raw.itemCount as number) >= 0) {
    result.itemCount = raw.itemCount as number;
  }

  const season = nonNegativeInteger(raw.season);
  const episode = nonNegativeInteger(raw.episode);
  const episodeEnd = nonNegativeInteger(raw.episodeEnd);
  if (season !== undefined) result.season = season;
  if (episode !== undefined) result.episode = episode;
  if (episode !== undefined && episodeEnd !== undefined && episodeEnd > episode) result.episodeEnd = episodeEnd;
  return result;
}
