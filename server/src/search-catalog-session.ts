import { randomBytes } from "node:crypto";
import {
  SEARCH_LIMITS,
  SearchError,
  parseStartRequest,
} from "./search-contracts.js";
import type { CatalogTarget } from "./addons.js";
import type { SearchAuthority } from "./search-session.js";
import { SearchScheduler, type SchedulerJob } from "./search-scheduler.js";
import type { MetaItem } from "./types.js";

export interface CatalogSearchRequest {
  query: string;
  type?: "movie" | "series";
  scope?: { addonKey: string; catalogType?: string; catalogId?: string };
  slotId: string;
  generation: number;
}

export interface CatalogSearchSnapshot {
  revision: number;
  state: "partial" | "complete";
  items: MetaItem[];
  sources: number;
  pending: number;
  failed: number;
  hasMore: boolean;
}

interface CatalogTimerApi {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface CatalogSearchDeps {
  scheduler: SearchScheduler;
  targets(authority: SearchAuthority, request: CatalogSearchRequest): CatalogTarget[];
  stillAllowed(authority: SearchAuthority, target: CatalogTarget): boolean;
  fetchPage(
    target: CatalogTarget,
    query: string,
    skip: number,
    signal: AbortSignal,
    key: string,
  ): Promise<MetaItem[]>;
  rewriteMeta(meta: MetaItem): MetaItem;
  now?: () => number;
  timers?: CatalogTimerApi;
  randomId?: () => string;
  limits?: Partial<{ [K in keyof typeof SEARCH_LIMITS]: number }>;
}

type TargetState = "loading" | "idle" | "failed";

interface StoredTarget {
  target: CatalogTarget;
  order: number;
  offset: number;
  pages: MetaItem[][];
  state: TargetState;
  exhausted: boolean;
  firstSettled: boolean;
  jobRunning: boolean;
  jobToken: number;
  jobCancel?: () => void;
}

interface WaitingPoll {
  resolve: (answer: { changed: false; revision: number } | { changed: true; snapshot: CatalogSearchSnapshot }) => void;
  reject: (error: unknown) => void;
  timer?: unknown;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface ManagedCatalogSession {
  id: string;
  userId: string;
  sid: string;
  slotKey: string;
  authority: SearchAuthority;
  request: CatalogSearchRequest;
  revision: number;
  targets: StoredTarget[];
  lastActivity: number;
  waitingPoll?: WaitingPoll;
  initialResolve?: () => void;
  initialTimer?: unknown;
  destroyed: boolean;
}

interface Tombstone {
  id: string;
  userId: string;
  sid: string;
  expiresAt: number;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};

export function parseCatalogSearchRequest(body: unknown): CatalogSearchRequest {
  if (!isPlainObject(body)) throw new SearchError("search-invalid-request", 400);
  const keys = [
    "query",
    "slotId",
    "generation",
    ...(body.type === undefined ? [] : ["type"]),
    ...(body.scope === undefined ? [] : ["scope"]),
  ];
  if (!hasExactKeys(body, keys)) throw new SearchError("search-invalid-request", 400);
  if (body.type !== undefined && body.type !== "movie" && body.type !== "series") {
    throw new SearchError("search-invalid-request", 400);
  }
  const parsed = parseStartRequest({
    query: body.query,
    kind: "all",
    sources: ["catalog"],
    slotId: body.slotId,
    generation: body.generation,
    ...(body.scope === undefined ? {} : { scope: body.scope }),
  });
  return {
    query: parsed.query,
    ...(body.type === undefined ? {} : { type: body.type }),
    ...(parsed.scope === undefined ? {} : { scope: parsed.scope }),
    slotId: parsed.slotId,
    generation: parsed.generation,
  };
}

const cloneSnapshot = (snapshot: CatalogSearchSnapshot): CatalogSearchSnapshot => ({
  ...snapshot,
  items: snapshot.items.map((item) => ({
    ...item,
    ...(Array.isArray(item.sources) ? { sources: [...item.sources as string[]] } : {}),
  })),
});

const sameRequest = (left: CatalogSearchRequest, right: CatalogSearchRequest): boolean =>
  left.query === right.query
  && left.type === right.type
  && left.slotId === right.slotId
  && left.generation === right.generation
  && left.scope?.addonKey === right.scope?.addonKey
  && left.scope?.catalogType === right.scope?.catalogType
  && left.scope?.catalogId === right.scope?.catalogId;

const poolKeyOf = (target: CatalogTarget): string => {
  try {
    return new URL(target.addon.manifestUrl).host;
  } catch {
    return "";
  }
};

export class CatalogSearchManager {
  private readonly scheduler: SearchScheduler;
  private readonly targets: CatalogSearchDeps["targets"];
  private readonly stillAllowed: CatalogSearchDeps["stillAllowed"];
  private readonly fetchPage: CatalogSearchDeps["fetchPage"];
  private readonly rewriteMeta: CatalogSearchDeps["rewriteMeta"];
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly timers: CatalogTimerApi;
  private readonly limits: Record<keyof typeof SEARCH_LIMITS, number>;
  private readonly sessions = new Map<string, ManagedCatalogSession>();
  private readonly slots = new Map<string, string>();
  private tombstones: Tombstone[] = [];
  private readonly sweepTimer: unknown;
  private closed = false;

  constructor(deps: CatalogSearchDeps) {
    this.scheduler = deps.scheduler;
    this.targets = deps.targets;
    this.stillAllowed = deps.stillAllowed;
    this.fetchPage = deps.fetchPage;
    this.rewriteMeta = deps.rewriteMeta;
    this.now = deps.now ?? Date.now;
    this.randomId = deps.randomId ?? (() => randomBytes(16).toString("base64url"));
    this.limits = { ...SEARCH_LIMITS, ...deps.limits };
    this.timers = deps.timers ?? {
      setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
      clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
      setInterval: (callback, milliseconds) => globalThis.setInterval(callback, milliseconds),
      clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
    };
    this.sweepTimer = this.timers.setInterval(() => this.sweep(), this.limits.sweepIntervalMs);
    const timer = this.sweepTimer as { unref?: () => void } | undefined;
    timer?.unref?.();
  }

  async start(
    authority: SearchAuthority,
    request: CatalogSearchRequest,
  ): Promise<{ id: string; snapshot: CatalogSearchSnapshot }> {
    const slotKey = this.slotKey(authority.userId, authority.sid, request.slotId);
    const slotId = this.slots.get(slotKey);
    const existing = slotId === undefined ? undefined : this.sessions.get(slotId);
    if (existing !== undefined) {
      if (!existing.authority.isCurrent()) {
        this.destroy(existing);
        throw new SearchError("search-restart-required", 410);
      }
      if (existing.request.generation > request.generation) {
        throw new SearchError("search-generation-conflict", 409);
      }
      if (existing.request.generation === request.generation) {
        if (!sameRequest(existing.request, request)) throw new SearchError("search-generation-conflict", 409);
        this.touch(existing);
        this.revalidate(existing);
        return { id: existing.id, snapshot: cloneSnapshot(this.responseSnapshot(existing)) };
      }
    }
    if (!authority.isCurrent()) throw new SearchError("search-restart-required", 410);

    let id: string;
    do {
      id = `cs_${this.randomId()}`;
    } while (this.sessions.has(id));
    const selected = this.targets(authority, request);

    if (existing !== undefined) this.destroy(existing);
    const owned = [...this.sessions.values()]
      .filter((session) => session.userId === authority.userId && session.sid === authority.sid)
      .sort((left, right) => left.lastActivity - right.lastActivity);
    while (owned.length >= this.limits.sessionsPerBrowserSession) this.destroy(owned.shift()!);
    if (this.sessions.size >= this.limits.sessionsServerWide) {
      throw new SearchError("search-capacity-limit", 503);
    }

    const session: ManagedCatalogSession = {
      id,
      userId: authority.userId,
      sid: authority.sid,
      slotKey,
      authority,
      request: {
        ...request,
        ...(request.scope === undefined ? {} : { scope: { ...request.scope } }),
      },
      revision: 1,
      targets: selected.map((target, order) => ({
        target,
        order,
        offset: 0,
        pages: [],
        state: "loading",
        exhausted: false,
        firstSettled: false,
        jobRunning: false,
        jobToken: 0,
      })),
      lastActivity: this.now(),
      destroyed: false,
    };
    this.sessions.set(id, session);
    this.slots.set(slotKey, id);

    const initial = new Promise<void>((resolve) => {
      session.initialResolve = resolve;
      session.initialTimer = this.timers.setTimeout(() => {
        session.initialTimer = undefined;
        session.initialResolve = undefined;
        resolve();
      }, this.limits.firstSnapshotMs);
    });
    for (const target of session.targets) this.schedulePage(session, target, false);
    if (this.sessions.get(id) === session && allFirstPagesSettled(session)) {
      this.finishInitialWait(session);
    }
    await initial;
    if (this.sessions.get(id) !== session || session.destroyed) {
      throw new SearchError("search-restart-required", 410);
    }
    this.touch(session);
    this.revalidate(session);
    return { id, snapshot: cloneSnapshot(this.responseSnapshot(session)) };
  }

  async poll(
    authority: SearchAuthority,
    id: string,
    revision: number,
    signal?: AbortSignal,
  ): Promise<{ changed: false; revision: number } | { changed: true; snapshot: CatalogSearchSnapshot }> {
    const session = this.getSession(authority, id);
    this.touch(session);
    this.revalidate(session);
    if (revision < session.revision) {
      return { changed: true, snapshot: cloneSnapshot(this.responseSnapshot(session)) };
    }
    if (session.waitingPoll !== undefined) {
      return revision < session.revision
        ? { changed: true, snapshot: cloneSnapshot(this.responseSnapshot(session)) }
        : { changed: false, revision: session.revision };
    }
    if (signal?.aborted) {
      return this.noChangeAnswer(session);
    }
    return new Promise((resolve, reject) => {
      const waiter: WaitingPoll = { resolve, reject };
      session.waitingPoll = waiter;
      const finish = (changed: boolean) => {
        if (session.waitingPoll !== waiter) return;
        session.waitingPoll = undefined;
        if (waiter.timer !== undefined) this.timers.clearTimeout(waiter.timer);
        if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
          waiter.signal.removeEventListener("abort", waiter.onAbort);
        }
        try {
          if (changed) resolve({ changed: true, snapshot: cloneSnapshot(this.responseSnapshot(session)) });
          else resolve(this.noChangeAnswer(session));
        } catch (error) {
          reject(error);
        }
      };
      waiter.timer = this.timers.setTimeout(() => finish(false), this.limits.pollWaitMs);
      if (signal !== undefined) {
        waiter.signal = signal;
        waiter.onAbort = () => finish(false);
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
    });
  }

  page(authority: SearchAuthority, id: string): { revision: number } {
    const session = this.getSession(authority, id);
    this.touch(session);
    this.revalidate(session);
    let scheduled = false;
    for (const target of session.targets) {
      if (target.exhausted || target.jobRunning) continue;
      target.state = "loading";
      this.schedulePage(session, target, false);
      scheduled = true;
    }
    if (scheduled) this.changed(session);
    return { revision: session.revision };
  }

  delete(authority: SearchAuthority, id: string): void {
    const session = this.sessions.get(id);
    if (session !== undefined && session.userId === authority.userId && session.sid === authority.sid) {
      this.destroy(session);
    }
  }

  dropSession(sid: string): void {
    for (const session of [...this.sessions.values()]) {
      if (session.sid === sid) this.destroy(session);
    }
  }

  dropUser(userId: string): void {
    for (const session of [...this.sessions.values()]) {
      if (session.userId === userId) this.destroy(session);
    }
  }

  invalidateContent(): void {
    for (const session of [...this.sessions.values()]) {
      if (this.removeDisallowedTargets(session)) this.changed(session);
    }
  }

  sweep(): void {
    const now = this.now();
    for (const session of [...this.sessions.values()]) {
      if (now - session.lastActivity >= this.limits.idleExpiryMs) this.destroy(session);
    }
    this.tombstones = this.tombstones.filter((tombstone) => tombstone.expiresAt > now);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const session of [...this.sessions.values()]) this.destroy(session);
    this.timers.clearInterval(this.sweepTimer);
  }

  size(): number {
    return this.sessions.size;
  }

  private slotKey(userId: string, sid: string, slotId: string): string {
    return `${userId}\0${sid}\0${slotId}`;
  }

  private getSession(authority: SearchAuthority, id: string): ManagedCatalogSession {
    const session = this.sessions.get(id);
    if (session === undefined) {
      const tombstone = this.tombstones.find((candidate) =>
        candidate.id === id
        && candidate.userId === authority.userId
        && candidate.sid === authority.sid
        && candidate.expiresAt > this.now(),
      );
      if (tombstone !== undefined) throw new SearchError("search-restart-required", 410);
      throw new SearchError("search-not-found", 404);
    }
    if (session.userId !== authority.userId || session.sid !== authority.sid) {
      throw new SearchError("search-not-found", 404);
    }
    if (!session.authority.isCurrent()) {
      this.destroy(session);
      throw new SearchError("search-restart-required", 410);
    }
    return session;
  }

  private touch(session: ManagedCatalogSession): void {
    session.lastActivity = this.now();
  }

  private changed(session: ManagedCatalogSession): void {
    if (session.destroyed) return;
    session.revision += 1;
    const waiter = session.waitingPoll;
    if (waiter === undefined) return;
    session.waitingPoll = undefined;
    if (waiter.timer !== undefined) this.timers.clearTimeout(waiter.timer);
    if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    try {
      waiter.resolve({ changed: true, snapshot: cloneSnapshot(this.responseSnapshot(session)) });
    } catch (error) {
      waiter.reject(error);
    }
  }

  private revalidate(session: ManagedCatalogSession): void {
    if (!session.authority.isCurrent()) {
      this.destroy(session);
      throw new SearchError("search-restart-required", 410);
    }
    if (this.removeDisallowedTargets(session)) this.changed(session);
  }

  private responseSnapshot(session: ManagedCatalogSession): CatalogSearchSnapshot {
    if (!session.authority.isCurrent()) {
      this.destroy(session);
      throw new SearchError("search-restart-required", 410);
    }
    if (this.removeDisallowedTargets(session)) session.revision += 1;
    return this.snapshot(session);
  }

  private noChangeAnswer(
    session: ManagedCatalogSession,
  ): { changed: false; revision: number } | { changed: true; snapshot: CatalogSearchSnapshot } {
    const previousRevision = session.revision;
    const snapshot = this.responseSnapshot(session);
    return snapshot.revision > previousRevision
      ? { changed: true, snapshot: cloneSnapshot(snapshot) }
      : { changed: false, revision: session.revision };
  }

  private removeDisallowedTargets(session: ManagedCatalogSession): boolean {
    let removed = false;
    for (const target of [...session.targets]) {
      let allowed = false;
      try {
        allowed = this.stillAllowed(session.authority, target.target);
      } catch {
        allowed = false;
      }
      if (!allowed) {
        this.removeTarget(session, target);
        removed = true;
      }
    }
    return removed;
  }

  private removeTarget(session: ManagedCatalogSession, target: StoredTarget): void {
    const index = session.targets.indexOf(target);
    if (index < 0) return;
    session.targets.splice(index, 1);
    target.jobToken += 1;
    target.jobRunning = false;
    target.jobCancel?.();
    target.jobCancel = undefined;
    target.firstSettled = true;
    if (allFirstPagesSettled(session)) this.finishInitialWait(session);
  }

  private schedulePage(session: ManagedCatalogSession, target: StoredTarget, announce: boolean): void {
    if (
      session.destroyed
      || target.exhausted
      || target.jobRunning
      || !session.targets.includes(target)
    ) {
      return;
    }
    target.jobRunning = true;
    if (announce) {
      target.state = "loading";
      this.changed(session);
    }
    const token = ++target.jobToken;
    const job: SchedulerJob = {
      sessionId: session.id,
      sourceClass: "catalog",
      poolKey: poolKeyOf(target.target),
      order: target.order,
      run: async (signal) => {
        if (
          session.destroyed
          || target.jobToken !== token
          || !session.targets.includes(target)
        ) {
          throw new Error("cancelled");
        }
        if (!session.authority.isCurrent()) {
          this.destroy(session);
          throw new Error("cancelled");
        }
        let allowed = false;
        try {
          allowed = this.stillAllowed(session.authority, target.target);
        } catch {
          allowed = false;
        }
        if (!allowed) {
          this.removeTarget(session, target);
          this.changed(session);
          throw new Error("cancelled");
        }
        const skip = target.offset;
        const metas = await this.fetchPage(
          target.target,
          session.request.query,
          skip,
          signal,
          session.id,
        );
        if (
          session.destroyed
          || target.jobToken !== token
          || !session.targets.includes(target)
        ) {
          return;
        }
        this.applyPage(session, target, metas);
      },
    };
    const task = this.scheduler.enqueue(job);
    target.jobCancel = task.cancel;
    void task.done.then((result) => this.finishPageJob(session, target, token, result));
  }

  private applyPage(session: ManagedCatalogSession, target: StoredTarget, metas: MetaItem[]): void {
    if (metas.length === 0) {
      target.state = "idle";
      target.exhausted = true;
      this.changed(session);
      return;
    }
    const addonName = target.target.addon.manifest.name;
    const rows = metas.map((meta) => ({
      ...meta,
      type: meta.type || target.target.definition.type,
      addonName,
    }));
    target.pages.push(rows);
    target.offset += rows.length;
    target.state = "idle";
    this.changed(session);
  }

  private finishPageJob(
    session: ManagedCatalogSession,
    target: StoredTarget,
    token: number,
    result: "ok" | "error" | "cancelled" | "hardLimit",
  ): void {
    if (session.destroyed || target.jobToken !== token || !session.targets.includes(target)) return;
    target.jobRunning = false;
    target.jobCancel = undefined;
    target.jobToken += 1;
    if (result === "error" || result === "hardLimit") {
      target.state = "failed";
      target.exhausted = true;
      this.changed(session);
    } else if (result === "cancelled" && target.state === "loading") {
      target.state = "idle";
      this.changed(session);
    }
    target.firstSettled = true;
    if (allFirstPagesSettled(session)) this.finishInitialWait(session);
  }

  private finishInitialWait(session: ManagedCatalogSession): void {
    if (session.initialResolve === undefined) return;
    if (session.initialTimer !== undefined) {
      this.timers.clearTimeout(session.initialTimer);
      session.initialTimer = undefined;
    }
    const resolve = session.initialResolve;
    session.initialResolve = undefined;
    resolve();
  }

  private snapshot(session: ManagedCatalogSession): CatalogSearchSnapshot {
    const seen = new Map<string, MetaItem>();
    for (const target of [...session.targets].sort((left, right) => left.order - right.order)) {
      const addonName = target.target.addon.manifest.name;
      for (const page of target.pages) {
        for (const meta of page) {
          const key = `${meta.type || target.target.definition.type}:${meta.id}`;
          const existing = seen.get(key);
          if (existing !== undefined) {
            const sources = Array.isArray(existing.sources) ? existing.sources as string[] : [];
            if (!sources.includes(addonName)) sources.push(addonName);
            existing.sources = sources;
          } else {
            seen.set(key, { ...meta, sources: [addonName] });
          }
        }
      }
    }
    return {
      revision: session.revision,
      state: session.targets.some((target) => target.state === "loading") ? "partial" : "complete",
      items: [...seen.values()].map((item) => this.rewriteMeta(item)),
      sources: session.targets.length,
      pending: session.targets.filter((target) => target.state === "loading").length,
      failed: session.targets.filter((target) => target.state === "failed").length,
      hasMore: session.targets.some((target) => !target.exhausted),
    };
  }

  private destroy(session: ManagedCatalogSession): void {
    if (session.destroyed) return;
    session.destroyed = true;
    this.sessions.delete(session.id);
    if (this.slots.get(session.slotKey) === session.id) this.slots.delete(session.slotKey);
    this.scheduler.cancelSession(session.id);
    for (const target of session.targets) {
      target.jobToken += 1;
      target.jobRunning = false;
      target.jobCancel?.();
      target.jobCancel = undefined;
    }
    const waiter = session.waitingPoll;
    if (waiter !== undefined) {
      session.waitingPoll = undefined;
      if (waiter.timer !== undefined) this.timers.clearTimeout(waiter.timer);
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.reject(new SearchError("search-restart-required", 410));
    }
    if (session.initialTimer !== undefined) {
      this.timers.clearTimeout(session.initialTimer);
      session.initialTimer = undefined;
    }
    session.initialResolve?.();
    session.initialResolve = undefined;
    this.writeTombstone(session);
  }

  private writeTombstone(session: ManagedCatalogSession): void {
    const now = this.now();
    this.tombstones = this.tombstones.filter((tombstone) =>
      tombstone.id !== session.id && tombstone.expiresAt > now,
    );
    this.tombstones.push({
      id: session.id,
      userId: session.userId,
      sid: session.sid,
      expiresAt: now + this.limits.tombstoneTtlMs,
    });
    if (this.tombstones.length > this.limits.tombstoneMax) {
      this.tombstones.splice(0, this.tombstones.length - this.limits.tombstoneMax);
    }
  }
}

const allFirstPagesSettled = (session: ManagedCatalogSession): boolean =>
  session.targets.every((target) => target.firstSettled);
