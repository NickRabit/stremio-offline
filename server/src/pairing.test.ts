import assert from "node:assert/strict";
import { test } from "node:test";
import { createSession, readSession, type SessionInfo } from "./auth.js";
import {
  normalizePairingCode,
  PAIRING_ALPHABET,
  PAIRING_CAPACITY,
  PAIRING_INTERVAL_MS,
  PAIRING_TTL_MS,
  PairingError,
  PairingRegistry,
} from "./pairing.js";
import type { UserRecord } from "./users.js";

const BASE = Date.now();

const user = (over: Partial<UserRecord> = {}): UserRecord => ({
  id: "usr_00000001",
  username: "owner",
  passwordHash: "scrypt$aa$bb",
  secret: "signing-secret",
  role: "admin",
  createdAt: "2026-01-01T00:00:00.000Z",
  permissions: { downloadToLibrary: true, downloadToDevice: true },
  permissionsVersion: 0,
  ...over,
});

const at = (sessionUser: UserRecord, sid: string, expiresAt: number): SessionInfo =>
  ({ userId: sessionUser.id, sid, expiresAt });

const language = () => "en";

const keyOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof PairingError ? error.messageKey : "other";
  }
  return "passed";
};

test("the 32-character alphabet has no ambiguous I, L, O or U", () => {
  assert.equal(PAIRING_ALPHABET.length, 32);
  assert.equal(new Set(PAIRING_ALPHABET).size, 32);
  for (const letter of "ILOU") assert.equal(PAIRING_ALPHABET.includes(letter), false);
});

test("codes normalize only ASCII case, space and hyphen", () => {
  assert.equal(normalizePairingCode("ab-cd ef23"), "ABCDEF23");
  assert.equal(normalizePairingCode("ABCDEF23"), "ABCDEF23");
  assert.equal(normalizePairingCode("ABCD EF2"), undefined);
  assert.equal(normalizePairingCode("ABCD\tEF23"), undefined);
  assert.equal(normalizePairingCode("ABCD_EF23"), undefined);
  assert.equal(normalizePairingCode("ABCD\u2011EF23"), undefined);
  assert.equal(normalizePairingCode(12345678), undefined);
});

test("start returns a grouped-display-ready code and a private 32-byte token", () => {
  const registry = new PairingRegistry({ now: () => BASE });
  const started = registry.start("  Living room TV  ");
  assert.match(started.code, /^[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.equal(started.pollToken.length, 43);
  assert.equal(started.expiresIn, 300);
  assert.equal(started.interval, 5);
  assert.equal(`${started.code.slice(0, 4)} ${started.code.slice(4)}`.length, 9);
});

test("device labels are trimmed, bounded and refuse control characters", () => {
  const registry = new PairingRegistry();
  assert.throws(() => registry.start(""), (error) => error instanceof PairingError && error.status === 400);
  assert.throws(() => registry.start("x".repeat(81)), (error) => error instanceof PairingError && error.status === 400);
  assert.throws(() => registry.start("TV\nbedroom"), (error) => error instanceof PairingError && error.status === 400);
  assert.throws(() => registry.start(undefined), (error) => error instanceof PairingError && error.status === 400);
  const started = registry.start(` ${"x".repeat(80)} `);
  assert.equal(started.code.length, 8);
});

test("colliding random codes are retried without replacing a live record", () => {
  let call = 0;
  const randomBytes = (size: number) => {
    call += 1;
    const fill = call === 1 || call === 3 ? 0 : call === 4 ? 1 : call;
    return Buffer.alloc(size, fill);
  };
  const registry = new PairingRegistry({ now: () => BASE, randomBytes });
  const first = registry.start("One");
  const second = registry.start("Two");
  assert.notEqual(first.code, second.code);
});

test("capacity prunes expiry first and never evicts a live record", () => {
  let now = BASE;
  const registry = new PairingRegistry({ now: () => now });
  for (let index = 0; index < PAIRING_CAPACITY; index += 1) registry.start(`TV ${index}`);
  assert.equal(keyOf(() => registry.start("overflow")), "err.pairBusy");
  now += PAIRING_TTL_MS - 1;
  assert.equal(keyOf(() => registry.start("still full")), "err.pairBusy");
  now += 1;
  assert.doesNotThrow(() => registry.start("fresh"));
});

test("unknown, malformed and expired poll tokens share terminal rejection", () => {
  let now = BASE;
  const registry = new PairingRegistry({ now: () => now });
  assert.equal(keyOf(() => registry.poll("short", [user()], language)), "err.pairInvalid");
  assert.equal(keyOf(() => registry.poll("A".repeat(43), [user()], language)), "err.pairInvalid");
  const started = registry.start("TV");
  now += PAIRING_TTL_MS;
  assert.equal(keyOf(() => registry.poll(started.pollToken, [user()], language)), "err.pairInvalid");
});

test("per-record polling waits five seconds and does not extend TTL", () => {
  let now = BASE;
  const registry = new PairingRegistry({ now: () => now });
  const started = registry.start("TV");
  assert.deepEqual(registry.poll(started.pollToken, [user()], language), { status: "pending" });
  assert.throws(
    () => registry.poll(started.pollToken, [user()], language),
    (error) => error instanceof PairingError
      && error.status === 429
      && error.retryAfterMs === PAIRING_INTERVAL_MS,
  );
  now += PAIRING_INTERVAL_MS;
  assert.deepEqual(registry.poll(started.pollToken, [user()], language), { status: "pending" });
  now = BASE + PAIRING_TTL_MS;
  assert.equal(keyOf(() => registry.poll(started.pollToken, [user()], language)), "err.pairInvalid");
});

test("inspect replaces one pending nonce and does not approve", () => {
  let now = BASE;
  const registry = new PairingRegistry({ now: () => now });
  const owner = user();
  const session = at(owner, "phone-sid", now + 60_000);
  const started = registry.start("Bedroom TV");
  const first = registry.inspect(started.code.toLowerCase(), session, [owner]);
  const second = registry.inspect(`${started.code.slice(0, 4)} ${started.code.slice(4)}`, session, [owner]);
  assert.equal(first.username, owner.username);
  assert.equal(first.deviceLabel, "Bedroom TV");
  assert.notEqual(first.nonce, second.nonce);
  now += PAIRING_INTERVAL_MS;
  assert.equal(keyOf(() => registry.approve(started.code, first.nonce, session, [owner])), "err.pairChanged");
  assert.deepEqual(registry.poll(started.pollToken, [owner], language), { status: "pending" });
});

test("approval is bound to the precise user, sid and secret generation", () => {
  let now = BASE;
  const registry = new PairingRegistry({ now: () => now });
  const owner = user();
  const other = user({ id: "usr_00000002", username: "other", secret: "other-secret" });
  const phone = at(owner, "phone", now + 60_000);
  const started = registry.start("TV");
  const inspected = registry.inspect(started.code, phone, [owner, other]);

  assert.equal(keyOf(() => registry.approve(started.code, inspected.nonce, at(other, "other-phone", now + 60_000), [owner, other])), "err.pairChanged");
  assert.equal(keyOf(() => registry.approve(started.code, inspected.nonce, at(owner, "different-sid", now + 60_000), [owner])), "err.pairChanged");
  assert.equal(keyOf(() => registry.approve(started.code, inspected.nonce, phone, [{ ...owner, secret: "rotated" }])), "err.pairChanged");
  registry.approve(started.code, inspected.nonce, phone, [owner]);
  assert.equal(keyOf(() => registry.approve(started.code, inspected.nonce, phone, [owner])), "err.pairChanged");
});

test("deny is terminal and bound to the same inspection", () => {
  const now = BASE;
  const registry = new PairingRegistry({ now: () => now });
  const owner = user();
  const phone = at(owner, "phone", now + 60_000);
  const started = registry.start("TV");
  const inspected = registry.inspect(started.code, phone, [owner]);
  assert.equal(keyOf(() => registry.deny(started.code, "A".repeat(43), phone, [owner])), "err.pairChanged");
  registry.deny(started.code, inspected.nonce, phone, [owner]);
  assert.equal(keyOf(() => registry.inspect(started.code, phone, [owner])), "err.pairInvalid");
  assert.equal(keyOf(() => registry.poll(started.pollToken, [owner], language)), "err.pairInvalid");
});

test("the first approved poll issues one remembered session and replays it unchanged", () => {
  let now = BASE;
  const registry = new PairingRegistry({ now: () => now });
  const owner = user();
  const phone = at(owner, "phone", now + 60_000);
  const started = registry.start("TV");
  const inspected = registry.inspect(started.code, phone, [owner]);
  registry.approve(started.code, inspected.nonce, phone, [owner]);
  const first = registry.poll(started.pollToken, [owner], () => "cs");
  assert.equal(first.status, "approved");
  if (first.status !== "approved") return;
  const parsed = readSession(owner.secret, first.token);
  assert.ok(parsed);
  assert.notEqual(parsed.sid, phone.sid);
  assert.equal(parsed.userId, owner.id);
  assert.equal(first.language, "cs");
  assert.equal(first.expiresAt, now + 30 * 24 * 60 * 60 * 1000);

  now += PAIRING_INTERVAL_MS;
  const replay = registry.poll(started.pollToken, [owner], language);
  assert.equal(replay.status, "approved");
  if (replay.status === "approved") {
    assert.equal(replay.token, first.token);
    assert.equal(replay.expiresAt, first.expiresAt);
  }
});

test("invalidating the approver before first issuance cancels instead of signing", () => {
  for (const change of ["secret", "disabled", "deleted", "mustChange", "expired", "revoked"] as const) {
    let now = BASE;
    const registry = new PairingRegistry({ now: () => now });
    const owner = user();
    const phone = at(owner, "phone", now + 60_000);
    const started = registry.start("TV");
    const inspected = registry.inspect(started.code, phone, [owner]);
    registry.approve(started.code, inspected.nonce, phone, [owner]);
    let current: UserRecord[] = [owner];
    if (change === "secret") current = [{ ...owner, secret: "rotated" }];
    if (change === "disabled") current = [{ ...owner, disabled: true }];
    if (change === "deleted") current = [];
    if (change === "mustChange") current = [{ ...owner, mustChangePassword: true }];
    if (change === "expired") now += 60_000;
    if (change === "revoked") current = [{ ...owner, revoked: { phone: phone.expiresAt } }];
    assert.equal(keyOf(() => registry.poll(started.pollToken, current, language)), "err.pairInvalid", change);
  }
});

test("revoking the approver sid after issuance leaves the independent TV session valid", () => {
  let now = BASE;
  const registry = new PairingRegistry({ now: () => now });
  const owner = user();
  const phone = at(owner, "phone", now + 60_000);
  const started = registry.start("TV");
  const inspected = registry.inspect(started.code, phone, [owner]);
  registry.approve(started.code, inspected.nonce, phone, [owner]);
  const first = registry.poll(started.pollToken, [owner], language);
  assert.equal(first.status, "approved");

  now += PAIRING_INTERVAL_MS;
  const replay = registry.poll(started.pollToken, [{ ...owner, revoked: { phone: phone.expiresAt } }], language);
  assert.equal(replay.status, "approved");
  if (first.status === "approved" && replay.status === "approved") assert.equal(replay.token, first.token);
});

test("account changes and revoking the issued TV sid invalidate replay", () => {
  for (const change of ["secret", "disabled", "deleted", "mustChange", "revoked"] as const) {
    let now = BASE;
    const registry = new PairingRegistry({ now: () => now });
    const owner = user();
    const phone = at(owner, "phone", now + 60_000);
    const started = registry.start("TV");
    const inspected = registry.inspect(started.code, phone, [owner]);
    registry.approve(started.code, inspected.nonce, phone, [owner]);
    const first = registry.poll(started.pollToken, [owner], language);
    assert.equal(first.status, "approved");
    if (first.status !== "approved") continue;
    const tv = readSession(owner.secret, first.token)!;
    let current: UserRecord[] = [owner];
    if (change === "secret") current = [{ ...owner, secret: "rotated" }];
    if (change === "disabled") current = [{ ...owner, disabled: true }];
    if (change === "deleted") current = [];
    if (change === "mustChange") current = [{ ...owner, mustChangePassword: true }];
    if (change === "revoked") current = [{ ...owner, revoked: { [tv.sid]: tv.expiresAt } }];
    now += PAIRING_INTERVAL_MS;
    assert.equal(keyOf(() => registry.poll(started.pollToken, current, language)), "err.pairInvalid", change);
  }
});

test("a new registry forgets unfinished and delivered pairings", () => {
  const started = new PairingRegistry().start("TV");
  const restarted = new PairingRegistry();
  assert.equal(keyOf(() => restarted.poll(started.pollToken, [user()], language)), "err.pairInvalid");
});

test("a live record is never evicted when a duplicate code is requested", () => {
  const registry = new PairingRegistry();
  const started = registry.start("Original TV");
  assert.match(started.code, /^[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.equal(registry.start(`TV ${started.code}`).code.length, 8);
  assert.deepEqual(registry.poll(started.pollToken, [user()], language), { status: "pending" });
});
