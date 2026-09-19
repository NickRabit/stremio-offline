import type express from "express";
import type { AudioMode, DownloadQueue, DownloadSelection, SubtitleMode } from "../downloads.js";
import { AppError } from "../errors.js";
import { normalizeLanguage } from "../language.js";
import { log } from "../logger.js";
import { defaultDownloadSettings, type MediaInfo } from "../naming.js";
import { titleLanguage } from "../ranking.js";
import type { UserPrefs } from "../store.js";
import type { MetaItem, StreamItem } from "../types.js";
import { asyncRoute, type RouteContext } from "./context.js";

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
  const { store, queue, jobView, sourceOf, mediaSource, posterOf, rememberTitle, titleKey, saveCatalogPoster, libraryKey, cachedMeta, prefsOf } = deps;

  app.get("/api/downloads", (_req, res) => {
    const snapshot = queue.snapshot();
    res.json({ ...snapshot, jobs: snapshot.jobs.map(jobView) });
  });
  app.post("/api/downloads", asyncRoute(async (req, res) => {
    const stream = sourceOf(req);
    const media = mediaSource(req.body.media);
    const addon = store.addons().find((item) => item.key === stream.addonKey);
    const settings = addon?.downloadSettings ?? defaultDownloadSettings();
    const targetSettings = media?.kind === "episode" ? settings.series : settings.movie;
    const job = await queue.add(String(req.body.title ?? "video"), stream, media, targetSettings);
    await rememberTitle(job.target, media, targetSettings.layout === "flat");
    const posterKey = titleKey(job.target, media, targetSettings.layout === "flat");
    if (posterKey && posterKey !== ".") saveCatalogPoster(libraryKey(posterKey), media?.poster);
    res.status(201).json(jobView(job));
  }));
  // Adding episodes in bulk: the jobs are lazy, streams are asked for at download time.
  app.post("/api/downloads/bulk", asyncRoute(async (req, res) => {
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
    const addonKeys = Array.isArray(rawSelection.addonKeys)
      ? [...new Set(rawSelection.addonKeys.map(String))].filter((key) => store.addons().some((addon) => addon.key === key && addon.enabled && addon.role !== "catalog"))
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
    let added = 0, skipped = 0;
    for (const episode of episodes) {
      const videoId = String(episode.id ?? "").trim();
      if (!videoId) { skipped += 1; continue; }
      const season = episode.season == null ? undefined : Number(episode.season);
      const number = episode.episode == null ? undefined : Number(episode.episode);
      const episodeTitle = episode.title ? String(episode.title) : undefined;
      const jobTitle = `${title} · ${episodeTitle ?? (season != null ? `S${String(season).padStart(2, "0")}E${String(number ?? 0).padStart(2, "0")}` : `Episode ${number ?? "?"}`)}`;
      const media: MediaInfo = { kind: "episode", title, season, episode: number, episodeTitle, id: parentId, metaType, poster };
      const job = await queue.addPending(jobTitle, { type, videoId, selection }, media);
      if (job) added += 1; else skipped += 1;
    }
    log("INFO", "Bulk addition to the queue", { title, added, skipped });
    res.status(201).json({ added, skipped });
  }));
  app.post("/api/downloads/:id/pause", asyncRoute(async (req, res) => { await queue.pause(String(req.params.id)); res.status(204).end(); }));
  app.post("/api/downloads/:id/resume", asyncRoute(async (req, res) => { await queue.resume(String(req.params.id)); res.status(204).end(); }));
  app.post("/api/downloads/:id/retry", asyncRoute(async (req, res) => { await queue.retry(String(req.params.id)); res.status(204).end(); }));
  app.post("/api/downloads/:id/move", asyncRoute(async (req, res) => { await queue.move(String(req.params.id), Number(req.body.direction) < 0 ? -1 : 1); res.status(204).end(); }));
  app.delete("/api/downloads/:id", asyncRoute(async (req, res) => { await queue.remove(String(req.params.id)); res.status(204).end(); }));
  app.delete("/api/downloads", asyncRoute(async (_req, res) => { await queue.clearCompleted(); res.status(204).end(); }));
}
