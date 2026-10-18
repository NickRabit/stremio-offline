import { MediaServerError } from "./media-server-types.js";

export interface OriginalQuotaSeams {
  clock?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface OriginalSlot {
  wrap(response: Response, signal: AbortSignal): Response;
  release(): void;
}

interface SourcePacer {
  nextFreeAt: number;
}

const abortError = (signal: AbortSignal): unknown =>
  signal.reason ?? new Error("The media-server quota wait was cancelled.");

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal.aborted) {
    reject(abortError(signal));
    return;
  }
  const onAbort = () => {
    clearTimeout(timer);
    reject(abortError(signal));
  };
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  timer.unref?.();
  signal.addEventListener("abort", onAbort, { once: true });
});

export class OriginalQuota {
  private readonly slots = new Map<string, Map<string, number>>();
  private readonly pacers = new Map<string, Map<string, SourcePacer>>();
  private readonly clock: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(seams: OriginalQuotaSeams = {}) {
    this.clock = seams.clock ?? (() => Date.now());
    this.sleep = seams.sleep ?? defaultSleep;
  }

  reserve(connectionId: string, sourceKey: string, limits: { bitrateLimit?: number; streamLimit?: number }): OriginalSlot {
    let slots = this.slots.get(connectionId);
    if (!slots) {
      slots = new Map();
      this.slots.set(connectionId, slots);
    }
    const held = slots.get(sourceKey) ?? 0;
    if (held === 0) {
      if (limits.streamLimit !== undefined && slots.size >= limits.streamLimit) {
        if (slots.size === 0 && this.slots.get(connectionId) === slots) this.slots.delete(connectionId);
        throw new MediaServerError("busy", "Too many media-server streams are open.");
      }
    }
    slots.set(sourceKey, held + 1);

    let pacers = this.pacers.get(connectionId);
    if (!pacers) {
      pacers = new Map();
      this.pacers.set(connectionId, pacers);
    }
    const now = this.clock();
    for (const [key, pacer] of pacers) {
      // A paused body still holds its pacer; a second one for the same key would double the rate.
      if (pacer.nextFreeAt < now - 1000 && !slots.has(key)) pacers.delete(key);
    }
    let pacer = pacers.get(sourceKey);
    if (!pacer) {
      pacer = { nextFreeAt: 0 };
      pacers.set(sourceKey, pacer);
    }
    const heldPacer = pacer;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const refs = (slots.get(sourceKey) ?? 1) - 1;
      if (refs > 0) {
        slots.set(sourceKey, refs);
      } else {
        slots.delete(sourceKey);
        if (slots.size === 0 && this.slots.get(connectionId) === slots) this.slots.delete(connectionId);
      }
    };

    return {
      release,
      wrap: (response, signal) => {
        if (!response.body) {
          release();
          return response;
        }
        const reader = response.body.getReader();
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          signal.removeEventListener("abort", onAbort);
          release();
        };
        const onAbort = () => {
          finish();
          void reader.cancel(abortError(signal)).catch(() => undefined);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();

        const bitrateLimit = limits.bitrateLimit;
        const body = new ReadableStream<Uint8Array>({
          pull: async (controller) => {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                finish();
                controller.close();
                return;
              }
              const bytes = chunk.value;
              if (bitrateLimit === undefined) {
                controller.enqueue(bytes);
                return;
              }
              const burst = bitrateLimit / 8;
              const pieces = Math.max(1, Math.ceil(bytes.byteLength / burst));
              const size = Math.ceil(bytes.byteLength / pieces);
              for (let offset = 0; offset < bytes.byteLength; offset += size) {
                const piece = bytes.subarray(offset, Math.min(bytes.byteLength, offset + size));
                const now = this.clock();
                const start = Math.max(now, heldPacer.nextFreeAt);
                heldPacer.nextFreeAt = start + piece.byteLength * 8000 / bitrateLimit;
                const wait = start - now - 1000;
                if (wait > 0) await this.sleep(wait, signal);
                controller.enqueue(piece);
              }
            } catch (error) {
              finish();
              void reader.cancel(error).catch(() => undefined);
              controller.error(error);
            }
          },
          cancel: async (reason) => {
            finish();
            await reader.cancel(reason).catch(() => undefined);
          },
        });
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      },
    };
  }

  forget(connectionId: string): void {
    this.slots.delete(connectionId);
    this.pacers.delete(connectionId);
  }
}
