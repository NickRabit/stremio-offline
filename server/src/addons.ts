import { AppError } from "./errors.js";
import { createHash, randomUUID } from "node:crypto";
import type { AddonRecord, AddonRole, CatalogDefinition, MetaItem, StremioManifest, StreamItem, SubtitleItem } from "./types.js";
import { validateRemoteUrl } from "./security.js";
import { guardedFetch } from "./outbound.js";
import { defaultDownloadSettings } from "./naming.js";
import { log } from "./logger.js";
import { normalizeLanguage } from "./language.js";

const reasonOf = (error: unknown) => error instanceof Error ? error.message : String(error);

const TIMEOUT_MS = 12_000;
const STREAM_TIMEOUT_MS = Number(process.env.STREAM_ADDON_TIMEOUT_MS ?? 60_000);

async function jsonFetch<T>(rawUrl: string, timeoutMs = TIMEOUT_MS): Promise<T> {
  const url = await validateRemoteUrl(rawUrl);
  const response = await guardedFetch(url.toString(), {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json", "user-agent": "StremioOffline/0.3.1" },
  });
  if (!response.ok) throw new Error(`The addon answered HTTP ${response.status}.`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) throw new AppError("The addon did not return JSON.", "err.addonNotJson");
  return response.json() as Promise<T>;
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
    addedAt: new Date().toISOString(), manifest, downloadSettings: defaultDownloadSettings(),
  };
}

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

export async function catalog(addon: AddonRecord, type: string, catalogId: string, search?: string, skip = 0, genre?: string) {
  const extras: Record<string, string | number> = {};
  if (search) extras.search = search;
  if (genre) extras.genre = genre;
  if (skip) extras.skip = skip;
  const response = await jsonFetch<{ metas?: MetaItem[] }>(resourceUrl(addon, "catalog", type, catalogId, extras));
  return response.metas ?? [];
}

/** Addons declare extras support in three different ways; the protocol changed over time. */
function declaresExtra(definition: CatalogDefinition, name: string): boolean {
  if (definition.extra?.some((item) => item.name === name)) return true;
  return Array.isArray(definition.extraSupported) && definition.extraSupported.includes(name);
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

/** Every source returns batches of a different size, so each carries its own offset. A shared
 *  number would skip items nobody has seen yet in the smaller catalogues. -1 means exhausted. */
const decodeCursor = (cursor?: string): Record<string, number> => {
  if (!cursor) return {};
  try { return JSON.parse(Buffer.from(cursor, "base64url").toString()) as Record<string, number>; }
  catch { return {}; }
};
const encodeCursor = (offsets: Record<string, number>) => Buffer.from(JSON.stringify(offsets)).toString("base64url");

/** Stremio asks every addon at once; one slow or broken addon must not bring the rest down. */
export async function searchAll(addons: AddonRecord[], query: string, type: string | undefined, cursor?: string, scope?: SearchScope): Promise<SearchResult> {
  const targets = searchableCatalogs(addons, type, scope);
  const offsets = decodeCursor(cursor);
  const nextOffsets: Record<string, number> = {};

  const settled = await Promise.allSettled(targets.map(async ({ addon, definition }) => {
    const key = `${addon.key}:${definition.type}:${definition.id}`;
    const from = offsets[key] ?? 0;
    if (from < 0) return { key, from, metas: [] as MetaItem[] };
    const metas = await catalog(addon, definition.type, definition.id, query, from);
    return { key, from, metas: metas.map((meta) => ({ ...meta, type: meta.type || definition.type, addonName: addon.manifest.name })) };
  }));

  const seen = new Map<string, MetaItem>();
  settled.forEach((result, index) => {
    const { addon, definition } = targets[index];
    const key = `${addon.key}:${definition.type}:${definition.id}`;
    if (result.status === "rejected") {
      log("WARN", "Addon request failed", { operation: "search", addon: addon.manifest.name, catalog: definition.id, query, reason: reasonOf(result.reason) });
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

function fillMissingMeta(base: MetaItem, extra: MetaItem): MetaItem {
  return {
    ...base,
    ...(!base.description && extra.description ? { description: extra.description } : {}),
    ...(!base.poster && extra.poster ? { poster: extra.poster } : {}),
    ...(!base.background && extra.background ? { background: extra.background } : {}),
    ...(base.year == null && extra.year != null ? { year: extra.year } : {}),
    ...(!base.releaseInfo && extra.releaseInfo ? { releaseInfo: extra.releaseInfo } : {}),
    ...(!base.genres?.length && extra.genres?.length ? { genres: extra.genres } : {}),
    ...(!base.videos?.length && extra.videos?.length ? { videos: extra.videos } : {}),
    ...(base.runtime == null && extra.runtime != null ? { runtime: extra.runtime } : {}),
  };
}

export type MetaProvider = (type: string, id: string) => Promise<MetaItem | null>;

export async function metadata(addons: AddonRecord[], type: string, id: string, preferredLanguage?: string, provider?: MetaProvider) {
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
      const response = await jsonFetch<{ meta?: MetaItem }>(resourceUrl(addon, "meta", type, id));
      if (!response.meta) continue;
      const language = addonMetadataLanguage(addon);
      const meta = { ...response.meta, ...(language ? { nameLanguage: language } : {}) };
      best = best ? fillMissingMeta(best, meta) : meta;
      if (best.description && (type !== "series" || (best.videos?.length ?? 0) > 0)) return best;
    } catch { /* try next metadata provider */ }
  }
  return best;
}

/** The addons that can return streams for this title. The client then asks them one by one. */
export function streamCandidates(addons: AddonRecord[], type: string, id: string) {
  return addons.filter((a) => a.enabled && a.role !== "catalog" && supports(a, "stream", type, id));
}

export async function streams(addons: AddonRecord[], type: string, id: string, addonKey?: string): Promise<StreamItem[]> {
  const candidates = streamCandidates(addons, type, id).filter((a) => !addonKey || a.key === addonKey);
  const results = await Promise.allSettled(candidates.map(async (addon) => {
    const response = await jsonFetch<{ streams?: StreamItem[] }>(resourceUrl(addon, "stream", type, id), STREAM_TIMEOUT_MS);
    return (response.streams ?? []).map((stream) => ({ ...stream, addonKey: addon.key, addonName: addon.manifest.name }));
  }));
  results.forEach((result, index) => {
    if (result.status === "rejected") log("WARN", "Addon request failed", { operation: "streams", addon: candidates[index].manifest.name, type, id, reason: reasonOf(result.reason) });
  });
  return results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
}

export async function subtitles(addons: AddonRecord[], type: string, id: string): Promise<SubtitleItem[]> {
  const candidates = addons.filter((a) => a.enabled && supports(a, "subtitles", type, id));
  const results = await Promise.allSettled(candidates.map(async (addon) => {
    const response = await jsonFetch<{ subtitles?: SubtitleItem[] }>(resourceUrl(addon, "subtitles", type, id));
    return (response.subtitles ?? []).map((subtitle) => ({ ...subtitle, addonName: addon.manifest.name }));
  }));
  results.forEach((result, index) => {
    if (result.status === "rejected") log("WARN", "Addon request failed", { operation: "subtitles", addon: candidates[index].manifest.name, type, id, reason: reasonOf(result.reason) });
  });
  return results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
}

export function streamToken(stream: StreamItem): string {
  return createHash("sha256").update(JSON.stringify(stream)).digest("hex").slice(0, 32);
}
