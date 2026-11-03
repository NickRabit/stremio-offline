import type express from "express";
import { AppError } from "../errors.js";
import { libraryFor, libraryPathOpen, parseLibraryPath, type Viewer } from "../libraries.js";
import type { BrowseItem } from "../library.js";
import type { LibraryMetaStore } from "../library-meta-store.js";
import type { LibrarySeenStore } from "../library-seen.js";
import { ShuffleSessions, shuffleUnits, type ShuffleOwner, type ShuffleUnit } from "../shuffle.js";
import { asyncRoute, viewerOf, type RouteContext } from "./context.js";

export interface ShuffleDeps extends RouteContext {
  seen: LibrarySeenStore;
  metaStore: LibraryMetaStore;
  describeLibraryPath(key: string, read?: { stale?: boolean }): Promise<BrowseItem | undefined>;
  libraryKey(value: string): string;
  wirePath(key: string): string;
  fileAvailable(key: string, viewer: Viewer): Promise<boolean>;
}

const notFound = () => new AppError("The item was not found.", "err.itemNotFound", 404);

export function registerShuffleRoutes(app: express.Application, deps: ShuffleDeps): void {
  const { store, currentSession, currentUser, seen, metaStore, describeLibraryPath, libraryKey, wirePath, fileAvailable } = deps;
  const sessions = new ShuffleSessions();

  const ownerOf = (req: express.Request): ShuffleOwner => {
    const session = currentSession(req);
    if (!session) throw new AppError("The item was not found.", "err.itemNotFound", 404);
    return { userId: session.userId, sid: session.sid };
  };

  const chooser = (req: express.Request) => {
    const viewer = viewerOf(currentUser(req));
    return async (unit: ShuffleUnit): Promise<string | undefined> => {
      const libraries = store.libraries();
      for (const key of unit.files) {
        if (!libraryPathOpen(key, viewer, libraries)) continue;
        if (await fileAvailable(key, viewer)) return wirePath(key);
      }
      return undefined;
    };
  };

  app.post("/api/shuffle", asyncRoute(async (req, res) => {
    const viewer = viewerOf(currentUser(req));
    const owner = ownerOf(req);
    let key: string;
    try {
      key = libraryKey(String(req.body.path ?? "").trim());
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
      seen.filesUnder(parsed.libraryId, parsed.relative),
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
