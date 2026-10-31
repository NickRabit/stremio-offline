import type express from "express";
import { readFile } from "node:fs/promises";
import { allowedAddons, catalog, orderedForUser, orderFor, searchAll, searchableCatalogs, streamCandidates, streams, subtitleTarget, subtitles, type MetaProvider } from "../addons.js";
import { DetailGalleryCache } from "../detail-gallery.js";
import { AppError } from "../errors.js";
import { ExternalIdStore, imdbOf, siteLinks } from "../external-ids.js";
import { askedSurface, imageSurface, logPoster, noteImage } from "../image-stats.js";
import { images, type ImageProxy } from "../images.js";
import { normalizeLanguage } from "../language.js";
import { libraryFor, libraryVisible, parseLibraryPath, posixBase, type Viewer } from "../libraries.js";
import { episodeNumberOf, knownTitleEntry, unitFor, type LibraryMetaRecord, type TitleUnit } from "../library-match.js";
import type { LibraryMetaStore } from "../library-meta-store.js";
import { mediaResources, ResourceError, safeSourceText, type ResourceOwner } from "../media-resources.js";
import { readMediaBytes } from "../media-playlist.js";
import { isRemoteMediaStream } from "../media-server-reference.js";
import type { MediaServerSources } from "../media-server-sources.js";
import { guardedBody } from "../outbound.js";
import { titleLanguage } from "../ranking.js";
import { contentOf } from "../revocation.js";
import { cancelResponseBody } from "../response-body.js";
import type { UserPrefs } from "../store.js";
import { trailerFor } from "../trailers.js";
import { titleExtras } from "../title-extras.js";
import { tmdbGallery } from "../tmdb.js";
import type { MetaItem, StreamItem } from "../types.js";
import { subtitleVtt } from "../subtitle-text.js";
import { shiftVtt } from "../vtt.js";
import { listedLocalCopyEvidence } from "../local-copy-admission.js";
import { listedAddonSourceEvidence } from "../source-addon-evidence.js";
import { ruleSnapshots, ruleVerdictsForProfiles, sourceVideoFacts } from "../source-rule-verdict.js";
import { asyncRoute, routeDisconnectSignal, viewerOf, type RouteContext } from "./context.js";

/** The language the player shows a subtitle under, which is what a file that is not Unicode
 *  is read by. Only ever picks a code page, so anything unrecognised just falls back. */
const subtitleLanguage = (value: unknown) => typeof value === "string" ? value.slice(0, 32) : undefined;

export interface CatalogDeps extends RouteContext {
  tmdbProvider(language: string): MetaProvider | undefined;
  cachedMeta(type: string, id: string, language?: string, viewer?: Viewer, opts?: { artwork?: boolean; signal?: AbortSignal }): Promise<MetaItem | null>;
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
  debridReady?: (infoHash: string) => boolean;
  subtitleDelay(value: unknown): number;
  mediaSources: MediaServerSources;
  imageProxy?: ImageProxy;
}

const SUBTITLE_MAX_BYTES = 2 * 1024 * 1024;
const SUBTITLE_DEADLINE_MS = 20_000;
const SVG_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

export function registerCatalogRoutes(app: express.Application, deps: CatalogDeps): void {
  const { store, currentUser, cachedMeta, prefsOf, libraryTarget, ownerOf, trackMedia, libraryKey, localCopies, libraryUnits, ownRecord, metaStore, externalIds, subtitleDelay, mediaSources, requireAccess } = deps;
  const imageProxy = deps.imageProxy ?? images;

  /** The addons this caller may use, read once per request. A disabled addon is left out
   *  later by the helpers that honour `enabled`; visibility narrows an enabled addon only. */
  const usable = (req: express.Request) => allowedAddons(store.addons(), viewerOf(currentUser(req)));
  /** The same addons, in the order the caller put them in. Everything that asks addons for
   *  something the caller will then choose between has to use this: the priority is the one
   *  setting an ordinary account owns, so a list that ignores it makes that setting a lie. */
  const inOrder = (req: express.Request) =>
    orderedForUser(usable(req), orderFor(currentUser(req), (id) => store.userData(id).addonOrder));
  const rulesFor = (req: express.Request, type: string) => ruleSnapshots({
    user: currentUser(req),
    store,
    preferences: prefsOf(req),
    mediaKind: type === "series" ? "episode" : "movie",
  });

  /** The binding key for a path the caller may see. A path in an invisible library reads
   *  exactly like one that carries no binding, which is what these two endpoints already
   *  answer for a path nothing is bound to. */
  const boundKey = (raw: string, viewer: Viewer) => {
    const key = libraryKey(raw);
    const libraryId = parseLibraryPath(key)?.libraryId;
    const library = libraryId ? libraryFor(store.libraries(), libraryId) : undefined;
    return library && libraryVisible(library, viewer) ? key : undefined;
  };

  const titleTrailer = (type: string, id: string, language: string, viewer: Viewer, signal?: AbortSignal) => {
    const apiKey = store.settings().tmdbApiKey;
    return trailerFor(allowedAddons(store.addons(), viewer), type, id, language, apiKey ? { apiKey, language } : undefined, signal);
  };

  const detailGallery = new DetailGalleryCache((type, id, config, signal) => tmdbGallery(type, id, config, undefined, signal));

  app.get("/api/catalogs", (req, res) => res.json(inOrder(req).filter((a) => a.enabled && a.role !== "source").flatMap((addon) => (addon.manifest.catalogs ?? []).map((item) => ({ ...item, addonKey: addon.key, addonName: addon.manifest.name })) )));
  app.get("/api/catalog", asyncRoute(async (req, res) => {
    const disconnect = routeDisconnectSignal(req, res);
    try {
      if (disconnect.signal.aborted) return;
      // Switched off as well as allowed: `usable` narrows by who is asking, and the listing
      // above drops the disabled ones, but a catalogue id somebody already has is a direct
      // request that never passes the listing. Answered as a miss, which is what it now is.
      const addon = usable(req).find((a) => a.key === req.query.addon && a.enabled);
      if (!addon) throw new AppError("The addon was not found.", "err.addonNotFound");
      const items = await catalog(addon, String(req.query.type), String(req.query.id), req.query.search ? String(req.query.search) : undefined, Number(req.query.skip) || 0, req.query.genre ? String(req.query.genre) : undefined, true, disconnect.signal);
      if (disconnect.signal.aborted) return;
      res.json(items.map((item) => images.rewriteMeta(item)));
    } catch (error) {
      if (disconnect.signal.aborted) return;
      throw error;
    } finally {
      disconnect.dispose();
    }
  }));
  app.get("/api/search", asyncRoute(async (req, res) => {
    const disconnect = routeDisconnectSignal(req, res);
    try {
      if (disconnect.signal.aborted) return;
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
      }, true, { signal: disconnect.signal, key: currentUser(req)?.id ?? "" });
      if (disconnect.signal.aborted) return;
      res.json({ ...found, items: found.items.map((item) => images.rewriteMeta(item)) });
    } catch (error) {
      if (disconnect.signal.aborted) return;
      throw error;
    } finally {
      disconnect.dispose();
    }
  }));
  app.get("/api/searchable", (req, res) => res.json(searchableCatalogs(inOrder(req)).map(({ addon, definition }) => ({ addonKey: addon.key, addonName: addon.manifest.name, globalSearch: addon.globalSearch, type: definition.type, id: definition.id, name: definition.name ?? definition.id }))));
  app.get("/api/meta/:type/:id", asyncRoute(async (req, res) => {
    const language = normalizeLanguage(String(req.query.language ?? "")) ?? prefsOf(req).uiLanguage;
    const gallery = req.query.gallery === "1";
    const disconnect = routeDisconnectSignal(req, res);
    try {
      if (disconnect.signal.aborted) return;
      // The detail page is the one reader that wants the wider backdrop, so it asks for the
      // artwork reading and keeps a Metahub background at its full size.
      const meta = await cachedMeta(
        String(req.params.type),
        String(req.params.id),
        language,
        viewerOf(currentUser(req)),
        { artwork: true, signal: disconnect.signal },
      );
      if (disconnect.signal.aborted) return;
      if (!meta) throw new AppError("The metadata was not found.", "err.metaNotFound", 404);
      if (gallery) {
        const pictures = await detailGallery.get(String(req.params.type), String(req.params.id), language, store.settings().tmdbApiKey, disconnect.signal);
        if (disconnect.signal.aborted) return;
        res.json(images.rewriteMeta({ ...meta, images: pictures.map((picture) => ({ ...picture, shape: picture.kind === "poster" ? "poster" : "wide" })) }, true));
        return;
      }
      res.json(images.rewriteMeta(meta, true));
    } catch (error) {
      if (disconnect.signal.aborted) return;
      throw error;
    } finally {
      disconnect.dispose();
    }
  }));
  app.get("/api/meta/:type/:id/extras", asyncRoute(async (req, res) => {
    const language = normalizeLanguage(String(req.query.language ?? "")) ?? prefsOf(req).uiLanguage;
    const disconnect = routeDisconnectSignal(req, res);
    try {
      if (disconnect.signal.aborted) return;
      const type = String(req.params.type);
      const id = String(req.params.id);
      const viewer = viewerOf(currentUser(req));
      const apiKey = store.settings().tmdbApiKey;
      const extras = await titleExtras(type, id, language, {
        ...(apiKey ? { tmdb: { apiKey, language } } : {}),
        meta: () => cachedMeta(type, id, language, viewer, { artwork: true, signal: disconnect.signal }),
        copies: (copyType, copyId) =>
          viewer ? localCopies(copyType, copyId, viewer) : Promise.resolve([]),
        signal: disconnect.signal,
      });
      if (disconnect.signal.aborted) return;
      res.json(imageProxy.rewriteExtras(extras));
    } catch (error) {
      if (disconnect.signal.aborted) return;
      throw error;
    } finally {
      disconnect.dispose();
    }
  }));
  app.get("/api/library/trailer", asyncRoute(async (req, res) => {
    const disconnect = routeDisconnectSignal(req, res);
    try {
      const language = normalizeLanguage(String(req.query.language ?? "")) ?? prefsOf(req).uiLanguage;
      const viewer = viewerOf(currentUser(req));
      const raw = String(req.query.path ?? "").trim();
      const key = raw ? boundKey(raw, viewer) : undefined;
      const entry = key ? knownTitleEntry(key, metaStore.qualifiedMeta()) : undefined;
      if (disconnect.signal.aborted) return;
      const trailer = entry ? await titleTrailer(entry.record.type, entry.record.id, language, viewer, disconnect.signal) : null;
      if (disconnect.signal.aborted) return;
      res.json({ trailer });
    } catch (error) {
      if (disconnect.signal.aborted) return;
      throw error;
    } finally {
      disconnect.dispose();
    }
  }));
  app.get("/api/trailer/:type/:id", asyncRoute(async (req, res) => {
    const disconnect = routeDisconnectSignal(req, res);
    try {
      const language = normalizeLanguage(String(req.query.language ?? "")) ?? prefsOf(req).uiLanguage;
      const trailer = await titleTrailer(
        String(req.params.type),
        String(req.params.id),
        language,
        viewerOf(currentUser(req)),
        disconnect.signal,
      );
      if (disconnect.signal.aborted) return;
      res.json({ trailer });
    } catch (error) {
      if (disconnect.signal.aborted) return;
      throw error;
    } finally {
      disconnect.dispose();
    }
  }));
  /** The same row for a folder that is bound to a title. A path with no binding asks
   *  Wikidata nothing and answers no links. */
  app.get("/api/library/links", asyncRoute(async (req, res) => {
    const disconnect = routeDisconnectSignal(req, res);
    try {
      const language = normalizeLanguage(String(req.query.language ?? "")) ?? prefsOf(req).uiLanguage;
      const raw = String(req.query.path ?? "").trim();
      const key = raw ? boundKey(raw, viewerOf(currentUser(req))) : undefined;
      const entry = key ? knownTitleEntry(key, metaStore.qualifiedMeta()) : undefined;
      if (!entry) return res.json({ links: [] });
      const ids = (await externalIds.ids(entry.record.id, disconnect.signal)) ?? {};
      if (disconnect.signal.aborted) return;
      res.json({ links: siteLinks(entry.record.type, entry.record.id, ids, language) });
    } catch (error) {
      if (disconnect.signal.aborted) return;
      throw error;
    } finally {
      disconnect.dispose();
    }
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
    const disconnect = routeDisconnectSignal(req, res);
    try {
      const id = String(req.params.id);
      const language = normalizeLanguage(String(req.query.language ?? "")) ?? prefsOf(req).uiLanguage;
      const imdbId = imdbOf(id);
      const ids = imdbId ? await externalIds.ids(imdbId, disconnect.signal) : {};
      if (disconnect.signal.aborted) return;
      res.json({ links: siteLinks(String(req.params.type), id, ids ?? {}, language) });
    } catch (error) {
      if (disconnect.signal.aborted) return;
      throw error;
    } finally {
      disconnect.dispose();
    }
  }));
  /** Opaque id in, cached bytes out. An id we never handed out means nothing here. The id is a
   *  hash of the address, not of the bytes, so it stays a day rather than a year: the bytes may
   *  be replaced under the same id. */
  app.get("/api/image/:id", asyncRoute(async (req, res) => {
    const disconnect = routeDisconnectSignal(req, res);
    try {
      if (disconnect.signal.aborted) return;
      const id = String(req.params.id);
      const cached = await imageProxy.fetch(id, disconnect.signal);
      if (disconnect.signal.aborted) return;
      if (!cached) return res.status(404).end();
      const surface = imageSurface(req.query.surface, "catalog");
      const asked = askedSurface(req.query.surface);
      const cache = "private, max-age=86400";
      res.setHeader("content-type", cached.type);
      if (cached.type === "image/svg+xml") res.setHeader("content-security-policy", SVG_CONTENT_SECURITY_POLICY);
      res.setHeader("etag", cached.etag);
      res.setHeader("cache-control", cache);
      if (req.headers["if-none-match"] === cached.etag) {
        imageProxy.takeFetched(id);
        logPoster({ kind: "catalog", surface, asked, status: 304, bytes: 0, cache });
        return res.status(304).end();
      }
      // The bytes come from memory when they are already there, and from one read otherwise;
      // sendFile would refuse a data directory that sits inside a dotted folder.
      const warm = imageProxy.inMemory(id);
      const bytes = await imageProxy.readCached(id, disconnect.signal);
      if (disconnect.signal.aborted) return;
      if (!bytes) {
        imageProxy.takeFetched(id);
        return res.status(404).end();
      }
      const from = imageProxy.takeFetched(id) ? "upstream" : warm ? "memory" : "disk";
      noteImage(surface, from);
      logPoster({ kind: "catalog", surface, asked, from, status: 200, bytes: bytes.length, cache });
      res.end(bytes);
    } catch (error) {
      if (disconnect.signal.aborted) return;
      throw error;
    } finally {
      disconnect.dispose();
    }
  }));
  app.get("/api/stream-sources/:type/:id", asyncRoute(async (req, res) => {
    // The picker lists these in the caller's own order, the same one `GET /api/addons` answers.
    const candidates = await streamCandidates(inOrder(req), String(req.params.type), String(req.params.id), true);
    res.json(candidates.map(({ addon }) => ({ key: addon.key, name: addon.manifest.name })));
  }));
  app.get("/api/streams/:type/:id", asyncRoute(async (req, res) => {
    const disconnect = routeDisconnectSignal(req, res);
    try {
      if (disconnect.signal.aborted) return;
      const owner = ownerOf(req);
      const type = String(req.params.type);
      const id = String(req.params.id);
      const snapshots = rulesFor(req, type);
      const parentId = type === "series" ? /^(.+):\d+:\d+$/.exec(id)?.[1] ?? id : id;
      const titleMeta = snapshots.length
        ? cachedMeta(
            type,
            parentId,
            prefsOf(req).uiLanguage,
            viewerOf(currentUser(req)),
            { signal: disconnect.signal },
          ).catch(() => null)
        : Promise.resolve(null);
      const items = await streams(inOrder(req), type, id, req.query.addon ? String(req.query.addon) : undefined, true, disconnect.signal);
      if (disconnect.signal.aborted) return;
      // The listing hands out one resource per source, and the addons that answered took as
      // long as they liked: an addon switched off, or a grant withdrawn, while they were
      // answering must not get one. Nothing is awaited between the check and the listing.
      for (const addonKey of new Set(items.map((item) => item.addonKey).filter((key): key is string => Boolean(key)))) {
        requireAccess(req, { addonKey });
      }
      if (disconnect.signal.aborted) return;
      const metaLanguage = titleLanguage((await titleMeta)?.language);
      const candidates = items.map((stream, providerResponseIndex) => {
        const addonKey = stream.addonKey;
        if (typeof addonKey !== "string" || addonKey.length === 0) return undefined;
        return listedAddonSourceEvidence({
          providerKey: `addon:${addonKey}`,
          stream,
          providerResponseIndex,
          available: true,
          ...(deps.debridReady === undefined ? {} : { debridReady: deps.debridReady }),
          ...(metaLanguage === undefined ? {} : { titleLanguage: metaLanguage }),
        });
      });
      const verdicts = ruleVerdictsForProfiles(snapshots, candidates.filter((candidate) => candidate !== undefined));
      const videoFacts = new Map(candidates.flatMap((candidate) => {
        if (candidate === undefined) return [];
        const facts = sourceVideoFacts(candidate);
        return facts === undefined ? [] : [[candidate.sourceId, facts] as const];
      }));
      const listed = mediaResources.listing(items, owner);
      res.setHeader("cache-control", "private, no-store").json(listed.map((stream, index) => {
        const candidate = candidates[index];
        const verdict = candidate === undefined ? undefined : verdicts.get(candidate.sourceId);
        const facts = candidate === undefined ? undefined : videoFacts.get(candidate.sourceId);
        return {
          ...stream,
          ...(verdict === undefined ? {} : { rules: verdict }),
          ...(facts === undefined ? {} : { videoFacts: facts }),
        };
      }));
    } catch (error) {
      if (disconnect.signal.aborted) return;
      throw error;
    } finally {
      disconnect.dispose();
    }
  }));
  app.get("/api/local-streams/:type/:id", asyncRoute(async (req, res) => {
    const viewer = viewerOf(currentUser(req));
    const owner = ownerOf(req);
    const type = String(req.params.type);
    const id = String(req.params.id);
    let copies = await localCopies(type, id, viewer);
    if (!copies.length) {
      const fallbackId = await subtitleTarget(inOrder(req), type, id, true);
      if (fallbackId && fallbackId !== id) copies = await localCopies(type, fallbackId, viewer);
    }
    // A grant withdrawn while the walk was being read must not get a resource, the same way
    // the addon listing re-checks. Nothing is awaited between the check and the listing.
    for (const libraryId of new Set(copies.map((copy) => copy.libraryId))) requireAccess(req, { libraryId });
    const listed = mediaResources.listing(copies.map((copy) => ({
      url: `file://${copy.key}`,
      behaviorHints: { filename: posixBase(copy.key), videoSize: copy.size },
    })), owner);
    // The listing redacts long path segments as if they were an addon's secrets; the name of the
    // viewer's own file is not one, and it is what the row shows.
    const snapshots = rulesFor(req, String(req.params.type));
    const candidates = copies.map((copy, index) => listedLocalCopyEvidence(copy, index, posixBase(copy.key)));
    const verdicts = ruleVerdictsForProfiles(snapshots, candidates);
    const videoFacts = new Map(candidates.flatMap((candidate) => {
      const facts = sourceVideoFacts(candidate);
      return facts === undefined ? [] : [[candidate.sourceId, facts] as const];
    }));
    res.setHeader("cache-control", "private, no-store").json(listed.map((stream, index) => {
      const verdict = verdicts.get(candidates[index]!.sourceId);
      const facts = videoFacts.get(candidates[index]!.sourceId);
      return {
        ...stream, behaviorHints: { ...stream.behaviorHints, filename: posixBase(copies[index]!.key) },
        localPath: copies[index]!.path, libraryId: copies[index]!.libraryId,
        libraryName: copies[index]!.libraryName,
        ...(verdict === undefined ? {} : { rules: verdict }),
        ...(facts === undefined ? {} : { videoFacts: facts }),
      };
    }));
  }));
  app.get("/api/subtitles/:type/:id", asyncRoute(async (req, res) => {
    const disconnect = routeDisconnectSignal(req, res);
    try {
      if (disconnect.signal.aborted) return;
      const owner = ownerOf(req);
      const items = await subtitles(inOrder(req), String(req.params.type), String(req.params.id), true, disconnect.signal);
      if (disconnect.signal.aborted) return;
      // Per addon, the way the stream listing does it: a bare re-check never reaches the
      // addon, so a grant withdrawn while the addon was answering would still be listed --
      // language, addon name and an issued id for a source the account may no longer use.
      for (const addonKey of new Set(items.map((item) => item.addonKey).filter((key): key is string => Boolean(key)))) {
        requireAccess(req, { addonKey });
      }
      if (disconnect.signal.aborted) return;
      // The addon travels with the resource. Without it the record names no content, so the
      // sweep that runs when an addon is removed or taken away cannot recognise it, and the
      // subtitle keeps being served from an addon the account may no longer use.
      res.setHeader("cache-control", "private, no-store").json(items.map((item) => ({
        subtitleId: mediaResources.add({ url: item.url, addonKey: item.addonKey }, owner, "subtitle"),
        lang: safeSourceText(item.lang, { url: item.url }), addonName: safeSourceText(item.addonName, { url: item.url }),
      })));
    } catch (error) {
      if (disconnect.signal.aborted) return;
      throw error;
    } finally {
      disconnect.dispose();
    }
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
      let text = subtitleVtt(asset.bytes, subtitleLanguage(req.query.lang));
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
      let text = subtitleVtt(await readFile(target), subtitleLanguage(req.query.lang));
      // Shifted like an addon's: the player asks with the same offset and delay for both.
      const shift = (Number(req.query.offset) || 0) - subtitleDelay(req.query.delay);
      if (shift) text = shiftVtt(text, shift);
      return void res.type("text/vtt; charset=utf-8").setHeader("x-content-type-options", "nosniff").send(text);
    }
    const disconnect = routeDisconnectSignal(req, res);
    try {
      if (disconnect.signal.aborted) return;
      const downloaded = await guardedBody<Buffer | null>(
        raw,
        {},
        async (response, signal) => {
          if (!response.ok) {
            cancelResponseBody(response);
            return null;
          }
          return readMediaBytes(response, SUBTITLE_MAX_BYTES, signal);
        },
        { signal: disconnect.signal, deadlineMs: SUBTITLE_DEADLINE_MS },
      );
      if (downloaded === null) throw new Error("Subtitle source unavailable.");
      let text = subtitleVtt(downloaded, subtitleLanguage(req.query.lang));
      const shift = (Number(req.query.offset) || 0) - subtitleDelay(req.query.delay);
      if (shift) text = shiftVtt(text, shift);
      requireAccess(req, { addonKey: resource.stream.addonKey });
      mediaResources.get(resource.id, owner.sid, "subtitle");
      if (disconnect.signal.aborted || res.destroyed || res.writableEnded) return;
      res.type("text/vtt; charset=utf-8")
        .setHeader("cache-control", "private, no-store")
        .setHeader("x-content-type-options", "nosniff")
        .send(text);
    } catch (error) {
      if (disconnect.signal.aborted) return;
      throw error;
    } finally {
      disconnect.dispose();
    }
  }));
}
