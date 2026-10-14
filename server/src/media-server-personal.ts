import { remoteLibraryVisibleTo } from "./media-server-access.js";
import type { RemoteHomeCard } from "./home.js";
import type { MediaServerAuthority, MediaServerManager } from "./media-server-manager.js";
import type { ProviderItem, ProviderItemType } from "./media-server-provider.js";
import { remoteArtworkPath, remoteProgressKey } from "./media-server-types.js";
import {
  MEDIA_SERVER_LIMITS,
  MediaServerError,
  REMOTE_LIBRARY_ID,
  type MediaConnectionRecord,
  type MediaServerKind,
  type PublicRemoteItem,
  type RemoteLibraryRecord,
} from "./media-server-types.js";
import { ResourceError } from "./media-resources.js";
import type { Store } from "./store.js";
import { emptyUserData, findUserById, type UserRecord } from "./users.js";

/** What one account sees for one verified remote item. Never carries a URL, token, seal or
 *  owner stamp. */
export interface RemoteItemState {
  key: string;
  position: number;
  duration: number;
  favorite: boolean;
  watched: boolean;
  mediaSourceId?: string;
  updatedAt?: string;
}

interface RemoteSeries { id?: string; name?: string; season?: number; episode?: number }

interface RemoteMediaRecord {
  key: string;
  provider: MediaServerKind;
  serverId: string;
  accountId: string;
  itemId: string;
  remoteLibraryId: string;
  type: ProviderItemType;
  name: string;
  series?: RemoteSeries;
  position: number;
  duration: number;
  favorite: boolean;
  watched: boolean;
  mediaSourceId?: string;
  /** A role the provider reported as absent. Only the true flag is stored: an unknown role
   *  keeps its legacy URL, and a later build clears the flag when the image appears. */
  primaryAbsent?: true;
  backdropAbsent?: true;
  updatedAt: string;
}

interface Resolved {
  userId: string;
  actorSecret: string;
  user: UserRecord;
  library: RemoteLibraryRecord;
  connection: MediaConnectionRecord;
  item: ProviderItem;
  key: string;
  playable: boolean;
}

/** One account's projected remote cards, plus the private proof the route re-checks before the
 *  JSON leaves: the libraries and connections the projection was built against. */
export interface RemoteCardsOptions {
  filter: "resume" | "favorites";
  onHome?: boolean;
  skip?: number;
  limit?: number;
}

export interface RemoteCards {
  items: RemoteHomeCard[];
  total: number;
  partial?: boolean;
}

interface CardProof {
  actor: { id: string; secret: string };
  filter: "resume" | "favorites";
  onHome: boolean;
  libraries: Array<{
    libraryId: string;
    connectionId: string;
    provider: MediaServerKind;
    serverId: string;
    accountId: string;
    remoteId: string;
    generation: number;
    secretRef: string | undefined;
  }>;
}

const cardProofs = new WeakMap<object, CardProof>();

const boundedCount = (value: unknown, fallback: number, max: number): number => {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) throw invalid("The remote card page is out of range.");
  return value;
};

/** Whether one attached library belongs in a card projection: the switch the destination
 *  honours is still on. Only an explicit false opts a library out, the same way a record
 *  written before the switches existed reads as on. Resume honours the continue-watching
 *  switch; favourites honours its own, never the continue-watching one. */
const cardLibraryWanted = (filter: "resume" | "favorites", onHome: boolean, library: RemoteLibraryRecord): boolean =>
  filter === "resume"
    ? library.showInContinueWatching !== false && (!onHome || library.showOnHome !== false)
    : library.showInFavorites !== false && (!onHome || library.showOnHome !== false);

/** The whole-projection budget of one card run. It owns a child signal that follows the
 *  caller's abort and fires once the budget is spent, which is the signal every confirmation
 *  gets: a group the budget can no longer cover is failed without a network call, and a
 *  caller that goes away aborts whatever is still in flight. */
class CardBudget {
  private readonly controller = new AbortController();
  private readonly timer: NodeJS.Timeout;
  private readonly deadline: number;
  private readonly relay: () => void;
  private spent = false;

  constructor(private readonly caller: AbortSignal | undefined, totalMs: number) {
    this.deadline = Date.now() + totalMs;
    // Deliberately not unref'd: this timer is what ends a projection whose work ignores its
    // abort, and it is cleared as soon as the projection is done.
    this.timer = setTimeout(() => this.spend(), totalMs);
    this.relay = () => this.spend();
    if (caller) {
      if (caller.aborted) this.spend();
      else caller.addEventListener("abort", this.relay, { once: true });
    }
  }

  /** The child signal every confirmation in this run is given. */
  get signal(): AbortSignal { return this.controller.signal; }

  /** Whether nothing further may start: the budget is spent or the caller is gone. */
  get exhausted(): boolean { return this.spent; }

  remainingMs(): number { return Math.max(0, this.deadline - Date.now()); }

  close(): void {
    clearTimeout(this.timer);
    if (this.caller) this.caller.removeEventListener("abort", this.relay);
  }

  private spend(): void {
    this.spent = true;
    this.controller.abort();
  }
}

/** Confirms one library inside what is left of the projection budget. The work is given its
 *  own child signal that carries both the caller's abort and the budget's deadline, so a
 *  cancellation reaches it whatever it awaits; the race answers `false` even when the work
 *  ignores its signal and keeps running, and that ignored work's failure is swallowed by the
 *  race's own handler rather than surfacing later as an unhandled rejection. The budget signal
 *  owns the only deadline; an independent timer could expire while the budget still accepts work. */
const withinDeadline = async (
  work: (signal: AbortSignal) => Promise<void>,
  caller: AbortSignal,
): Promise<boolean> => {
  const controller = new AbortController();
  const relay = () => controller.abort();
  if (caller.aborted) relay();
  else caller.addEventListener("abort", relay, { once: true });
  const outcome = work(controller.signal).then(() => true, () => false);
  const expired = new Promise<boolean>((resolve) => {
    if (controller.signal.aborted) resolve(false);
    else controller.signal.addEventListener("abort", () => resolve(false), { once: true });
  });
  try {
    return await Promise.race([outcome, expired]);
  } finally {
    caller.removeEventListener("abort", relay);
  }
};

const runBounded = async <T>(items: T[], limit: number, work: (item: T) => Promise<void>, stop: () => boolean): Promise<void> => {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (;;) {
      if (stop()) return;
      const next = queue.shift();
      if (next === undefined) return;
      await work(next);
    }
  });
  await Promise.all(workers);
};

/** The parts of the passed store state a write re-proves against, so a change queued behind
 *  another cannot land under records the mutator no longer sees. */
interface WriteState {
  users?: UserRecord[];
  userData?: Record<string, { prefs?: Record<string, unknown>; remoteMedia?: Record<string, unknown> }>;
  mediaConnections?: MediaConnectionRecord[];
  remoteLibraries?: RemoteLibraryRecord[];
}

const MAX_RECORDS = 1000;
const MAX_SECONDS = 31_536_000;
const PATCH_KEYS = ["position", "duration", "favorite", "watched", "mediaSourceId"];
const CARD_LIMIT_DEFAULT = 20;
const CARD_LIMIT_MAX = 1000;
const CARD_SKIP_MAX = 1000;
const CARD_DEADLINE_HOME_MS = 1500;
const CARD_DEADLINE_MS = 5000;
const CARD_CONCURRENCY = 2;
const CARD_RESUME_MIN_POSITION = 5;
const CARD_FINISHED_RATIO = 0.94;
const invalid = (message: string): MediaServerError => new MediaServerError("invalid-input", message);
const notFound = (message: string): MediaServerError => new MediaServerError("not-found", message);

const seconds = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_SECONDS) throw invalid(`The remote ${field} is out of range.`);
  return value;
};

const boundedId = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > MEDIA_SERVER_LIMITS.upstreamId) throw invalid("The remote source id is malformed.");
  return value;
};

interface Patch { position?: number; duration?: number; favorite?: boolean; watched?: boolean; mediaSourceId?: string }

const readPatch = (body: unknown): Patch => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("The remote item change is malformed.");
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!PATCH_KEYS.includes(key)) throw invalid("The remote item change has an unknown field.");
  if (Object.keys(record).length === 0) throw invalid("The remote item change names nothing to change.");
  const patch: Patch = {};
  if (record.position !== undefined) patch.position = seconds(record.position, "position");
  if (record.duration !== undefined) patch.duration = seconds(record.duration, "duration");
  if (record.favorite !== undefined) { if (typeof record.favorite !== "boolean") throw invalid("The remote favorite is malformed."); patch.favorite = record.favorite; }
  if (record.watched !== undefined) { if (typeof record.watched !== "boolean") throw invalid("The remote watched flag is malformed."); patch.watched = record.watched; }
  if (record.mediaSourceId !== undefined) patch.mediaSourceId = boundedId(record.mediaSourceId);
  return patch;
};

const safeString = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;

const validSeries = (value: unknown): RemoteSeries | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const series: RemoteSeries = {};
  const id = safeString(record.id, MEDIA_SERVER_LIMITS.upstreamId);
  const name = safeString(record.name, MEDIA_SERVER_LIMITS.name);
  if (id !== undefined) series.id = id;
  if (name !== undefined) series.name = name;
  if (typeof record.season === "number" && Number.isSafeInteger(record.season) && record.season >= 0) series.season = record.season;
  if (typeof record.episode === "number" && Number.isSafeInteger(record.episode) && record.episode >= 0) series.episode = record.episode;
  return series;
};

const validRecord = (value: unknown): RemoteMediaRecord | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const provider = record.provider;
  if (provider !== "jellyfin" && provider !== "emby") return undefined;
  const key = safeString(record.key, 256);
  const serverId = safeString(record.serverId, MEDIA_SERVER_LIMITS.upstreamId);
  const accountId = safeString(record.accountId, MEDIA_SERVER_LIMITS.upstreamId);
  const itemId = safeString(record.itemId, MEDIA_SERVER_LIMITS.upstreamId);
  const remoteLibraryId = safeString(record.remoteLibraryId, MEDIA_SERVER_LIMITS.upstreamId);
  const name = safeString(record.name, MEDIA_SERVER_LIMITS.name);
  const type = record.type;
  if (!key || !serverId || !accountId || !itemId || !remoteLibraryId || !name) return undefined;
  if (type !== "movie" && type !== "series" && type !== "season" && type !== "episode") return undefined;
  const stored: RemoteMediaRecord = {
    key, provider, serverId, accountId, itemId, remoteLibraryId, type, name,
    position: typeof record.position === "number" && Number.isFinite(record.position) && record.position >= 0 ? Math.min(record.position, MAX_SECONDS) : 0,
    duration: typeof record.duration === "number" && Number.isFinite(record.duration) && record.duration >= 0 ? Math.min(record.duration, MAX_SECONDS) : 0,
    favorite: record.favorite === true,
    watched: record.watched === true,
    updatedAt: safeString(record.updatedAt, 64) ?? "",
  };
  const series = validSeries(record.series);
  if (series) stored.series = series;
  const mediaSourceId = safeString(record.mediaSourceId, MEDIA_SERVER_LIMITS.upstreamId);
  if (mediaSourceId !== undefined) stored.mediaSourceId = mediaSourceId;
  if (record.primaryAbsent === true) stored.primaryAbsent = true;
  if (record.backdropAbsent === true) stored.backdropAbsent = true;
  return stored;
};

/** A persisted row that names itself: the map key and the stored key agree, and the key is the
 *  canonical remote key of the identity the row carries. A malformed row is never projected. */
const projectableRecord = (mapKey: string, value: unknown): RemoteMediaRecord | undefined => {
  const record = validRecord(value);
  if (!record || record.key !== mapKey) return undefined;
  if (record.key !== remoteProgressKey({ provider: record.provider, serverId: record.serverId, accountId: record.accountId, itemId: record.itemId })) return undefined;
  return record;
};

const stateOf = (record: RemoteMediaRecord): RemoteItemState => ({
  key: record.key,
  position: record.position,
  duration: record.duration,
  favorite: record.favorite,
  watched: record.watched,
  ...(record.mediaSourceId === undefined ? {} : { mediaSourceId: record.mediaSourceId }),
  ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
});

const seriesOf = (item: ProviderItem): RemoteSeries | undefined => {
  if (item.type === "episode") {
    const series: RemoteSeries = {};
    if (item.seriesId !== undefined) series.id = item.seriesId;
    if (item.season !== undefined) series.season = item.season;
    if (item.episode !== undefined) series.episode = item.episode;
    return series;
  }
  if (item.type === "series") return { id: item.id, name: item.name };
  return undefined;
};

/** One account's own state for verified remote items. It is kept apart from the generic
 *  progress map, and every write re-proves the account, the grant and the connection against
 *  the state the write lands on. */
export class MediaServerPersonal {
  constructor(private readonly store: Store, private readonly manager: MediaServerManager) {}

  private currentActor(authority: MediaServerAuthority): UserRecord {
    authority.assertCurrent();
    const user = findUserById(this.store.users(), authority.actor.id);
    if (!user || user.secret !== authority.actor.secret || user.disabled || user.mustChangePassword) throw new ResourceError(401, "AUTH_REQUIRED");
    return user;
  }

  private capture(handle: string, user: UserRecord): { library: RemoteLibraryRecord; connection: MediaConnectionRecord } {
    const library = this.store.remoteLibraries().find((candidate) => candidate.id === handle);
    if (!library) throw notFound("That remote library does not exist.");
    const connection = this.store.mediaConnections().find((candidate) => candidate.id === library.connectionId);
    if (!connection || !connection.enabled || !connection.secretRef) throw notFound("That remote library does not exist.");
    if (!remoteLibraryVisibleTo(this.store.mediaConnections(), library, user)) throw notFound("That remote library does not exist.");
    return { library, connection };
  }

  private async resolve(authority: MediaServerAuthority, libraryId: unknown, itemId: unknown, signal?: AbortSignal): Promise<Resolved> {
    const user = this.currentActor(authority);
    if (typeof libraryId !== "string" || !REMOTE_LIBRARY_ID.test(libraryId)) throw notFound("That remote library does not exist.");
    const before = this.capture(libraryId, user);
    const detail = await this.manager.itemDetail(authority, libraryId, itemId, signal);
    authority.assertCurrent();
    const fresh = this.capture(libraryId, user);
    if (fresh.connection.id !== before.connection.id || fresh.connection.generation !== before.connection.generation
      || fresh.connection.secretRef !== before.connection.secretRef || fresh.connection.provider !== before.connection.provider
      || fresh.connection.serverId !== before.connection.serverId || fresh.connection.accountId !== before.connection.accountId
      || fresh.library.id !== before.library.id || fresh.library.remoteId !== before.library.remoteId) throw notFound("That remote library does not exist.");
    const key = remoteProgressKey({ provider: fresh.connection.provider, serverId: fresh.connection.serverId, accountId: fresh.connection.accountId, itemId: detail.item.id });
    return { userId: user.id, actorSecret: user.secret, user, library: fresh.library, connection: fresh.connection, item: detail.item, key, playable: detail.item.type === "movie" || detail.item.type === "episode" };
  }

  async read(authority: MediaServerAuthority, libraryId: unknown, itemId: unknown, signal?: AbortSignal): Promise<RemoteItemState> {
    const resolved = await this.resolve(authority, libraryId, itemId, signal);
    const record = validRecord(this.mapOf(resolved.userId)[resolved.key]);
    authority.assertCurrent();
    return record ? stateOf(record) : { key: resolved.key, position: 0, duration: 0, favorite: false, watched: false };
  }

  async patch(authority: MediaServerAuthority, libraryId: unknown, itemId: unknown, body: unknown, signal?: AbortSignal): Promise<RemoteItemState> {
    const patch = readPatch(body);
    const resolved = await this.resolve(authority, libraryId, itemId, signal);
    if (resolved.item.type === "folder") throw invalid("That folder has no personal playback state.");
    if (!resolved.playable && (patch.position !== undefined || patch.duration !== undefined || patch.mediaSourceId !== undefined)) {
      throw invalid("That item has no playable media.");
    }
    if (patch.mediaSourceId !== undefined) {
      const versions = await this.manager.itemVersions(authority, resolved.library.id, resolved.item.id, signal);
      authority.assertCurrent();
      if (!versions.versions.some((version) => version.id === patch.mediaSourceId)) throw notFound("That media-server source is no longer available.");
    }
    let state!: RemoteItemState;
    await this.store.update((next) => {
      this.assertWrite(next, authority, resolved);
      const previous = validRecord(this.mapOf(resolved.userId, next)[resolved.key]);
      const record = this.build(previous, resolved, patch, this.trackProgressOf(next, resolved.userId));
      const map: Record<string, unknown> = { ...this.mapOf(resolved.userId, next), [resolved.key]: record };
      this.enforceBound(map, resolved.key);
      const data = next.userData?.[resolved.userId] ?? emptyUserData();
      next.userData = { ...(next.userData ?? {}), [resolved.userId]: { ...data, remoteMedia: map } };
      state = stateOf(record);
    });
    authority.assertCurrent();
    return state;
  }

  /** The account's own valid records, filtered to libraries still reachable by the verified
   *  identity. Used by later Home integration; nothing here reads another account's rows. */
  async list(authority: MediaServerAuthority, signal?: AbortSignal): Promise<RemoteItemState[]> {
    const user = this.currentActor(authority);
    const connections = this.store.mediaConnections();
    const libraries = this.store.remoteLibraries();
    const out: RemoteItemState[] = [];
    for (const value of Object.values(this.mapOf(user.id))) {
      const record = validRecord(value);
      if (!record) continue;
      const connection = connections.find((candidate) => candidate.enabled && candidate.provider === record.provider && candidate.serverId === record.serverId && candidate.accountId === record.accountId);
      const library = connection ? libraries.find((candidate) => candidate.connectionId === connection.id && candidate.remoteId === record.remoteLibraryId) : undefined;
      if (!library || !remoteLibraryVisibleTo(connections, library, user)) continue;
      out.push(stateOf(record));
    }
    if (signal?.aborted) throw new ResourceError(401, "AUTH_REQUIRED");
    authority.assertCurrent();
    return out;
  }

  /** One account's own resume or favourite cards. Each distinct library is confirmed against
   *  the live remote policy before any of its stored labels are projected; a library that
   *  cannot be confirmed inside its deadline is dropped and the answer is marked partial,
   *  never returned as an empty or stale list. Local and add-on rows are built elsewhere and
   *  never depend on this call. */
  async cards(authority: MediaServerAuthority, options: RemoteCardsOptions, signal?: AbortSignal): Promise<RemoteCards> {
    const filter = options?.filter;
    if (filter !== "resume" && filter !== "favorites") throw invalid("The remote card filter is not supported.");
    const onHome = options.onHome === true;
    const skip = boundedCount(options.skip, 0, CARD_SKIP_MAX);
    const limit = boundedCount(options.limit, CARD_LIMIT_DEFAULT, CARD_LIMIT_MAX);
    const user = this.currentActor(authority);
    const connections = this.store.mediaConnections();
    const libraries = this.store.remoteLibraries();
    const attachments: Array<{ library: RemoteLibraryRecord; connection: MediaConnectionRecord }> = [];
    for (const library of libraries) {
      if (!remoteLibraryVisibleTo(connections, library, user)) continue;
      if (!cardLibraryWanted(filter, onHome, library)) continue;
      const connection = connections.find((candidate) => candidate.id === library.connectionId);
      if (!connection || !connection.enabled || !connection.secretRef) continue;
      attachments.push({ library, connection });
    }
    attachments.sort((left, right) => left.library.order - right.library.order || left.library.id.localeCompare(right.library.id));
    const groups = new Map<string, { library: RemoteLibraryRecord; connection: MediaConnectionRecord; records: RemoteMediaRecord[] }>();
    for (const [key, value] of Object.entries(this.mapOf(user.id))) {
      const record = projectableRecord(key, value);
      if (!record || !this.cardWanted(filter, record)) continue;
      const attachment = attachments.find((entry) => entry.library.remoteId === record.remoteLibraryId
        && entry.connection.provider === record.provider && entry.connection.serverId === record.serverId && entry.connection.accountId === record.accountId);
      if (!attachment) continue;
      const bucket = groups.get(attachment.library.id);
      if (bucket) bucket.records.push(record);
      else groups.set(attachment.library.id, { ...attachment, records: [record] });
    }
    const budget = new CardBudget(signal, onHome ? CARD_DEADLINE_HOME_MS : CARD_DEADLINE_MS);
    let partial = false;
    const confirmed: Array<{ library: RemoteLibraryRecord; connection: MediaConnectionRecord; records: RemoteMediaRecord[] }> = [];
    try {
      await runBounded([...groups.values()], CARD_CONCURRENCY, async (group) => {
        // A group the budget can no longer cover is a partial answer, never a network call.
        if (budget.exhausted || budget.remainingMs() <= 0) { partial = true; return; }
        const ok = await withinDeadline(
          (child) => this.manager.verifyLibrary(authority, group.library.id, child),
          budget.signal,
        );
        authority.assertCurrent();
        if (ok) confirmed.push(group);
        else partial = true;
      }, () => signal?.aborted === true);
    } finally {
      budget.close();
    }
    const seen = new Set<string>();
    const cards: RemoteHomeCard[] = [];
    for (const group of confirmed) {
      for (const record of group.records) {
        if (seen.has(record.key)) continue;
        seen.add(record.key);
        cards.push(this.cardOf(record, group.library));
      }
    }
    cards.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.key.localeCompare(right.key));
    const proof: CardProof = {
      actor: { id: user.id, secret: user.secret },
      filter,
      onHome,
      libraries: confirmed.map((group) => ({
        libraryId: group.library.id,
        connectionId: group.connection.id,
        provider: group.connection.provider,
        serverId: group.connection.serverId,
        accountId: group.connection.accountId,
        remoteId: group.library.remoteId,
        generation: group.connection.generation,
        secretRef: group.connection.secretRef,
      })),
    };
    if (signal?.aborted) throw new ResourceError(401, "AUTH_REQUIRED");
    authority.assertCurrent();
    const result: RemoteCards = { items: cards.slice(skip, skip + limit), total: cards.length, ...(partial ? { partial: true } : {}) };
    cardProofs.set(result, proof);
    this.assertCardsCurrent(authority, result);
    return result;
  }

  /** Re-proves a card projection before its JSON leaves. It reads the private proof, so a
   *  caller cannot mint one, and refuses unless the acting account is exactly the one the
   *  cards were projected for and every library still stands as it was captured: the same
   *  granted, enabled connection and identity, the same generation and secret, the same
   *  upstream library, and the switch that put the library in this projection still on. */
  assertCardsCurrent(authority: MediaServerAuthority, cards: unknown): void {
    const proof = typeof cards === "object" && cards !== null ? cardProofs.get(cards) : undefined;
    if (!proof) throw new ResourceError(404, "RESOURCE_NOT_FOUND");
    authority.assertCurrent();
    if (authority.actor.id !== proof.actor.id || authority.actor.secret !== proof.actor.secret) throw new ResourceError(404, "RESOURCE_NOT_FOUND");
    const user = findUserById(this.store.users(), proof.actor.id);
    if (!user || user.secret !== proof.actor.secret || user.disabled || user.mustChangePassword) throw new ResourceError(401, "AUTH_REQUIRED");
    const connections = this.store.mediaConnections();
    const libraries = this.store.remoteLibraries();
    for (const ref of proof.libraries) {
      const library = libraries.find((candidate) => candidate.id === ref.libraryId);
      const connection = connections.find((candidate) => candidate.id === ref.connectionId);
      if (!library || !connection || library.connectionId !== ref.connectionId || !connection.enabled || !connection.secretRef
        || connection.generation !== ref.generation || connection.secretRef !== ref.secretRef
        || connection.provider !== ref.provider || connection.serverId !== ref.serverId || connection.accountId !== ref.accountId
        || library.remoteId !== ref.remoteId || !cardLibraryWanted(proof.filter, proof.onHome, library)
        || !remoteLibraryVisibleTo(connections, library, user)) throw new ResourceError(404, "RESOURCE_NOT_FOUND");
    }
  }

  /** Only a playable item with a real, unfinished position is a resume card; a favourite is
   *  whatever the account starred. A season is neither a card kind nor playable. */
  private cardWanted(filter: "resume" | "favorites", record: RemoteMediaRecord): boolean {
    if (record.type !== "movie" && record.type !== "series" && record.type !== "episode") return false;
    if (filter === "favorites") return record.favorite;
    if (record.type !== "movie" && record.type !== "episode") return false;
    if (record.watched || !(record.duration > 0)) return false;
    if (record.position < CARD_RESUME_MIN_POSITION) return false;
    return record.position / record.duration < CARD_FINISHED_RATIO;
  }

  private cardOf(record: RemoteMediaRecord, library: RemoteLibraryRecord): RemoteHomeCard {
    return {
      kind: "remote",
      key: record.key,
      title: record.name,
      provider: record.provider,
      libraryId: library.id,
      libraryName: library.name,
      itemId: record.itemId,
      itemType: record.type as "movie" | "series" | "episode",
      ...(record.mediaSourceId !== undefined ? { mediaSourceId: record.mediaSourceId } : {}),
      ...(record.series?.season !== undefined ? { season: record.series.season } : {}),
      ...(record.series?.episode !== undefined ? { episode: record.series.episode } : {}),
      ...(record.primaryAbsent === true ? {} : { poster: remoteArtworkPath(library.id, record.itemId, "Primary") }),
      ...(record.backdropAbsent === true ? {} : { wide: remoteArtworkPath(library.id, record.itemId, "Backdrop") }),
      ...(record.duration > 0 ? { progress: { position: record.position, duration: record.duration } } : {}),
      updatedAt: record.updatedAt,
    };
  }

  private mapOf(userId: string, state?: WriteState): Record<string, unknown> {
    const data = state ? state.userData?.[userId] : this.store.userData(userId);
    return { ...(data?.remoteMedia ?? {}) };
  }

  private assertWrite(state: WriteState, authority: MediaServerAuthority, resolved: Resolved): void {
    authority.assertCurrent();
    const user = (state.users ?? []).find((candidate) => candidate.id === resolved.userId);
    if (!user || user.secret !== resolved.actorSecret || user.disabled || user.mustChangePassword) throw new ResourceError(401, "AUTH_REQUIRED");
    const connections = state.mediaConnections ?? [];
    const library = (state.remoteLibraries ?? []).find((candidate) => candidate.id === resolved.library.id);
    const connection = connections.find((candidate) => candidate.id === resolved.connection.id);
    if (!library || !connection || library.connectionId !== resolved.connection.id) throw notFound("That remote library does not exist.");
    if (connection.generation !== resolved.connection.generation || connection.secretRef !== resolved.connection.secretRef
      || connection.provider !== resolved.connection.provider || connection.serverId !== resolved.connection.serverId
      || connection.accountId !== resolved.connection.accountId || !connection.enabled) throw notFound("That remote library does not exist.");
    if (!remoteLibraryVisibleTo(connections, library, user)) throw notFound("That remote library does not exist.");
  }

  /** The preference as the state a write lands on holds it, with the same default the store's
   *  own `prefs` reader applies: absent means on. */
  private trackProgressOf(state: WriteState, userId: string): boolean {
    const prefs = state.userData?.[userId]?.prefs as Record<string, unknown> | undefined;
    return prefs?.trackProgress === undefined ? true : prefs.trackProgress === true;
  }

  private build(previous: RemoteMediaRecord | undefined, resolved: Resolved, patch: Patch, trackProgress: boolean): RemoteMediaRecord {
    // The detail route answers the public projection, so an absent role reads as a missing
    // path here. Unknown roles keep a path, which leaves the flag unset.
    const shown = resolved.item as PublicRemoteItem;
    const record: RemoteMediaRecord = {
      key: resolved.key,
      provider: resolved.connection.provider,
      serverId: resolved.connection.serverId,
      accountId: resolved.connection.accountId,
      itemId: resolved.item.id,
      remoteLibraryId: resolved.library.remoteId,
      type: resolved.item.type,
      name: resolved.item.name,
      position: resolved.playable ? previous?.position ?? 0 : 0,
      duration: resolved.playable ? previous?.duration ?? 0 : 0,
      favorite: previous?.favorite ?? false,
      watched: previous?.watched ?? false,
      updatedAt: new Date().toISOString(),
    };
    if (shown.poster === undefined) record.primaryAbsent = true;
    if (shown.wide === undefined) record.backdropAbsent = true;
    const series = seriesOf(resolved.item);
    if (series) record.series = series;
    if (resolved.playable && previous?.mediaSourceId !== undefined) record.mediaSourceId = previous.mediaSourceId;
    if (resolved.playable && trackProgress) {
      // Switching the chosen version is switching the stream, so a stale position no longer
      // belongs to what a resume would find.
      if (patch.mediaSourceId !== undefined && patch.mediaSourceId !== record.mediaSourceId) {
        record.position = 0;
        record.duration = 0;
      }
      if (patch.position !== undefined) record.position = patch.position;
      if (patch.duration !== undefined) record.duration = patch.duration;
      if (patch.mediaSourceId !== undefined) record.mediaSourceId = patch.mediaSourceId;
    }
    if (patch.favorite !== undefined) record.favorite = patch.favorite;
    if (patch.watched !== undefined) record.watched = patch.watched;
    return record;
  }

  /** Bounds one account's map. A full map with no non-favorite row to drop refuses the write
   *  rather than silently discarding a favorite. */
  private enforceBound(map: Record<string, unknown>, key: string): void {
    if (Object.keys(map).length <= MAX_RECORDS) return;
    const evictable = Object.keys(map)
      .filter((candidate) => candidate !== key)
      .map((candidate) => ({ key: candidate, record: validRecord(map[candidate]) }))
      .filter((entry): entry is { key: string; record: RemoteMediaRecord } => entry.record !== undefined && !entry.record.favorite)
      .sort((left, right) => left.record.updatedAt.localeCompare(right.record.updatedAt));
    while (Object.keys(map).length > MAX_RECORDS && evictable.length) {
      const victim = evictable.shift()!;
      delete map[victim.key];
    }
    if (Object.keys(map).length > MAX_RECORDS) throw new MediaServerError("busy", "The remote media state has no room for a new item.");
  }
}
