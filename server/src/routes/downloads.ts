import type express from "express";
import { allowedAddons } from "../addons.js";
import { ownerMayDownload, type AudioMode, type DownloadQueue, type DownloadSelection, type SubtitleMode } from "../downloads.js";
import { AppError } from "../errors.js";
import { normalizeLanguage } from "../language.js";
import { log } from "../logger.js";
import { defaultDownloadSettings, type MediaInfo } from "../naming.js";
import { titleLanguage } from "../ranking.js";
import type { UserPrefs } from "../store.js";
import type { MetaItem, StreamItem } from "../types.js";
import { asyncRoute, viewerOf, type RouteContext } from "./context.js";

export interface DownloadsDeps extends RouteContext {
  queue: DownloadQueue;
  jobView: <T extends { media?: MediaInfo; target?: string }>(job: T) => T;
  sourceOf(req: express.Request): StreamItem;
  mediaSource(value: unknown): MediaInfo | undefined;
  posterOf(value: unknown): string | undefined;
  rememberTitle(target: string, media: MediaInfo | undefined, flat: boolean): Promise<void>;
  titleKey(target: string, media: MediaInfo | undefined, flat: boolean): string;
  saveCatalogPoster(key: string, url?: string, fallback?: string, backdrop?: string): void;
  libraryKey(value: string): string;
  cachedMeta(type: string, id: string, language?: string): Promise<MetaItem | null>;
  prefsOf(req?: express.Request): UserPrefs;
}

export function registerDownloadRoutes(app: express.Application, deps: DownloadsDeps): void {
  const { store, currentUser, queue, jobView, sourceOf, mediaSource, posterOf, rememberTitle, titleKey, saveCatalogPoster, libraryKey, cachedMeta, prefsOf } = deps;

  /** The owner-bound check where a failure reaches the caller instead of pausing a job. The
   *  rights are asked before the body is read; the source and the library the rule names are
   *  asked again once they are known. */
  const assertMayQueue = (req: express.Request, job: { stream?: StreamItem; libraryId?: string } = {}) => {
    const owner = currentUser(req);
    if (owner && ownerMayDownload({ owner, addons: store.addons(), libraries: store.libraries() }, job)) return;
    throw new AppError("This account may not download to the library.", "err.downloadLibraryNotAllowed", 403);
  };

  /** A job the caller does not own is answered exactly like one that is not there: 403 would
   *  tell the caller that the id exists. */
  const requireOwnJob = (req: express.Request, id: string): string => {
    const viewer = viewerOf(currentUser(req));
    const job = queue.list().find((item) => item.id === id);
    if (!job || (viewer.role !== "admin" && job.ownerUserId !== viewer.id)) {
      throw new AppError("The item was not found.", "err.itemNotFound", 404);
    }
    return id;
  };

  app.get("/api/downloads", (req, res) => {
    const viewer = viewerOf(currentUser(req));
    const snapshot = queue.snapshot();
    const jobs = snapshot.jobs.filter((job) => viewer.role === "admin" || job.ownerUserId === viewer.id);
    res.json({ ...snapshot, jobs: jobs.map(jobView) });
  });
  app.post("/api/downloads", asyncRoute(async (req, res) => {
    const owner = currentUser(req);
    assertMayQueue(req);
    const stream = sourceOf(req);
    const media = mediaSource(req.body.media);
    const addon = store.addons().find((item) => item.key === stream.addonKey);
    const settings = addon?.downloadSettings ?? defaultDownloadSettings();
    const targetSettings = media?.kind === "episode" ? settings.series : settings.movie;
    assertMayQueue(req, { stream, libraryId: targetSettings.libraryId });
    const job = await queue.add(String(req.body.title ?? "video"), stream, media, targetSettings, owner?.id);
    await rememberTitle(job.target, media, targetSettings.layout === "flat");
    // Only for a source the catalogue has no title for: `rememberTitle` already saved the
    // artwork of one that has, and it knows the background as well. Repeating the write here
    // with the poster alone put the picture back that the pair had just corrected.
    if (!media?.id) {
      const posterKey = titleKey(job.target, media, targetSettings.layout === "flat");
      if (posterKey && posterKey !== ".") saveCatalogPoster(libraryKey(posterKey), media?.poster);
    }
    res.status(201).json(jobView(job));
  }));
  // Adding episodes in bulk: the jobs are lazy, streams are asked for at download time.
  app.post("/api/downloads/bulk", asyncRoute(async (req, res) => {
    const owner = currentUser(req);
    assertMayQueue(req);
    const title = String(req.body.title ?? "").trim() || "Show";
    const type = String(req.body.type ?? "series");
    const parent = req.body.media && typeof req.body.media === "object" ? req.body.media as Record<string, unknown> : {};
    const parentId = String(parent.id ?? "").trim() || undefined;
    const poster = posterOf(parent.poster);
    const metaType = String(parent.metaType ?? type).trim() || type;
    const episodes = Array.isArray(req.body.episodes) ? req.body.episodes as Array<Record<string, unknown>> : [];
    if (!episodes.length) throw new AppError("Missing episode list.", "err.missingEpisodes");
    if (episodes.length > 500) throw new AppError("At most 500 episodes at a time.", "err.tooManyEpisodes");
    const rawSelection = req.body.selection && typeof req.body.selection === "object" ? req.body.selection as Record<string, unknown> : {};
    // The caller's own addons, so a disallowed key cannot be smuggled in by naming it here.
    const usable = allowedAddons(store.addons(), viewerOf(currentUser(req)));
    const addonKeys = Array.isArray(rawSelection.addonKeys)
      ? [...new Set(rawSelection.addonKeys.map(String))].filter((key) => usable.some((addon) => addon.key === key && addon.enabled && addon.role !== "catalog"))
      : [];
    if (!addonKeys.length) throw new AppError("Pick at least one stream addon.", "err.missingDownloadSources");
    const sourceStrategy = String(rawSelection.sourceStrategy) === "largest" ? "largest" : "priority";
    const audioLanguage = normalizeLanguage(String(rawSelection.audioLanguage ?? ""));
    if (!audioLanguage) throw new AppError("Pick an audio language.", "err.missingAudioLanguage");
    const fallbackAudioLanguage = normalizeLanguage(String(rawSelection.fallbackAudioLanguage ?? ""));
    const audioMode: AudioMode = ["strict", "preferred"].includes(String(rawSelection.audioMode)) ? String(rawSelection.audioMode) as AudioMode : "listed";
    const subtitleMode: SubtitleMode = ["optional", "required"].includes(String(rawSelection.subtitleMode)) ? String(rawSelection.subtitleMode) as SubtitleMode : "off";
    const subtitleLanguage = subtitleMode === "off" ? undefined : normalizeLanguage(String(rawSelection.subtitleLanguage ?? ""));
    if (subtitleMode !== "off" && !subtitleLanguage) throw new AppError("Pick a subtitle language.", "err.missingSubtitleLanguage");
    const fallbackSubtitleLanguage = subtitleMode === "off" ? undefined : normalizeLanguage(String(rawSelection.fallbackSubtitleLanguage ?? ""));
    const firstAddon = store.addons().find((addon) => addon.key === addonKeys[0]);
    // A source whose addon found no language falls back to the one the title's own metadata names.
    const metaLanguage = parentId ? titleLanguage((await cachedMeta(metaType, parentId, prefsOf(req).uiLanguage))?.language) : undefined;
    const selection: DownloadSelection = {
      addonKeys, sourceStrategy, audioLanguage,
      fallbackAudioLanguage: fallbackAudioLanguage === audioLanguage ? undefined : fallbackAudioLanguage,
      audioMode,
      titleLanguage: metaLanguage,
      subtitleMode, subtitleLanguage,
      fallbackSubtitleLanguage: fallbackSubtitleLanguage === subtitleLanguage ? undefined : fallbackSubtitleLanguage,
      targetSettings: firstAddon?.downloadSettings.series ?? defaultDownloadSettings().series,
    };
    assertMayQueue(req, { libraryId: selection.targetSettings.libraryId });
    let added = 0, skipped = 0;
    for (const episode of episodes) {
      const videoId = String(episode.id ?? "").trim();
      if (!videoId) { skipped += 1; continue; }
      const season = episode.season == null ? undefined : Number(episode.season);
      const number = episode.episode == null ? undefined : Number(episode.episode);
      const episodeTitle = episode.title ? String(episode.title) : undefined;
      const jobTitle = `${title} · ${episodeTitle ?? (season != null ? `S${String(season).padStart(2, "0")}E${String(number ?? 0).padStart(2, "0")}` : `Episode ${number ?? "?"}`)}`;
      const media: MediaInfo = { kind: "episode", title, season, episode: number, episodeTitle, id: parentId, metaType, poster };
      const job = await queue.addPending(jobTitle, { type, videoId, selection }, media, owner?.id);
      if (job) added += 1; else skipped += 1;
    }
    log("INFO", "Bulk addition to the queue", { title, added, skipped });
    res.status(201).json({ added, skipped });
  }));
  app.post("/api/downloads/:id/pause", asyncRoute(async (req, res) => { await queue.pause(requireOwnJob(req, String(req.params.id))); res.status(204).end(); }));
  app.post("/api/downloads/:id/resume", asyncRoute(async (req, res) => { await queue.resume(requireOwnJob(req, String(req.params.id))); res.status(204).end(); }));
  app.post("/api/downloads/:id/retry", asyncRoute(async (req, res) => { await queue.retry(requireOwnJob(req, String(req.params.id))); res.status(204).end(); }));
  app.post("/api/downloads/:id/move", asyncRoute(async (req, res) => { await queue.move(String(req.params.id), Number(req.body.direction) < 0 ? -1 : 1); res.status(204).end(); }));
  app.delete("/api/downloads/:id", asyncRoute(async (req, res) => { await queue.remove(requireOwnJob(req, String(req.params.id))); res.status(204).end(); }));
  app.delete("/api/downloads", asyncRoute(async (_req, res) => { await queue.clearCompleted(); res.status(204).end(); }));
}
