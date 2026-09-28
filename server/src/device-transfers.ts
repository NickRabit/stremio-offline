import { randomBytes } from "node:crypto";
import type express from "express";

export type DeviceTransferSource = "library" | "addon" | "hls";
export type DeviceTransferState = "running" | "completed" | "interrupted";

export interface DeviceTransferView {
  id: string;
  userId: string;
  username?: string;
  filename: string;
  source: DeviceTransferSource;
  addonName?: string;
  state: DeviceTransferState;
  sent: number;
  total?: number;
  speed: number;
  startedAt: string;
  finishedAt?: string;
}

export interface DeviceTransferMeta {
  userId: string;
  username?: string;
  filename: string;
  source: DeviceTransferSource;
  addonName?: string;
}

interface OpenResponse {
  res: express.Response;
  /** Offset this response starts at; resolved from the headers on its first chunk. */
  start?: number;
  /** Offset just past the last byte written by this response. */
  end: number;
}

interface Transfer {
  id: string;
  ticketId: string;
  seq: number;
  userId: string;
  username?: string;
  filename: string;
  source: DeviceTransferSource;
  addonName?: string;
  state: DeviceTransferState;
  total?: number;
  /** Merged half-open intervals [start, end) covering the bytes sent so far. */
  coverage: Array<[number, number]>;
  samples: Array<{ at: number; bytes: number }>;
  open: Set<OpenResponse>;
  wrote: boolean;
  aborted: boolean;
  startedAt: number;
  finishedAt?: number;
}

type Viewer = { id: string; role: "admin" | "user" };

const RANGE = /^bytes\s+(\d+)-(\d+)\/(\d+)$/;
const SPEED_WINDOW_MS = 3000;

/** One ticket can be read by several responses at once -- a browser resuming, a download
 *  manager opening parallel connections -- so the bytes are kept as merged ranges: every
 *  offset is counted once no matter how many responses cover it. */
export class DeviceTransfers {
  private readonly byTicket = new Map<string, Transfer>();
  private readonly byId = new Map<string, string>();
  private readonly now: () => number;
  private readonly retainMs: number;
  private readonly maxEntries: number;
  private seq = 0;

  constructor(options: { now?: () => number; retainMs?: number; maxEntries?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.retainMs = options.retainMs ?? 90_000;
    this.maxEntries = options.maxEntries ?? 200;
  }

  /** Attach one HTTP response to the transfer of `ticketId`, creating the transfer on first use. */
  attach(ticketId: string, meta: DeviceTransferMeta, res: express.Response): void {
    let transfer = this.byTicket.get(ticketId);
    if (!transfer) {
      transfer = {
        id: randomBytes(12).toString("base64url"), ticketId, seq: this.seq++,
        userId: meta.userId, username: meta.username, filename: meta.filename,
        source: meta.source, addonName: meta.addonName,
        state: "running", coverage: [], samples: [], open: new Set(),
        wrote: false, aborted: false, startedAt: this.now(),
      };
      this.byTicket.set(ticketId, transfer);
      this.byId.set(transfer.id, ticketId);
      this.sweep();
    } else if (transfer.state !== "running") {
      transfer.state = "running";
      delete transfer.finishedAt;
    }
    transfer.aborted = false;
    const current = transfer;

    const response: OpenResponse = { res, end: 0 };
    current.open.add(response);

    const write = res.write.bind(res) as (...args: unknown[]) => boolean;
    const end = res.end.bind(res) as (...args: unknown[]) => express.Response;
    const measure = (chunk: unknown) => {
      if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) return;
      const bytes = Buffer.byteLength(chunk);
      if (!bytes) return;
      if (response.start == null) this.resolveStart(current, response);
      const start = response.end;
      const finish = start + bytes;
      response.end = finish;
      current.wrote = true;
      this.cover(current, start, finish);
      const at = this.now();
      current.samples.push({ at, bytes });
      // A transfer nobody is watching is never swept, so the window is kept here.
      if (current.samples.length > 256) current.samples = current.samples.filter((sample) => sample.at > at - SPEED_WINDOW_MS);
    };
    res.write = ((...args: unknown[]) => { measure(args[0]); return write(...args); }) as typeof res.write;
    res.end = ((...args: unknown[]) => { measure(args[0]); return end(...args); }) as typeof res.end;

    res.once("close", () => {
      current.open.delete(response);
      if (current.open.size) return;
      if (!current.wrote) { this.drop(current); return; }
      if (current.finishedAt == null) current.finishedAt = this.now();
      current.state = this.finalState(current, response);
    });
  }

  /** Rows the viewer may see, newest first. Sweeps expired finished rows first. */
  list(viewer: Viewer): DeviceTransferView[] {
    this.sweep();
    return [...this.byTicket.values()]
      .filter((transfer) => viewer.role === "admin" || transfer.userId === viewer.id)
      .sort((a, b) => b.seq - a.seq)
      .map((transfer) => this.viewOf(transfer, viewer));
  }

  /** Destroy the transfer's open responses and mark it interrupted. Returns the ticket id,
   *  or undefined when the id is unknown OR the viewer is neither its owner nor an administrator. */
  abort(id: string, viewer: Viewer): string | undefined {
    const ticketId = this.byId.get(id);
    if (!ticketId) return undefined;
    const transfer = this.byTicket.get(ticketId);
    if (!transfer || (viewer.role !== "admin" && transfer.userId !== viewer.id)) return undefined;
    transfer.aborted = true;
    transfer.state = "interrupted";
    if (transfer.finishedAt == null) transfer.finishedAt = this.now();
    for (const response of [...transfer.open]) response.res.destroy();
    return ticketId;
  }

  private resolveStart(transfer: Transfer, response: OpenResponse): void {
    const range = RANGE.exec(String(response.res.getHeader("content-range") ?? ""));
    if (range) {
      response.start = Number(range[1]);
      transfer.total = Number(range[3]);
    } else {
      response.start = 0;
      const length = response.res.getHeader("content-length");
      const total = Number(length);
      if (length != null && Number.isFinite(total) && total >= 0) transfer.total = total;
    }
    response.end = response.start;
  }

  private cover(transfer: Transfer, start: number, finish: number): void {
    if (finish <= start) return;
    const ranges = transfer.coverage;
    let index = 0;
    while (index < ranges.length && ranges[index][1] < start) index++;
    if (index < ranges.length && ranges[index][0] <= finish) {
      ranges[index][0] = Math.min(ranges[index][0], start);
      ranges[index][1] = Math.max(ranges[index][1], finish);
      while (index + 1 < ranges.length && ranges[index + 1][0] <= ranges[index][1]) {
        ranges[index][1] = Math.max(ranges[index][1], ranges[index + 1][1]);
        ranges.splice(index + 1, 1);
      }
      return;
    }
    ranges.splice(index, 0, [start, finish]);
  }

  private sentOf(transfer: Transfer): number {
    const covered = transfer.coverage.reduce((sum, [start, finish]) => sum + (finish - start), 0);
    return transfer.total == null ? covered : Math.min(covered, transfer.total);
  }

  private speedOf(transfer: Transfer): number {
    if (!transfer.open.size) return 0;
    const cutoff = this.now() - SPEED_WINDOW_MS;
    let bytes = 0;
    for (const sample of transfer.samples) if (sample.at > cutoff) bytes += sample.bytes;
    return bytes / (SPEED_WINDOW_MS / 1000);
  }

  private finalState(transfer: Transfer, response: OpenResponse): DeviceTransferState {
    if (transfer.aborted) return "interrupted";
    if (transfer.total != null) return this.sentOf(transfer) >= transfer.total ? "completed" : "interrupted";
    return response.res.writableFinished && (response.res.statusCode ?? 0) < 400 ? "completed" : "interrupted";
  }

  private viewOf(transfer: Transfer, viewer: Viewer): DeviceTransferView {
    return {
      id: transfer.id,
      userId: transfer.userId,
      ...(viewer.role === "admin" ? { username: transfer.username } : {}),
      filename: transfer.filename,
      source: transfer.source,
      ...(transfer.addonName ? { addonName: transfer.addonName } : {}),
      state: transfer.state,
      sent: this.sentOf(transfer),
      ...(transfer.total != null ? { total: transfer.total } : {}),
      speed: this.speedOf(transfer),
      startedAt: new Date(transfer.startedAt).toISOString(),
      ...(transfer.finishedAt != null ? { finishedAt: new Date(transfer.finishedAt).toISOString() } : {}),
    };
  }

  private sweep(): void {
    const now = this.now();
    const cutoff = now - SPEED_WINDOW_MS;
    for (const transfer of [...this.byTicket.values()]) {
      if (transfer.finishedAt != null && now - transfer.finishedAt >= this.retainMs) { this.drop(transfer); continue; }
      if (transfer.samples.length > 8) transfer.samples = transfer.samples.filter((sample) => sample.at > cutoff);
    }
    if (this.byTicket.size <= this.maxEntries) return;
    const finished = [...this.byTicket.values()]
      .filter((transfer) => transfer.finishedAt != null)
      .sort((a, b) => a.finishedAt! - b.finishedAt!);
    for (const transfer of finished) {
      if (this.byTicket.size <= this.maxEntries) break;
      this.drop(transfer);
    }
  }

  private drop(transfer: Transfer): void {
    this.byTicket.delete(transfer.ticketId);
    this.byId.delete(transfer.id);
  }
}
