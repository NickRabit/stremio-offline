import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { INTERNAL_TOKEN } from "./auth.js";
import type { PublicStream, StreamItem } from "./types.js";

export interface ResourceOwner { sid: string; expiresAt: number }
export type ResourceScope = "source" | "media" | "subtitle";
interface Resource {
  id: string; owner: ResourceOwner; scope: ResourceScope; stream: StreamItem;
  expiresAt: number; parent?: string; bytes: number; key: string;
}
export class ResourceError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code === "RESOURCE_LIMIT" ? "Too many media resources. Try again later." : "Media resource expired or unavailable. Select the source again.");
  }
}

export function safeSourceText(value: unknown, stream: StreamItem): string | undefined {
  if (typeof value !== "string") return undefined;
  let text = value.slice(0, 4096);
  const secrets: string[] = [];
  for (const raw of [stream.url, stream.externalUrl, ...(stream.subtitles ?? []).map((item) => item.url)]) {
    if (!raw) continue;
    secrets.push(raw);
    try {
      const url = new URL(raw);
      secrets.push(url.host, ...url.pathname.split("/").filter((part) => part.length >= 8), ...url.searchParams.values());
    } catch { /* Invalid source addresses are never returned. */ }
  }
  for (const value of Object.values(stream.behaviorHints?.proxyHeaders?.request ?? {})) secrets.push(value, ...value.split(/\s+/));
  for (const secret of secrets.filter((item) => item.length >= 3).sort((a, b) => b.length - a.length)) {
    for (const form of [secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("base64url")]) {
      text = text.split(form).join("[redacted]");
    }
  }
  return text.replace(/(?:https?:\/\/|https?%3a%2f%2f|file:\/\/)\S+/gi, "[redacted]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

const INFO_HASH = /^(?:[a-f0-9]{40}|[a-z2-7]{32})$/i;
const MAGNET_HASH = /xt=urn:btih:([a-z0-9]+)/i;

export function infoHashOf(stream: StreamItem): string | undefined {
  const direct = typeof stream.infoHash === "string" ? stream.infoHash.trim() : "";
  if (INFO_HASH.test(direct)) return direct.toLowerCase();
  const fromMagnet = typeof stream.url === "string" ? MAGNET_HASH.exec(stream.url)?.[1] : undefined;
  return fromMagnet && INFO_HASH.test(fromMagnet) ? fromMagnet.toLowerCase() : undefined;
}

/** Playlist entries are sealed onto the parent instead of stored: a 2-hour HLS
 *  VOD would otherwise create thousands of media records, hit the cap (429),
 *  and 404 after a seek once the previous generation's ids were gone. AES-GCM
 *  keeps the origin URL off the client; a deterministic IV makes a rewrite stable. */
const mediaSealKey = () => Buffer.from(INTERNAL_TOKEN, "hex");

export function sealedMediaUrl(parentId: string, url: string): string {
  const iv = createHash("sha256").update(`${parentId}\0${url}`).digest().subarray(0, 12);
  const cipher = createCipheriv("aes-256-gcm", mediaSealKey(), iv);
  cipher.setAAD(Buffer.from(parentId));
  const enc = Buffer.concat([cipher.update(url, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64url");
}

export function openMediaUrl(parentId: string, token: string): string | undefined {
  try {
    const buf = Buffer.from(token, "base64url");
    if (buf.length < 29) return;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const decipher = createDecipheriv("aes-256-gcm", mediaSealKey(), iv);
    decipher.setAAD(Buffer.from(parentId));
    decipher.setAuthTag(tag);
    const url = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
    return /^https?:\/\//i.test(url) ? url : undefined;
  } catch { return; }
}

export const mediaChildPath = (parentId: string, url: string) => `/api/media/${parentId}/u/${sealedMediaUrl(parentId, url)}`;

/** Loopback FFmpeg/ffprobe carry ?token=, not a cookie. The path must accept playlist
 *  children (`/u/...`) too, or HLS probe gets 401 and anime will not start. */
export const isInternalMediaPath = (path: string) =>
  /^(?:\/api)?\/media\/[A-Za-z0-9_-]{43}(?:\/u\/[A-Za-z0-9_-]+)?$/.test(path);

export function streamKind(stream: StreamItem): PublicStream["kind"] {
  if (stream.url?.startsWith("file://")) return "library";
  if (/^https?:\/\//i.test(stream.url ?? "")) return "remote";
  if (infoHashOf(stream) || /^magnet:/i.test(stream.url ?? "")) return "torrent";
  return "unsupported";
}

function normalizedStream(input: StreamItem): StreamItem {
  const headers = new Headers(input.behaviorHints?.proxyHeaders?.request);
  for (const name of ["host", "connection", "content-length", "transfer-encoding", "x-forwarded-for", "forwarded"]) headers.delete(name);
  const infoHash = infoHashOf(input);
  const fileIdx = Number.isInteger(input.fileIdx) && (input.fileIdx as number) >= 0 ? input.fileIdx : undefined;
  return {
    url: typeof input.url === "string" && !/^magnet:/i.test(input.url) ? input.url : undefined,
    infoHash, fileIdx,
    name: safeSourceText(input.name, input), title: safeSourceText(input.title, input),
    description: safeSourceText(input.description, input), addonKey: input.addonKey,
    addonName: safeSourceText(input.addonName, input),
    behaviorHints: { filename: safeSourceText(input.behaviorHints?.filename, input),
      bingeGroup: safeSourceText(input.behaviorHints?.bingeGroup, input),
      notWebReady: input.behaviorHints?.notWebReady === true,
      videoSize: Number.isFinite(input.behaviorHints?.videoSize) ? input.behaviorHints?.videoSize : undefined,
      proxyHeaders: { request: Object.fromEntries(headers) } },
  };
}

export class MediaResources {
  private entries = new Map<string, Resource>();
  private dedup = new Map<string, string>();
  private expired = new Map<string, { sid: string; scope: ResourceScope }>();
  private creationWindows = new Map<string, { at: number; count: number }>();
  private bindings = new WeakMap<StreamItem, string>();
  private bytes = 0;
  private prunedAt = Number.NEGATIVE_INFINITY;
  constructor(private now = Date.now, private maxEntries = 20_000, private maxBytes = 64 * 1024 * 1024,
    private creationsPerMinute = 1200, private maxSessions = 500) {}

  private prune(force = false) {
    if (!force && this.now() - this.prunedAt < 1000) return;
    this.prunedAt = this.now();
    for (const record of [...this.entries.values()]) if (record.expiresAt <= this.now()) this.remove(record.id, true);
  }

  private fits(bytes: number) {
    return this.entries.size < this.maxEntries && this.bytes + bytes <= this.maxBytes;
  }

  /**
   * A selection is re-created the moment the user opens the list again, so a full
   * registry drops the oldest ones instead of refusing the request. Playback claims
   * and everything hanging off them are never evicted -- they cannot be re-created
   * without interrupting what is already running.
   */
  private reserve(bytes: number) {
    if (this.fits(bytes)) return;
    this.prune(true);
    for (const record of [...this.entries.values()]) {
      if (this.fits(bytes)) return;
      if (record.scope === "media" || record.parent) continue;
      this.remove(record.id, true);
    }
    if (!this.fits(bytes)) throw new ResourceError(429, "RESOURCE_LIMIT");
  }

  /**
   * The window bounds how often a session asks for sources, not how many a title happens
   * to carry: a stocked provider answers one episode with hundreds of streams, and billing
   * each of them spends the session's minute on a single click.
   */
  private charge(sid: string) {
    for (const [key, window] of this.creationWindows) if (window.at + 60_000 <= this.now()) this.creationWindows.delete(key);
    if (!this.creationWindows.has(sid)) {
      while (this.creationWindows.size >= this.maxSessions) this.creationWindows.delete(this.creationWindows.keys().next().value!);
    }
    const window = this.creationWindows.get(sid) ?? { at: this.now(), count: 0 };
    if (window.count >= this.creationsPerMinute) throw new ResourceError(429, "RESOURCE_LIMIT");
    window.count++;
    this.creationWindows.set(sid, window);
  }

  add(stream: StreamItem, owner: ResourceOwner, scope: ResourceScope, parent?: string, unique = false, bill = true): string {
    this.prune();
    if (owner.expiresAt <= this.now()) throw new ResourceError(410, "RESOURCE_EXPIRED");
    if (parent) this.get(parent, owner.sid, "media");
    const normalized = normalizedStream(stream);
    const serialized = JSON.stringify(normalized);
    const key = createHash("sha256").update(JSON.stringify([owner.sid, scope, parent, serialized, unique ? randomBytes(16).toString("hex") : ""])).digest("hex");
    const existing = this.dedup.get(key);
    if (existing) return existing;
    if (scope === "source" && bill) this.charge(owner.sid);
    const bytes = Buffer.byteLength(serialized) + 512;
    this.reserve(bytes);
    const id = randomBytes(32).toString("base64url");
    const expiresAt = Math.min(owner.expiresAt, scope === "media" || parent ? owner.expiresAt : this.now() + 30 * 60_000);
    this.entries.set(id, { id, owner: { ...owner }, scope, stream: normalized, expiresAt, parent, bytes, key });
    this.dedup.set(key, id);
    this.bytes += bytes;
    return id;
  }

  get(id: string, sid: string | undefined, scope: ResourceScope, internal = false): Resource {
    const record = this.entries.get(id);
    if (!record) {
      const expired = this.expired.get(id);
      const owned = expired && expired.sid === sid && expired.scope === scope;
      throw new ResourceError(owned ? 410 : 404, owned ? "RESOURCE_EXPIRED" : "RESOURCE_NOT_FOUND");
    }
    if ((!internal && record.owner.sid !== sid) || record.scope !== scope) throw new ResourceError(404, "RESOURCE_NOT_FOUND");
    if (record.expiresAt <= this.now()) {
      this.remove(id, true);
      throw new ResourceError(410, "RESOURCE_EXPIRED");
    }
    if (record.parent) this.get(record.parent, sid, "media", internal);
    return record;
  }

  remove(id: string, expired = false) {
    const record = this.entries.get(id);
    if (!record) return;
    this.entries.delete(id); this.dedup.delete(record.key); this.bytes -= record.bytes;
    if (expired) {
      this.expired.set(id, { sid: record.owner.sid, scope: record.scope });
      while (this.expired.size > Math.min(this.maxEntries, 5_000)) this.expired.delete(this.expired.keys().next().value!);
    }
    for (const child of this.entries.values()) if (child.parent === id) this.remove(child.id, expired);
  }

  revoke(sid?: string) {
    for (const record of this.entries.values()) if (!sid || record.owner.sid === sid) this.remove(record.id);
  }

  mediaStream(source: StreamItem, owner: ResourceOwner): { stream: StreamItem; resourceId: string } {
    const resourceId = this.add(source, owner, "media", undefined, true);
    const stream = structuredClone(this.get(resourceId, owner.sid, "media").stream);
    this.bindings.set(stream, resourceId);
    return { stream, resourceId };
  }

  path(stream: StreamItem): string {
    let id = this.bindings.get(stream);
    if (!id) {
      id = this.add(stream, { sid: "internal", expiresAt: this.now() + 30 * 60_000 }, "media");
      this.bindings.set(stream, id);
    }
    return `/api/media/${id}`;
  }

  publicStream(stream: StreamItem, owner: ResourceOwner): PublicStream {
    return this.materialize(stream, owner, true);
  }

  /** A listing hands out one resource per stream, and a stocked provider answers a single
   *  episode with hundreds of them. The session's minute is spent by the listing, so a click
   *  cannot exhaust it -- a refused addon used to drop out of the next-episode pick and the
   *  viewer landed on another provider, in another language. */
  listing(streams: StreamItem[], owner: ResourceOwner): PublicStream[] {
    if (streams.length) this.charge(owner.sid);
    return streams.map((stream) => this.materialize(stream, owner, false));
  }

  private materialize(stream: StreamItem, owner: ResourceOwner, bill: boolean): PublicStream {
    const kind = streamKind(stream);
    const sourceId = this.add(stream, owner, "source", undefined, false, bill);
    const record = this.get(sourceId, owner.sid, "source").stream;
    return {
      sourceId, kind, playable: kind === "remote" || kind === "library",
      name: record.name, title: record.title, description: record.description,
      addonKey: record.addonKey, addonName: record.addonName,
      behaviorHints: { filename: record.behaviorHints?.filename, videoSize: record.behaviorHints?.videoSize,
        bingeGroup: record.behaviorHints?.bingeGroup },
      subtitles: (stream.subtitles ?? []).filter((item) => /^https?:\/\//i.test(item.url) || (kind === "library" && item.url.startsWith("file://"))).map((item) => ({
        subtitleId: this.add({ url: item.url }, owner, "subtitle"),
        lang: safeSourceText(item.lang, stream), addonName: safeSourceText(item.addonName, stream),
      })),
    };
  }
}

export const mediaResources = new MediaResources();
