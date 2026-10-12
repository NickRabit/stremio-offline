import assert from "node:assert/strict";
import { test } from "node:test";
import { LIBRARY_ID } from "./libraries.js";
import {
  MEDIA_CONNECTION_ID,
  MEDIA_SECRET_REF,
  READ_ONLY_MEDIA_CAPABILITIES,
  REMOTE_LIBRARY_ID,
  adminMediaConnection,
  adminRemoteLibrary,
  newConnectionId,
  newRemoteLibraryId,
  publicMediaConnection,
  publicRemoteLibrary,
  remoteProgressKey,
  validateMediaServerToken,
  type MediaConnectionRecord,
  type RemoteLibraryRecord,
} from "./media-server-types.js";

const connection = (over: Partial<MediaConnectionRecord> = {}): MediaConnectionRecord => ({
  id: "mconn_00000000000000000000000000000000",
  provider: "jellyfin",
  name: "Living room",
  baseUrl: "https://media.example/prefix",
  allowLan: false,
  allowLoopback: false,
  serverId: "server-1",
  accountId: "user-1",
  enabled: true,
  generation: 3,
  addedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const library = (over: Partial<RemoteLibraryRecord> = {}): RemoteLibraryRecord => ({
  id: "rlib_00000000000000000000000000000000",
  connectionId: connection().id,
  remoteId: "lib-remote-1",
  name: "Films",
  type: "movie",
  enabled: true,
  order: 0,
  allowedUsers: ["u1"],
  showOnHome: true,
  showInContinueWatching: true,
  ...over,
});

test("the progress key is a hashed ordered tuple, not a JSON object", () => {
  const identity = { provider: "jellyfin" as const, serverId: "s", accountId: "a", itemId: "i" };
  const key = remoteProgressKey(identity);
  assert.match(key, /^remote:[0-9a-f]{64}$/);
  assert.equal(key, remoteProgressKey({ ...identity }), "field order is stable");
  assert.notEqual(key, remoteProgressKey({ ...identity, accountId: "b" }));
  assert.notEqual(
    remoteProgressKey(identity),
    remoteProgressKey({ ...identity, serverId: "a", accountId: "s" }),
    "a swap of the tuple order is a different key",
  );
});

test("generated handles use their prefixes and are disjoint from filesystem ids", () => {
  assert.match(newConnectionId(), MEDIA_CONNECTION_ID);
  assert.match(newRemoteLibraryId(), REMOTE_LIBRARY_ID);
  assert.equal(MEDIA_CONNECTION_ID.test("lib_ab12cd34"), false);
  assert.equal(REMOTE_LIBRARY_ID.test("lib_ab12cd34"), false);
  assert.equal(LIBRARY_ID.test(newRemoteLibraryId()), false);
  assert.equal(MEDIA_SECRET_REF.test("msecret_" + "a".repeat(32)), true);
});

test("read-only capabilities are frozen and every one is false", () => {
  assert.equal(Object.isFrozen(READ_ONLY_MEDIA_CAPABILITIES), true);
  assert.deepEqual(READ_ONLY_MEDIA_CAPABILITIES, {
    rename: false,
    move: false,
    delete: false,
    identify: false,
    writeArtwork: false,
    downloadToLibrary: false,
    downloadToDevice: false,
  });
});

test("the member projection is an allow-list that strips injected fields", () => {
  const injected = { ...connection(), accountId: "secret-account", baseUrl: "https://10.0.0.1", secretRef: "msecret_" + "b".repeat(32) };
  const projected = publicMediaConnection(injected);
  assert.deepEqual(Object.keys(projected).sort(), ["configured", "enabled", "generation", "id", "name", "provider"]);
  assert.equal(projected.configured, true);
  assert.equal("baseUrl" in projected, false);
  assert.equal("accountId" in projected, false);
  assert.equal("serverId" in projected, false);
  assert.equal("secretRef" in projected, false);
});

test("the admin projection keeps verified identity and address policy but never the secret ref", () => {
  const projected = adminMediaConnection({ ...connection(), secretRef: "msecret_" + "c".repeat(32) });
  assert.equal(projected.baseUrl, "https://media.example/prefix");
  assert.equal(projected.allowLan, false);
  assert.equal(projected.accountId, "user-1");
  assert.equal(projected.configured, true);
  assert.equal("secretRef" in projected, false);
  assert.equal("addedAt" in projected, false);
});

test("the remote-library projection never spreads the record and always carries capabilities", () => {
  const injected = { ...library(), root: "/etc", writeArtwork: true, secretRef: "x" };
  const projected = publicRemoteLibrary(injected);
  assert.equal("root" in projected, false);
  assert.equal("writeArtwork" in projected, false);
  assert.equal("secretRef" in projected, false);
  assert.deepEqual(projected.capabilities, READ_ONLY_MEDIA_CAPABILITIES);
  assert.equal("allowedUsers" in projected, false);
  const admin = adminRemoteLibrary(injected);
  assert.deepEqual(admin.allowedUsers, ["u1"]);
  admin.allowedUsers.push("mutated");
  assert.deepEqual(library().allowedUsers, ["u1"], "the projection copies the grant list");
});

test("token validation accepts the printable boundary and refuses the rest", () => {
  assert.equal(validateMediaServerToken("a".repeat(8192)), "a".repeat(8192));
  assert.equal(validateMediaServerToken("!"), "!");
  assert.throws(() => validateMediaServerToken("a".repeat(8193)), { code: "invalid-input" });
  assert.throws(() => validateMediaServerToken(""), { code: "invalid-input" });
  assert.throws(() => validateMediaServerToken('ab"cd'), { code: "invalid-input" });
  assert.throws(() => validateMediaServerToken("ab\\cd"), { code: "invalid-input" });
  assert.throws(() => validateMediaServerToken("ab\ncd"), { code: "invalid-input" });
  assert.throws(() => validateMediaServerToken("héllo"), { code: "invalid-input" });
  assert.throws(() => validateMediaServerToken(42), { code: "invalid-input" });
});
