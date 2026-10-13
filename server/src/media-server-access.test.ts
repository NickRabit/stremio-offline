import assert from "node:assert/strict";
import { test } from "node:test";
import { remoteContentAccessible, remoteLibraryVisibleTo, type RemoteAccessSource } from "./media-server-access.js";
import { remoteSecretStamp, type RemoteContentRef } from "./media-server-reference.js";
import type { MediaConnectionRecord, RemoteLibraryRecord } from "./media-server-types.js";
import type { UserRecord } from "./users.js";

const user = (over: Partial<UserRecord> & Pick<UserRecord, "id" | "role">): UserRecord => ({
  username: over.id,
  passwordHash: "scrypt$aa$bb",
  secret: `secret-${over.id}`,
  createdAt: "2026-01-01T00:00:00.000Z",
  permissions: { downloadToLibrary: true, downloadToDevice: true },
  permissionsVersion: 0,
  ...over,
});

const connection = (over: Partial<MediaConnectionRecord> = {}): MediaConnectionRecord => ({
  id: `mconn_${"a".repeat(32)}`,
  provider: "jellyfin",
  name: "Home",
  baseUrl: "http://media.example",
  allowLan: false,
  allowLoopback: false,
  serverId: "server-1",
  accountId: "account-1",
  enabled: true,
  generation: 2,
  secretRef: `msecret_${"f".repeat(32)}`,
  addedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const library = (over: Partial<RemoteLibraryRecord> = {}): RemoteLibraryRecord => ({
  id: `rlib_${"b".repeat(32)}`,
  connectionId: connection().id,
  remoteId: "remote-1",
  name: "Movies",
  type: "movie",
  enabled: true,
  order: 0,
  allowedUsers: [],
  showOnHome: true,
  showInContinueWatching: true,
  ...over,
});

const owner = user({ id: "usr_00000001", role: "admin" });

const ref = (over: Partial<RemoteContentRef> = {}): RemoteContentRef => ({
  provider: "jellyfin",
  serverId: "server-1",
  accountId: "account-1",
  itemId: "item-1",
  connectionId: connection().id,
  libraryId: library().id,
  generation: 2,
  mediaSourceId: "source-1",
  owner: { userId: owner.id, sid: "sid-1", expiresAt: Date.now() + 3_600_000, secretStamp: remoteSecretStamp(owner.secret) },
  ...over,
});

interface SourceOptions { users?: UserRecord[]; connections?: MediaConnectionRecord[]; libraries?: RemoteLibraryRecord[] }

const source = (over: SourceOptions = {}): RemoteAccessSource => ({
  users: () => over.users ?? [owner],
  mediaConnections: () => over.connections ?? [connection()],
  remoteLibraries: () => over.libraries ?? [library()],
});

test("remoteLibraryVisibleTo requires an enabled, configured library and connection", () => {
  const admin = { id: owner.id, role: "admin" as const };
  const member = { id: "usr_00000002", role: "user" as const };
  assert.equal(remoteLibraryVisibleTo([connection()], library(), admin), true);
  assert.equal(remoteLibraryVisibleTo([connection()], library(), member), false);
  assert.equal(remoteLibraryVisibleTo([connection()], library({ allowedUsers: [member.id] }), member), true);
  assert.equal(remoteLibraryVisibleTo([connection({ enabled: false })], library(), admin), false);
  assert.equal(remoteLibraryVisibleTo([connection()], library({ enabled: false }), admin), false);
  assert.equal(remoteLibraryVisibleTo([connection({ secretRef: undefined })], library(), admin), false);
  assert.equal(remoteLibraryVisibleTo([], library(), admin), false);
});

test("remoteContentAccessible accepts a current owner and library", () => {
  assert.equal(remoteContentAccessible(source(), ref()), true);
});

test("remoteContentAccessible refuses a wrong stamp, a dead session and an expired owner", () => {
  const dead = user({ id: owner.id, role: "admin", secret: "secret-changed" });
  assert.equal(remoteContentAccessible(source({ users: [dead] }), ref()), false);
  assert.equal(remoteContentAccessible(source({ users: [user({ id: owner.id, role: "admin", disabled: true })] }), ref()), false);
  assert.equal(remoteContentAccessible(source({ users: [user({ id: owner.id, role: "admin", mustChangePassword: true })] }), ref()), false);
  assert.equal(remoteContentAccessible(source({ users: [user({ id: owner.id, role: "admin", revoked: { "sid-1": Date.now() + 1000 } })] }), ref()), false);
  assert.equal(remoteContentAccessible(source(), ref({ owner: { ...ref().owner, expiresAt: Date.now() - 1 } })), false);
});

test("remoteContentAccessible refuses a demoted grant and a disabled or removed resource", () => {
  const member = user({ id: "usr_00000002", role: "user" });
  const mine = ref({ owner: { ...ref().owner, userId: member.id, secretStamp: remoteSecretStamp(member.secret) } });
  assert.equal(remoteContentAccessible(source({ users: [member] }), mine), false, "not granted to the member");
  assert.equal(remoteContentAccessible(source({ users: [member], libraries: [library({ allowedUsers: [member.id] })] }), mine), true);
  assert.equal(remoteContentAccessible(source({ users: [member], libraries: [library({ allowedUsers: [member.id], enabled: false })] }), mine), false);
  assert.equal(remoteContentAccessible(source({ users: [member], connections: [connection({ enabled: false })] }), mine), false);
  assert.equal(remoteContentAccessible(source({ users: [member], libraries: [] }), mine), false);
});

test("remoteContentAccessible refuses a generation or identity change", () => {
  assert.equal(remoteContentAccessible(source({ connections: [connection({ generation: 3 })] }), ref()), false);
  assert.equal(remoteContentAccessible(source({ connections: [connection({ accountId: "other" })] }), ref()), false);
  assert.equal(remoteContentAccessible(source({ connections: [connection({ serverId: "other" })] }), ref()), false);
  assert.equal(remoteContentAccessible(source({ connections: [connection({ provider: "emby" })] }), ref()), false);
  assert.equal(remoteContentAccessible(source({ libraries: [library({ connectionId: `mconn_${"c".repeat(32)}` })] }), ref()), false);
});
