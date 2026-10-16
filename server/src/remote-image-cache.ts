import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { renameWithRetry } from "./fs-retry.js";
import { log } from "./logger.js";
import { MediaServerError } from "./media-server-types.js";

/**
 * The posters and backdrops a Jellyfin or Emby library hands out. They belong to a connection,
 * not to the catalogue: a remote address can carry a token, so the key is drawn from the
 * connection, the item, the role, the size and the tag the bytes belong to -- never from a URL,
 * a token or a user id. The tag is the one the client asked for, or the proof's current one for
 * a request that names none, so an address a page still holds keeps its own entry and does not
 * reach the provider again. Every request rechecks the viewer's grant before either copy is read.
 */

const MAX_STORED_BYTES = 5 * 1024 * 1024;
const KEY_LENGTH = 64;
const KEY_FILE = /^[0-9a-f]{64}\.(jpg|png|webp|gif)$/;

const IMAGE_EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
};
const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif",
};

const megabytes = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return (Number.isFinite(parsed) && parsed > 0 ? parsed : fallback) * 1024 * 1024;
};

/** Unlike `megabytes`, an explicit `0` is honoured: it turns the memory layer off. */
const memoryMegabytes = (value: string | undefined, fallback: number) => {
  const text = value?.trim();
  const parsed = Number(text);
  return (!text || !Number.isFinite(parsed) || parsed < 0 ? fallback : parsed) * 1024 * 1024;
};

/** How far below the cap a pass drops: the smaller of 8 MiB and 2% of the cap, at least one
 *  byte. A cache that stays above its cap evicts on every pass; the cap is the lever. */
function evictionFloor(cap: number): number {
  const margin = Math.min(8 * 1024 * 1024, Math.max(1, Math.floor(cap * 0.02)));
  return cap - margin;
}

export function remoteImageKey(parts: {
  connectionId: string;
  itemId: string;
  imageType: "Primary" | "Backdrop" | "Thumb";
  size: "" | "tile" | "detail";
  /** The image version the bytes belong to: what the client named, or the proof's tag. */
  tag: string;
}): string {
  return createHash("sha256")
    .update([parts.connectionId, parts.itemId, parts.imageType, parts.size, parts.tag].join("\u0000"))
    .digest("hex");
}

export interface RemoteImageBody {
  stream: ReadableStream<Uint8Array>;
  contentType: string;
  cached: boolean;
  /** Where these bytes came from. `cached` stays true for memory and disk. */
  source: "memory" | "disk" | "upstream";
}

interface Entry { file: string; ext: string; size: number; at: number }

interface Waiter {
  stream: ReadableStream<Uint8Array>;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  cancelled: Promise<never>;
  reject?: (error: unknown) => void;
  detached: boolean;
  onAbort?: () => void;
  signal?: AbortSignal;
}

/** One upstream body shared by everyone who asked for the same key while it is in flight. A
 *  waiter that joins late receives the buffered prefix and then the live chunks. */
interface Inflight {
  key: string;
  controller: AbortController;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  contentType: string;
  ext?: string;
  storeable: boolean;
  chunks: Buffer[];
  size: number;
  settled: boolean;
  abandoned: boolean;
  failure?: unknown;
  waiters: Set<Waiter>;
  ready: Promise<void>;
  /** Resolves when the upstream read has settled, including a store it already decided on. */
  done: Promise<void>;
  markReady: () => void;
  failReady: (error: unknown) => void;
}

const cancelledError = (): MediaServerError => new MediaServerError("cancelled", "The media-server request was cancelled.");

const bufferStream = (bytes: Buffer): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start: (controller) => { controller.enqueue(new Uint8Array(bytes)); controller.close(); },
  });

export class RemoteImageCache {
  private index = new Map<string, Entry>();
  private memory = new Map<string, { bytes: Buffer; contentType: string }>();
  private memoryBytes = 0;
  private dirty = new Set<string>();
  private inflight = new Map<string, Inflight>();
  private maintenance?: Promise<void>;
  private chain: Promise<unknown> = Promise.resolve();
  /** Disk stores started after a body finished. `close` waits for them, so a directory removed
   *  immediately afterwards is not still being written. */
  private pendingWrites: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly cap: number;
  private readonly memoryCap: number;

  constructor(
    private dir = path.join(process.env.DATA_DIR ?? "/data", "remote-images"),
    cap?: number,
    memoryCap?: number,
  ) {
    // A cap of `0` is the default, not an unlimited or empty cache; a passed memory cap of `0`
    // is the one value that turns that layer off.
    this.cap = cap !== undefined && cap > 0 ? cap : megabytes(process.env.REMOTE_IMAGE_CACHE_MB, 512);
    this.memoryCap = memoryCap === 0 ? 0
      : memoryCap !== undefined && memoryCap > 0 ? memoryCap : memoryMegabytes(process.env.REMOTE_IMAGE_MEMORY_MB, 128);
  }

  /** Builds the index from the files that are actually there; there is no index file. A
   *  half-written `.tmp` from a previous run is the only thing dropped. */
  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const names = await readdir(this.dir).catch(() => []);
    for (const name of names) if (name.endsWith(".tmp")) await rm(path.join(this.dir, name), { force: true });
    this.index.clear();
    for (const name of names) {
      if (!KEY_FILE.test(name)) continue;
      const file = path.join(this.dir, name);
      const info = await stat(file).catch(() => undefined);
      if (!info?.isFile()) continue;
      this.index.set(name.slice(0, KEY_LENGTH), { file, ext: name.slice(KEY_LENGTH + 1), size: info.size, at: info.mtimeMs });
    }
    await this.evict();
  }

  /** One INFO line when it finishes, and nothing at all when the memory is off. */
  async preheat(): Promise<void> {
    if (this.memoryCap <= 0) return;
    const ordered = [...this.index.entries()].sort((left, right) => right[1].at - left[1].at);
    const warmed: string[] = [];
    let files = 0;
    let bytes = 0;
    for (const [key, entry] of ordered) {
      if (this.closed) return;
      if (this.memory.has(key)) continue;
      const info = await stat(entry.file).catch(() => undefined);
      if (!info?.isFile()) continue;
      if (info.size > this.memoryCap) continue;
      if (info.size > this.memoryCap - this.memoryBytes) break;
      const data = await readFile(entry.file).catch(() => undefined);
      if (!data) continue;
      this.putMemory(key, data, MIME_BY_EXT[entry.ext] ?? "application/octet-stream");
      warmed.push(key);
      files += 1;
      bytes += data.length;
    }
    // Newest was inserted first, so it would be evicted first. Replay oldest-first.
    for (const key of warmed.reverse()) {
      const remembered = this.memory.get(key);
      if (!remembered) continue;
      this.memory.delete(key);
      this.memory.set(key, remembered);
    }
    log("INFO", "Remote image cache preheat finished", { files, bytes });
  }

  maintain(): Promise<void> {
    if (!this.maintenance) {
      this.maintenance = this.flushDirty()
        .then(() => this.evict())
        .then(
          () => undefined,
          (error) => { log("WARN", "Remote image cache maintenance failed", { reason: String(error).slice(0, 120) }); },
        )
        .finally(() => { this.maintenance = undefined; });
    }
    return this.maintenance;
  }

  /** Flushes the recency of memory hits, stops preheat and aborts every shared upstream read.
   *  A store already decided still finishes first: the bytes are what the next start indexes,
   *  and a caller removing the directory must not race that write. */
  async close(): Promise<void> {
    this.closed = true;
    await this.flushDirty();
    const running = [...this.inflight.values()];
    for (const inflight of running) inflight.controller.abort();
    await Promise.all(running.map((inflight) => inflight.done));
    let pending = this.pendingWrites;
    for (;;) {
      await pending;
      if (pending === this.pendingWrites) return;
      pending = this.pendingWrites;
    }
  }

  /** The bytes behind a key: memory, then disk, then the upstream -- which runs once for
   *  everyone who asked while that body is in flight. */
  async open(key: string, signal: AbortSignal | undefined, loadUpstream: (signal: AbortSignal) => Promise<Response>): Promise<RemoteImageBody> {
    const remembered = this.memory.get(key);
    if (remembered) {
      this.memory.delete(key);
      this.memory.set(key, remembered);
      const known = this.index.get(key);
      if (known) known.at = Date.now();
      this.dirty.add(key);
      return { stream: bufferStream(remembered.bytes), contentType: remembered.contentType, cached: true, source: "memory" };
    }
    const entry = this.index.get(key);
    if (entry) {
      const data = await readFile(entry.file).catch(() => undefined);
      if (data) {
        entry.at = Date.now();
        const contentType = MIME_BY_EXT[entry.ext] ?? "application/octet-stream";
        this.putMemory(key, data, contentType);
        return { stream: bufferStream(data), contentType, cached: true, source: "disk" };
      }
      this.index.delete(key);
    }
    const inflight = this.inflight.get(key) ?? this.start(key, loadUpstream);
    const waiter = this.attach(inflight, signal);
    try {
      await Promise.race([inflight.ready, waiter.cancelled]);
    } catch (error) {
      this.detach(inflight, waiter);
      throw error;
    }
    return { stream: waiter.stream, contentType: inflight.contentType, cached: false, source: "upstream" };
  }

  private start(key: string, loadUpstream: (signal: AbortSignal) => Promise<Response>): Inflight {
    const controller = new AbortController();
    let markReady!: () => void;
    let failReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { markReady = resolve; failReady = reject; });
    ready.catch(() => undefined);
    const inflight: Inflight = {
      key, controller, contentType: "application/octet-stream", storeable: false, chunks: [], size: 0,
      settled: false, abandoned: false, waiters: new Set(), ready, markReady, failReady,
      done: Promise.resolve(),
    };
    this.inflight.set(key, inflight);
    inflight.done = this.pump(inflight, loadUpstream).then(() => undefined, () => undefined);
    return inflight;
  }

  private async pump(inflight: Inflight, loadUpstream: (signal: AbortSignal) => Promise<Response>): Promise<void> {
    try {
      const response = await loadUpstream(inflight.controller.signal);
      const header = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      inflight.contentType = response.headers.get("content-type") ?? "application/octet-stream";
      inflight.ext = IMAGE_EXT[header];
      inflight.storeable = response.status === 200 && inflight.ext !== undefined;
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new MediaServerError("unavailable", "The media-server image is unavailable.");
      }
      const reader = response.body.getReader();
      inflight.reader = reader;
      if (inflight.abandoned) {
        await reader.cancel().catch(() => undefined);
        return;
      }
      // The headers are known, so waiters may start reading: the first chunk does not wait for
      // the end of the body.
      inflight.markReady();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const bytes = Buffer.from(chunk.value);
        inflight.chunks.push(bytes);
        inflight.size += bytes.length;
        for (const waiter of inflight.waiters) waiter.controller?.enqueue(new Uint8Array(bytes));
      }
      this.finish(inflight);
    } catch (error) {
      this.fail(inflight, error);
    }
  }

  private finish(inflight: Inflight): void {
    inflight.settled = true;
    if (this.inflight.get(inflight.key) === inflight) this.inflight.delete(inflight.key);
    inflight.markReady();
    for (const waiter of inflight.waiters) waiter.controller?.close();
    inflight.waiters.clear();
    // The last waiter left before the body ended: the upstream was aborted and nothing is kept.
    if (inflight.abandoned) return;
    if (!inflight.storeable || inflight.ext === undefined || inflight.size === 0 || inflight.size > MAX_STORED_BYTES) return;
    const data = Buffer.concat(inflight.chunks);
    // Both `image/jpeg` and `image/jpg` are remembered as the former.
    this.putMemory(inflight.key, data, MIME_BY_EXT[inflight.ext] ?? inflight.contentType);
    const stored = this.write(inflight.key, inflight.ext, data);
    this.pendingWrites = this.pendingWrites.then(() => stored, () => stored).then(() => undefined, () => undefined);
  }

  private fail(inflight: Inflight, error: unknown): void {
    if (inflight.settled) return;
    inflight.settled = true;
    inflight.failure = error;
    if (this.inflight.get(inflight.key) === inflight) this.inflight.delete(inflight.key);
    inflight.failReady(error);
    for (const waiter of inflight.waiters) {
      waiter.detached = true;
      waiter.controller?.error(error);
      waiter.reject?.(error);
    }
    inflight.waiters.clear();
  }

  private attach(inflight: Inflight, signal?: AbortSignal): Waiter {
    let reject!: (error: unknown) => void;
    const cancelled = new Promise<never>((_resolve, rejectFn) => { reject = rejectFn; });
    cancelled.catch(() => undefined);
    const waiter = { cancelled, reject, detached: false } as Waiter;
    waiter.stream = new ReadableStream<Uint8Array>({
      start: (controller) => { waiter.controller = controller; },
      cancel: () => this.detach(inflight, waiter),
    });
    for (const chunk of inflight.chunks) waiter.controller?.enqueue(new Uint8Array(chunk));
    if (inflight.failure !== undefined) waiter.controller?.error(inflight.failure);
    else if (inflight.settled) waiter.controller?.close();
    inflight.waiters.add(waiter);
    if (signal) {
      waiter.signal = signal;
      waiter.onAbort = () => this.detach(inflight, waiter);
      if (signal.aborted) waiter.onAbort();
      else signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    return waiter;
  }

  /** One waiter is gone: its own read stops, and the upstream is aborted once nobody is left. */
  private detach(inflight: Inflight, waiter: Waiter): void {
    if (waiter.detached) return;
    waiter.detached = true;
    inflight.waiters.delete(waiter);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.controller?.error(cancelledError());
    waiter.reject?.(cancelledError());
    if (inflight.waiters.size === 0 && !inflight.settled && !inflight.abandoned) {
      inflight.abandoned = true;
      if (this.inflight.get(inflight.key) === inflight) this.inflight.delete(inflight.key);
      inflight.controller.abort();
      void inflight.reader?.cancel().catch(() => undefined);
    }
  }

  private putMemory(key: string, bytes: Buffer, contentType: string): void {
    if (this.memoryCap <= 0 || bytes.length > this.memoryCap) return;
    const known = this.memory.get(key);
    if (known) { this.memory.delete(key); this.memoryBytes -= known.bytes.length; }
    while (this.memoryBytes + bytes.length > this.memoryCap) {
      const oldest = this.memory.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const dropped = this.memory.get(oldest)!;
      this.memory.delete(oldest);
      this.memoryBytes -= dropped.bytes.length;
    }
    this.memory.set(key, { bytes, contentType });
    this.memoryBytes += bytes.length;
  }

  private async write(key: string, ext: string, data: Buffer): Promise<void> {
    const target = path.join(this.dir, `${key}.${ext}`);
    const temp = `${target}.tmp`;
    try {
      await writeFile(temp, data, { mode: 0o600 });
      await renameWithRetry(temp, target);
      this.index.set(key, { file: target, ext, size: data.length, at: Date.now() });
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      log("WARN", "A cached remote image could not be stored", { reason: String(error).slice(0, 120) });
    }
  }

  /** One `utimes` per key served from memory since the previous flush. A file that is gone --
   *  evicted while the memory copy lived on -- is not written back. */
  private async flushDirty(): Promise<void> {
    const keys = [...this.dirty];
    this.dirty.clear();
    const now = new Date();
    for (const key of keys) {
      const entry = this.index.get(key);
      if (!entry) continue;
      await utimes(entry.file, now, now).catch(() => undefined);
    }
  }

  private exclusively<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  private evict(): Promise<void> { return this.exclusively(() => this.evictOnce()); }

  private async evictOnce(): Promise<void> {
    let total = 0;
    for (const entry of this.index.values()) total += entry.size;
    if (total <= this.cap) return;
    const floor = evictionFloor(this.cap);
    const ordered = [...this.index.entries()].sort((left, right) => left[1].at - right[1].at);
    let removed = 0;
    for (const [key, entry] of ordered) {
      if (total <= floor) break;
      await rm(entry.file, { force: true }).catch(() => undefined);
      if (this.index.delete(key)) { total -= entry.size; removed += 1; }
    }
    if (removed) log("INFO", "Cached remote images dropped to stay under the limit", { removed });
  }
}
