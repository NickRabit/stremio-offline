import type express from "express";
import { AppError } from "../errors.js";
import type { IntroQuery, IntroSegmentsCache } from "../intro-segments.js";
import { asyncRoute, routeDisconnectSignal, type RouteContext } from "./context.js";

export interface IntroSegmentDeps extends RouteContext {
  introSegments: Pick<IntroSegmentsCache, "get">;
}

const invalidRequest = () =>
  new AppError("The request was not understood.", "err.invalidRequest", 400);

const numberParam = (value: unknown) => {
  if (typeof value !== "string" || !value.trim()) throw invalidRequest();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw invalidRequest();
  return number;
};

// Secure mode keeps the browser away from third parties. IntroDB is asked by the server with
// nothing but an IMDb id, like the catalogue lookups, so the switch does not touch it.
export function registerIntroSegmentRoutes(app: express.Application, deps: IntroSegmentDeps): void {
  app.get("/api/intro-segments", asyncRoute(async (req, res) => {
    const imdb = req.query.imdb;
    if (typeof imdb !== "string" || !/^tt\d{5,10}$/.test(imdb)) throw invalidRequest();
    const hasSeason = req.query.season !== undefined;
    const hasEpisode = req.query.episode !== undefined;
    if (hasSeason !== hasEpisode) throw invalidRequest();

    const query: IntroQuery = {
      imdbId: imdb,
      ...(hasSeason ? {
        season: numberParam(req.query.season),
        episode: numberParam(req.query.episode),
      } : {}),
    };

    const disconnect = routeDisconnectSignal(req, res);
    try {
      res.json(await deps.introSegments.get(query, disconnect.signal));
    } finally {
      disconnect.dispose();
    }
  }));
}
