import type express from "express";
import { AppError } from "../errors.js";
import { libraryFor, libraryPathOpen, parseLibraryPath, type Viewer } from "../libraries.js";
import type { BrowseItem } from "../library.js";
import type { LibraryMetaStore } from "../library-meta-store.js";
import type { MediaServerAuthority, MediaServerManager } from "../media-server-manager.js";
import { ShuffleSessions, shuffleUnits, type ShuffleOwner, type ShuffleUnit } from "../shuffle.js";
import { asyncRoute, routeDisconnectSignal, viewerOf, type RouteContext } from "./context.js";

export interface ShuffleDeps extends RouteContext {
  metaStore: LibraryMetaStore;
  localFiles(libraryId: string, relativePrefix: string): Promise<string[]>;
  describeLibraryPath(key: string, read?: { stale?: boolean }): Promise<BrowseItem | undefined>;
  libraryKey(value: string): string;
  wirePath(key: string): string;
  fileAvailable(key: string, viewer: Viewer): Promise<boolean>;
  isCarvedOut(key: string): boolean;
  mediaServers: MediaServerManager;
  authorityOf(req: express.Request): MediaServerAuthority;
}

const notFound = () => new AppError("The item was not found.", "err.itemNotFound", 404);

export function registerShuffleRoutes(app: express.Application, deps: ShuffleDeps): void {
  const { store, currentSession, currentUser, metaStore, localFiles, describeLibraryPath, libraryKey, wirePath, fileAvailable, isCarvedOut, mediaServers, authorityOf } = deps;
  const sessions = new ShuffleSessions();

  const ownerOf = (req: express.Request): ShuffleOwner => {
    const session = currentSession(req);
    if (!session) throw new AppError("The item was not found.", "err.itemNotFound", 404);
    return { userId: session.userId, sid: session.sid };
  };

  const chooser = (req: express.Request) => {
    const viewer = viewerOf(currentUser(req));
    const authority = authorityOf(req);
    return async (unit: ShuffleUnit) => {
      if (unit.remote) {
        if (!mediaServers.shuffleStillCurrent(authority, unit.remote.libraryId, unit.remote.generation)) return undefined;
        return {
          remote: { libraryId: unit.remote.libraryId, itemId: unit.remote.itemId },
          title: unit.title,
          ...(unit.season === undefined ? {} : { season: unit.season }),
          ...(unit.episode === undefined ? {} : { episode: unit.episode }),
        };
      }
      const libraries = store.libraries();
      for (const key of unit.files) {
        if (!libraryPathOpen(key, viewer, libraries)) continue;
        if (isCarvedOut(key)) continue;
        if (await fileAvailable(key, viewer)) return wirePath(key);
      }
      return undefined;
    };
  };

  app.post("/api/shuffle", asyncRoute(async (req, res) => {
    const viewer = viewerOf(currentUser(req));
    const owner = ownerOf(req);
    const remote = req.body?.remote;
    if (remote !== undefined) {
      if (req.body?.path !== undefined || typeof remote !== "object" || remote === null || Array.isArray(remote)) throw notFound();
      const libraryId = (remote as Record<string, unknown>).libraryId;
      const parentId = (remote as Record<string, unknown>).parentId;
      if (typeof libraryId !== "string" || (parentId !== undefined && typeof parentId !== "string")) throw notFound();
      const disconnect = routeDisconnectSignal(req, res);
      try {
        const pool = await mediaServers.shufflePool(authorityOf(req), libraryId, parentId, disconnect.signal).catch(() => undefined);
        if (!pool) throw notFound();
        const units: ShuffleUnit[] = pool.items.map((unit) => ({
          files: [],
          remote: { libraryId: unit.libraryId, itemId: unit.itemId, generation: unit.generation },
          title: unit.title,
          ...(unit.season === undefined ? {} : { season: unit.season }),
          ...(unit.episode === undefined ? {} : { episode: unit.episode }),
        }));
        const answer = await sessions.start(owner, units, chooser(req), { capped: pool.capped });
        if (!answer) throw notFound();
        return void res.setHeader("cache-control", "private, no-store").json(answer);
      } finally {
        disconnect.dispose();
      }
    }
    if (typeof req.body?.path !== "string") throw notFound();
    let key: string;
    try {
      key = libraryKey(req.body.path.trim());
    } catch {
      throw notFound();
    }
    if (!libraryPathOpen(key, viewer, store.libraries())) throw notFound();
    const item = await describeLibraryPath(key, { stale: true }).catch(() => undefined);
    const parsed = parseLibraryPath(key);
    if (item?.kind !== "folder" || !parsed) throw notFound();
    const library = libraryFor(store.libraries(), parsed.libraryId);
    if (!library) throw notFound();
    const units = shuffleUnits(
      parsed.libraryId,
      await localFiles(parsed.libraryId, parsed.relative),
      metaStore.qualifiedMeta(),
      metaStore.episodes(),
      library.type,
    );
    const answer = await sessions.start(owner, units, chooser(req));
    if (!answer) throw notFound();
    res.setHeader("cache-control", "private, no-store").json(answer);
  }));

  app.post("/api/shuffle/:id/next", asyncRoute(async (req, res) => {
    const answer = await sessions.next(ownerOf(req), String(req.params.id), chooser(req));
    if (!answer) throw notFound();
    res.setHeader("cache-control", "private, no-store").json(answer);
  }));

  app.post("/api/shuffle/:id/previous", asyncRoute(async (req, res) => {
    const answer = await sessions.previous(ownerOf(req), String(req.params.id), chooser(req));
    if (!answer) throw notFound();
    res.setHeader("cache-control", "private, no-store").json(answer);
  }));

  app.delete("/api/shuffle/:id", asyncRoute(async (req, res) => {
    if (!sessions.delete(ownerOf(req), String(req.params.id))) throw notFound();
    res.status(204).end();
  }));
}
