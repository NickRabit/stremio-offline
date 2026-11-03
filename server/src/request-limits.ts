import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ipKeyGenerator, MemoryStore, rateLimit, type Options, type RateLimitInfo } from "express-rate-limit";

const MINUTE_MS = 60_000;
const API_REQUESTS_PER_MINUTE = 3000;
const AUTH_REQUESTS_PER_MINUTE = 20;
const PAGE_REQUESTS_PER_MINUTE = 180;
const MAX_STORE_KEYS = 4096;

interface LimitOptions {
  windowMs?: number;
  limit?: number;
}

interface ApiLimitOptions extends LimitOptions {
  userId(req: Request): string | undefined;
  skip?(req: Request): boolean;
}

export class BoundedMemoryStore extends MemoryStore {
  constructor(private readonly maxKeys = MAX_STORE_KEYS) {
    super();
  }

  override async increment(key: string) {
    const info = await super.increment(key);
    this.trim(key);
    return info;
  }

  private trim(keep: string) {
    let excess = this.current.size + this.previous.size - this.maxKeys;
    for (const entries of [this.previous, this.current]) {
      for (const entry of entries.keys()) {
        if (excess <= 0) return;
        if (entries === this.current && entry === keep && entries.size === 1) return;
        entries.delete(entry);
        excess -= 1;
      }
    }
  }
}

const requester = (req: Request, userId?: string): string =>
  userId ? `user:${userId}` : `ip:${ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? "unknown")}`;

const retrySeconds = (req: Request, options: Options): number => {
  const info = (req as Request & { rateLimit?: RateLimitInfo }).rateLimit;
  const remaining = info?.resetTime ? info.resetTime.getTime() - Date.now() : options.windowMs;
  return Math.max(1, Math.ceil(remaining / 1000));
};

const limited = (req: Request, res: Response, _next: NextFunction, options: Options) => {
  const seconds = retrySeconds(req, options);
  res.status(options.statusCode)
    .setHeader("retry-after", String(seconds))
    .json({
      error: "Too many requests. Try again later.",
      messageKey: "err.tooManyRequests",
      vars: { seconds },
    });
};

const common = (identifier: string, options: LimitOptions) => ({
  windowMs: options.windowMs ?? MINUTE_MS,
  limit: options.limit ?? API_REQUESTS_PER_MINUTE,
  identifier,
  standardHeaders: "draft-8" as const,
  legacyHeaders: false,
  handler: limited,
  store: new BoundedMemoryStore(),
});

export function apiRequestLimiter(options: ApiLimitOptions): RequestHandler {
  return rateLimit({
    ...common("api", options),
    keyGenerator: (req) => requester(req, options.userId(req)),
    skip: (req) => options.skip?.(req) === true,
  });
}

export function authRequestLimiter(options: Omit<ApiLimitOptions, "skip"> = { userId: () => undefined }): RequestHandler {
  return rateLimit({
    ...common("auth", { ...options, limit: options.limit ?? AUTH_REQUESTS_PER_MINUTE }),
    keyGenerator: (req) => requester(req, options.userId(req)),
  });
}

export function pageRequestLimiter(options: LimitOptions = {}): RequestHandler {
  return rateLimit({
    ...common("page", { ...options, limit: options.limit ?? PAGE_REQUESTS_PER_MINUTE }),
    keyGenerator: (req) => requester(req),
  });
}

/** Browser media elements and FFmpeg issue many independent range requests. Their admission
 *  is limited when playback starts; throttling every byte request would only break playback. */
export function isMediaTransferRequest(req: Request): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  return req.path.startsWith("/media/")
    || req.path.startsWith("/device-download/")
    || /^\/playback\/[^/]+\/\d+\/[^/]+$/.test(req.path);
}
