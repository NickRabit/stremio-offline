import { AppError } from "./errors.js";
import { createHash, randomUUID } from "node:crypto";
import type { Viewer } from "./libraries.js";
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

/** May this account use this addon? An administrator may use every addon,
 *  including ones nobody has been granted -- but never a disabled one: the
 *  `enabled` switch is enforced by the helpers below (`searchableCatalogs`,
 *  `streamCandidates`, `metadata`, `subtitles`), which drop a disabled addon
 *  before its audience is considered. */
export const addonAllowed = (addon: AddonRecord, viewer: Viewer): boolean =>
  viewer.role === "admin" || (addon.allowedUsers ?? []).includes(viewer.id);

export const allowedAddons = (addons: AddonRecord[], viewer: Viewer): AddonRecord[] =>
  addons.filter((addon) => addonAllowed(addon, viewer));

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
export async function addonMetadata(addon: AddonRecord, type: string, id: string): Promise<MetaItem | null> {
  if (!addon.enabled || addon.role === "source" || !supports(addon, "meta", type, id)) return null;
  const response = await jsonFetch<{ meta?: MetaItem }>(resourceUrl(addon, "meta", type, id));
  if (!response.meta) return null;
  const language = addonMetadataLanguage(addon);
  return { ...response.meta, ...(language ? { nameLanguage: language } : {}) };
}

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
      const meta = await addonMetadata(addon, type, id);
      if (!meta) continue;
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
