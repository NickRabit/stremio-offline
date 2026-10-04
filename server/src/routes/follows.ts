import type express from "express";
import { AppError } from "../errors.js";
import type { Follow, FollowEpisode, FollowService, FollowStore } from "../follows.js";
import type { UserPrefs, WatchedMarker } from "../store.js";
import type { UserData } from "../users.js";
import { asyncRoute, viewerOf, type RouteContext } from "./context.js";

export interface FollowDeps extends RouteContext {
  follows: FollowService;
  followStore: FollowStore;
  prefsOf(req?: express.Request): UserPrefs;
  markersOf(data: UserData): Record<string, WatchedMarker>;
  dataOf(req: express.Request): UserData;
  posterOf(value: unknown): string | undefined;
}

interface FollowEpisodeView { season: number; episode: number; title?: string; released?: string }
interface FollowView {
  id: string;
  ownerUserId: string;
  type: string;
  metaId: string;
  name: string;
  poster?: string;
  createdAt: string;
  updatedAt: string;
  enabled: boolean;
  revision: number;
  lastCheckedAt?: string;
  lastSuccessfulCheckAt?: string;
  nextCheckAt: string;
  failures: number;
  lastErrorKey?: string;
  episodeCount: number;
  nextEpisode?: FollowEpisodeView;
  latestEpisode?: FollowEpisodeView;
}

const episodeView = (episode: FollowEpisode): FollowEpisodeView => ({
  season: episode.season, episode: episode.episode,
  ...(episode.title ? { title: episode.title } : {}),
  ...(episode.released ? { released: episode.released } : {}),
});

/** The follow as the interface reads it: the episode map is replaced by a count and
 *  the nearest episode on either side of now. */
const followView = (follow: Follow, now: number): FollowView => {
  const episodes = Object.values(follow.episodes);
  let next: FollowEpisode | undefined;
  let latest: FollowEpisode | undefined;
  for (const episode of episodes) {
    if (!episode.released) continue;
    const released = Date.parse(episode.released);
    if (released > now) {
      if (!next || released < Date.parse(next.released!)) next = episode;
    } else if (!latest || released > Date.parse(latest.released!)) {
      latest = episode;
    }
  }
  const { episodes: _episodes, ...rest } = follow;
  return {
    ...rest,
    episodeCount: episodes.length,
    ...(next ? { nextEpisode: episodeView(next) } : {}),
    ...(latest ? { latestEpisode: episodeView(latest) } : {}),
  };
};

export function registerFollowRoutes(app: express.Application, deps: FollowDeps): void {
  const { followStore, follows, currentUser, dataOf, markersOf, posterOf } = deps;

  /** The follow the caller owns, or nothing. A follow owned by somebody else answers
   *  exactly like one that does not exist, so the route never confirms it is there. */
  const owned = (req: express.Request, id: string): Follow => {
    const owner = viewerOf(currentUser(req));
    const follow = followStore.get(id);
    if (!follow || follow.ownerUserId !== owner.id) throw new AppError("The item was not found.", "err.itemNotFound", 404);
    return follow;
  };

  app.get("/api/follows", (req, res) => {
    const owner = viewerOf(currentUser(req));
    const now = Date.now();
    res.json({ follows: followStore.listForOwner(owner.id).map((follow) => followView(follow, now)) });
  });

  app.post("/api/follows", asyncRoute(async (req, res) => {
    const owner = viewerOf(currentUser(req));
    const type = String(req.body?.type ?? "").trim();
    const metaId = String(req.body?.id ?? "").trim();
    const name = String(req.body?.name ?? "").trim();
    if (!type || !metaId || !name) throw new AppError("The followed series is missing a type, an id or a name.", "err.followInvalid");
    const follow = await followStore.create({ ownerUserId: owner.id, type, metaId, name, poster: posterOf(req.body?.poster) }, Date.now());
    res.status(201).json(followView(follow, Date.now()));
  }));

  app.patch("/api/follows/:id", asyncRoute(async (req, res) => {
    const follow = owned(req, String(req.params.id));
    const updated = await followStore.update(follow.id, (current) => {
      if (typeof req.body?.enabled === "boolean") current.enabled = req.body.enabled;
      current.revision += 1;
    });
    res.json(followView(updated, Date.now()));
  }));

  app.delete("/api/follows/:id", asyncRoute(async (req, res) => {
    const follow = owned(req, String(req.params.id));
    await followStore.remove(follow.id);
    res.status(204).end();
  }));

  app.post("/api/follows/:id/check", asyncRoute(async (req, res) => {
    const owner = viewerOf(currentUser(req));
    const follow = owned(req, String(req.params.id));
    const checked = await follows.checkNow(follow.id, owner.id);
    res.json(followView(checked ?? follow, Date.now()));
  }));

  app.get("/api/follows/new-episodes", (req, res) => {
    const owner = viewerOf(currentUser(req));
    const markers = markersOf(dataOf(req));
    res.json({ items: follows.newEpisodes(owner.id, (metaId) => {
      const marker = markers[metaId];
      return marker ? { season: marker.season, episode: marker.episode } : undefined;
    }) });
  });

  app.get("/api/follows/by-meta/:type/:id", (req, res) => {
    const owner = viewerOf(currentUser(req));
    const follow = followStore.findByMeta(owner.id, String(req.params.type), String(req.params.id));
    if (!follow) throw new AppError("The item was not found.", "err.itemNotFound", 404);
    res.json(followView(follow, Date.now()));
  });
}
