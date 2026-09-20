import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

/** Valid only inside this process. FFmpeg reaches /api/proxy over loopback and has no cookie. */
export const INTERNAL_TOKEN = randomBytes(32).toString("hex");


/** The one account as `state.json` held it before there was a list of users. `migrateUsers`
 *  turns it into a record; boot throws out whatever it leaves behind. */
export interface AuthState {
  username: string; passwordHash: string; secret: string; isDefault: boolean;
  /** Revoked sessions by identifier; the value is when they would have expired anyway. */
  revoked?: Record<string, number>;
}

export interface SessionInfo { userId: string; sid: string; expiresAt: number }

const equals = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

/** Comparing through a digest keeps the time constant whatever the two lengths are. */
export const secretEquals = (a: string, b: string) =>
  equals(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

/** A guess at a name that has no account has to cost the same scrypt round as a
 *  guess at the real one, otherwise the answer arrives sooner and says so. */
export const DECOY_HASH = `scrypt$${randomBytes(16).toString("hex")}$${randomBytes(64).toString("hex")}`;

/** The password is not stored, only its scrypt hash with a random salt. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize("NFKC"), salt, 64);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const derived = await scrypt(password.normalize("NFKC"), Buffer.from(saltHex, "hex"), 64);
  return equals(derived, Buffer.from(hashHex, "hex"));
}

/** A signed token with no server-side state, so a restart signs nobody out. Its own session
 *  identifier still allows revoking it before it expires on its own. */
export function createSession(secret: string, userId: string, expiresAt: number, sid = randomBytes(12).toString("base64url")): string {
  const payload = Buffer.from(JSON.stringify({ u: userId, e: expiresAt, s: sid })).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

/** Which user a token names, read before its signature can be checked: the secret that
 *  checks it belongs to that user, so the payload has to be read first. */
export function sessionUserId(token: string | undefined): string | undefined {
  const payload = token?.split(".")[0];
  if (!payload) return undefined;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as { u?: unknown };
    return typeof data.u === "string" && data.u ? data.u : undefined;
  } catch { return undefined; }
}

export function readSession(secret: string, token: string | undefined): SessionInfo | undefined {
  if (!token) return undefined;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return undefined;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (!equals(Buffer.from(signature), Buffer.from(expected))) return undefined;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as { u?: string; e?: number; s?: string };
    if (!data.u || !data.e || !data.s || data.e < Date.now()) return undefined;
    return { userId: data.u, sid: data.s, expiresAt: data.e };
  } catch { return undefined; }
}

/** Forgotten sessions would otherwise pile up in the list without end. */
export function pruneRevoked(revoked: Record<string, number> = {}): Record<string, number> {
  const now = Date.now();
  return Object.fromEntries(Object.entries(revoked).filter(([, expiresAt]) => expiresAt > now));
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (name) result[name] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}

/** Fallback credentials for a forgotten password. They do not replace the stored password; they stand beside it. */
export function envCredentials(): { username: string; password: string } | undefined {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  return username && password ? { username, password } : undefined;
}

export const SESSION_COOKIE = "stremio_offline_session";
export const REMEMBER_DAYS = 30;

export function sessionCookie(token: string, remember: boolean, secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (remember) parts.push(`Max-Age=${REMEMBER_DAYS * 24 * 60 * 60}`);
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export const clearedCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

/**
 * Sign-in has no other cost to an attacker, so repeated failures have to buy time.
 * The pause doubles with every failure past the free attempts and is capped low
 * enough that a mistyped password never locks the household out -- behind a reverse
 * proxy every request arrives from the same address, so a long lock would hit the
 * legitimate user as hard as anyone else.
 */
export class LoginThrottle {
  private failures = new Map<string, { count: number; until: number; at: number }>();

  constructor(private now = Date.now, private freeAttempts = 5, private lockMs = 1000,
    private maxLockMs = 60_000, private forgetMs = 15 * 60_000, private maxKeys = 5000) {}

  private prune() {
    for (const [key, entry] of this.failures) if (entry.at + this.forgetMs <= this.now()) this.failures.delete(key);
    while (this.failures.size > this.maxKeys) this.failures.delete(this.failures.keys().next().value!);
  }

  /** Milliseconds the caller has to wait, or 0 when the attempt may proceed. */
  retryAfterMs(key: string): number {
    this.prune();
    return Math.max(0, (this.failures.get(key)?.until ?? 0) - this.now());
  }

  fail(key: string) {
    this.prune();
    const entry = this.failures.get(key) ?? { count: 0, until: 0, at: this.now() };
    entry.count += 1;
    entry.at = this.now();
    const over = entry.count - this.freeAttempts;
    entry.until = over > 0 ? this.now() + Math.min(this.maxLockMs, this.lockMs * 2 ** (over - 1)) : 0;
    this.failures.set(key, entry);
  }

  succeed(key: string) {
    this.failures.delete(key);
  }
}
