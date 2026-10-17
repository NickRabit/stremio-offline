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
import { posixBase, visibleLibraries, type LibraryRecord } from "./libraries.js";
import type { MediaServerAuthority, MediaServerManager } from "./media-server-manager.js";
import { isMediaServerError, type PublicRemoteItem, type PublicRemoteLibrary } from "./media-server-types.js";
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
      for (const meta of metas) {
        if (meta.type !== "movie" && meta.type !== "series") continue;
        const id = String(meta.id);
        const name = typeof meta.name === "string" ? meta.name : "";
        // The same file comes back from a movie and a series catalogue of one addon; as a file
        // it is one item, kept apart from titles and never joined to anything else.
        const file = FILE_NAME.test(name.trim());
        const ids = file ? {} : strongIdsFromStremioId(id);
        const rewritten = deps.rewriteMeta(meta);
        const year = yearOf(meta);
        records.push({
          itemKey: file ? `file:${id}` : `${meta.type}:${id}`,
          kind: file ? "file" : meta.type,
          title: name,
          ...(year === undefined ? {} : { year }),
          ...(typeof meta.description === "string" ? { description: meta.description } : {}),
          ...(typeof rewritten.poster === "string" ? { poster: rewritten.poster } : {}),
          ...(typeof rewritten.background === "string" ? { background: rewritten.background } : {}),
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
      if (!live || !live.enabled || live.globalSearch === false || live.manifestUrl !== manifestUrl) return false;
      return searchableCatalogs([live], undefined, {
        catalogType: type,
        catalogId: definition.id,
        respectGlobalSearch: true,
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
      ...(hasIds(ids) ? { ids } : { opaque: `local:${libraryId}:${meta.type}:${id}` }),
      locator: { kind: "local", key: entry.key, libraryId, itemKind: singleFile ? "file" : "folder" },
    };
  }
  return {
    itemKey: entry.key,
    kind: singleFile ? "file" : "folder",
    title: entry.title,
    ...(poster === undefined ? {} : { poster }),
    locator: { kind: "local", key: entry.key, libraryId, itemKind: singleFile ? "file" : "folder" },
  };
};

const localSource = (
  deps: DiscoverDeps,
  context: SourceContext,
  libraryId: string,
  libraryName: string,
): Omit<SearchSource, "id"> => {
  let cached: { generation: number; entries: LibraryEntry[] } | undefined;
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
      const entries = result.entries.slice(offset, offset + LOCAL_PAGE_SIZE);
      const nextOffset = offset + entries.length;
      return {
        records: entries.map((entry) => localRecord(entry, libraryId, deps)),
        cursor: { generation: result.generation, offset: nextOffset },
        exhausted: nextOffset >= result.entries.length,
        stale: deps.localIndex.state().stale,
      };
    },
    stillAllowed(): boolean {
      const user = deps.user(context.userId);
      if (!user || user.disabled) return false;
      return visibleLibraries(deps.libraries(), viewerOf(user)).some((library) => library.id === libraryId);
    },
    onReady(listener): () => void {
      return deps.localIndex.onReady(listener);
    },
  };
};

const remoteRecord = (
  item: PublicRemoteItem,
  libraryId: string,
  provider: PublicRemoteLibrary["provider"],
): RawSearchRecord | undefined => {
  if (item.type !== "movie" && item.type !== "series" && item.type !== "episode") return undefined;
  return {
    itemKey: item.id,
    kind: item.type,
    title: item.name,
    ...(item.year === undefined ? {} : { year: item.year }),
    ...(item.overview === undefined ? {} : { description: item.overview }),
    ...(item.poster === undefined ? {} : { poster: item.poster }),
    ids: validStrongIds(item.providerIds),
    ...(item.type !== "episode" ? {} : {
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

const remoteSource = (
  deps: DiscoverDeps,
  context: SourceContext,
  library: PublicRemoteLibrary,
  generation: number,
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
        { search: context.query, kind: context.kind, cursor: cursor as string | undefined },
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
    return {
      records,
      ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
      exhausted: page.cursor === undefined,
    };
  },
  stillAllowed(): boolean {
    return deps.remote.canSearchLibrary(context.userId, library.id, generation);
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

  if (request.sources.includes("local")) {
    for (const library of visibleLibraries(deps.libraries(), viewer)) {
      sources.push(localSource(deps, context, library.id, library.name));
    }
  }

  if (request.sources.includes("remote")) {
    const libraries = await deps.remote.visibleLibraries(deps.mediaAuthority(authority.userId));
    for (const library of libraries) {
      const generation = deps.remote.libraryGeneration(library.id);
      if (generation === undefined) continue;
      sources.push(remoteSource(deps, context, library, generation));
    }
  }

  if (request.sources.includes("catalog")) {
    const order = orderFor(user, (id) => deps.addonOrder(id));
    const allowed = orderedForUser(allowedAddons(deps.addons(), viewer), order);
    for (const target of searchableCatalogs(allowed, catalogKind(request.kind), { respectGlobalSearch: true })) {
      sources.push(catalogSource(deps, context, target));
    }
  }

  return sources.map((source, index) => ({ ...source, id: `s${index}` }));
}
