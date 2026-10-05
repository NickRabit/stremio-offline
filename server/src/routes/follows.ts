import type express from "express";
import { randomBytes } from "node:crypto";
import { allowedAddons } from "../addons.js";
import type { DownloadSelection } from "../downloads.js";
import { AppError } from "../errors.js";
import { images } from "../images.js";
import { activityItems, calendarFeed, calendarItems, CALENDAR_MAX_SPAN_MS, downloadEligibility, parseFollowDefaults, undatedCalendarItems, type Follow, type FollowAutoDownload, type FollowEpisode, type FollowService, type FollowStore } from "../follows.js";
import { defaultLibrary, libraryVisible, type DefaultLibrarySettings, type LibraryRecord, type Viewer } from "../libraries.js";
import type { UserPrefs, WatchedMarker } from "../store.js";
import type { DownloadTargetSettings, MetaItem } from "../types.js";
import { feedTokenMatches, type FollowDefaults, type UserData, type UserRecord } from "../users.js";
import { asyncRoute, viewerOf, type RouteContext } from "./context.js";
import { createSelectionParser } from "./downloads.js";

export interface FollowDeps extends RouteContext {
  follows: FollowService;
  followStore: FollowStore;
  prefsOf(req?: express.Request): UserPrefs;
  markersOf(data: UserData): Record<string, WatchedMarker>;
  dataOf(req: express.Request): UserData;
  updateData(req: express.Request | undefined, mutate: (data: UserData) => void): Promise<void>;
  posterOf(value: unknown): string | undefined;
  cachedMeta(type: string, id: string, language?: string, viewer?: Viewer): Promise<MetaItem | null>;
}

interface FollowEpisodeView { season: number; episode: number; title?: string; released?: string; releasedSource?: "addon" | "tmdb"; dateUncertain?: boolean }
interface FollowDownloads { queued: number; waiting: number; completed: number; skipped: number; attention: number }
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
  autoDownload?: FollowAutoDownload;
  downloads: FollowDownloads;
  movie?: { released?: string; releaseKind?: FollowEpisode["releaseKind"]; theatricalAt?: string; dateUncertain?: boolean; state?: string; reasonKey?: string; nextAttemptAt?: string; graceUntil?: string };
}

const episodeView = (episode: FollowEpisode): FollowEpisodeView => ({
  season: episode.season, episode: episode.episode,
  ...(episode.title ? { title: episode.title } : {}),
  ...(episode.released ? { released: episode.released } : {}),
  ...(episode.releasedSource ? { releasedSource: episode.releasedSource } : {}),
  ...(episode.dateUncertain ? { dateUncertain: true } : {}),
});

/** `reserved` is an episode being queued, so it counts as queued for the summary. */
const downloadsSummary = (follow: Follow): FollowDownloads => {
  const counts: FollowDownloads = { queued: 0, waiting: 0, completed: 0, skipped: 0, attention: 0 };
  for (const episode of Object.values(follow.episodes)) {
    switch (episode.download?.state) {
      case "reserved":
      case "queued": counts.queued += 1; break;
      case "waiting": counts.waiting += 1; break;
      case "completed": counts.completed += 1; break;
      case "skipped": counts.skipped += 1; break;
      case "attention": counts.attention += 1; break;
    }
  }
  return counts;
};

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
      if (!next || released < Date.parse(next.released!)
        || (released === Date.parse(next.released!) && (episode.season < next.season || (episode.season === next.season && episode.episode < next.episode)))) next = episode;
    } else if (!latest || released > Date.parse(latest.released!)
      // A season dropped in one day answers with its last episode, not its first.
      || (released === Date.parse(latest.released!) && (episode.season > latest.season || (episode.season === latest.season && episode.episode > latest.episode)))) {
      latest = episode;
    }
  }
  const { episodes: _episodes, poster, ...rest } = follow;
  return {
    ...rest,
    // Stored as the provider's address; the page only ever loads our own proxy.
    ...(poster ? { poster: images.proxied(poster) } : {}),
    episodeCount: episodes.length,
    downloads: downloadsSummary(follow),
    ...(next ? { nextEpisode: episodeView(next) } : {}),
    ...(latest ? { latestEpisode: episodeView(latest) } : {}),
    // A film is one record; the dialog and the card read its release and download from here.
    ...(follow.type === "movie" && follow.episodes["1:1"] ? { movie: movieView(follow.episodes["1:1"]) } : {}),
  };
};

const movieView = (episode: FollowEpisode) => ({
  ...(episode.released ? { released: episode.released } : {}),
  ...(episode.releaseKind ? { releaseKind: episode.releaseKind } : {}),
  ...(episode.theatricalAt ? { theatricalAt: episode.theatricalAt } : {}),
  ...(episode.dateUncertain ? { dateUncertain: true } : {}),
  ...(episode.download ? { state: episode.download.state, ...(episode.download.reasonKey ? { reasonKey: episode.download.reasonKey } : {}), ...(episode.download.nextAttemptAt ? { nextAttemptAt: episode.download.nextAttemptAt } : {}), ...(episode.download.graceUntil ? { graceUntil: episode.download.graceUntil } : {}) } : {}),
});

/** The pinned destination a follow stores. An explicit choice is already concrete; a rule
 *  that names no library is resolved to the queue's own default series library, and a rule
 *  naming one that is gone falls back the same way. No library taking series is refused. */
const pinnedTarget = (selection: DownloadSelection, libraries: LibraryRecord[], settings: DefaultLibrarySettings, kind: "movie" | "series"): DownloadTargetSettings => {
  const rule = selection.targetSettings;
  if (rule.explicit) return rule;
  const named = rule.libraryId ? libraries.find((library) => library.id === rule.libraryId) : undefined;
  const library = named ?? defaultLibrary(libraries, settings, kind === "movie" ? "movie" : "episode");
  if (!library) throw kind === "movie"
    ? new AppError("No library takes films.", "err.noLibraryForMovies")
    : new AppError("No library takes series.", "err.noLibraryForSeries");
  return { libraryId: library.id, subfolder: rule.subfolder, layout: rule.layout, explicit: true };
};

export interface CalendarFeedDeps {
  users(): UserRecord[];
  userData(id: string): UserData;
  followsOf(id: string): Follow[];
  languageOf(id: string): string;
}

/** The public feed, reached with a token instead of a session. index.ts registers it outside
 *  `/api`, ahead of the SPA fallback, so it carries no session middleware. An unknown token,
 *  a gone account and a disabled one all answer the same bare 404, and the token is never
 *  written to the log. */
export function calendarFeedHandler(deps: CalendarFeedDeps): express.RequestHandler {
  return (req, res) => {
    const token = String(req.params.token ?? "");
    let owner: UserRecord | undefined;
    if (token) {
      for (const user of deps.users()) {
        if (!owner && feedTokenMatches(deps.userData(user.id).calendarFeedToken, token)) owner = user;
      }
    }
    if (!owner || owner.disabled) { res.status(404).end(); return; }
    const body = calendarFeed(deps.followsOf(owner.id), Date.now(), {
      name: `${owner.username} – Stremio Offline`,
      language: deps.languageOf(owner.id),
    });
    res.setHeader("content-type", "text/calendar; charset=utf-8");
    res.setHeader("cache-control", "private, max-age=900");
    res.send(body);
  };
}

export function registerFollowRoutes(app: express.Application, deps: FollowDeps): void {
  const { store, followStore, follows, currentUser, dataOf, updateData, markersOf, posterOf, cachedMeta, prefsOf } = deps;
  const parseSelection = createSelectionParser({ store, currentUser, cachedMeta, prefsOf });

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

  /** The stored wizard choices as the caller may still use them: addon keys they can no
   *  longer reach and a target library they can no longer see are dropped. What is left is a
   *  suggestion the wizard opens with, never a grant. */
  const visibleFollowDefaults = (req: express.Request): FollowDefaults | null => {
    const stored = dataOf(req).followDefaults;
    if (!stored) return null;
    const viewer = viewerOf(currentUser(req));
    const allowed = new Set(allowedAddons(store.addons(), viewer).filter((addon) => addon.enabled && addon.role !== "catalog").map((addon) => addon.key));
    const libraries = store.libraries();
    const { selection, target, ...rest } = stored;
    const targetVisible = target && libraries.some((library) => library.id === target.libraryId && libraryVisible(library, viewer));
    return {
      ...rest,
      ...(selection ? { selection: { ...selection, addonKeys: selection.addonKeys.filter((key) => allowed.has(key)) } } : {}),
      ...(target && targetVisible ? { target } : {}),
    };
  };

  // Registered before any `/api/follows/:id`, so `defaults`, `calendar` and `activity`
  // are never read as an id.
  app.get("/api/follows/defaults", (req, res) => {
    res.json({ defaults: visibleFollowDefaults(req) });
  });

  app.put("/api/follows/defaults", asyncRoute(async (req, res) => {
    const defaults = parseFollowDefaults(req.body);
    if (!defaults) throw new AppError("The follow defaults are not valid.", "err.followInvalid");
    await updateData(req, (data) => { data.followDefaults = defaults; });
    res.status(204).end();
  }));

  app.get("/api/follows/calendar", (req, res) => {
    const owner = viewerOf(currentUser(req));
    const from = Date.parse(String(req.query.from ?? ""));
    const to = Date.parse(String(req.query.to ?? ""));
    if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from) || to - from > CALENDAR_MAX_SPAN_MS) {
      throw new AppError("The calendar window is not valid.", "err.followInvalid");
    }
    const items = calendarItems(followStore.listForOwner(owner.id), from, to, Date.now())
      .map((item) => ({ ...item, poster: images.proxied(item.poster) }));
    const undated = undatedCalendarItems(followStore.listForOwner(owner.id), 100)
      .map((item) => ({ ...item, poster: images.proxied(item.poster) }));
    res.json({ items, undated });
  });

  app.get("/api/follows/activity", (req, res) => {
    const owner = viewerOf(currentUser(req));
    const requested = Number(req.query.limit);
    const limit = Number.isFinite(requested) ? Math.min(100, Math.max(1, Math.trunc(requested))) : 50;
    const items = activityItems(followStore.listForOwner(owner.id), limit)
      .map((item) => ({ ...item, poster: images.proxied(item.poster) }));
    res.json({ items });
  });

  // The private feed a calendar app subscribes to. Registered before `/api/follows/:id`, so
  // `calendar-feed` is never read as an id.
  app.get("/api/follows/calendar-feed", (req, res) => {
    res.json({ token: dataOf(req).calendarFeedToken ?? null });
  });

  app.post("/api/follows/calendar-feed", asyncRoute(async (req, res) => {
    const token = randomBytes(32).toString("base64url");
    await updateData(req, (data) => { data.calendarFeedToken = token; });
    res.json({ token });
  }));

  app.delete("/api/follows/calendar-feed", asyncRoute(async (req, res) => {
    await updateData(req, (data) => { delete data.calendarFeedToken; });
    res.status(204).end();
  }));

  app.post("/api/follows", asyncRoute(async (req, res) => {
    const owner = viewerOf(currentUser(req));
    const type = String(req.body?.type ?? "").trim();
    const metaId = String(req.body?.id ?? "").trim();
    const name = String(req.body?.name ?? "").trim();
    if (!type || !metaId || !name || (type !== "series" && type !== "movie")) throw new AppError("The followed series is missing a type, an id or a name.", "err.followInvalid");
    const follow = await followStore.create({ ownerUserId: owner.id, type, metaId, name, poster: posterOf(req.body?.poster) }, Date.now());
    // The first check runs now rather than at the next tick, so the episodes are known
    // while the person who just followed is still looking.
    void follows.check(follow.id, "schedule").catch(() => undefined);
    res.status(201).json(followView(follow, Date.now()));
  }));

  app.patch("/api/follows/:id", asyncRoute(async (req, res) => {
    const owner = viewerOf(currentUser(req));
    const follow = owned(req, String(req.params.id));
    const body = (req.body ?? {}) as Record<string, unknown>;
    if ("autoDownload" in body) {
      const raw = body.autoDownload;
      if (raw === null) {
        await follows.setAutoDownload(follow.id, owner.id, null);
      } else {
        const item = typeof raw === "object" && raw ? raw as Record<string, unknown> : {};
        // A film has no episodes to start from; it downloads whenever it comes out.
        const startMode = follow.type === "movie" ? "new" : item.startMode === "from" ? "from" : item.startMode === "new" ? "new" : undefined;
        if (!startMode) throw new AppError("The followed series is missing a type, an id or a name.", "err.followInvalid");
        let startSeason: number | undefined;
        let startEpisode: number | undefined;
        if (startMode === "from" && follow.type !== "movie") {
          startSeason = Number(item.startSeason);
          startEpisode = Number(item.startEpisode);
          if (!Number.isInteger(startSeason) || startSeason < 1 || !Number.isInteger(startEpisode) || startEpisode < 1) {
            throw new AppError("The followed series is missing a type, an id or a name.", "err.followInvalid");
          }
        }
        let graceDays: number | undefined;
        if (item.graceDays !== undefined && item.graceDays !== null) {
          graceDays = Number(item.graceDays);
          if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > 30) throw new AppError("The followed series is missing a type, an id or a name.", "err.followInvalid");
        }
        const selection = await parseSelection(req, { selection: item.selection, target: item.target, metaType: follow.type, parentId: follow.metaId });
        const targetSettings = pinnedTarget(selection, store.libraries(), store.settings(), follow.type === "movie" ? "movie" : "series");
        const value: Omit<FollowAutoDownload, "enabledAt" | "blockedKey"> = {
          startMode,
          ...(startSeason != null ? { startSeason } : {}),
          ...(startEpisode != null ? { startEpisode } : {}),
          ...(graceDays ? { graceDays } : {}),
          selection: { ...selection, targetSettings },
        };
        await follows.setAutoDownload(follow.id, owner.id, value);
      }
    }
    const updated = await followStore.update(follow.id, (current) => {
      if (typeof body.enabled === "boolean") current.enabled = body.enabled;
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
    }).map((item) => ({ ...item, poster: images.proxied(item.poster) })) });
  });

  app.get("/api/follows/by-meta/:type/:id", (req, res) => {
    const owner = viewerOf(currentUser(req));
    const follow = followStore.findByMeta(owner.id, String(req.params.type), String(req.params.id));
    // Not following is an ordinary answer for every series detail, not a failure to log.
    res.json({ follow: follow ? followView(follow, Date.now()) : null });
  });

  app.get("/api/follows/:id/episodes", (req, res) => {
    const follow = owned(req, String(req.params.id));
    const now = Date.now();
    const episodes = Object.values(follow.episodes)
      .map((episode) => ({
        key: episode.key, season: episode.season, episode: episode.episode,
        ...(episode.title ? { title: episode.title } : {}),
        ...(episode.released ? { released: episode.released } : {}),
        ...(episode.releasedSource ? { releasedSource: episode.releasedSource } : {}),
        ...(episode.dateUncertain ? { dateUncertain: true } : {}),
        ...(episode.ambiguous ? { ambiguous: true } : {}),
        eligibility: downloadEligibility(follow, episode, now),
        ...(episode.download ? { download: episode.download } : {}),
      }))
      .sort((left, right) => left.season - right.season || left.episode - right.episode);
    res.json({ episodes });
  });

  app.get("/api/follows/:id/preview", (req, res) => {
    const follow = owned(req, String(req.params.id));
    const startMode = req.query.startMode === "from" ? "from" : req.query.startMode === "new" ? "new" : undefined;
    if (!startMode) throw new AppError("The followed series is missing a type, an id or a name.", "err.followInvalid");
    let startSeason: number | undefined;
    let startEpisode: number | undefined;
    if (startMode === "from") {
      startSeason = Number(req.query.startSeason);
      startEpisode = Number(req.query.startEpisode);
      if (!Number.isInteger(startSeason) || startSeason < 1 || !Number.isInteger(startEpisode) || startEpisode < 1) {
        throw new AppError("The followed series is missing a type, an id or a name.", "err.followInvalid");
      }
    }
    const eligible = follows.preview(follow, {
      startMode,
      ...(startSeason != null ? { startSeason } : {}),
      ...(startEpisode != null ? { startEpisode } : {}),
    });
    const episodes = eligible.slice(0, 50).map((episode) => ({
      key: episode.key, season: episode.season, episode: episode.episode,
      ...(episode.title ? { title: episode.title } : {}),
    }));
    res.json({ count: eligible.length, episodes });
  });

  app.post("/api/follows/:id/episodes/:key/skip", asyncRoute(async (req, res) => {
    const owner = viewerOf(currentUser(req));
    const follow = owned(req, String(req.params.id));
    await follows.skipEpisode(follow.id, owner.id, String(req.params.key));
    res.status(204).end();
  }));

  app.post("/api/follows/:id/episodes/:key/retry", asyncRoute(async (req, res) => {
    const owner = viewerOf(currentUser(req));
    const follow = owned(req, String(req.params.id));
    await follows.retryEpisode(follow.id, owner.id, String(req.params.key));
    res.status(204).end();
  }));
}
