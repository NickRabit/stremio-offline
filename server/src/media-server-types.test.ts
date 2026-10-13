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
  effectiveBrowseMode,
  effectiveMosaic,
  effectiveShowInFavorites,
  newConnectionId,
  newRemoteLibraryId,
  publicMediaConnection,
  publicRemoteLibrary,
  publicRemoteItem,
  remoteProgressKey,
  validateMediaServerToken,
  type MediaConnectionRecord,
  type RemoteLibraryRecord,
} from "./media-server-types.js";
import type { ProviderItem } from "./media-server-provider.js";

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

test("the effective display defaults follow the library type and only an explicit false opts out", () => {
  assert.equal(effectiveBrowseMode(library({ type: "mixed" })), "folders", "a mixed library is a folder tree by default");
  assert.equal(effectiveBrowseMode(library({ type: "movie" })), "titles");
  assert.equal(effectiveBrowseMode(library({ type: "series" })), "titles");
  assert.equal(effectiveBrowseMode(library({ type: "movie", browseMode: "folders" })), "folders", "an explicit choice wins");
  assert.equal(effectiveMosaic(library()), true);
  assert.equal(effectiveMosaic(library({ mosaic: false })), false);
  assert.equal(effectiveShowInFavorites(library()), true);
  assert.equal(effectiveShowInFavorites(library({ showInFavorites: false })), false);

  const projected = publicRemoteLibrary(library({ type: "mixed" }));
  assert.equal(projected.browseMode, "folders");
  assert.equal(projected.mosaic, true);
  assert.equal(projected.showInFavorites, true);
  assert.deepEqual(adminRemoteLibrary(library({ type: "mixed", mosaic: false })).mosaic, false);
});

test("the item projection strips the internal image flag and still carries both artwork paths", () => {
  const item: ProviderItem = { id: "f1", name: "Folder", type: "folder", providerIds: {}, hasPrimaryImage: true };
  const projected = publicRemoteItem(item, "rlib_00000000000000000000000000000000");
  assert.equal("hasPrimaryImage" in projected, false, "the internal flag never reaches a client");
  assert.equal("hasBackdropImage" in projected, false, "no second internal flag leaks either");
  assert.equal(projected.poster, "/api/remote-libraries/rlib_00000000000000000000000000000000/items/f1/artwork/Primary");
  assert.equal(projected.wide, "/api/remote-libraries/rlib_00000000000000000000000000000000/items/f1/artwork/Backdrop");
});

test("the item projection omits a path only for a fact the metadata proves absent", () => {
  const libraryId = "rlib_00000000000000000000000000000000";
  const present = publicRemoteItem(
    { id: "i1", name: "Present", type: "movie", providerIds: {}, hasPrimaryImage: true, hasBackdropImage: true },
    libraryId,
  );
  assert.equal(present.poster, `/api/remote-libraries/${libraryId}/items/i1/artwork/Primary`);
  assert.equal(present.wide, `/api/remote-libraries/${libraryId}/items/i1/artwork/Backdrop`);
  assert.equal("hasPrimaryImage" in present, false);
  assert.equal("hasBackdropImage" in present, false);

  const absent = publicRemoteItem(
    { id: "i2", name: "Absent", type: "movie", providerIds: {}, hasPrimaryImage: false, hasBackdropImage: false },
    libraryId,
  );
  assert.equal("poster" in absent, false, "a proven-absent poster emits no path");
  assert.equal("wide" in absent, false, "a proven-absent backdrop emits no path");
  assert.equal("hasPrimaryImage" in absent, false);
  assert.equal("hasBackdropImage" in absent, false);

  const unknown = publicRemoteItem({ id: "i3", name: "Unknown", type: "movie", providerIds: {} }, libraryId);
  assert.equal(unknown.poster, `/api/remote-libraries/${libraryId}/items/i3/artwork/Primary`, "an unknown primary keeps the legacy path");
  assert.equal(unknown.wide, `/api/remote-libraries/${libraryId}/items/i3/artwork/Backdrop`, "an unknown backdrop keeps the legacy path");

  const halfKnown = publicRemoteItem(
    { id: "i4", name: "Half", type: "movie", providerIds: {}, hasPrimaryImage: false },
    libraryId,
  );
  assert.equal("poster" in halfKnown, false, "each role is decided on its own fact");
  assert.equal(halfKnown.wide, `/api/remote-libraries/${libraryId}/items/i4/artwork/Backdrop`);
});
