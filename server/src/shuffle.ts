import { randomBytes, randomInt } from "node:crypto";
import { libraryPath, posixBase, type LibraryType } from "./libraries.js";
import { episodeKey, episodeNumberOf, isExtraName, knownEntryForUnit, titleUnits, unitFor, type LibraryEpisodeRecord, type LibraryMetaRecord } from "./library-match.js";
import { parseMediaPath } from "./library-parse.js";

export const SHUFFLE_POOL_LIMIT = 5000;
export const SHUFFLE_TTL_MS = 6 * 60 * 60_000;
export const SHUFFLE_ACCOUNT_LIMIT = 3;
export const SHUFFLE_TOTAL_LIMIT = 200;

export interface ShuffleItem {
  path: string;
  title: string;
  season?: number;
  episode?: number;
}

export interface ShuffleUnit {
  files: string[];
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

type ChooseFile = (unit: ShuffleUnit) => Promise<string | undefined>;

interface Session {
  id: string;
  owner: ShuffleOwner;
  order: ShuffleUnit[];
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
  private readonly now: () => number;
  private readonly random: (maxExclusive: number) => number;
  private sequence = 0;

  constructor(options: ShuffleSessionOptions = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.randomInt ?? ((maxExclusive) => randomInt(maxExclusive));
  }

  async start(owner: ShuffleOwner, units: ShuffleUnit[], choose: ChooseFile): Promise<ShuffleStartAnswer | undefined> {
    const now = this.now();
    this.cleanup(now);
    const shuffled = shuffle(units, this.random);
    const capped = shuffled.length > SHUFFLE_POOL_LIMIT;
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
    const index = await this.firstPlayable(session, 0, choose);
    if (index === undefined) return undefined;
    this.placeLimits(owner.userId);
    session.cursor = index;
    session.history = [index];
    session.historyCursor = 0;
    this.sessions.set(session.id, session);
    const item = await this.itemAt(session, index, choose);
    if (!item) {
      this.sessions.delete(session.id);
      return undefined;
    }
    const next = await this.peekNext(session, choose);
    return {
      id: session.id,
      item,
      total: session.order.length,
      ...(capped ? { capped: true as const } : {}),
      hasNext: Boolean(next),
      hasPrevious: false,
      ...(next ? { upcoming: { title: next.title } } : {}),
    };
  }

  async next(owner: ShuffleOwner, id: string, choose: ChooseFile): Promise<ShuffleNextAnswer | undefined> {
    const session = this.session(owner, id);
    if (!session) return undefined;
    session.lastUsed = this.now();

    while (session.historyCursor + 1 < session.history.length) {
      const index = session.history[++session.historyCursor]!;
      const item = await this.itemAt(session, index, choose);
      if (item) return this.stepAnswer(session, item, choose);
      session.history.splice(session.historyCursor--, 1);
    }

    const index = await this.firstPlayable(session, session.cursor + 1, choose);
    if (index === undefined) return { item: null, exhausted: true };
    session.cursor = index;
    session.history = session.history.slice(0, session.historyCursor + 1);
    session.history.push(index);
    session.historyCursor += 1;
    const item = await this.itemAt(session, index, choose);
    if (!item) return { item: null, exhausted: true };
    return this.stepAnswer(session, item, choose);
  }

  async previous(owner: ShuffleOwner, id: string, choose: ChooseFile): Promise<ShufflePreviousAnswer | undefined> {
    const session = this.session(owner, id);
    if (!session) return undefined;
    session.lastUsed = this.now();
    while (session.historyCursor > 0) {
      const index = session.history[--session.historyCursor]!;
      const item = await this.itemAt(session, index, choose);
      if (item) {
        session.cursor = index;
        return this.stepAnswer(session, item, choose);
      }
      session.history.splice(session.historyCursor, 1);
    }
    return { item: null };
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

  private async firstPlayable(session: Session, from: number, choose: ChooseFile): Promise<number | undefined> {
    for (let index = Math.max(0, from); index < session.order.length; index += 1) {
      if (await this.itemAt(session, index, choose)) return index;
    }
    return undefined;
  }

  private async itemAt(session: Session, index: number, choose: ChooseFile): Promise<ShuffleItem | undefined> {
    const unit = session.order[index];
    if (!unit) return undefined;
    const path = await choose(unit);
    return path ? {
      path,
      title: unit.title,
      ...(unit.season !== undefined ? { season: unit.season } : {}),
      ...(unit.episode !== undefined ? { episode: unit.episode } : {}),
    } : undefined;
  }

  private async peekNext(session: Session, choose: ChooseFile): Promise<ShuffleItem | undefined> {
    for (let cursor = session.historyCursor + 1; cursor < session.history.length; cursor += 1) {
      const item = await this.itemAt(session, session.history[cursor]!, choose);
      if (item) return item;
    }
    const seen = new Set(session.history.slice(0, session.historyCursor + 1));
    for (let index = session.cursor + 1; index < session.order.length; index += 1) {
      if (seen.has(index)) continue;
      const item = await this.itemAt(session, index, choose);
      if (item) return item;
    }
    return undefined;
  }

  private async stepAnswer(session: Session, item: ShuffleItem, choose: ChooseFile): Promise<ShuffleStepAnswer> {
    const upcoming = await this.peekNext(session, choose);
    let hasPrevious = false;
    for (let cursor = session.historyCursor - 1; cursor >= 0; cursor -= 1) {
      if (await this.itemAt(session, session.history[cursor]!, choose)) {
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
