import { randomBytes, randomInt } from "node:crypto";
import { libraryPath, posixBase, type LibraryType } from "./libraries.js";
import { episodeKey, episodeNumberOf, isExtraName, knownEntryForUnit, titleUnits, unitFor, type LibraryEpisodeRecord, type LibraryMetaRecord } from "./library-match.js";
import { parseMediaPath } from "./library-parse.js";

export const SHUFFLE_POOL_LIMIT = 5000;
export const SHUFFLE_TTL_MS = 6 * 60 * 60_000;
export const SHUFFLE_ACCOUNT_LIMIT = 3;
export const SHUFFLE_TOTAL_LIMIT = 200;
export const SHUFFLE_SKIP_LIMIT = 50;

export interface ShuffleItem {
  path?: string;
  remote?: { libraryId: string; itemId: string };
  title: string;
  season?: number;
  episode?: number;
}

export interface ShuffleUnit {
  files: string[];
  remote?: { libraryId: string; itemId: string; generation: number };
  title: string;
  season?: number;
  episode?: number;
}

export interface ShuffleOwner {
  userId: string;
  sid: string;
}

export interface ShuffleStartAnswer {
  id: string;
  item: ShuffleItem;
  total: number;
  capped?: true;
  hasNext: boolean;
  hasPrevious: false;
  upcoming?: { title: string };
}

export interface ShuffleStepAnswer {
  item: ShuffleItem;
  hasNext: boolean;
  hasPrevious: boolean;
  upcoming?: { title: string };
}

export type ShuffleNextAnswer = ShuffleStepAnswer | { item: null; exhausted: true };
export type ShufflePreviousAnswer = ShuffleStepAnswer | { item: null };

type ChooseItem = (unit: ShuffleUnit) => Promise<string | ShuffleItem | undefined>;

interface Session {
  id: string;
  owner: ShuffleOwner;
  order: Array<ShuffleUnit | undefined>;
  cursor: number;
  history: number[];
  historyCursor: number;
  lastUsed: number;
  sequence: number;
}

export interface ShuffleSessionOptions {
  now?: () => number;
  randomInt?: (maxExclusive: number) => number;
}

const sameOwner = (session: Session, owner: ShuffleOwner) =>
  session.owner.userId === owner.userId && session.owner.sid === owner.sid;

const naturalPathOrder = (left: string, right: string) =>
  left.localeCompare(right, "en", { numeric: true, sensitivity: "base" }) || left.localeCompare(right, "en");

/** One unit per bound movie, bound episode, or unbound file. */
export function shuffleUnits(
  libraryId: string,
  files: string[],
  records: Record<string, LibraryMetaRecord>,
  episodes: Record<string, LibraryEpisodeRecord> = {},
  libraryType: LibraryType = "mixed",
): ShuffleUnit[] {
  const titleUnitsForFiles = titleUnits(files.map((relative) => ({ relative, size: 0, modified: "" })), libraryType);
  const groups = new Map<string, { files: string[]; title: string; season?: number; episode?: number }>();
  for (const relative of files) {
    if (isExtraName(posixBase(relative))) continue;
    const key = libraryPath(libraryId, relative);
    const entry = knownEntryForUnit(unitFor(relative, titleUnitsForFiles), records, key);
    const record = entry?.record;
    const numbers = episodeNumberOf(key, records[key]?.id ? records[key] : undefined, { loose: record?.type === "series" });
    const identity = record?.id && record.type === "movie"
      ? `movie:${record.id}`
      : record?.id && record.type === "series" && numbers
        ? `series:${record.id}:${numbers.season}:${numbers.episode}`
        : `file:${key}`;
    const episodeName = record?.type === "series" && numbers
      ? episodes[episodeKey(record.type, record.id, numbers.season, numbers.episode)]?.name
      : undefined;
    const title = episodeName || record?.name || parseMediaPath(posixBase(relative)).title || posixBase(relative);
    const existing = groups.get(identity);
    if (existing) {
      existing.files.push(key);
      continue;
    }
    groups.set(identity, {
      files: [key],
      title,
      ...(numbers ? { season: numbers.season, episode: numbers.episode } : {}),
    });
  }
  return [...groups.values()].map((unit) => ({ ...unit, files: unit.files.sort(naturalPathOrder) }));
}

export class ShuffleSessions {
  private readonly sessions = new Map<string, Session>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly random: (maxExclusive: number) => number;
  private sequence = 0;

  constructor(options: ShuffleSessionOptions = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.randomInt ?? ((maxExclusive) => randomInt(maxExclusive));
  }

  async start(owner: ShuffleOwner, units: ShuffleUnit[], choose: ChooseItem, options: { capped?: boolean } = {}): Promise<ShuffleStartAnswer | undefined> {
    const now = this.now();
    this.cleanup(now);
    const shuffled = shuffle(units, this.random);
    const capped = options.capped === true || shuffled.length > SHUFFLE_POOL_LIMIT;
    const session: Session = {
      id: randomBytes(18).toString("base64url"),
      owner,
      order: shuffled.slice(0, SHUFFLE_POOL_LIMIT),
      cursor: -1,
      history: [],
      historyCursor: -1,
      lastUsed: now,
      sequence: ++this.sequence,
    };
    const budget = { remaining: SHUFFLE_SKIP_LIMIT };
    const picked = await this.firstPlayable(session, 0, choose, budget);
    if (!picked) return undefined;
    this.placeLimits(owner.userId);
    session.cursor = picked.index;
    session.history = [picked.index];
    session.historyCursor = 0;
    this.sessions.set(session.id, session);
    const next = await this.peekNext(session, choose, budget);
    return {
      id: session.id,
      item: picked.item,
      total: session.order.length,
      ...(capped ? { capped: true as const } : {}),
      hasNext: Boolean(next),
      hasPrevious: false,
      ...(next ? { upcoming: { title: next.title } } : {}),
    };
  }

  async next(owner: ShuffleOwner, id: string, choose: ChooseItem): Promise<ShuffleNextAnswer | undefined> {
    return this.serialized(id, async () => {
      const session = this.session(owner, id);
      if (!session) return undefined;
      session.lastUsed = this.now();
      const budget = { remaining: SHUFFLE_SKIP_LIMIT };

      while (session.historyCursor + 1 < session.history.length && budget.remaining > 0) {
        const index = session.history[++session.historyCursor]!;
        const item = await this.itemAt(session, index, choose, budget);
        if (item) return this.stepAnswer(session, item, choose, budget);
        session.history.splice(session.historyCursor--, 1);
      }

      const picked = await this.firstPlayable(session, session.cursor + 1, choose, budget);
      if (!picked) return { item: null, exhausted: true };
      session.cursor = picked.index;
      session.history = session.history.slice(0, session.historyCursor + 1);
      session.history.push(picked.index);
      session.historyCursor += 1;
      return this.stepAnswer(session, picked.item, choose, budget);
    });
  }

  async previous(owner: ShuffleOwner, id: string, choose: ChooseItem): Promise<ShufflePreviousAnswer | undefined> {
    return this.serialized(id, async () => {
      const session = this.session(owner, id);
      if (!session) return undefined;
      session.lastUsed = this.now();
      const budget = { remaining: SHUFFLE_SKIP_LIMIT };
      while (session.historyCursor > 0 && budget.remaining > 0) {
        const index = session.history[--session.historyCursor]!;
        const item = await this.itemAt(session, index, choose, budget);
        if (item) return this.stepAnswer(session, item, choose, budget);
        session.history.splice(session.historyCursor, 1);
      }
      return { item: null };
    });
  }

  delete(owner: ShuffleOwner, id: string): boolean {
    const session = this.session(owner, id);
    if (!session) return false;
    this.sessions.delete(id);
    return true;
  }

  get size(): number {
    this.cleanup(this.now());
    return this.sessions.size;
  }

  private session(owner: ShuffleOwner, id: string): Session | undefined {
    this.cleanup(this.now());
    const session = this.sessions.get(id);
    return session && sameOwner(session, owner) ? session : undefined;
  }

  private serialized<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const result = previous.then(run);
    const tail = result.then(() => undefined, () => undefined);
    this.queues.set(id, tail);
    void tail.then(() => {
      if (this.queues.get(id) === tail) this.queues.delete(id);
    });
    return result;
  }

  private cleanup(now: number): void {
    for (const [id, session] of this.sessions) {
      if (session.lastUsed + SHUFFLE_TTL_MS <= now) this.sessions.delete(id);
    }
  }

  private placeLimits(userId: string): void {
    const own = [...this.sessions.values()]
      .filter((session) => session.owner.userId === userId)
      .sort((left, right) => left.lastUsed - right.lastUsed || left.sequence - right.sequence);
    while (own.length >= SHUFFLE_ACCOUNT_LIMIT) {
      const oldest = own.shift()!;
      this.sessions.delete(oldest.id);
    }
    if (this.sessions.size < SHUFFLE_TOTAL_LIMIT) return;
    const oldest = [...this.sessions.values()].sort((left, right) => left.lastUsed - right.lastUsed || left.sequence - right.sequence)[0];
    if (oldest) this.sessions.delete(oldest.id);
  }

  private async firstPlayable(
    session: Session,
    from: number,
    choose: ChooseItem,
    budget: { remaining: number },
  ): Promise<{ index: number; item: ShuffleItem } | undefined> {
    for (let index = Math.max(0, from); index < session.order.length; index += 1) {
      const item = await this.itemAt(session, index, choose, budget);
      if (item) return { index, item };
      if (budget.remaining <= 0) return undefined;
    }
    return undefined;
  }

  private async itemAt(
    session: Session,
    index: number,
    choose: ChooseItem,
    budget: { remaining: number },
  ): Promise<ShuffleItem | undefined> {
    const unit = session.order[index];
    if (!unit || budget.remaining <= 0) return undefined;
    const selected = await choose(unit);
    if (!selected) {
      session.order[index] = undefined;
      budget.remaining -= 1;
      return undefined;
    }
    return typeof selected === "string" ? {
      path: selected,
      title: unit.title,
      ...(unit.season !== undefined ? { season: unit.season } : {}),
      ...(unit.episode !== undefined ? { episode: unit.episode } : {}),
    } : selected;
  }

  private async peekNext(
    session: Session,
    choose: ChooseItem,
    budget: { remaining: number },
  ): Promise<ShuffleItem | undefined> {
    for (let cursor = session.historyCursor + 1; cursor < session.history.length; cursor += 1) {
      const item = await this.itemAt(session, session.history[cursor]!, choose, budget);
      if (item) return item;
      if (budget.remaining <= 0) return undefined;
    }
    const seen = new Set(session.history.slice(0, session.historyCursor + 1));
    for (let index = session.cursor + 1; index < session.order.length; index += 1) {
      if (seen.has(index)) continue;
      const item = await this.itemAt(session, index, choose, budget);
      if (item) return item;
      if (budget.remaining <= 0) return undefined;
    }
    return undefined;
  }

  private async stepAnswer(
    session: Session,
    item: ShuffleItem,
    choose: ChooseItem,
    budget: { remaining: number },
  ): Promise<ShuffleStepAnswer> {
    const upcoming = await this.peekNext(session, choose, budget);
    let hasPrevious = false;
    for (let cursor = session.historyCursor - 1; cursor >= 0 && budget.remaining > 0; cursor -= 1) {
      if (await this.itemAt(session, session.history[cursor]!, choose, budget)) {
        hasPrevious = true;
        break;
      }
    }
    return {
      item,
      hasNext: Boolean(upcoming),
      hasPrevious,
      ...(upcoming ? { upcoming: { title: upcoming.title } } : {}),
    };
  }
}

function shuffle<T>(values: T[], random: (maxExclusive: number) => number): T[] {
  const out = [...values];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const other = random(index + 1);
    [out[index], out[other]] = [out[other]!, out[index]!];
  }
  return out;
}
