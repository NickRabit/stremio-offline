import type express from "express";
import { readFile } from "node:fs/promises";
import { allowedAddons, catalog, orderedForUser, orderFor, searchAll, searchableCatalogs, streamCandidates, streams, subtitles, type MetaProvider } from "../addons.js";
import { AppError } from "../errors.js";
import { ExternalIdStore, imdbOf, siteLinks } from "../external-ids.js";
import { images } from "../images.js";
import { normalizeLanguage } from "../language.js";
import { libraryFor, libraryVisible, parseLibraryPath, posixBase, type Viewer } from "../libraries.js";
import { episodeNumberOf, knownTitleEntry, unitFor, type LibraryMetaRecord, type TitleUnit } from "../library-match.js";
import type { LibraryMetaStore } from "../library-meta-store.js";
import { mediaResources, ResourceError, safeSourceText, type ResourceOwner } from "../media-resources.js";
import { readMediaText } from "../media-playlist.js";
import { isRemoteMediaStream } from "../media-server-reference.js";
import type { MediaServerSources } from "../media-server-sources.js";
import { guardedFetch } from "../outbound.js";
import { contentOf } from "../revocation.js";
import type { UserPrefs } from "../store.js";
import { trailerFor } from "../trailers.js";
import { tmdbGallery, type TmdbGalleryPicture } from "../tmdb.js";
import type { MetaItem, StreamItem } from "../types.js";
import { shiftVtt } from "../vtt.js";
import { asyncRoute, viewerOf, type RouteContext } from "./context.js";

export interface CatalogDeps extends RouteContext {
  tmdbProvider(language: string): MetaProvider | undefined;
  cachedMeta(type: string, id: string, language?: string, viewer?: Viewer, opts?: { artwork?: boolean }): Promise<MetaItem | null>;
  prefsOf(req?: express.Request): UserPrefs;
  libraryTarget(value: string, viewer: Viewer | undefined): Promise<string>;
  ownerOf(req: express.Request): ResourceOwner;
  trackMedia(owner: ResourceOwner, res: express.Response, resourceId?: string): void;
  libraryKey(value: string): string;
  /** The caller's library copies of one catalogue title or episode, in answer order. */
  localCopies(type: string, id: string, viewer: Viewer): Promise<Array<{ key: string; libraryId: string; libraryName: string; path: string; size: number }>>;
  /** The title units of the current walks, and the binding stored on one path itself. Both are
   *  what the identity route derives an episode number from. */
  libraryUnits(): Promise<TitleUnit[]>;
  ownRecord(relative: string, records: Record<string, LibraryMetaRecord>): LibraryMetaRecord | undefined;
  metaStore: LibraryMetaStore;
  externalIds: ExternalIdStore;
  subtitleDelay(value: unknown): number;
  mediaSources: MediaServerSources;
}

export function registerCatalogRoutes(app: express.Application, deps: CatalogDeps): void {
  const { store, currentUser, cachedMeta, prefsOf, libraryTarget, ownerOf, trackMedia, libraryKey, localCopies, libraryUnits, ownRecord, metaStore, externalIds, subtitleDelay, mediaSources, requireAccess } = deps;

  /** The addons this caller may use, read once per request. A disabled addon is left out
   *  later by the helpers that honour `enabled`; visibility narrows an enabled addon only. */
  const usable = (req: express.Request) => allowedAddons(store.addons(), viewerOf(currentUser(req)));
  /** The same addons, in the order the caller put them in. Everything that asks addons for
   *  something the caller will then choose between has to use this: the priority is the one
   *  setting an ordinary account owns, so a list that ignores it makes that setting a lie. */
  const inOrder = (req: express.Request) =>
    orderedForUser(usable(req), orderFor(currentUser(req), (id) => store.userData(id).addonOrder));

  /** The binding key for a path the caller may see. A path in an invisible library reads
   *  exactly like one that carries no binding, which is what these two endpoints already
   *  answer for a path nothing is bound to. */
  const boundKey = (raw: string, viewer: Viewer) => {
    const key = libraryKey(raw);
    const libraryId = parseLibraryPath(key)?.libraryId;
    const library = libraryId ? libraryFor(store.libraries(), libraryId) : undefined;
    return library && libraryVisible(library, viewer) ? key : undefined;
  };

  const titleTrailer = (type: string, id: string, language: string, viewer: Viewer) => {
    const apiKey = store.settings().tmdbApiKey;
    return trailerFor(allowedAddons(store.addons(), viewer), type, id, language, apiKey ? { apiKey, language } : undefined);
  };

  const galleryCache = new Map<string, { at: number; promise: Promise<TmdbGalleryPicture[]> }>();
  const detailGallery = (type: string, id: string, language: string) => {
    const apiKey = store.settings().tmdbApiKey;
    if (!apiKey || (type !== "movie" && type !== "series") || !/^(tt[0-9]+|tmdb:[0-9]+)$/.test(id)) return Promise.resolve([]);
    const key = `${type}:${id}:${language}:${apiKey}`;
    const cached = galleryCache.get(key);
    if (cached && Date.now() - cached.at < 30 * 60_000) return cached.promise;
    const entry = { at: Date.now(), promise: tmdbGallery(type, id, { apiKey, language }).catch(() => []) };
    galleryCache.set(key, entry);
    if (galleryCache.size > 128) galleryCache.delete(galleryCache.keys().next().value!);
    return entry.promise;
  };

  app.get("/api/catalogs", (req, res) => res.json(inOrder(req).filter((a) => a.enabled && a.role !== "source").flatMap((addon) => (addon.manifest.catalogs ?? []).map((item) => ({ ...item, addonKey: addon.key, addonName: addon.manifest.name })) )));
  app.get("/api/catalog", asyncRoute(async (req, res) => {
    // Switched off as well as allowed: `usable` narrows by who is asking, and the listing
    // above drops the disabled ones, but a catalogue id somebody already has is a direct
    // request that never passes the listing. Answered as a miss, which is what it now is.
    const addon = usable(req).find((a) => a.key === req.query.addon && a.enabled);
    if (!addon) throw new AppError("The addon was not found.", "err.addonNotFound");
    const items = await catalog(addon, String(req.query.type), String(req.query.id), req.query.search ? String(req.query.search) : undefined, Number(req.query.skip) || 0, req.query.genre ? String(req.query.genre) : undefined, true);
    res.json(items.map((item) => images.rewriteMeta(item)));
  }));
  app.get("/api/search", asyncRoute(async (req, res) => {
    const query = String(req.query.query ?? "").trim();
    if (!query) throw new AppError("Enter a search term.", "err.emptyQuery");
    res.set("Cache-Control", "no-store");
    const type = req.query.type ? String(req.query.type) : undefined;
    const addonKey = req.query.addon ? String(req.query.addon) : undefined;
    const found = await searchAll(inOrder(req), query, type, req.query.cursor ? String(req.query.cursor) : undefined, {
      addonKey,
      catalogType: addonKey && req.query.catalogType ? String(req.query.catalogType) : undefined,
      catalogId: addonKey && req.query.catalogId ? String(req.query.catalogId) : undefined,
      respectGlobalSearch: !addonKey,
    }, true);
    res.json({ ...found, items: found.items.map((item) => images.rewriteMeta(item)) });
  }));
  app.get("/api/searchable", (req, res) => res.json(searchableCatalogs(inOrder(req)).map(({ addon, definition }) => ({ addonKey: addon.key, addonName: addon.manifest.name, globalSearch: addon.globalSearch, type: definition.type, id: definition.id, name: definition.name ?? definition.id }))));
  app.get("/api/meta/:type/:id", asyncRoute(async (req, res) => {
    const language = normalizeLanguage(String(req.query.language ?? "")) ?? prefsOf(req).uiLanguage;
    // The detail page is the one reader that wants the wider backdrop, so it asks for the
    // artwork reading and keeps a Metahub background at its full size.
    const meta = await cachedMeta(String(req.params.type), String(req.params.id), language, viewerOf(currentUser(req)), { artwork: true });
    if (!meta) throw new AppError("The metadata was not found.", "err.metaNotFound", 404);
    if (req.query.gallery === "1") {
      const gallery = await detailGallery(String(req.params.type), String(req.params.id), language);
      res.json(images.rewriteMeta({ ...meta, images: gallery.map((image) => ({ ...image, shape: image.kind === "poster" ? "poster" : "wide" })) }, true));
      return;
    }
    res.json(images.rewriteMeta(meta, true));
  }));
  app.get("/api/library/trailer", asyncRoute(async (req, res) => {
    const language = normalizeLanguage(String(req.query.language ?? "")) ?? prefsOf(req).uiLanguage;
    const viewer = viewerOf(currentUser(req));
    const raw = String(req.query.path ?? "").trim();
    const key = raw ? boundKey(raw, viewer) : undefined;
    const entry = key ? knownTitleEntry(key, metaStore.qualifiedMeta()) : undefined;
    res.json({ trailer: entry ? await titleTrailer(entry.record.type, entry.record.id, language, viewer) : null });
  }));
  app.get("/api/trailer/:type/:id", asyncRoute(async (req, res) => {
    const language = normalizeLanguage(String(req.query.language ?? "")) ?? prefsOf(req).uiLanguage;
    res.json({ trailer: await titleTrailer(String(req.params.type), String(req.params.id), language, viewerOf(currentUser(req))) });
  }));
  /** The same row for a folder that is bound to a title. A path with no binding asks
   *  Wikidata nothing and answers no links. */
  app.get("/api/library/links", asyncRoute(async (req, res) => {
    const language = normalizeLanguage(String(req.query.language ?? "")) ?? prefsOf(req).uiLanguage;
    const raw = String(req.query.path ?? "").trim();
    const key = raw ? boundKey(raw, viewerOf(currentUser(req))) : undefined;
    const entry = key ? knownTitleEntry(key, metaStore.qualifiedMeta()) : undefined;
    if (!entry) return res.json({ links: [] });
    const ids = (await externalIds.ids(entry.record.id)) ?? {};
    res.json({ links: siteLinks(entry.record.type, entry.record.id, ids, language) });
  }));
  /** The catalogue title a library file is bound to, so a play that started from the library can
   *  ask the addons about it the way the catalogue detail does. A path the caller may not see, an
   *  invalid path and a file with no binding all answer an empty object, which the client reads as
   *  "no sources": none of them is an error. */
  app.get("/api/library/title", asyncRoute(async (req, res) => {
    res.setHeader("cache-control", "private, no-store");
    const raw = String(req.query.path ?? "").trim();
    const key = raw ? boundKey(raw, viewerOf(currentUser(req))) : undefined;
    const records = metaStore.qualifiedMeta();
    const entry = key ? knownTitleEntry(key, records) : undefined;
    if (!key || !entry) return res.json({});
    const record = entry.record;
    // The clicked file's own number, derived exactly as the identity route derives it, so a
    // series file names the video id the addon stream endpoint takes for its episode.
    const numbers = record.type === "series"
      ? episodeNumberOf(key, ownRecord(key, records), { loose: unitFor(key, await libraryUnits())?.kind === "series" })
      : undefined;
    res.json({
      type: record.type,
      id: record.id,
      name: record.name ?? "",
      ...(numbers ? { videoId: `${record.id}:${numbers.season}:${numbers.episode}` } : {}),
    });
  }));
  /** The sites worth checking before watching. Wikidata supplies two ids, the catalogue id
   *  the rest; when it cannot be reached the links it would have added are simply missing. */
  app.get("/api/links/:type/:id", asyncRoute(async (req, res) => {
    const id = String(req.params.id);
    const language = normalizeLanguage(String(req.query.language ?? "")) ?? prefsOf(req).uiLanguage;
    const imdbId = imdbOf(id);
    const ids = imdbId ? await externalIds.ids(imdbId) : {};
    res.json({ links: siteLinks(String(req.params.type), id, ids ?? {}, language) });
  }));
  /** Opaque id in, cached bytes out. An id we never handed out means nothing here. The id is a
   *  hash of the address, not of the bytes, so it stays a day rather than a year: the bytes may
   *  be replaced under the same id. */
  app.get("/api/image/:id", asyncRoute(async (req, res) => {
    const cached = await images.fetch(String(req.params.id));
    if (!cached) return res.status(404).end();
    res.setHeader("content-type", cached.type);
    res.setHeader("etag", cached.etag);
    res.setHeader("cache-control", "private, max-age=86400");
    if (req.headers["if-none-match"] === cached.etag) return res.status(304).end();
    // The bytes come from memory when they are already there, and from one read otherwise;
    // sendFile would refuse a data directory that sits inside a dotted folder.
    const bytes = await images.readCached(String(req.params.id));
    if (!bytes) return res.status(404).end();
    res.end(bytes);
  }));
  app.get("/api/stream-sources/:type/:id", (req, res) => {
    // The picker lists these in the caller's own order, the same one `GET /api/addons` answers.
    res.json(streamCandidates(inOrder(req), String(req.params.type), String(req.params.id))
      .map((addon) => ({ key: addon.key, name: addon.manifest.name })));
  });
  app.get("/api/streams/:type/:id", asyncRoute(async (req, res) => {
    const owner = ownerOf(req);
    const items = await streams(inOrder(req), String(req.params.type), String(req.params.id), req.query.addon ? String(req.query.addon) : undefined, true);
    // The listing hands out one resource per source, and the addons that answered took as
    // long as they liked: an addon switched off, or a grant withdrawn, while they were
    // answering must not get one. Nothing is awaited between the check and the listing.
    for (const addonKey of new Set(items.map((item) => item.addonKey).filter((key): key is string => Boolean(key)))) {
      requireAccess(req, { addonKey });
    }
    res.setHeader("cache-control", "private, no-store").json(mediaResources.listing(items, owner));
  }));
  app.get("/api/local-streams/:type/:id", asyncRoute(async (req, res) => {
    const viewer = viewerOf(currentUser(req));
    const owner = ownerOf(req);
    const copies = await localCopies(String(req.params.type), String(req.params.id), viewer);
    // A grant withdrawn while the walk was being read must not get a resource, the same way
    // the addon listing re-checks. Nothing is awaited between the check and the listing.
    for (const libraryId of new Set(copies.map((copy) => copy.libraryId))) requireAccess(req, { libraryId });
    const listed = mediaResources.listing(copies.map((copy) => ({
      url: `file://${copy.key}`,
      behaviorHints: { filename: posixBase(copy.key), videoSize: copy.size },
    })), owner);
    // The listing redacts long path segments as if they were an addon's secrets; the name of the
    // viewer's own file is not one, and it is what the row shows.
    res.setHeader("cache-control", "private, no-store").json(listed.map((stream, index) => ({
      ...stream, behaviorHints: { ...stream.behaviorHints, filename: posixBase(copies[index]!.key) },
      localPath: copies[index]!.path, libraryName: copies[index]!.libraryName,
    })));
  }));
  app.get("/api/subtitles/:type/:id", asyncRoute(async (req, res) => {
    const owner = ownerOf(req);
    const items = await subtitles(inOrder(req), String(req.params.type), String(req.params.id), true);
    // Per addon, the way the stream listing does it: a bare re-check never reaches the
    // addon, so a grant withdrawn while the addon was answering would still be listed --
    // language, addon name and an issued id for a source the account may no longer use.
    for (const addonKey of new Set(items.map((item) => item.addonKey).filter((key): key is string => Boolean(key)))) {
      requireAccess(req, { addonKey });
    }
    // The addon travels with the resource. Without it the record names no content, so the
    // sweep that runs when an addon is removed or taken away cannot recognise it, and the
    // subtitle keeps being served from an addon the account may no longer use.
    res.setHeader("cache-control", "private, no-store").json(items.map((item) => ({
      subtitleId: mediaResources.add({ url: item.url, addonKey: item.addonKey }, owner, "subtitle"),
      lang: safeSourceText(item.lang, { url: item.url }), addonName: safeSourceText(item.addonName, { url: item.url }),
    })));
  }));
  app.get("/api/subtitle/:subtitleId", asyncRoute(async (req, res) => {
    res.setHeader("cache-control", "private, no-store");
    if ("url" in req.query || "headers" in req.query) throw new ResourceError(400, "UNSAFE_SOURCE_INPUT");
    const owner = ownerOf(req);
    const resource = mediaResources.get(String(req.params.subtitleId), owner.sid, "subtitle");
    // A media-server subtitle is a sealed reference, never a URL: it is read through the
    // scoped transport, converted locally and guarded again before it is sent. A malformed
    // media-server attempt refuses here rather than reaching the generic URL fetch below.
    if (isRemoteMediaStream(resource.stream)) {
      const need = contentOf(resource.stream);
      requireAccess(req, need);
      mediaResources.get(resource.id, owner.sid, "subtitle");
      trackMedia(owner, res, resource.parent ?? resource.id);
      const controller = new AbortController();
      res.once("close", () => { if (!res.writableEnded) controller.abort(); });
      const asset = await mediaSources.readSubtitle(resource.stream, owner, controller.signal);
      let text = new TextDecoder().decode(asset.bytes);
      if (!text.trimStart().startsWith("WEBVTT")) text = `WEBVTT\n\n${text.replace(/^\ufeff/, "").replace(/\r/g, "").replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2").replace(/^\d+\n(?=\d{2}:\d{2}:\d{2}[.,]\d{3} -->)/gm, "")}`;
      const shift = (Number(req.query.offset) || 0) - subtitleDelay(req.query.delay);
      if (shift) text = shiftVtt(text, shift);
      // The session, the grant and the resource are all re-read after the await and the
      // conversion, so a revocation that landed while the bytes were in flight refuses.
      requireAccess(req, need);
      mediaResources.get(resource.id, owner.sid, "subtitle");
      if (res.destroyed || res.writableEnded) return;
      return void res.type("text/vtt; charset=utf-8")
        .setHeader("cache-control", "private, no-store")
        .setHeader("x-content-type-options", "nosniff")
        .send(text);
    }
    // Re-checked against the addon it came from, the way a stream is: the resource may have
    // been minted while the account still had it.
    requireAccess(req, { addonKey: resource.stream.addonKey });
    trackMedia(owner, res, resource.parent ?? resource.id);
    const raw = resource.stream.url!;
    if (raw.startsWith("file://")) {
      const target = await libraryTarget(raw.slice(7), currentUser(req));
      const text = await readFile(target, "utf8");
      const vtt = text.trimStart().startsWith("WEBVTT") ? text : `WEBVTT\n\n${text.replace(/^\ufeff/, "").replace(/\r/g, "").replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2").replace(/^\d+\n(?=\d{2}:\d{2}:\d{2}[.,]\d{3} -->)/gm, "")}`;
      return void res.type("text/vtt; charset=utf-8").send(vtt);
    }
    const controller = new AbortController();
    res.once("close", () => { if (!res.writableEnded) controller.abort(); });
    const response = await guardedFetch(raw, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) });
    if (!response.ok) { await response.body?.cancel(); throw new Error("Subtitle source unavailable."); }
    let text = await readMediaText(response); if (!text.trimStart().startsWith("WEBVTT")) text = `WEBVTT\n\n${text.replace(/^\ufeff/, "").replace(/\r/g, "").replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2").replace(/^\d+\n(?=\d{2}:\d{2}:\d{2}[.,]\d{3} -->)/gm, "")}`;
    const shift = (Number(req.query.offset) || 0) - subtitleDelay(req.query.delay);
    if (shift) text = shiftVtt(text, shift);
    res.type("text/vtt; charset=utf-8").setHeader("cache-control", "private, no-store").send(text);
  }));
}
