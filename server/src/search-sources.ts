import {
  allowedAddons,
  fetchCatalogPage,
  orderFor,
  orderedForUser,
  searchableCatalogs,
  supportsSkip,
  type CatalogTarget,
} from "./addons.js";
import { isVideo, type LibraryEntry } from "./library.js";
import { libraryPath, parseLibraryPath, posixBase, posixDir, visibleLibraries, type LibraryRecord } from "./libraries.js";
import type { MediaServerAuthority, MediaServerManager } from "./media-server-manager.js";
import {
  isMediaServerError,
  publicRemoteItem,
  type PublicRemoteItem,
  type PublicRemoteLibrary,
} from "./media-server-types.js";
import { GuardRejection, OutboundError } from "./outbound.js";
import type { AddonRecord, MetaItem } from "./types.js";
import type { UserRecord } from "./users.js";
import { viewerOf } from "./routes/context.js";
import {
  SEARCH_LIMITS,
  type RawSearchRecord,
  type SearchKindFilter,
  type SearchStartRequest,
  type StrongIds,
} from "./search-contracts.js";
import { strongIdsFromStremioId, validStrongIds } from "./search-identity.js";
import type { LocalSearchIndex } from "./search-local-index.js";
import {
  SourceFailure,
  type SearchAuthority,
  type SearchSource,
  type SourcePage,
} from "./search-session.js";

export interface SourceContext {
  sessionId: string;
  query: string;
  kind: SearchKindFilter;
  userId: string;
}

export interface DiscoverDeps {
  user(userId: string): UserRecord | undefined;
  addons(): AddonRecord[];
  addonOrder(userId: string): string[] | undefined;
  libraries(): LibraryRecord[];
  localIndex: LocalSearchIndex;
  remote: {
    visibleLibraries(authority: MediaServerAuthority): Promise<PublicRemoteLibrary[]>;
    searchLibrary: MediaServerManager["searchLibrary"];
    canSearchLibrary: MediaServerManager["canSearchLibrary"];
    matchingItems: MediaServerManager["matchingItems"];
    libraryGeneration(libraryId: string): number | undefined;
  };
  mediaAuthority(userId: string): MediaServerAuthority;
  rewriteMeta(meta: MetaItem): MetaItem;
}

const LOCAL_PAGE_SIZE = SEARCH_LIMITS.recordsPerPage;

const firstFourDigits = (value: unknown): number | undefined => {
  if (typeof value !== "string") return undefined;
  const match = /(\d{4})/.exec(value);
  return match ? Number(match[1]) : undefined;
};

const yearOf = (meta: MetaItem): number | undefined => {
  if (typeof meta.year === "number" && Number.isInteger(meta.year)) return meta.year;
  if (typeof meta.year === "string") {
    const parsed = Number(meta.year.trim());
    if (Number.isInteger(parsed)) return parsed;
  }
  return firstFourDigits(meta.releaseInfo);
};

/** A catalogue that searches a file host answers with file names, not titles. */
const FILE_NAME = /\.(?:avi|mkv|mp4|m4v|mov|wmv|mpg|mpeg|ts|m2ts|webm|flv|iso)$/i;

const hostnameOf = (manifestUrl: string): string => {
  try {
    return new URL(manifestUrl).hostname;
  } catch {
    return "";
  }
};

const hasIds = (ids: StrongIds): boolean =>
  ids.imdb !== undefined || ids.tmdb !== undefined || ids.tvdb !== undefined;

const ratingOf = (meta: MetaItem): number | undefined => {
  const value = typeof meta.imdbRating === "number"
    ? meta.imdbRating
    : typeof meta.imdbRating === "string" && meta.imdbRating.trim() !== ""
      ? Number(meta.imdbRating)
      : Number.NaN;
  return Number.isFinite(value) && value >= 0 && value <= 10 ? value : undefined;
};

const catalogFailure = (error: unknown): SourceFailure => {
  if (error instanceof OutboundError) {
    switch (error.code) {
      case "timeout":
        return new SourceFailure("timeout");
      case "cancelled":
        return new SourceFailure("cancelled");
      case "invalid-json":
      case "too-large":
        return new SourceFailure("invalid-json");
      default:
        if (error.code.startsWith("http-")) return new SourceFailure(error.code as `http-${number}`);
        return new SourceFailure("network");
    }
  }
  if (error instanceof GuardRejection) return new SourceFailure("unavailable");
  return new SourceFailure("network");
};

const catalogSource = (
  deps: DiscoverDeps,
  context: SourceContext,
  target: CatalogTarget,
  explicitScope: boolean,
): Omit<SearchSource, "id"> => {
  const { addon, definition } = target;
  const type = definition.type;
  const continuation = supportsSkip(definition) ? "supported" : "unsupported";
  const manifestUrl = addon.manifestUrl;
  return {
    sourceClass: "catalog",
    label: `${addon.manifest.name} · ${definition.name ?? definition.id}`,
    poolKey: hostnameOf(manifestUrl),
    continuation,
    async next(cursor, signal): Promise<SourcePage> {
      const skip = typeof cursor === "number" ? cursor : 0;
      let metas: MetaItem[];
      try {
        metas = await fetchCatalogPage(target, context.query, skip, { signal, key: context.sessionId });
      } catch (error) {
        throw catalogFailure(error);
      }
      const records: RawSearchRecord[] = [];
      for (const [index, meta] of metas.entries()) {
        if (meta.type !== "movie" && meta.type !== "series") continue;
        const id = String(meta.id);
        const name = typeof meta.name === "string" ? meta.name : "";
        // The same file comes back from a movie and a series catalogue of one addon; as a file
        // it is one item, kept apart from titles and never joined to anything else.
        const file = FILE_NAME.test(name.trim());
        const ids = file ? {} : strongIdsFromStremioId(id);
        const rewritten = deps.rewriteMeta(meta);
        const year = yearOf(meta);
        const rating = ratingOf(meta);
        const originalTitle = typeof meta.originalTitle === "string" ? meta.originalTitle.trim() : "";
        records.push({
          itemKey: file ? `file:${id}` : `${meta.type}:${id}`,
          kind: file ? "file" : meta.type,
          title: name,
          ...(originalTitle === "" || originalTitle === name.trim() ? {} : { originalTitle }),
          ...(year === undefined ? {} : { year }),
          ...(typeof meta.description === "string" ? { description: meta.description } : {}),
          ...(typeof rewritten.poster === "string" ? { poster: rewritten.poster } : {}),
          ...(typeof rewritten.background === "string" ? { background: rewritten.background } : {}),
          ...(rating === undefined ? {} : { rating }),
          sourcePosition: skip + index,
          ...(hasIds(ids) ? { ids } : { opaque: `addon:${addon.key}:${file ? "file" : meta.type}:${id}` }),
          locator: {
            kind: "catalog",
            addonKey: addon.key,
            type: meta.type,
            id,
            catalogId: definition.id,
          },
        });
      }
      return {
        records,
        cursor: skip + metas.length,
        exhausted: metas.length === 0 || continuation === "unsupported",
      };
    },
    stillAllowed(): boolean {
      const user = deps.user(context.userId);
      if (!user || user.disabled) return false;
      const live = allowedAddons(deps.addons(), viewerOf(user)).find((candidate) => candidate.key === addon.key);
      if (!live || !live.enabled || (!explicitScope && live.globalSearch === false) || live.manifestUrl !== manifestUrl) return false;
      return searchableCatalogs([live], undefined, {
        catalogType: type,
        catalogId: definition.id,
        respectGlobalSearch: !explicitScope,
      }).length > 0;
    },
  };
};

interface LocalCursor {
  generation: number;
  offset: number;
}

const localCursor = (cursor: unknown): LocalCursor | undefined => {
  if (typeof cursor !== "object" || cursor === null) return undefined;
  const value = cursor as Record<string, unknown>;
  if (
    !Number.isSafeInteger(value.generation)
    || (value.generation as number) < 0
    || !Number.isSafeInteger(value.offset)
    || (value.offset as number) < 0
  ) {
    return undefined;
  }
  return { generation: value.generation as number, offset: value.offset as number };
};

const localRecord = (entry: LibraryEntry, libraryId: string, deps: DiscoverDeps): RawSearchRecord => {
  const meta = entry.meta;
  const identified = meta !== undefined && (meta.type === "movie" || meta.type === "series");
  const singleFile = entry.files.length === 1 && isVideo(posixBase(entry.files[0]!.path));
  const relative = parseLibraryPath(entry.key)?.relative;
  const parentTitle = singleFile && relative !== undefined ? posixBase(posixDir(relative)) || undefined : undefined;
  const searchText: RawSearchRecord["searchText"] = {
    ...(parentTitle === undefined ? {} : { parentTitle }),
    ...(relative === undefined || relative === "" ? {} : { path: relative }),
  };
  const posterSource = entry.poster ?? meta?.poster;
  const poster = posterSource === undefined
    ? undefined
    : deps.rewriteMeta({ poster: posterSource } as MetaItem).poster;
  if (identified) {
    const id = meta.id;
    const ids = strongIdsFromStremioId(id);
    const rawYear = Number(meta.year);
    return {
      itemKey: entry.key,
      kind: meta.type as "movie" | "series",
      title: meta.name ?? entry.title,
      ...(Number.isInteger(rawYear) ? { year: rawYear } : {}),
      ...(poster === undefined ? {} : { poster }),
      ...(Object.keys(searchText).length === 0 ? {} : { searchText }),
      ...(hasIds(ids) ? { ids } : { opaque: `local:${libraryId}:${meta.type}:${id}` }),
      locator: { kind: "local", key: entry.key, libraryId, itemKind: singleFile ? "file" : "folder" },
    };
  }
  return {
    itemKey: entry.key,
    kind: singleFile ? "file" : "folder",
    title: entry.title,
    ...(poster === undefined ? {} : { poster }),
    ...(Object.keys(searchText).length === 0 ? {} : { searchText }),
    ...(singleFile
      ? {}
      : { itemCount: entry.files.filter((file) => isVideo(posixBase(file.path))).length }),
    locator: { kind: "local", key: entry.key, libraryId, itemKind: singleFile ? "file" : "folder" },
  };
};

const localSource = (
  deps: DiscoverDeps,
  context: SourceContext,
  libraryId: string,
  libraryName: string,
  path = "",
  explicitScope = false,
): Omit<SearchSource, "id"> => {
  let cached: { generation: number; entries: LibraryEntry[] } | undefined;
  const root = libraryPath(libraryId, path);
  const subtree = `${root}/`;
  // An index entry is a whole title folder or a loose file. Searching from inside a title folder
  // (or one of its subfolders) still finds that title, so an entry that contains the folder on
  // screen counts as well as one beneath it.
  const withinScope = (entry: LibraryEntry): boolean =>
    entry.key === root || entry.key.startsWith(subtree) || root.startsWith(`${entry.key}/`);
  return {
    sourceClass: "local",
    label: libraryName,
    poolKey: "local",
    continuation: "supported",
    async next(cursor, signal): Promise<SourcePage> {
      const state = deps.localIndex.state();
      if (!state.ready) return { records: [], exhausted: false, indexing: true };
      let result = cached;
      if (result === undefined || result.generation !== state.generation) {
        result = await deps.localIndex.search(libraryId, context.query, context.kind, signal);
        cached = result;
      }
      const previous = localCursor(cursor);
      const offset = previous !== undefined && previous.generation === result.generation ? previous.offset : 0;
      const scoped = result.entries.filter(withinScope);
      const entries = scoped.slice(offset, offset + LOCAL_PAGE_SIZE);
      const nextOffset = offset + entries.length;
      return {
        records: entries.map((entry) => localRecord(entry, libraryId, deps)),
        cursor: { generation: result.generation, offset: nextOffset },
        exhausted: nextOffset >= scoped.length,
        stale: deps.localIndex.state().stale,
      };
    },
    stillAllowed(): boolean {
      const user = deps.user(context.userId);
      if (!user || user.disabled) return false;
      return visibleLibraries(deps.libraries(), viewerOf(user)).some((library) =>
        library.id === libraryId && (explicitScope || library.showInSearch !== false));
    },
    onReady(listener): () => void {
      return deps.localIndex.onReady(listener);
    },
    async expand(ids, kind): Promise<RawSearchRecord[]> {
      if (kind !== "movie" && kind !== "series") return [];
      return deps.localIndex.byIds(libraryId, ids, kind)
        .filter(withinScope)
        .map((entry) => localRecord(entry, libraryId, deps));
    },
  };
};

const remoteRecord = (
  item: PublicRemoteItem,
  libraryId: string,
  provider: PublicRemoteLibrary["provider"],
): RawSearchRecord | undefined => {
  if (item.type !== "movie" && item.type !== "series" && item.type !== "episode" && item.type !== "folder") return undefined;
  return {
    itemKey: item.id,
    kind: item.type,
    title: item.name,
    ...(item.year === undefined ? {} : { year: item.year }),
    ...(item.overview === undefined ? {} : { description: item.overview }),
    ...(item.poster === undefined ? {} : { poster: item.poster }),
    ids: validStrongIds(item.providerIds),
    ...(item.type === "folder" && item.childCount !== undefined ? { itemCount: item.childCount } : {}),
    ...(item.type !== "episode" ? {} : {
      ...(item.seriesName === undefined ? {} : { searchText: { parentTitle: item.seriesName } }),
      ...(item.seriesId === undefined ? {} : { parentRef: item.seriesId }),
      ...(item.season === undefined ? {} : { season: item.season }),
      ...(item.episode === undefined ? {} : { episode: item.episode }),
      ...(item.episodeEnd === undefined ? {} : { episodeEnd: item.episodeEnd }),
    }),
    locator: {
      kind: "remote",
      libraryId,
      itemId: item.id,
      itemType: item.type,
      ...(provider === undefined ? {} : { provider }),
    },
  };
};

const catalogIdFor = (ids: StrongIds): string | undefined => {
  if (ids.imdb !== undefined) return ids.imdb;
  if (ids.tmdb !== undefined) return `tmdb:${ids.tmdb}`;
  if (ids.tvdb !== undefined) return `tvdb:${ids.tvdb}`;
  return undefined;
};

const remoteSource = (
  deps: DiscoverDeps,
  context: SourceContext,
  library: PublicRemoteLibrary,
  generation: number,
  parentId?: string,
  explicitScope = false,
): Omit<SearchSource, "id"> => ({
  sourceClass: "remote",
  label: library.name,
  poolKey: library.connectionId,
  continuation: "supported",
  async next(cursor, signal): Promise<SourcePage> {
    let page: { items: PublicRemoteItem[]; cursor?: string };
    try {
      page = await deps.remote.searchLibrary(
        deps.mediaAuthority(context.userId),
        library.id,
        {
          search: context.query,
          kind: context.kind,
          ...(parentId === undefined ? {} : { parentId }),
          cursor: cursor as string | undefined,
        },
        signal,
      );
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new SourceFailure("cancelled");
      }
      if (isMediaServerError(error) && error.code === "cancelled") throw new SourceFailure("cancelled");
      if (isMediaServerError(error)) {
        let allowed = false;
        try { allowed = deps.remote.canSearchLibrary(context.userId, library.id, generation); } catch { allowed = false; }
        throw new SourceFailure(allowed ? "network" : "unavailable");
      }
      throw new SourceFailure("network");
    }
    const records = page.items.flatMap((item) => {
      const record = remoteRecord(item, library.id, library.provider);
      return record === undefined ? [] : [record];
    });
    // A server matches episodes by their series name without returning the series itself (it
    // may spell the name with diacritics the query lacks). The episodes name it, so the series is
    // added from them and they gather under it instead of standing alone.
    // The series go first: a page accepts a bounded number of rows, and an episode only joins a
    // series that is already there.
    const present = new Set(records.map((record) => record.itemKey));
    const derivedSeries: RawSearchRecord[] = [];
    for (const item of page.items) {
      if (item.type !== "episode" || item.seriesId === undefined || item.seriesName === undefined || present.has(item.seriesId)) continue;
      present.add(item.seriesId);
      derivedSeries.push({
        itemKey: item.seriesId,
        kind: "series",
        title: item.seriesName,
        ids: {},
        derived: true,
        locator: { kind: "remote", libraryId: library.id, itemId: item.seriesId, itemType: "series", ...(library.provider === undefined ? {} : { provider: library.provider }) },
      });
    }
    return {
      records: [...derivedSeries, ...records],
      ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
      exhausted: page.cursor === undefined,
    };
  },
  stillAllowed(): boolean {
    return deps.remote.canSearchLibrary(context.userId, library.id, generation, explicitScope);
  },
  async expand(ids, kind, signal): Promise<RawSearchRecord[]> {
    const catalogId = catalogIdFor(ids);
    if (catalogId === undefined) return [];
    try {
      const items = await deps.remote.matchingItems(
        deps.mediaAuthority(context.userId),
        library.id,
        kind,
        catalogId,
        signal,
      );
      return items.flatMap((item) => {
        const record = remoteRecord(publicRemoteItem(item, library.id), library.id, library.provider);
        return record === undefined ? [] : [record];
      });
    } catch {
      return [];
    }
  },
});

const catalogKind = (kind: SearchKindFilter): "movie" | "series" | undefined =>
  kind === "all" ? undefined : kind;

export async function discoverSources(
  deps: DiscoverDeps,
  authority: SearchAuthority,
  request: SearchStartRequest,
  sessionId: string,
): Promise<SearchSource[]> {
  const user = deps.user(authority.userId);
  if (!user || user.disabled) return [];
  const viewer = viewerOf(user);
  const context: SourceContext = {
    sessionId,
    query: request.query,
    kind: request.kind,
    userId: authority.userId,
  };
  const sources: Array<Omit<SearchSource, "id">> = [];

  if (request.library !== undefined) {
    const library = request.library;
    if (request.sources[0] === "local") {
      const found = visibleLibraries(deps.libraries(), viewer).find((candidate) => candidate.id === library.libraryId);
      if (found) {
        sources.push(localSource(deps, context, found.id, found.name, library.path ?? "", true));
      }
    } else if (request.sources[0] === "remote") {
      const libraries = await deps.remote.visibleLibraries(deps.mediaAuthority(authority.userId));
      const found = libraries.find((candidate) => candidate.id === library.libraryId);
      if (found) {
        const generation = deps.remote.libraryGeneration(found.id);
        if (generation !== undefined) {
          sources.push(remoteSource(deps, context, found, generation, library.parentId, true));
        }
      }
    }
    return sources.map((source, index) => ({ ...source, id: `s${index}` }));
  }

  if (request.sources.includes("local")) {
    // A library switched out of search is left out of every search scope, like an addon kept out
    // of all-addon search; browsing it is unaffected.
    for (const library of visibleLibraries(deps.libraries(), viewer).filter((candidate) => candidate.showInSearch !== false)) {
      sources.push(localSource(deps, context, library.id, library.name));
    }
  }

  if (request.sources.includes("remote")) {
    const libraries = await deps.remote.visibleLibraries(deps.mediaAuthority(authority.userId));
    for (const library of libraries.filter((candidate) => candidate.showInSearch !== false)) {
      const generation = deps.remote.libraryGeneration(library.id);
      if (generation === undefined) continue;
      sources.push(remoteSource(deps, context, library, generation));
    }
  }

  if (request.sources.includes("catalog")) {
    const order = orderFor(user, (id) => deps.addonOrder(id));
    const allowed = orderedForUser(allowedAddons(deps.addons(), viewer), order);
    const scope = request.scope === undefined
      ? { respectGlobalSearch: true }
      : {
        addonKey: request.scope.addonKey,
        ...(request.scope.catalogType === undefined ? {} : { catalogType: request.scope.catalogType }),
        ...(request.scope.catalogId === undefined ? {} : { catalogId: request.scope.catalogId }),
        respectGlobalSearch: false,
      };
    for (const target of searchableCatalogs(allowed, catalogKind(request.kind), scope)) {
      sources.push(catalogSource(deps, context, target, request.scope !== undefined));
    }
  }

  return sources.map((source, index) => ({ ...source, id: `s${index}` }));
}
