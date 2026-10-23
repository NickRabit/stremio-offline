import { AppError } from "./errors.js";
import { createHash, randomUUID } from "node:crypto";
import type { Viewer } from "./libraries.js";
import type { AddonRecord, AddonRole, CatalogDefinition, MetaItem, StremioManifest, StreamItem, SubtitleItem } from "./types.js";
import { validateRemoteUrl } from "./security.js";
import { GuardRejection, OutboundError, guardedJson } from "./outbound.js";
import { defaultDownloadSettings } from "./naming.js";
import { log } from "./logger.js";
import { normalizeLanguage } from "./language.js";
import { imdbOf } from "./external-ids.js";

const reasonOf = (error: unknown) => error instanceof Error ? error.message : String(error);

const TIMEOUT_MS = 12_000;
export const SEARCH_TIMEOUT_MS = 12_000;
export const CATALOG_MAX_BYTES = 8 * 1024 * 1024;
const STREAM_TIMEOUT_MS = Number(process.env.STREAM_ADDON_TIMEOUT_MS ?? 60_000);
/** Far past any real manifest, stream list or long series' metadata; an addon sending more is
 *  broken, and reading it whole would only fill the server's memory for the length of the timeout. */
const ADDON_MAX_BYTES = 16 * 1024 * 1024;

async function jsonFetch<T>(rawUrl: string, timeoutMs = TIMEOUT_MS, interactive = false, signal?: AbortSignal): Promise<T> {
  const url = await validateRemoteUrl(rawUrl);
  try {
    return await guardedJson<T>(url.toString(), {
      headers: { accept: "application/json", "user-agent": "StremioOffline/0.3.1" },
    }, {
      signal,
      deadlineMs: timeoutMs,
      maxBytes: ADDON_MAX_BYTES,
      interactive,
    });
  } catch (error) {
    if (!(error instanceof OutboundError)) throw error;
    if (error.code === "invalid-json") throw new AppError("The addon did not return JSON.", "err.addonNotJson");
    if (error.code === "too-large") throw new Error(`The addon answered with more than ${Math.round(ADDON_MAX_BYTES / (1024 * 1024))} MB.`);
    const status = /^http-(\d+)$/.exec(error.code)?.[1];
    if (status) throw new Error(`The addon answered HTTP ${status}.`);
    throw error;
  }
}

export async function loadAddon(rawUrl: string, role: AddonRole): Promise<AddonRecord> {
  const url = await validateRemoteUrl(rawUrl);
  if (!url.pathname.endsWith("/manifest.json") && url.pathname !== "/manifest.json") {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/manifest.json`;
  }
  const manifest = await jsonFetch<StremioManifest>(url.toString());
  if (!manifest.id || !manifest.name || !manifest.version) throw new AppError("The manifest is missing id, name or version.", "err.manifestIncomplete");
  return {
    key: randomUUID(), manifestUrl: url.toString(), role, enabled: true, globalSearch: true, showInContinueWatching: true,
    showOnHome: true,
    addedAt: new Date().toISOString(), manifest, downloadSettings: defaultDownloadSettings(),
  };
}

/** May this account use this addon? An administrator may use every addon,
 *  including ones nobody has been granted -- but never a disabled one: the
 *  `enabled` switch is enforced by the helpers below (`searchableCatalogs`,
 *  `streamCandidates`, `metadata`, `subtitles`), which drop a disabled addon
 *  before its audience is considered. */
export const addonAllowed = (addon: AddonRecord, viewer: Viewer): boolean =>
  viewer.role === "admin" || (addon.allowedUsers ?? []).includes(viewer.id);

export const allowedAddons = (addons: AddonRecord[], viewer: Viewer): AddonRecord[] =>
  addons.filter((addon) => addonAllowed(addon, viewer));

/** The order one account reads its addons in: its own, and only if it is an ordinary account.
 *  An administrator reads the instance order, because that is the one their arrows edit --
 *  showing them a personal overlay while the note says "this applies to everybody" would be a
 *  lie, and reordering from that view would scramble the global list. An order kept from
 *  before a promotion stays stored and is simply not applied. */
export const orderFor = (
  user: { id: string; role: string } | undefined,
  stored: (id: string) => string[] | undefined,
): string[] | undefined => (user && user.role !== "admin" ? stored(user.id) : undefined);

/** The addons this account sees, in the order it prefers them. Unknown keys
 *  are dropped and unlisted addons follow in the instance's own order, so a
 *  personal list never has to be repaired when the instance changes. */
export const orderedForUser = (addons: AddonRecord[], order: string[] | undefined): AddonRecord[] => {
  if (!order?.length) return addons;
  const present = new Set(addons.map((addon) => addon.key));
  const rank = new Map<string, number>();
  for (const key of order) if (present.has(key) && !rank.has(key)) rank.set(key, rank.size);
  if (!rank.size) return addons;
  // `sort` is stable, so the addons no list names keep the instance's own order.
  return [...addons].sort((a, b) => (rank.get(a.key) ?? rank.size) - (rank.get(b.key) ?? rank.size));
};

function baseUrl(addon: AddonRecord): URL { return new URL("./", addon.manifestUrl); }

export function addonMetadataLanguage(addon: AddonRecord): string | undefined {
  if (addon.manifest.id === "com.linvo.cinemeta") return "en";
  const url = new URL(addon.manifestUrl);
  for (const value of [url.searchParams.get("language"), url.searchParams.get("lang")]) {
    const language = normalizeLanguage(value ?? undefined);
    if (language) return language;
  }
  for (const segment of url.pathname.split("/")) {
    try {
      const config = JSON.parse(decodeURIComponent(segment)) as Record<string, unknown>;
      const language = normalizeLanguage(typeof config.language === "string" ? config.language : undefined);
      if (language) return language;
    } catch { /* not a JSON configuration segment */ }
  }
  return undefined;
}
function resourceUrl(addon: AddonRecord, resource: string, type: string, id: string, extras?: Record<string, string | number>) {
  const base = baseUrl(addon);
  const parts = [resource, encodeURIComponent(type), encodeURIComponent(id)];
  if (extras && Object.keys(extras).length) {
    parts.push(Object.entries(extras).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&"));
  }
  return new URL(`${parts.join("/")}.json`, base).toString();
}

function supports(addon: AddonRecord, resource: string, type: string, id?: string): boolean {
  const declared = addon.manifest.resources ?? [];
  const match = declared.find((entry) => typeof entry === "string" ? entry === resource : entry.name === resource);
  if (!match) return false;
  if (typeof match !== "string" && match.types?.length && !match.types.includes(type)) return false;
  const prefixes = typeof match !== "string" ? match.idPrefixes : addon.manifest.idPrefixes;
  return !id || !prefixes?.length || prefixes.some((prefix) => id.startsWith(prefix));
}

export async function catalogWithExtras(
  addon: AddonRecord,
  type: string,
  catalogId: string,
  extras: Record<string, string | number> = {},
  interactive = false,
  signal?: AbortSignal,
) {
  const response = await jsonFetch<{ metas?: MetaItem[] }>(resourceUrl(addon, "catalog", type, catalogId, extras), TIMEOUT_MS, interactive, signal);
  return response.metas ?? [];
}

export async function catalog(
  addon: AddonRecord,
  type: string,
  catalogId: string,
  search?: string,
  skip = 0,
  genre?: string,
  interactive = false,
  signal?: AbortSignal,
) {
  const extras: Record<string, string | number> = {};
  if (search) extras.search = search;
  if (genre) extras.genre = genre;
  if (skip) extras.skip = skip;
  return catalogWithExtras(addon, type, catalogId, extras, interactive, signal);
}

/** Addons declare extras support in three different ways; the protocol changed over time. */
function declaresExtra(definition: CatalogDefinition, name: string): boolean {
  if (definition.extra?.some((item) => item.name === name)) return true;
  return Array.isArray(definition.extraSupported) && definition.extraSupported.includes(name);
}

export function supportsSkip(definition: CatalogDefinition): boolean {
  return declaresExtra(definition, "skip");
}

function requiredExtras(definition: CatalogDefinition): string[] {
  const fromExtra = (definition.extra ?? []).filter((item) => item.isRequired).map((item) => item.name);
  return [...new Set([...fromExtra, ...(definition.extraRequired ?? [])])];
}

/** Catalogues worth querying: they support search and demand nothing we cannot supply. */
export interface SearchScope {
  addonKey?: string;
  catalogType?: string;
  catalogId?: string;
  respectGlobalSearch?: boolean;
}

export function searchableCatalogs(addons: AddonRecord[], type?: string, scope?: SearchScope) {
  return addons.filter((addon) =>
    addon.enabled
    && addon.role !== "source"
    && (!scope?.addonKey || addon.key === scope.addonKey)
    && (!scope?.respectGlobalSearch || scope.addonKey || addon.globalSearch !== false))
    .flatMap((addon) =>
    (addon.manifest.catalogs ?? [])
      .filter((definition) => (!type || definition.type === type) && declaresExtra(definition, "search"))
      .filter((definition) => !scope?.catalogId || (definition.id === scope.catalogId && (!scope.catalogType || definition.type === scope.catalogType)))
      .filter((definition) => requiredExtras(definition).every((name) => name === "search"))
      .map((definition) => ({ addon, definition })));
}

export interface SearchResult { items: MetaItem[]; cursor: string; hasMore: boolean; sources: number }

export interface CatalogTarget { addon: AddonRecord; definition: CatalogDefinition }

export const catalogTargetKey = (target: CatalogTarget) =>
  `${target.addon.key}:${target.definition.type}:${target.definition.id}`;

const invalidCatalogUrls = new WeakSet<object>();

export async function fetchCatalogPage(target: CatalogTarget, query: string, skip: number, options?: {
  signal?: AbortSignal; key?: string; interactive?: boolean;
}): Promise<MetaItem[]> {
  const { addon, definition } = target;
  const extras: Record<string, string | number> = {};
  if (query) extras.search = query;
  if (skip > 0) extras.skip = skip;
  const raw = resourceUrl(addon, "catalog", definition.type, definition.id, extras);
  let url: URL;
  try {
    url = await validateRemoteUrl(raw);
  } catch (error) {
    if (typeof error === "object" && error !== null) invalidCatalogUrls.add(error);
    throw error;
  }
  const payload = await guardedJson<{ metas?: MetaItem[] }>(url.toString(), {
    headers: { accept: "application/json", "user-agent": "StremioOffline/0.3.1" },
  }, {
    signal: options?.signal,
    key: options?.key,
    interactive: options?.interactive,
    deadlineMs: SEARCH_TIMEOUT_MS,
    maxBytes: CATALOG_MAX_BYTES,
  });
  const metas = Array.isArray(payload?.metas) ? payload.metas : [];
  return metas.map((meta) => ({ ...meta, type: meta.type || definition.type }));
}

/** Every source returns batches of a different size, so each carries its own offset. A shared
 *  number would skip items nobody has seen yet in the smaller catalogues. -1 means exhausted. */
const decodeCursor = (cursor?: string): Record<string, number> => {
  if (!cursor) return {};
  try { return JSON.parse(Buffer.from(cursor, "base64url").toString()) as Record<string, number>; }
  catch { return {}; }
};
const encodeCursor = (offsets: Record<string, number>) => Buffer.from(JSON.stringify(offsets)).toString("base64url");

/** Stremio asks every addon at once; one slow or broken addon must not bring the rest down. */
export async function searchAll(addons: AddonRecord[], query: string, type: string | undefined, cursor?: string, scope?: SearchScope, interactive = false,
  options?: { signal?: AbortSignal; key?: string }): Promise<SearchResult> {
  const targets = searchableCatalogs(addons, type, scope);
  const offsets = decodeCursor(cursor);
  const nextOffsets: Record<string, number> = {};

  const settled = await Promise.allSettled(targets.map(async (target) => {
    const { addon, definition } = target;
    const key = catalogTargetKey(target);
    const from = offsets[key] ?? 0;
    if (from < 0) return { key, from, metas: [] as MetaItem[] };
    const metas = await fetchCatalogPage(target, query, from, { interactive, signal: options?.signal, key: options?.key });
    return { key, from, metas: metas.map((meta) => ({ ...meta, type: meta.type || definition.type, addonName: addon.manifest.name })) };
  }));

  const seen = new Map<string, MetaItem>();
  settled.forEach((result, index) => {
    const { addon, definition } = targets[index];
    const key = catalogTargetKey(targets[index]);
    if (result.status === "rejected") {
      const reason = result.reason;
      const code = reason instanceof OutboundError ? reason.code
        : reason instanceof GuardRejection ? "breaker-open"
        : typeof reason === "object" && reason !== null && invalidCatalogUrls.has(reason) ? "invalid-url"
        : "error";
      log("WARN", "Addon request failed", { operation: "search", addon: addon.manifest.name, catalog: definition.id, reason: code });
      nextOffsets[key] = -1;
      return;
    }
    const { from, metas } = result.value;
    nextOffsets[key] = metas.length ? from + metas.length : -1;
    for (const meta of metas) {
      const id = `${meta.type}:${meta.id}`;
      const existing = seen.get(id);
      if (existing) { const sources = (existing.sources as string[]) ?? []; if (!sources.includes(String(meta.addonName))) sources.push(String(meta.addonName)); existing.sources = sources; }
      else seen.set(id, { ...meta, sources: [String(meta.addonName)] });
    }
  });

  return {
    items: [...seen.values()],
    cursor: encodeCursor(nextOffsets),
    hasMore: Object.values(nextOffsets).some((offset) => offset >= 0),
    sources: targets.length,
  };
}

/** An empty string, an empty array and null all mean "this answer did not carry it". */
const carries = (value: unknown) =>
  value != null && value !== "" && !(Array.isArray(value) && value.length === 0);

/** Everything `base` does not carry, taken from `extra`. Naming the fields instead would
 *  quietly drop every other one an addon answers with -- the IMDb rating, the cast, the
 *  logo -- which is what happened while this listed eight of them by hand. */
function fillMissingMeta(base: MetaItem, extra: MetaItem): MetaItem {
  const filled: MetaItem = { ...base };
  for (const [key, value] of Object.entries(extra)) if (!carries(filled[key]) && carries(value)) filled[key] = value;
  return filled;
}

export type MetaProvider = (type: string, id: string) => Promise<MetaItem | null>;

/** One metadata answer, kept public for focused consumers such as trailers that must not
 * use the aggregate's provider order. */
export async function addonMetadata(addon: AddonRecord, type: string, id: string, interactive = false): Promise<MetaItem | null> {
  if (!addon.enabled || addon.role === "source" || !supports(addon, "meta", type, id)) return null;
  const response = await jsonFetch<{ meta?: MetaItem }>(resourceUrl(addon, "meta", type, id), TIMEOUT_MS, interactive);
  if (!response.meta) return null;
  const language = addonMetadataLanguage(addon);
  return { ...response.meta, ...(language ? { nameLanguage: language } : {}) };
}

/** `requireArtwork` keeps the loop going past a description that carries no backdrop, so a
 *  later addon can supply one. Only the explicit detail request asks for it. */
export async function metadata(addons: AddonRecord[], type: string, id: string, preferredLanguage?: string, provider?: MetaProvider, interactive = false, requireArtwork = false) {
  let best: MetaItem | null = null;
  if (provider) {
    try { best = await provider(type, id); }
    catch { best = null; }
  }
  const candidates = addons.filter((a) => a.enabled && a.role !== "source" && supports(a, "meta", type, id));
  const ordered = preferredLanguage
    ? [...candidates.filter((addon) => addonMetadataLanguage(addon) === preferredLanguage), ...candidates.filter((addon) => addonMetadataLanguage(addon) !== preferredLanguage)]
    : candidates;
  for (const addon of ordered) {
    try {
      const meta = await addonMetadata(addon, type, id, interactive);
      if (!meta) continue;
      best = best ? fillMissingMeta(best, meta) : meta;
      if (best.description && (type !== "series" || (best.videos?.length ?? 0) > 0) && (!requireArtwork || Boolean(best.background))) return best;
    } catch { /* try next metadata provider */ }
  }
  return best;
}

/** The addons that can return streams for this title. The client then asks them one by one. */
export function streamCandidates(addons: AddonRecord[], type: string, id: string) {
  return addons.filter((a) => a.enabled && a.role !== "catalog" && supports(a, "stream", type, id));
}

export async function streams(
  addons: AddonRecord[],
  type: string,
  id: string,
  addonKey?: string,
  interactive = false,
  signal?: AbortSignal,
): Promise<StreamItem[]> {
  const candidates = streamCandidates(addons, type, id).filter((a) => !addonKey || a.key === addonKey);
  const results = await Promise.allSettled(candidates.map(async (addon) => {
    const response = await jsonFetch<{ streams?: StreamItem[] }>(resourceUrl(addon, "stream", type, id), STREAM_TIMEOUT_MS, interactive, signal);
    return (response.streams ?? []).map((stream) => ({ ...stream, addonKey: addon.key, addonName: addon.manifest.name }));
  }));
  if (signal?.aborted) return [];
  results.forEach((result, index) => {
    if (result.status === "rejected") log("WARN", "Addon request failed", { operation: "streams", addon: candidates[index].manifest.name, type, id, reason: reasonOf(result.reason) });
  });
  return results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
}

const IMDB_TARGET_TTL_MS = 6 * 60 * 60_000;
const imdbTargets = new Map<string, { imdb: string | null; at: number }>();

/** Test seam only: forgets the IMDb ids read from metadata. */
export function resetImdbTargets() { imdbTargets.clear(); }

/** The IMDb id a title of an addon with its own ids stands for: carried in the id itself
 *  (`mpa:webshare-index:tt2709692`) or named by the addon's metadata as `imdb_id`. */
async function imdbTitle(addons: AddonRecord[], type: string, id: string, interactive: boolean): Promise<string | null> {
  const carried = imdbOf(id);
  if (carried) return carried;
  const key = `${type}:${id}`;
  const cached = imdbTargets.get(key);
  if (cached && Date.now() - cached.at < IMDB_TARGET_TTL_MS) return cached.imdb;
  let imdb: string | null = null;
  for (const addon of addons.filter((a) => a.enabled && a.role !== "source" && supports(a, "meta", type, id))) {
    try {
      const meta = await addonMetadata(addon, type, id, interactive);
      const named = [meta?.imdb_id, meta?.id].find((value): value is string => typeof value === "string" && /^tt\d+$/.test(value));
      if (named) { imdb = named; break; }
    } catch { /* the next metadata addon may know it */ }
  }
  imdbTargets.set(key, { imdb, at: Date.now() });
  return imdb;
}

/** Subtitle addons such as OpenSubtitles accept IMDb ids only, so a title whose id they do not
 *  take is asked under its IMDb id instead, an episode keeping its season and episode. */
async function subtitleTarget(addons: AddonRecord[], type: string, id: string, interactive: boolean): Promise<string | null> {
  const episode = type === "series" ? /^(.+):(\d+):(\d+)$/.exec(id) : null;
  const title = episode ? episode[1]! : id;
  const imdb = await imdbTitle(addons, type, title, interactive);
  return imdb ? (episode ? `${imdb}:${episode[2]}:${episode[3]}` : imdb) : null;
}

export async function subtitles(addons: AddonRecord[], type: string, id: string, interactive = false): Promise<SubtitleItem[]> {
  const offered = addons.filter((a) => a.enabled && supports(a, "subtitles", type));
  let candidates = offered.filter((a) => supports(a, "subtitles", type, id));
  if (!candidates.length && offered.length) {
    const target = await subtitleTarget(addons, type, id, interactive);
    if (target) { id = target; candidates = offered.filter((a) => supports(a, "subtitles", type, id)); }
  }
  const results = await Promise.allSettled(candidates.map(async (addon) => {
    const response = await jsonFetch<{ subtitles?: SubtitleItem[] }>(resourceUrl(addon, "subtitles", type, id), TIMEOUT_MS, interactive);
    // The key as well as the name, the way a stream carries it: the name is for the person
    // choosing, the key is what a permission check and a revocation sweep match on.
    return (response.subtitles ?? []).map((subtitle) => ({ ...subtitle, addonKey: addon.key, addonName: addon.manifest.name }));
  }));
  results.forEach((result, index) => {
    if (result.status === "rejected") log("WARN", "Addon request failed", { operation: "subtitles", addon: candidates[index].manifest.name, type, id, reason: reasonOf(result.reason) });
  });
  return results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
}

export function streamToken(stream: StreamItem): string {
  return createHash("sha256").update(JSON.stringify(stream)).digest("hex").slice(0, 32);
}
