import type express from "express";
import {
  isOpaqueId,
  parseRevision,
  parseStartRequest,
  SearchError,
} from "../search-contracts.js";
import {
  parseCatalogSearchRequest,
  type CatalogSearchManager,
} from "../search-catalog-session.js";
import type { SearchAuthority, SearchSessionManager } from "../search-session.js";
import { asyncRoute } from "./context.js";

export const searchEverywhereEnabled = (): boolean =>
  process.env.SEARCH_EVERYWHERE_ENABLED === "1";

export interface SearchEverywhereRouteDeps {
  manager: SearchSessionManager;
  catalogManager: CatalogSearchManager;
  authorityOf(req: express.Request): SearchAuthority;
  liveSearchOf(req: express.Request): boolean;
}

const noStore = (res: express.Response): void => {
  res.setHeader("Cache-Control", "private, no-store");
};

const opaque = (value: unknown): string => {
  const id = typeof value === "string" ? value : "";
  if (!isOpaqueId(id)) throw new SearchError("search-not-found", 404);
  return id;
};

export function registerSearchEverywhereRoutes(
  app: express.Express,
  deps: SearchEverywhereRouteDeps,
): void {
  app.get("/api/search/preferences", asyncRoute(async (req, res) => {
    noStore(res);
    deps.authorityOf(req);
    res.json({ liveSearch: deps.liveSearchOf(req) });
  }));

  app.post("/api/search/everywhere", asyncRoute(async (req, res) => {
    noStore(res);
    const authority = deps.authorityOf(req);
    const request = parseStartRequest(req.body);
    res.json(await deps.manager.start(authority, request));
  }));

  app.post("/api/search/everywhere/:id/poll", asyncRoute(async (req, res) => {
    noStore(res);
    const id = opaque(req.params.id);
    const authority = deps.authorityOf(req);
    const revision = parseRevision(req.body);
    const controller = new AbortController();
    const abort = () => {
      if (!res.writableEnded) controller.abort();
    };
    const onRequestClose = () => {
      if (!req.complete) abort();
    };
    req.once("close", onRequestClose);
    res.once("close", abort);
    try {
      const answer = await deps.manager.poll(authority, id, revision, controller.signal);
      if (!res.destroyed) res.json(answer);
    } finally {
      req.off("close", onRequestClose);
      res.off("close", abort);
    }
  }));

  app.post("/api/search/everywhere/:id/page", asyncRoute(async (req, res) => {
    noStore(res);
    const id = opaque(req.params.id);
    res.status(202).json(await deps.manager.pageAll(deps.authorityOf(req), id));
  }));

  app.post("/api/search/everywhere/:id/sources/:sourceId/retry", asyncRoute(async (req, res) => {
    noStore(res);
    const id = opaque(req.params.id);
    const sourceId = opaque(req.params.sourceId);
    res.status(202).json(await deps.manager.retry(deps.authorityOf(req), id, sourceId));
  }));

  app.get("/api/search/everywhere/:id/members/:memberKey", asyncRoute(async (req, res) => {
    noStore(res);
    const id = opaque(req.params.id);
    const memberKey = opaque(req.params.memberKey);
    const raw = req.query.from;
    let from = 0;
    if (raw !== undefined) {
      if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
        throw new SearchError("search-invalid-request", 400);
      }
      from = Number(raw);
      if (!Number.isSafeInteger(from)) throw new SearchError("search-invalid-request", 400);
    }
    res.json(await deps.manager.members(deps.authorityOf(req), id, memberKey, from));
  }));

  app.delete("/api/search/everywhere/:id", asyncRoute(async (req, res) => {
    noStore(res);
    const id = opaque(req.params.id);
    await deps.manager.delete(deps.authorityOf(req), id);
    res.status(204).end();
  }));

  app.post("/api/search/catalog", asyncRoute(async (req, res) => {
    noStore(res);
    const authority = deps.authorityOf(req);
    const request = parseCatalogSearchRequest(req.body);
    res.json(await deps.catalogManager.start(authority, request));
  }));

  app.post("/api/search/catalog/:id/poll", asyncRoute(async (req, res) => {
    noStore(res);
    const id = opaque(req.params.id);
    const authority = deps.authorityOf(req);
    const revision = parseRevision(req.body);
    const controller = new AbortController();
    const abort = () => {
      if (!res.writableEnded) controller.abort();
    };
    const onRequestClose = () => {
      if (!req.complete) abort();
    };
    req.once("close", onRequestClose);
    res.once("close", abort);
    try {
      const answer = await deps.catalogManager.poll(authority, id, revision, controller.signal);
      if (!res.destroyed) res.json(answer);
    } finally {
      req.off("close", onRequestClose);
      res.off("close", abort);
    }
  }));

  app.post("/api/search/catalog/:id/page", asyncRoute(async (req, res) => {
    noStore(res);
    const id = opaque(req.params.id);
    res.status(202).json(deps.catalogManager.page(deps.authorityOf(req), id));
  }));

  app.delete("/api/search/catalog/:id", asyncRoute(async (req, res) => {
    noStore(res);
    const id = opaque(req.params.id);
    deps.catalogManager.delete(deps.authorityOf(req), id);
    res.status(204).end();
  }));
}
