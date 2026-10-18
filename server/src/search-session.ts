import { createHash, randomBytes } from "node:crypto";
import {
  SEARCH_LIMITS,
  SearchError,
  projectRecord,
  type RawSearchRecord,
  type SearchClusterView,
  type SearchKind,
  type SearchMember,
  type SearchMemberPage,
  type SearchSnapshot,
  type SearchSourceClass,
  type SearchSourceState,
  type SearchStartRequest,
  type StrongIds,
} from "./search-contracts.js";
import {
  ClusterKeyTracker,
  clusterIdentities,
  episodeIdentity,
  pickPrimary,
  titleRank,
  validStrongIds,
  type DisplayCandidate,
  type IdentityGroup,
  type IdentityInput,
} from "./search-identity.js";
import { SearchScheduler, type SchedulerJob } from "./search-scheduler.js";

export class SourceFailure extends Error {
  readonly code:
    | "timeout"
    | "abort"
    | "network"
    | "invalid-json"
    | "unavailable"
    | "cancelled"
    | `http-${number}`;

  constructor(code: "timeout" | "abort" | "network" | "invalid-json" | "unavailable" | "cancelled" | `http-${number}`) {
    super(code);
    this.name = "SourceFailure";
    this.code = code;
  }
}

export interface SourcePage {
  records: RawSearchRecord[];
  cursor?: unknown;
  exhausted: boolean;
  indexing?: boolean;
  stale?: boolean;
}

export interface SearchSource {
  id: string;
  sourceClass: SearchSourceClass;
  label: string;
  poolKey: string;
  continuation: "supported" | "unsupported";
  next(cursor: unknown, signal: AbortSignal): Promise<SourcePage>;
  stillAllowed(): boolean;
  onReady?(listener: () => void): () => void;
}

export interface SearchAuthority {
  userId: string;
  sid: string;
  isCurrent(): boolean;
}

interface SessionTimerApi {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface SessionDeps {
  scheduler: SearchScheduler;
  discover(
    authority: SearchAuthority,
    request: SearchStartRequest,
    sessionId: string,
  ): SearchSource[] | Promise<SearchSource[]>;
  now?: () => number;
  randomId?: () => string;
  timers?: SessionTimerApi;
  limits?: Partial<{ [K in keyof typeof SEARCH_LIMITS]: number }>;
}

interface StoredRecord {
  memberKey: string;
  sequence: number;
  record: RawSearchRecord;
  source: SourceState;
  serializedLength: number;
}

interface SourceState {
  source: SearchSource;
  order: number;
  state: SearchSourceState;
  stateBeforePage: SearchSourceState;
  records: Map<string, StoredRecord>;
  buffer: RawSearchRecord[];
  cursor: unknown;
  exhausted: boolean;
  stale: boolean;
  errorCode?: string;
  continuation: "supported" | "unsupported" | "blocked";
  noProgress: number;
  dropped: number;
  firstSettled: boolean;
  jobRunning: boolean;
  jobToken: number;
  jobCancel?: () => void;
  jobFailure?: unknown;
  readyUnsubscribe?: () => void;
  lastRetryAt?: number;
}

interface WaitingPoll {
  revision: number;
  resolve: (answer: { changed: false; revision: number } | { changed: true; snapshot: SearchSnapshot }) => void;
  timer?: unknown;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface RawGroup {
  key: string;
  conflict: boolean;
  kind: SearchKind;
  members: StoredRecord[];
  ids: StrongIds;
  parentsCompatible: boolean;
  view: SearchClusterView;
}

interface ManagedSession {
  id: string;
  userId: string;
  sid: string;
  slotKey: string;
  authority: SearchAuthority;
  request: SearchStartRequest;
  revision: number;
  sources: SourceState[];
  records: Map<string, StoredRecord>;
  sequence: number;
  recordBytes: number;
  limitReached: boolean;
  lastActivity: number;
  tracker: ClusterKeyTracker;
  groups: RawGroup[];
  groupByMember: Map<string, RawGroup>;
  childrenByParent: Map<string, RawGroup[]>;
  mainOrder: string[];
  unidentifiedOrder: string[];
  previousVisibleMembers: Map<string, Set<string>>;
  aliases: { retired: string; current: string }[];
  waitingPoll?: WaitingPoll;
  initialResolve?: () => void;
  initialTimer?: unknown;
  destroyed: boolean;
  recordsDirty: boolean;
}

interface Tombstone {
  id: string;
  userId: string;
  sid: string;
  expiresAt: number;
}

const NAMESPACES = ["imdb", "tmdb", "tvdb"] as const;
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const memberKeyFor = (sourceId: string, itemKey: string, kind: SearchKind): string =>
  createHash("sha256").update(`${sourceId}\0${itemKey}\0${kind}`).digest("base64url").slice(0, 22);

const cut = (value: string, maximum: number): string => {
  const points = Array.from(value.trim());
  return points.length <= maximum ? value.trim() : points.slice(0, maximum).join("");
};

const cloneLocator = (locator: RawSearchRecord["locator"]): RawSearchRecord["locator"] => {
  if (locator.kind === "catalog") {
    return {
      kind: "catalog",
      addonKey: locator.addonKey,
      type: locator.type,
      id: locator.id,
      ...(locator.catalogId === undefined ? {} : { catalogId: locator.catalogId }),
    };
  }
  if (locator.kind === "local") {
    return { kind: "local", key: locator.key, libraryId: locator.libraryId, itemKind: locator.itemKind };
  }
  return {
    kind: "remote",
    libraryId: locator.libraryId,
    itemId: locator.itemId,
    itemType: locator.itemType,
    ...(locator.provider === undefined ? {} : { provider: locator.provider }),
  };
};

const cloneIds = (ids: StrongIds | undefined): StrongIds | undefined => {
  if (ids === undefined) return undefined;
  return {
    ...(ids.imdb === undefined ? {} : { imdb: ids.imdb }),
    ...(ids.tmdb === undefined ? {} : { tmdb: ids.tmdb }),
    ...(ids.tvdb === undefined ? {} : { tvdb: ids.tvdb }),
  };
};

const cloneSnapshot = (snapshot: SearchSnapshot): SearchSnapshot => ({
  revision: snapshot.revision,
  state: snapshot.state,
  sources: snapshot.sources.map((source) => ({
    ...source,
    ...(source.stale === undefined ? {} : { stale: source.stale }),
    ...(source.errorCode === undefined ? {} : { errorCode: source.errorCode }),
    ...(source.dropped === undefined ? {} : { dropped: source.dropped }),
  })),
  clusters: snapshot.clusters.map((cluster) => ({
    ...cluster,
    sourceLabels: [...cluster.sourceLabels],
    memberKeys: [...cluster.memberKeys],
  })),
  unidentified: snapshot.unidentified.map((cluster) => ({
    ...cluster,
    sourceLabels: [...cluster.sourceLabels],
    memberKeys: [...cluster.memberKeys],
  })),
  aliases: snapshot.aliases.map((alias) => ({ ...alias })),
  limitReached: snapshot.limitReached,
});

const idsHaveValue = (ids: StrongIds): boolean => NAMESPACES.some((namespace) => ids[namespace] !== undefined);

const mergeIds = (records: StoredRecord[], parentIds: Map<string, StrongIds>): { ids: StrongIds; compatible: boolean } => {
  const ids: StrongIds = {};
  let compatible = true;
  for (const record of records) {
    const values = record.record.kind === "episode"
      ? parentIds.get(record.memberKey) ?? {}
      : validStrongIds(record.record.ids);
    for (const namespace of NAMESPACES) {
      const value = values[namespace];
      if (value === undefined) continue;
      if (ids[namespace] !== undefined && ids[namespace] !== value) compatible = false;
      if (ids[namespace] === undefined) ids[namespace] = value;
    }
  }
  return { ids, compatible };
};

const shareAndCompatible = (left: StrongIds, right: StrongIds): boolean => {
  let shared = false;
  for (const namespace of NAMESPACES) {
    if (left[namespace] !== undefined && right[namespace] !== undefined) {
      if (left[namespace] !== right[namespace]) return false;
      shared = true;
    }
  }
  return shared;
};

export class SearchSessionManager {
  private readonly scheduler: SearchScheduler;
  private readonly discover: SessionDeps["discover"];
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly timers: SessionTimerApi;
  private readonly limits: Record<keyof typeof SEARCH_LIMITS, number>;
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly slots = new Map<string, string>();
  private tombstones: Tombstone[] = [];
  private readonly sweepTimer: unknown;
  private closed = false;

  constructor(deps: SessionDeps) {
    this.scheduler = deps.scheduler;
    this.discover = deps.discover;
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
    request: SearchStartRequest,
  ): Promise<{ id: string; snapshot: SearchSnapshot }> {
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
        return { id: existing.id, snapshot: cloneSnapshot(this.snapshot(existing)) };
      }
    }
    if (!authority.isCurrent()) throw new SearchError("search-restart-required", 410);

    let id: string;
    do {
      id = `ss_${this.randomId()}`;
    } while (this.sessions.has(id));
    const discovered = this.discover(authority, request, id);
    const sources = Array.isArray(discovered) ? discovered : await discovered;
    if (sources.length > this.limits.targetsPerSession) {
      const counts: Record<string, number> = { catalog: 0, local: 0, remote: 0 };
      for (const source of sources) counts[source.sourceClass] = (counts[source.sourceClass] ?? 0) + 1;
      throw new SearchError("search-too-broad", 422, counts);
    }

    if (existing !== undefined) this.destroy(existing);
    // A page that was reloaded or closed leaves its session behind until it expires. The same
    // browser session asking again gives up its own least recently used seat rather than being
    // refused; nobody else's search is ever touched.
    const owned = [...this.sessions.values()]
      .filter((session) => session.userId === authority.userId && session.sid === authority.sid)
      .sort((left, right) => left.lastActivity - right.lastActivity);
    while (owned.length >= this.limits.sessionsPerBrowserSession) this.destroy(owned.shift()!);
    if (this.sessions.size >= this.limits.sessionsServerWide) {
      throw new SearchError("search-capacity-limit", 503);
    }

    const session: ManagedSession = {
      id,
      userId: authority.userId,
      sid: authority.sid,
      slotKey,
      authority,
      request: {
        ...request,
        sources: [...request.sources],
      },
      revision: 1,
      sources: [],
      records: new Map(),
      sequence: 0,
      recordBytes: 0,
      limitReached: false,
      lastActivity: this.now(),
      tracker: new ClusterKeyTracker(),
      groups: [],
      groupByMember: new Map(),
      childrenByParent: new Map(),
      mainOrder: [],
      unidentifiedOrder: [],
      previousVisibleMembers: new Map(),
      aliases: [],
      destroyed: false,
      recordsDirty: false,
    };
    for (const [order, source] of sources.entries()) {
      session.sources.push({
        source,
        order,
        state: "queued",
        stateBeforePage: "queued",
        records: new Map(),
        buffer: [],
        cursor: undefined,
        exhausted: false,
        stale: false,
        continuation: source.continuation,
        noProgress: 0,
        dropped: 0,
        firstSettled: false,
        jobRunning: false,
        jobToken: 0,
      });
    }
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
    for (const source of session.sources) this.schedulePage(session, source);
    if (this.sessions.get(id) === session && allFirstPagesSettled(session)) {
      this.finishInitialWait(session);
    }
    await initial;
    if (this.sessions.get(id) !== session || session.destroyed) {
      throw new SearchError("search-restart-required", 410);
    }
    this.touch(session);
    this.revalidate(session);
    return { id, snapshot: cloneSnapshot(this.snapshot(session)) };
  }

  async poll(
    authority: SearchAuthority,
    id: string,
    revision: number,
    signal?: AbortSignal,
  ): Promise<{ changed: false; revision: number } | { changed: true; snapshot: SearchSnapshot }> {
    const session = this.getSession(authority, id);
    this.touch(session);
    this.revalidate(session);
    if (revision < session.revision) {
      return { changed: true, snapshot: cloneSnapshot(this.snapshot(session)) };
    }
    if (session.waitingPoll !== undefined) {
      return revision < session.revision
        ? { changed: true, snapshot: cloneSnapshot(this.snapshot(session)) }
        : { changed: false, revision: session.revision };
    }
    if (signal?.aborted) return { changed: false, revision: session.revision };
    return new Promise((resolve) => {
      const waiter: WaitingPoll = { revision, resolve };
      session.waitingPoll = waiter;
      const finish = (changed: boolean) => {
        if (session.waitingPoll !== waiter) return;
        session.waitingPoll = undefined;
        if (waiter.timer !== undefined) this.timers.clearTimeout(waiter.timer);
        if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
          waiter.signal.removeEventListener("abort", waiter.onAbort);
        }
        if (changed) resolve({ changed: true, snapshot: cloneSnapshot(this.snapshot(session)) });
        else resolve({ changed: false, revision: session.revision });
      };
      waiter.timer = this.timers.setTimeout(() => finish(false), this.limits.pollWaitMs);
      if (signal !== undefined) {
        waiter.signal = signal;
        waiter.onAbort = () => finish(false);
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
    });
  }

  pageAll(authority: SearchAuthority, id: string): { revision: number } {
    const session = this.getSession(authority, id);
    this.touch(session);
    this.revalidate(session);
    if (!session.limitReached) {
      for (const source of session.sources) {
        if (this.hasMore(session, source) && !source.jobRunning) this.schedulePage(session, source);
      }
    }
    return { revision: session.revision };
  }

  retry(authority: SearchAuthority, id: string, sourceId: string): { revision: number } {
    const session = this.getSession(authority, id);
    this.touch(session);
    this.revalidate(session);
    const source = session.sources.find((candidate) => candidate.source.id === sourceId);
    if (source === undefined || !retryable(source.state)) {
      throw new SearchError("search-not-retryable", 409);
    }
    const now = this.now();
    if (source.lastRetryAt !== undefined && now - source.lastRetryAt < this.limits.retryMinIntervalMs) {
      throw new SearchError("search-retry-limited", 429);
    }
    source.lastRetryAt = now;
    source.noProgress = 0;
    source.continuation = source.source.continuation;
    source.errorCode = undefined;
    source.state = "queued";
    source.stateBeforePage = "queued";
    this.changed(session);
    this.schedulePage(session, source);
    return { revision: session.revision };
  }

  members(authority: SearchAuthority, id: string, memberKey: string, from: number): SearchMemberPage {
    const session = this.getSession(authority, id);
    this.touch(session);
    this.revalidate(session);
    if (!Number.isSafeInteger(from) || from < 0) throw new SearchError("search-invalid-request", 400);
    const group = session.groupByMember.get(memberKey);
    if (group === undefined) throw new SearchError("search-not-found", 404);
    const records = [...group.members];
    if (group.kind === "series") {
      const children = session.childrenByParent.get(group.key) ?? [];
      records.push(...children
        .flatMap((child) => child.members)
        .sort((left, right) =>
          (left.record.season ?? Number.MAX_SAFE_INTEGER) - (right.record.season ?? Number.MAX_SAFE_INTEGER)
          || (left.record.episode ?? Number.MAX_SAFE_INTEGER) - (right.record.episode ?? Number.MAX_SAFE_INTEGER)
          || compareText(left.memberKey, right.memberKey),
        ));
    }
    const allMembers = records.map((record) => this.memberView(record, group.conflict));
    const canonical = this.canonical(group);
    const pageFor = (end: number): SearchMemberPage => {
      const truncated = end < allMembers.length;
      return {
        clusterKey: group.key,
        members: allMembers.slice(from, end),
        ...(truncated ? { nextFrom: end } : {}),
        truncated,
        ...(canonical === undefined ? {} : { canonical }),
      };
    };
    if (from >= allMembers.length) return pageFor(from);
    const maximum = Math.min(allMembers.length, from + this.limits.membersPerPage);
    let end = from;
    while (end < maximum) {
      const candidateEnd = end + 1;
      const candidate = pageFor(candidateEnd);
      if (candidateEnd > from + 1 && JSON.stringify(candidate).length > this.limits.memberPageBytes) break;
      end = candidateEnd;
      if (JSON.stringify(candidate).length > this.limits.memberPageBytes) break;
    }
    return pageFor(end);
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
      const removed = this.removeDisallowedSources(session);
      if (removed) this.changed(session);
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

  private getSession(authority: SearchAuthority, id: string): ManagedSession {
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

  private touch(session: ManagedSession): void {
    session.lastActivity = this.now();
  }

  private changed(session: ManagedSession): void {
    if (session.destroyed) return;
    session.revision += 1;
    if (session.recordsDirty) {
      session.recordsDirty = false;
      this.rebuild(session);
    }
    const waiter = session.waitingPoll;
    if (waiter !== undefined) {
      session.waitingPoll = undefined;
      if (waiter.timer !== undefined) this.timers.clearTimeout(waiter.timer);
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve({ changed: true, snapshot: cloneSnapshot(this.snapshot(session)) });
    }
  }

  private revalidate(session: ManagedSession): void {
    if (!session.authority.isCurrent()) {
      this.destroy(session);
      throw new SearchError("search-restart-required", 410);
    }
    if (this.removeDisallowedSources(session)) this.changed(session);
  }

  private removeDisallowedSources(session: ManagedSession): boolean {
    let removed = false;
    for (const source of [...session.sources]) {
      let allowed = false;
      try {
        allowed = source.source.stillAllowed();
      } catch {
        allowed = false;
      }
      if (!allowed) {
        this.removeSource(session, source);
        removed = true;
      }
    }
    return removed;
  }

  private removeSource(session: ManagedSession, source: SourceState): void {
    const index = session.sources.indexOf(source);
    if (index < 0) return;
    session.sources.splice(index, 1);
    source.jobToken += 1;
    source.jobRunning = false;
    source.jobCancel?.();
    source.jobCancel = undefined;
    source.readyUnsubscribe?.();
    source.readyUnsubscribe = undefined;
    for (const item of source.records.values()) {
      if (session.records.get(item.memberKey) === item) {
        session.records.delete(item.memberKey);
        session.recordBytes -= item.serializedLength;
      }
    }
    if (source.records.size) session.recordsDirty = true;
    source.records.clear();
    source.buffer = [];
    if (allFirstPagesSettled(session)) this.finishInitialWait(session);
  }

  private schedulePage(session: ManagedSession, source: SourceState): void {
    if (
      session.destroyed
      || session.limitReached
      || !session.sources.includes(source)
      || source.jobRunning
    ) {
      return;
    }
    source.jobRunning = true;
    source.stateBeforePage = source.state;
    if (source.state !== "queued") {
      source.state = "queued";
      this.changed(session);
    }
    source.jobFailure = undefined;
    const token = ++source.jobToken;
    const job: SchedulerJob = {
      sessionId: session.id,
      sourceClass: source.source.sourceClass,
      poolKey: source.source.poolKey,
      order: source.order,
      run: async (signal) => {
        if (
          session.destroyed
          || source.jobToken !== token
          || !session.sources.includes(source)
        ) {
          throw new SourceFailure("cancelled");
        }
        if (!session.authority.isCurrent()) {
          this.destroy(session);
          throw new SourceFailure("cancelled");
        }
        let allowed = false;
        try {
          allowed = source.source.stillAllowed();
        } catch {
          allowed = false;
        }
        if (!allowed) {
          this.removeSource(session, source);
          this.changed(session);
          throw new SourceFailure("cancelled");
        }
        if (source.state === "queued") {
          source.state = "loading";
          this.changed(session);
        }
        try {
          await this.fetchPage(session, source, token, signal);
        } catch (error) {
          if (source.jobToken === token) source.jobFailure = error;
          throw error;
        }
      },
    };
    const task = this.scheduler.enqueue(job);
    source.jobCancel = task.cancel;
    void task.done.then((result) => this.finishPageJob(session, source, token, result));
  }

  private async fetchPage(
    session: ManagedSession,
    source: SourceState,
    token: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (session.limitReached) {
      source.state = "ready";
      this.changed(session);
      return;
    }
    if (source.buffer.length > 0) {
      if (source.jobToken !== token) return;
      this.applyRecords(session, source, source.buffer.splice(0, this.limits.recordsPerPage), token);
      return;
    }
    const page = await source.source.next(source.cursor, signal);
    if (
      source.jobToken !== token
      || session.destroyed
      || !session.sources.includes(source)
      || session.limitReached
    ) {
      return;
    }
    if (page.indexing === true) {
      source.stale = page.stale === true;
      source.state = "indexing";
      this.changed(session);
      this.subscribeReady(session, source);
      return;
    }
    if (page.stale !== undefined) source.stale = page.stale;
    source.cursor = page.cursor;
    source.exhausted = page.exhausted;
    const rows: RawSearchRecord[] = [];
    for (const record of page.records) {
      const projected = projectRecord(record);
      if (projected === undefined) {
        source.dropped += 1;
        continue;
      }
      if (!matchesKind(projected, session.request.kind)) continue;
      rows.push(projected);
    }
    const acceptedRows = rows.slice(0, this.limits.recordsPerPage);
    source.buffer.push(...rows.slice(this.limits.recordsPerPage));
    this.applyRecords(session, source, acceptedRows, token);
  }

  private subscribeReady(session: ManagedSession, source: SourceState): void {
    if (source.readyUnsubscribe !== undefined || source.source.onReady === undefined) return;
    let unsubscribe: undefined | (() => void);
    const listener = () => {
      unsubscribe?.();
      source.readyUnsubscribe = undefined;
      if (session.destroyed || !session.sources.includes(source)) return;
      if (source.state !== "indexing") return;
      source.state = "queued";
      this.changed(session);
      this.schedulePage(session, source);
    };
    unsubscribe = source.source.onReady(listener);
    source.readyUnsubscribe = unsubscribe;
  }

  private applyRecords(
    session: ManagedSession,
    source: SourceState,
    records: RawSearchRecord[],
    token: number,
  ): void {
    if (source.jobToken !== token || session.destroyed) return;
    let gained = false;
    for (const record of records) {
      if (session.limitReached) break;
      const memberKey = memberKeyFor(source.source.id, record.itemKey, record.kind);
      const existing = session.records.get(memberKey);
      const serializedLength = JSON.stringify(record).length;
      const nextCount = session.records.size + (existing === undefined ? 1 : 0);
      const nextBytes = session.recordBytes - (existing?.serializedLength ?? 0) + serializedLength;
      if (nextCount > this.limits.recordsPerSession || nextBytes > this.limits.recordBytesPerSession) {
        session.limitReached = true;
        break;
      }
      if (existing === undefined) {
        const stored: StoredRecord = {
          memberKey,
          sequence: ++session.sequence,
          record,
          source,
          serializedLength,
        };
        session.records.set(memberKey, stored);
        source.records.set(memberKey, stored);
        session.recordsDirty = true;
        session.recordBytes += serializedLength;
        gained = true;
      } else {
        session.recordBytes = session.recordBytes - existing.serializedLength + serializedLength;
        existing.record = record;
        existing.serializedLength = serializedLength;
        session.recordsDirty = true;
        source.records.set(memberKey, existing);
      }
    }
    if (gained) source.noProgress = 0;
    else source.noProgress += 1;

    if (source.noProgress >= this.limits.noProgressPagesToStall) {
      source.state = "stalled";
      source.continuation = "blocked";
      source.errorCode = "no-progress";
    } else if (session.limitReached) {
      source.state = "ready";
      source.errorCode = undefined;
    } else if (source.continuation === "unsupported") {
      source.state = "ready";
      source.errorCode = undefined;
    } else if (source.exhausted && source.buffer.length === 0) {
      source.state = "exhausted";
      source.errorCode = undefined;
    } else {
      source.state = "ready";
      source.errorCode = undefined;
    }
    this.changed(session);
  }

  private finishPageJob(
    session: ManagedSession,
    source: SourceState,
    token: number,
    result: "ok" | "error" | "cancelled" | "hardLimit",
  ): void {
    if (session.destroyed || source.jobToken !== token || !session.sources.includes(source)) return;
    source.jobRunning = false;
    source.jobCancel = undefined;
    source.jobToken += 1;
    if (result === "error") {
      this.applyFailure(session, source, source.jobFailure);
    } else if (result === "hardLimit") {
      this.setFailure(session, source, "timedOut", "timeout");
    } else if (result === "ok" && session.limitReached && source.state === "loading") {
      source.state = "ready";
      this.changed(session);
    } else if (result === "cancelled" && source.state === "loading") {
      source.state = source.stateBeforePage;
      this.changed(session);
    }
    source.jobFailure = undefined;
    source.firstSettled = true;
    if (allFirstPagesSettled(session)) this.finishInitialWait(session);
  }

  private applyFailure(session: ManagedSession, source: SourceState, error: unknown): void {
    if (error instanceof SourceFailure) {
      if (error.code === "cancelled") {
        source.state = source.stateBeforePage;
        this.changed(session);
        return;
      }
      if (error.code === "timeout") {
        this.setFailure(session, source, "timedOut", error.code);
      } else if (error.code === "unavailable") {
        this.setFailure(session, source, "unavailable", error.code);
      } else {
        this.setFailure(session, source, "failed", error.code);
      }
      return;
    }
    this.setFailure(session, source, "failed", "internal");
  }

  private setFailure(
    session: ManagedSession,
    source: SourceState,
    state: "failed" | "timedOut" | "unavailable",
    errorCode: string,
  ): void {
    source.state = state;
    source.errorCode = errorCode;
    this.changed(session);
  }

  private finishInitialWait(session: ManagedSession): void {
    if (session.initialResolve === undefined) return;
    if (session.initialTimer !== undefined) {
      this.timers.clearTimeout(session.initialTimer);
      session.initialTimer = undefined;
    }
    const resolve = session.initialResolve;
    session.initialResolve = undefined;
    resolve();
  }

  private hasMore(session: ManagedSession, source: SourceState): boolean {
    return source.state === "ready"
      && source.continuation === "supported"
      && !session.limitReached
      && (source.buffer.length > 0 || !source.exhausted);
  }

  private snapshot(session: ManagedSession): SearchSnapshot {
    const clusters = this.viewsInOrder(session, session.mainOrder);
    const unidentified = this.viewsInOrder(session, session.unidentifiedOrder);
    const pending = session.sources.some((source) =>
      source.state === "queued" || source.state === "loading" || source.state === "indexing",
    );
    const failedOnly = session.sources.length > 0
      && session.sources.every((source) =>
        source.state === "failed" || source.state === "timedOut" || source.state === "unavailable",
      );
    const state: SearchSnapshot["state"] = pending
      ? "partial"
      : failedOnly && clusters.length + unidentified.length === 0
        ? "failed"
        : "complete";
    return {
      revision: session.revision,
      state,
      sources: session.sources.map((source) => ({
        id: source.source.id,
        sourceClass: source.source.sourceClass,
        label: cut(source.source.label, this.limits.labelMaxCodePoints),
        state: source.state,
        loaded: source.records.size,
        hasMore: this.hasMore(session, source),
        continuation: source.continuation,
        ...(source.stale ? { stale: true } : {}),
        retryable: retryable(source.state),
        ...(source.errorCode === undefined ? {} : { errorCode: source.errorCode }),
        ...(source.dropped === 0 ? {} : { dropped: source.dropped }),
      })),
      clusters,
      unidentified,
      aliases: session.aliases.map((alias) => ({ ...alias })),
      limitReached: session.limitReached,
    };
  }

  private viewsInOrder(session: ManagedSession, order: string[]): SearchClusterView[] {
    const byKey = new Map(session.groups.map((group) => [group.key, group]));
    return order.flatMap((key) => {
      const group = byKey.get(key);
      return group === undefined
        ? []
        : [{
          ...group.view,
          sourceLabels: [...group.view.sourceLabels],
          memberKeys: [...group.view.memberKeys],
        }];
    });
  }

  private rebuild(session: ManagedSession): void {
    const records = [...session.records.values()].sort((left, right) =>
      left.sequence - right.sequence || compareText(left.memberKey, right.memberKey),
    );
    const byItem = new Map(records.map((stored) => [`${stored.source.source.id}\0${stored.record.itemKey}`, stored]));
    const resolvedParents = new Map<string, StrongIds>();
    const identityIds = new Map<string, StrongIds>();
    for (const stored of records) {
      if (stored.record.kind !== "episode") continue;
      let ids = validStrongIds(stored.record.parentIds);
      if (!idsHaveValue(ids) && stored.record.parentRef !== undefined) {
        const parent = byItem.get(`${stored.source.source.id}\0${stored.record.parentRef}`);
        if (parent !== undefined) ids = validStrongIds(parent.record.ids);
      }
      if (idsHaveValue(ids)) resolvedParents.set(stored.memberKey, ids);
      if (
        idsHaveValue(ids)
        && stored.record.season !== undefined
        && stored.record.episode !== undefined
      ) {
        ids = episodeIdentity(
          ids,
          stored.record.season,
          stored.record.episode,
          stored.record.episodeEnd,
        );
      } else {
        ids = {};
      }
      identityIds.set(stored.memberKey, ids);
    }

    const inputs: IdentityInput[] = records.map((stored) => ({
      memberKey: stored.memberKey,
      sequence: stored.sequence,
      kind: stored.record.kind,
      ids: identityIds.get(stored.memberKey) ?? validStrongIds(stored.record.ids),
      ...(stored.record.opaque === undefined ? {} : { opaque: stored.record.opaque }),
    }));
    const identities = clusterIdentities(inputs);
    const assigned = session.tracker.assign(
      identities.map((group) => group.memberKeys),
      (memberKey) => session.records.get(memberKey)!.sequence,
    );
    session.aliases = assigned.aliases;

    const stores = new Map(records.map((record) => [record.memberKey, record]));
    const rawGroups = identities.map((identity, index) =>
      this.rawGroup(session, identity, assigned.keys[index]!, stores, resolvedParents),
    );

    const attached = new Map<string, RawGroup[]>();
    const attachedKeys = new Set<string>();
    const seriesGroups = rawGroups.filter((group) => group.kind === "series" && !group.conflict && group.parentsCompatible);
    for (const group of rawGroups) {
      if (group.kind !== "episode" || !group.parentsCompatible || !idsHaveValue(group.ids)) continue;
      const matches = seriesGroups.filter((series) =>
        idsHaveValue(series.ids) && shareAndCompatible(group.ids, series.ids),
      );
      if (matches.length !== 1) continue;
      const series = matches[0]!;
      const children = attached.get(series.key) ?? [];
      children.push(group);
      attached.set(series.key, children);
      attachedKeys.add(group.key);
    }
    for (const [seriesKey, children] of attached) {
      const series = rawGroups.find((group) => group.key === seriesKey);
      if (series !== undefined) series.view.episodeCount = children.length;
    }

    session.groups = rawGroups;
    session.childrenByParent = attached;
    session.groupByMember = new Map();
    for (const group of rawGroups) {
      for (const member of group.members) session.groupByMember.set(member.memberKey, group);
    }

    const main = rawGroups.filter((group) =>
      group.kind !== "folder" && group.kind !== "file" && group.kind !== "season" && !attachedKeys.has(group.key),
    );
    const unidentified = rawGroups.filter((group) =>
      group.kind === "folder" || group.kind === "file" || group.kind === "season",
    );
    session.mainOrder = this.orderGroups(main, session.mainOrder, session.previousVisibleMembers);
    session.unidentifiedOrder = this.orderGroups(unidentified, session.unidentifiedOrder, session.previousVisibleMembers);
    session.previousVisibleMembers = new Map(
      [...main, ...unidentified].map((group) => [group.key, new Set(group.members.map((member) => member.memberKey))]),
    );
  }

  private rawGroup(
    session: ManagedSession,
    identity: IdentityGroup,
    key: string,
    stores: Map<string, StoredRecord>,
    parentIds: Map<string, StrongIds>,
  ): RawGroup {
    const members = identity.memberKeys.map((memberKey) => stores.get(memberKey)!);
    const kind = members[0]!.record.kind;
    const candidates: DisplayCandidate[] = members.map((member) => ({
      memberKey: member.memberKey,
      sequence: member.sequence,
      sourceOrder: member.source.order,
      sourceClass: member.source.source.sourceClass,
      itemKey: member.record.itemKey,
      title: member.record.title,
      ...(member.record.originalTitle === undefined ? {} : { originalTitle: member.record.originalTitle }),
      ...(member.record.year === undefined ? {} : { year: member.record.year }),
      ...(member.record.poster === undefined ? {} : { poster: member.record.poster }),
      ...(member.record.background === undefined ? {} : { background: member.record.background }),
      ...(member.record.description === undefined ? {} : { description: member.record.description }),
      hasStrongId: idsHaveValue(parentIds.get(member.memberKey) ?? validStrongIds(member.record.ids)),
    }));
    const primary = pickPrimary(session.request.query, candidates);
    let year = primary.year;
    let poster = primary.poster;
    let background = primary.background;
    for (const candidate of candidates) {
      year ??= candidate.year;
      poster ??= candidate.poster;
      background ??= candidate.background;
    }
    const merged = mergeIds(members, parentIds);
    const sourceLabels: string[] = [];
    for (const member of members) {
      const label = cut(member.source.source.label, this.limits.labelMaxCodePoints);
      if (!sourceLabels.includes(label)) sourceLabels.push(label);
    }
    const view: SearchClusterView = {
      key,
      kind,
      title: primary.title,
      ...(primary.originalTitle === undefined ? {} : { originalTitle: primary.originalTitle }),
      ...(year === undefined ? {} : { year }),
      ...(poster === undefined ? {} : { poster }),
      ...(background === undefined ? {} : { background }),
      sourceLabels,
      hasLocal: members.some((member) => member.source.source.sourceClass === "local"),
      hasRemote: members.some((member) => member.source.source.sourceClass === "remote"),
      memberCount: members.length,
      primaryMemberKey: primary.memberKey,
      memberKeys: members.map((member) => member.memberKey),
      rank: titleRank(session.request.query, primary.title, primary.originalTitle),
    };
    return {
      key,
      conflict: identity.conflict,
      kind,
      members,
      ids: merged.ids,
      parentsCompatible: merged.compatible,
      view,
    };
  }

  private orderGroups(
    groups: RawGroup[],
    previousOrder: string[],
    previousMembers: Map<string, Set<string>>,
  ): string[] {
    const byKey = new Map(groups.map((group) => [group.key, group]));
    const result = previousOrder.filter((key) => byKey.has(key));
    const survivors = new Set(result);
    const insertions = new Map<string, RawGroup[]>();
    const fresh: RawGroup[] = [];
    for (const group of [...groups].sort((left, right) => this.compareGroups(left, right))) {
      if (survivors.has(group.key)) continue;
      const memberKeys = new Set(group.members.map((member) => member.memberKey));
      let anchor: string | undefined;
      for (const previousKey of previousOrder) {
        if (!survivors.has(previousKey)) continue;
        const previous = previousMembers.get(previousKey);
        if (previous === undefined) continue;
        if (![...memberKeys].some((memberKey) => previous.has(memberKey))) continue;
        anchor = previousKey;
        break;
      }
      if (anchor === undefined) {
        fresh.push(group);
      } else {
        const children = insertions.get(anchor) ?? [];
        children.push(group);
        insertions.set(anchor, children);
      }
    }
    const ordered: string[] = [];
    for (const key of result) {
      ordered.push(key);
      for (const child of insertions.get(key) ?? []) ordered.push(child.key);
    }
    for (const group of fresh) ordered.push(group.key);
    return ordered;
  }

  private compareGroups(left: RawGroup, right: RawGroup): number {
    return left.view.rank - right.view.rank
      || Number(right.view.hasLocal) - Number(left.view.hasLocal)
      || left.members[0]!.sequence - right.members[0]!.sequence
      || compareText(left.key, right.key);
  }

  private memberView(stored: StoredRecord, conflict: boolean): SearchMember {
    let parentIds = validStrongIds(stored.record.parentIds);
    if (stored.record.kind === "episode" && !idsHaveValue(parentIds) && stored.record.parentRef !== undefined) {
      const parent = [...stored.source.records.values()].find((candidate) =>
        candidate.record.itemKey === stored.record.parentRef,
      );
      if (parent !== undefined) parentIds = validStrongIds(parent.record.ids);
    }
    return {
      memberKey: stored.memberKey,
      sourceId: stored.source.source.id,
      sourceClass: stored.source.source.sourceClass,
      sourceLabel: cut(stored.source.source.label, this.limits.labelMaxCodePoints),
      kind: stored.record.kind,
      title: stored.record.title,
      ...(stored.record.year === undefined ? {} : { year: stored.record.year }),
      ...(stored.record.poster === undefined ? {} : { poster: stored.record.poster }),
      ...(stored.record.description === undefined ? {} : { description: stored.record.description }),
      ...(!idsHaveValue(parentIds) ? {} : { parentIds: cloneIds(parentIds) }),
      ...(stored.record.season === undefined ? {} : { season: stored.record.season }),
      ...(stored.record.episode === undefined ? {} : { episode: stored.record.episode }),
      ...(stored.record.episodeEnd === undefined ? {} : { episodeEnd: stored.record.episodeEnd }),
      ...(conflict ? { conflict: true } : {}),
      locator: cloneLocator(stored.record.locator),
    };
  }

  private canonical(
    group: RawGroup,
  ): { type: "movie" | "series"; id: string; name: string; poster?: string } | undefined {
    if ((group.kind !== "movie" && group.kind !== "series") || group.conflict) return undefined;
    const catalog = [...group.members].sort((left, right) =>
      left.source.order - right.source.order || left.sequence - right.sequence,
    ).find((member) => member.record.locator.kind === "catalog");
    if (catalog?.record.locator.kind === "catalog") {
      const locator = catalog.record.locator;
      if (locator.type === "movie" || locator.type === "series") {
        return {
          type: locator.type,
          id: locator.id,
          name: group.view.title,
          ...(group.view.poster === undefined ? {} : { poster: group.view.poster }),
        };
      }
    }
    const type = group.kind;
    let id: string | undefined;
    if (group.ids.imdb !== undefined) id = group.ids.imdb;
    else if (group.ids.tmdb !== undefined) id = `tmdb:${group.ids.tmdb}`;
    else if (group.ids.tvdb !== undefined) id = `tvdb:${group.ids.tvdb}`;
    if (id === undefined) return undefined;
    return {
      type,
      id,
      name: group.view.title,
      ...(group.view.poster === undefined ? {} : { poster: group.view.poster }),
    };
  }

  private destroy(session: ManagedSession): void {
    if (session.destroyed) return;
    session.destroyed = true;
    this.sessions.delete(session.id);
    if (this.slots.get(session.slotKey) === session.id) this.slots.delete(session.slotKey);
    this.scheduler.cancelSession(session.id);
    for (const source of session.sources) {
      source.jobToken += 1;
      source.jobCancel?.();
      source.readyUnsubscribe?.();
    }
    const waiter = session.waitingPoll;
    if (waiter !== undefined) {
      session.waitingPoll = undefined;
      if (waiter.timer !== undefined) this.timers.clearTimeout(waiter.timer);
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve({ changed: false, revision: session.revision });
    }
    if (session.initialTimer !== undefined) {
      this.timers.clearTimeout(session.initialTimer);
      session.initialTimer = undefined;
    }
    session.initialResolve?.();
    session.initialResolve = undefined;
    this.writeTombstone(session);
  }

  private writeTombstone(session: ManagedSession): void {
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
      this.tombstones = this.tombstones.slice(this.tombstones.length - this.limits.tombstoneMax);
    }
  }
}

const sameRequest = (left: SearchStartRequest, right: SearchStartRequest): boolean =>
  left.query === right.query
  && left.kind === right.kind
  && left.sources.length === right.sources.length
  && left.sources.every((source, index) => source === right.sources[index]);

const matchesKind = (record: RawSearchRecord, filter: SearchStartRequest["kind"]): boolean => {
  if (record.kind === "folder" || record.kind === "file") return true;
  if (filter === "all") return true;
  if (filter === "movie") return record.kind === "movie";
  return record.kind === "series" || record.kind === "episode";
};

const retryable = (state: SearchSourceState): boolean =>
  state === "stalled" || state === "failed" || state === "timedOut" || state === "unavailable";

const allFirstPagesSettled = (session: ManagedSession): boolean =>
  session.sources.every((source) => source.firstSettled);
