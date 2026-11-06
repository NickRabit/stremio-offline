import { createHash, randomBytes as cryptoRandomBytes, timingSafeEqual } from "node:crypto";
import { createSession, readSession, REMEMBER_DAYS, type SessionInfo } from "./auth.js";
import { AppError } from "./errors.js";
import type { UserRecord } from "./users.js";

export const PAIRING_TTL_MS = 5 * 60_000;
export const PAIRING_INTERVAL_MS = 5_000;
export const PAIRING_CAPACITY = 256;
export const PAIRING_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const POLL_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

type PairingState = "pending" | "approved" | "denied" | "delivered";

interface Authority {
  userId: string;
  sid: string;
  sessionExpiresAt: number;
  secretDigest: string;
}

interface PairingRecord {
  code: string;
  deviceLabel: string;
  pollDigest: string;
  createdAt: number;
  expiresAt: number;
  lastPollAt?: number;
  state: PairingState;
  inspection?: Authority & { nonceDigest: string };
  approval?: Authority;
  issued?: { token: string; sid: string; expiresAt: number };
}

export interface PairingStart {
  code: string;
  pollToken: string;
  expiresIn: number;
  interval: number;
}

export type PairingPoll =
  | { status: "pending" }
  | { status: "approved"; username: string; role: UserRecord["role"]; language: string; token: string; expiresAt: number };

export interface PairingInspection {
  code: string;
  deviceLabel: string;
  username: string;
  nonce: string;
  expiresIn: number;
}

export interface PairingRuntime {
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
}

export class PairingError extends AppError {
  constructor(
    message: string,
    messageKey: string,
    status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message, messageKey, status);
  }
}

const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

const sameDigest = (left: string, right: string): boolean => {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
};

const invalid = (status = 410) =>
  new PairingError("This code is invalid or no longer available.", "err.pairInvalid", status);

const changed = () =>
  new PairingError("The confirmation is no longer valid. Check the code again.", "err.pairChanged", 409);

export const normalizePairingCode = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  // The alphabet leaves out I, L and O, so a misread letter becomes the digit it looks like.
  const canonical = value
    .replace(/[ -]/g, "")
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return canonical.length === 8 && [...canonical].every((letter) => PAIRING_ALPHABET.includes(letter))
    ? canonical
    : undefined;
};

const sessionDigest = (user: UserRecord) => digest(user.secret);

const liveUser = (users: readonly UserRecord[], userId: string): UserRecord | undefined =>
  users.find((user) => user.id === userId && !user.disabled && !user.mustChangePassword);

const sessionAuthority = (
  session: SessionInfo,
  users: readonly UserRecord[],
  expected?: Authority,
  now = Date.now(),
): UserRecord => {
  const user = liveUser(users, session.userId);
  if (
    !user
    || session.userId !== user.id
    || session.userId !== (expected?.userId ?? session.userId)
    || session.expiresAt <= now
    || user.revoked?.[session.sid]
    || sessionDigest(user) !== (expected?.secretDigest ?? sessionDigest(user))
    || session.sid !== (expected?.sid ?? session.sid)
    || session.expiresAt !== (expected?.sessionExpiresAt ?? session.expiresAt)
  ) {
    throw changed();
  }
  return user;
};

export class PairingRegistry {
  private readonly records = new Map<string, PairingRecord>();
  private readonly byPoll = new Map<string, PairingRecord>();
  private readonly now: () => number;
  private readonly randomBytes: (size: number) => Buffer;

  constructor(runtime: PairingRuntime = {}) {
    this.now = runtime.now ?? Date.now;
    this.randomBytes = runtime.randomBytes ?? cryptoRandomBytes;
  }

  start(deviceLabelValue: unknown): PairingStart {
    const deviceLabel = typeof deviceLabelValue === "string" ? deviceLabelValue.trim() : "";
    if (!deviceLabel || deviceLabel.length > 80 || CONTROL.test(deviceLabel)) {
      throw new PairingError("Enter a device name of at most 80 characters.", "err.invalidRequest", 400);
    }

    const now = this.now();
    this.prune(now);
    if (this.records.size >= PAIRING_CAPACITY) {
      throw new PairingError("Too many devices are waiting. Try again later.", "err.pairBusy", 429, PAIRING_INTERVAL_MS);
    }

    let code = this.newCode();
    while (this.records.has(code)) code = this.newCode();
    const pollToken = this.randomBytes(32).toString("base64url");
    const record: PairingRecord = {
      code,
      deviceLabel,
      pollDigest: digest(pollToken),
      createdAt: now,
      expiresAt: now + PAIRING_TTL_MS,
      state: "pending",
    };
    this.records.set(code, record);
    this.byPoll.set(record.pollDigest, record);
    return { code, pollToken, expiresIn: PAIRING_TTL_MS / 1000, interval: PAIRING_INTERVAL_MS / 1000 };
  }

  poll(pollToken: unknown, users: readonly UserRecord[], languageOf: (userId: string) => string): PairingPoll {
    if (typeof pollToken !== "string" || !POLL_TOKEN.test(pollToken)) throw invalid(400);
    const record = this.byPoll.get(digest(pollToken));
    if (!record || !sameDigest(record.pollDigest, digest(pollToken))) throw invalid();

    const now = this.now();
    if (now >= record.expiresAt) {
      this.remove(record);
      throw invalid();
    }
    if (record.lastPollAt !== undefined && now - record.lastPollAt < PAIRING_INTERVAL_MS) {
      const retryAfterMs = PAIRING_INTERVAL_MS - Math.max(0, now - record.lastPollAt);
      throw new PairingError("Too many requests. Try again later.", "err.tooManyRequests", 429, retryAfterMs);
    }
    record.lastPollAt = now;

    if (record.state === "pending") return { status: "pending" };
    if (record.state === "denied") throw invalid();

    const approval = record.approval;
    if (!approval) {
      record.state = "denied";
      throw invalid();
    }
    const current = liveUser(users, approval.userId);
    if (!current) {
      record.state = "denied";
      throw invalid();
    }

    if (record.state === "approved") {
      if (
        sessionDigest(current) !== approval.secretDigest
        || approval.sessionExpiresAt <= now
        || current.revoked?.[approval.sid]
      ) {
        record.state = "denied";
        throw invalid();
      }
      const sid = this.randomBytes(12).toString("base64url");
      const expiresAt = now + REMEMBER_DAYS * 24 * 60 * 60 * 1000;
      const token = createSession(current.secret, current.id, expiresAt, sid);
      record.issued = { token, sid, expiresAt };
      record.state = "delivered";
      return {
        status: "approved",
        username: current.username,
        role: current.role,
        language: languageOf(current.id),
        token,
        expiresAt,
      };
    }

    const issued = record.issued;
    const verified = issued ? readSession(current.secret, issued.token) : undefined;
    if (
      !issued
      || !verified
      || verified.userId !== current.id
      || verified.sid !== issued.sid
      || verified.expiresAt !== issued.expiresAt
      || issued.expiresAt <= now
      || current.revoked?.[issued.sid]
    ) {
      record.state = "denied";
      throw invalid();
    }
    return {
      status: "approved",
      username: current.username,
      role: current.role,
      language: languageOf(current.id),
      token: issued.token,
      expiresAt: issued.expiresAt,
    };
  }

  inspect(codeValue: unknown, session: SessionInfo, users: readonly UserRecord[]): PairingInspection {
    const code = this.lookupCode(codeValue);
    if (code.state !== "pending") {
      if (code.state === "denied") throw invalid();
      throw changed();
    }
    const now = this.now();
    const user = sessionAuthority(session, users, undefined, now);
    const nonce = this.randomBytes(32).toString("base64url");
    code.inspection = {
      nonceDigest: digest(nonce),
      userId: user.id,
      sid: session.sid,
      sessionExpiresAt: session.expiresAt,
      secretDigest: sessionDigest(user),
    };
    return {
      code: code.code,
      deviceLabel: code.deviceLabel,
      username: user.username,
      nonce,
      expiresIn: Math.max(0, Math.ceil((code.expiresAt - now) / 1000)),
    };
  }

  approve(codeValue: unknown, nonceValue: unknown, session: SessionInfo, users: readonly UserRecord[]): void {
    const record = this.lookupCode(codeValue);
    const inspection = this.matchingInspection(record, nonceValue);
    if (record.state !== "pending") throw changed();
    sessionAuthority(session, users, inspection, this.now());
    record.approval = {
      userId: inspection.userId,
      sid: inspection.sid,
      sessionExpiresAt: inspection.sessionExpiresAt,
      secretDigest: inspection.secretDigest,
    };
    record.state = "approved";
  }

  deny(codeValue: unknown, nonceValue: unknown, session: SessionInfo, users: readonly UserRecord[]): void {
    const record = this.lookupCode(codeValue);
    const inspection = this.matchingInspection(record, nonceValue);
    if (record.state !== "pending") throw changed();
    sessionAuthority(session, users, inspection, this.now());
    record.state = "denied";
  }

  private matchingInspection(record: PairingRecord, nonceValue: unknown): Authority & { nonceDigest: string } {
    if (typeof nonceValue !== "string" || !NONCE.test(nonceValue) || !record.inspection) throw changed();
    const nonceDigest = digest(nonceValue);
    if (!sameDigest(record.inspection.nonceDigest, nonceDigest)) throw changed();
    return record.inspection;
  }

  private lookupCode(codeValue: unknown): PairingRecord {
    const code = normalizePairingCode(codeValue);
    if (!code) throw invalid(400);
    const record = this.records.get(code);
    if (!record) throw invalid();
    if (this.now() >= record.expiresAt) {
      this.remove(record);
      throw invalid();
    }
    return record;
  }

  private prune(now: number): void {
    for (const record of this.records.values()) {
      if (now >= record.expiresAt) this.remove(record);
    }
  }

  private remove(record: PairingRecord): void {
    this.records.delete(record.code);
    this.byPoll.delete(record.pollDigest);
  }

  private newCode(): string {
    const bytes = this.randomBytes(8);
    return [...bytes.subarray(0, 8)].map((byte) => PAIRING_ALPHABET[byte & 31]).join("");
  }
}
