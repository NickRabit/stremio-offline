export type FailureClass = "transient" | "source" | "storage" | "pause";

export type { QueueHalt } from "./api-types.js";

export class HttpSourceError extends Error {
  constructor(readonly httpStatus: number, message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = "HttpSourceError";
  }
}

export class IncompleteDownloadError extends Error {
  constructor(received: number, total?: number) {
    super(total
      ? `The downloaded size does not match (${received} / ${total}).`
      : `The transfer ended early (${received} B) and the source sent no size.`);
    this.name = "IncompleteDownloadError";
  }
}

export class SourceError extends Error {
  constructor(message: string, readonly messageKey?: string) {
    super(message);
    this.name = "SourceError";
  }
}

export class StorageError extends Error {
  constructor(message: string, code?: string) {
    super(message);
    this.name = "StorageError";
    if (code) (this as NodeJS.ErrnoException).code = code;
  }
}

const STORAGE_CODES = new Set(["ENOSPC", "EDQUOT", "EIO", "ESTALE", "ENODEV", "EROFS"]);
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

const classifyHttp = (status: number): FailureClass => {
  if (status === 429 || status === 408 || status === 416) return "transient";
  if (status >= 500) return "transient";
  if (status >= 400) return "source";
  return "transient";
};

const httpStatusFromMessage = (message: string): number | undefined => {
  const match = /HTTP\s+(\d{3})/i.exec(message);
  return match ? Number(match[1]) : undefined;
};

export function classifyFailure(error: unknown, extras: { stalled?: boolean } = {}): FailureClass {
  if (extras.stalled) return "transient";
  if (error instanceof IncompleteDownloadError) return "transient";
  if (error instanceof SourceError) return "source";
  if (error instanceof StorageError) return "storage";
  if (error instanceof HttpSourceError) return classifyHttp(error.httpStatus);
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code && STORAGE_CODES.has(code)) return "storage";
  const message = error instanceof Error ? error.message : String(error);
  const status = httpStatusFromMessage(message);
  if (status != null) return classifyHttp(status);
  if (/ENOSPC|EDQUOT|no space left|quota exceeded/i.test(message)) return "storage";
  if (/EIO|ESTALE|read-only/i.test(message)) return "storage";
  return "transient";
}

export function parseContentRange(header: string | null | undefined): { start: number; end: number; total?: number } | undefined {
  if (!header) return undefined;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(header.trim());
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === "*" ? undefined : Number(match[3]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return undefined;
  if (total != null && !Number.isFinite(total)) return undefined;
  return { start, end, total };
}

/** Keep 1 GiB free on a large volume, 2 % on a small one, never under 256 MiB. */
export function storageHeadroom(totalBytes?: number): number {
  const share = totalBytes && totalBytes > 0 ? Math.floor(totalBytes * 0.02) : GiB;
  return Math.min(GiB, Math.max(256 * MiB, share));
}

export function storageResumeNeed(totalBytes: number | undefined, remainingBytes: number): number {
  return storageHeadroom(totalBytes) + Math.max(remainingBytes, 256 * MiB);
}

export function retryDelayMs(retryCount: number, retryAfterMs?: number): number {
  const steps = [2_000, 8_000, 30_000];
  const fromCount = steps[Math.min(Math.max(retryCount, 1) - 1, steps.length - 1)] ?? 30_000;
  const fromHeader = retryAfterMs && retryAfterMs > 0 ? Math.min(retryAfterMs, 5 * 60_000) : 0;
  return Math.max(fromCount, fromHeader);
}

export function storageMessage(error: unknown): { message: string; key: string } {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ENOSPC" || /no space left/i.test(message)) return { message: "No space left on the disk.", key: "err.noSpace" };
  if (code === "EDQUOT" || /quota/i.test(message)) return { message: "The disk quota is used up.", key: "err.quotaSpent" };
  return { message: "The storage is not responding.", key: "err.storageUnresponsive" };
}

export function expectedSize(...candidates: Array<number | undefined>): number | undefined {
  for (const value of candidates) if (value && value > 0) return value;
  return undefined;
}
