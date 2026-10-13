import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REMOTE_HISTORY_RETENTION_MS,
  connectionScope,
  forgetRemovedHistory,
  historySweepPending,
  markRemovedHistory,
  purgeExpiredHistory,
  retainHistoryOnAttach,
  sweepRemoteHistory,
  type RemoteHistoryState,
} from "./media-server-retention.js";
import { remoteProgressKey, type MediaConnectionRecord, type RemoteLibraryRecord } from "./media-server-types.js";
import { emptyUserData, type UserData } from "./users.js";

const ADA = "usr_00000001";
const BOB = "usr_00000002";
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-06-01T00:00:00.000Z");

const connection = (over: Partial<MediaConnectionRecord> = {}): MediaConnectionRecord => ({
  id: `mconn_${"1".repeat(32)}`,
  provider: "jellyfin",
  name: "Home",
  baseUrl: "http://media.example",
  allowLan: false,
  allowLoopback: false,
  serverId: "server-1",
  accountId: "account-1",
  enabled: true,
  generation: 0,
  secretRef: `msecret_${"3".repeat(32)}`,
  addedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const library = (over: Partial<RemoteLibraryRecord> = {}): RemoteLibraryRecord => ({
  id: `rlib_${"2".repeat(32)}`,
  connectionId: connection().id,
  remoteId: "remote-1",
  name: "Films",
  type: "movie",
  enabled: true,
  order: 0,
  allowedUsers: [],
  showOnHome: true,
  showInContinueWatching: true,
  ...over,
});

/** One stored row, canonical by construction -- the key is derived from the identity the
 *  overrides leave behind -- unless a test breaks a field on purpose. */
const row = (over: Record<string, unknown> = {}): Record<string, unknown> => {
  const merged = {
    provider: "jellyfin", serverId: "server-1", accountId: "account-1", itemId: "m1",
    remoteLibraryId: "remote-1",
    type: "movie", name: "Alien", position: 10, duration: 100, favorite: false, watched: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
  const identity = merged as { provider: "jellyfin" | "emby"; serverId: string; accountId: string; itemId: string };
  return { ...merged, key: over.key ?? remoteProgressKey(identity) };
};

const mount = (rows: Record<string, Record<string, unknown>>, over: Partial<RemoteHistoryState> = {}): RemoteHistoryState => ({
  users: [],
  userData: Object.fromEntries(Object.entries(rows).map(([id, remoteMedia]) => [id, { ...emptyUserData(), remoteMedia } as UserData])),
  mediaConnections: [connection()],
  remoteLibraries: [library()],
  ...over,
});

const rowsOf = (state: RemoteHistoryState, userId: string): Record<string, unknown> =>
  (state.userData?.[userId]?.remoteMedia ?? {}) as Record<string, unknown>;

test("a removal marks the stored history once and the 30 days run from the removal", () => {
  const state = mount({ [ADA]: { [row().key as string]: row() } }, { users: [] });
  const scope = connectionScope(connection());
  markRemovedHistory(state, scope, NOW, { connectionIds: [connection().id] });
  const stored = rowsOf(state, ADA)[row().key as string] as { orphanedAt?: string };
  assert.equal(stored.orphanedAt, new Date(NOW).toISOString());
  assert.equal(purgeExpiredHistory(state, NOW + REMOTE_HISTORY_RETENTION_MS - 1), false, "a day short of thirty is kept");
  // A second removal, a playback and a favourite all leave the running countdown alone.
  markRemovedHistory(state, scope, NOW + 10 * DAY, { connectionIds: [connection().id] });
  assert.equal((rowsOf(state, ADA)[row().key as string] as { orphanedAt?: string }).orphanedAt, new Date(NOW).toISOString(), "removing it again does not extend the thirty days");
  assert.equal(purgeExpiredHistory(state, NOW + REMOTE_HISTORY_RETENTION_MS), true, "the day it runs out, it goes");
  assert.deepEqual(rowsOf(state, ADA), {});
});

test("a disabled attachment and an outage both keep the history", () => {
  const state = mount({ [ADA]: { [row().key as string]: row() } }, {
    mediaConnections: [connection({ enabled: false })],
    remoteLibraries: [library({ enabled: false })],
  });
  markRemovedHistory(state, { provider: "jellyfin", serverId: "server-1", accountId: "account-1", remoteLibraryId: "remote-2" }, NOW, { libraryIds: [library().id] });
  assert.equal(sweepRemoteHistory(state, NOW), false, "nothing is detached and nothing has expired");
  assert.equal((rowsOf(state, ADA)[row().key as string] as { orphanedAt?: string }).orphanedAt, undefined);
  assert.equal(historySweepPending(state, NOW), false, "a sweep with nothing to do writes nothing");
});

test("the scope is the exact identity and upstream library, never a neighbour", () => {
  const otherAccount = row({ accountId: "account-2" });
  const otherServer = row({ serverId: "server-2" });
  const otherLibrary = row({ remoteLibraryId: "remote-2", itemId: "m2" });
  const mine = row();
  const state = mount({
    [ADA]: { [mine.key as string]: mine, [otherAccount.key as string]: otherAccount, [otherServer.key as string]: otherServer, [otherLibrary.key as string]: otherLibrary },
    [BOB]: { [mine.key as string]: mine },
  });
  // Removing one upstream library covers its own rows in every account and nothing else.
  markRemovedHistory(state, { provider: "jellyfin", serverId: "server-1", accountId: "account-1", remoteLibraryId: "remote-1" }, NOW, { libraryIds: [library().id] });
  assert.equal((rowsOf(state, ADA)[mine.key as string] as { orphanedAt?: string }).orphanedAt, new Date(NOW).toISOString());
  assert.equal((rowsOf(state, BOB)[mine.key as string] as { orphanedAt?: string }).orphanedAt, new Date(NOW).toISOString(), "every account's row goes with the library");
  for (const untouched of [otherAccount, otherServer, otherLibrary]) {
    assert.equal((rowsOf(state, ADA)[untouched.key as string] as { orphanedAt?: string }).orphanedAt, undefined, JSON.stringify(untouched));
  }
});

test("a reattachment inside the thirty days takes the history back without grants", () => {
  const state = mount({ [ADA]: { [row().key as string]: row() } });
  markRemovedHistory(state, { provider: "jellyfin", serverId: "server-1", accountId: "account-1", remoteLibraryId: "remote-1" }, NOW, { libraryIds: [library().id] });
  retainHistoryOnAttach(state, connectionScope(connection()), "remote-1");
  const stored = rowsOf(state, ADA)[row().key as string] as Record<string, unknown>;
  assert.equal("orphanedAt" in stored, false, "the countdown is gone");
  assert.equal(stored.position, 10, "and the row itself is untouched");
  assert.equal(sweepRemoteHistory(state, NOW + 40 * DAY), false, "an attached row is never marked again");
});

test("history that ran out is gone for good, and a sweep never restarts a countdown", () => {
  const state = mount({ [ADA]: { [row().key as string]: row() } });
  markRemovedHistory(state, { provider: "jellyfin", serverId: "server-1", accountId: "account-1", remoteLibraryId: "remote-1" }, NOW, { libraryIds: [library().id] });
  assert.equal(sweepRemoteHistory(state, NOW + REMOTE_HISTORY_RETENTION_MS), true);
  assert.deepEqual(rowsOf(state, ADA), {});
  markRemovedHistory(state, { provider: "jellyfin", serverId: "server-1", accountId: "account-1", remoteLibraryId: "remote-1" }, NOW + 40 * DAY);
  assert.deepEqual(rowsOf(state, ADA), {}, "a forgotten row is never recovered");
});

test("forget deletes the rows of every account for the scope at once", () => {
  const mine = row();
  const state = mount({ [ADA]: { [mine.key as string]: mine }, [BOB]: { [mine.key as string]: mine } });
  forgetRemovedHistory(state, connectionScope(connection()));
  assert.deepEqual(rowsOf(state, ADA), {});
  assert.deepEqual(rowsOf(state, BOB), {});
});

test("a malformed row is never marked, recovered or purged", () => {
  const wrongKey = row({ key: `remote:${"0".repeat(64)}` });
  const badProvider = row({ provider: "plex" });
  const shortItem = row({ itemId: "" });
  const notARecord = "nonsense";
  const state = mount({
    [ADA]: {
      [wrongKey.key as string]: wrongKey,
      [badProvider.key as string]: badProvider,
      [shortItem.key as string]: shortItem,
      nonsense: notARecord,
    },
  });
  const before = JSON.stringify(rowsOf(state, ADA));
  markRemovedHistory(state, connectionScope(connection()), NOW);
  forgetRemovedHistory(state, connectionScope(connection()));
  assert.equal(JSON.stringify(rowsOf(state, ADA)), before, "a row that does not name itself is left exactly as it was");
  assert.equal(Object.keys(rowsOf(state, ADA)).length, 4, "a malformed row never stands in for another identity");
  assert.equal(historySweepPending(state, NOW + 400 * DAY), false, "and it never starts a countdown");
});

test("a startup sweep starts the countdown for detached legacy rows and then goes quiet", () => {
  const detached = row({ itemId: "m9", remoteLibraryId: "remote-gone" });
  const state = mount({ [ADA]: { [detached.key as string]: detached } }, { remoteLibraries: [] });
  assert.equal(historySweepPending(state, NOW), true);
  assert.equal(sweepRemoteHistory(state, NOW), true);
  assert.equal((rowsOf(state, ADA)[detached.key as string] as { orphanedAt?: string }).orphanedAt, new Date(NOW).toISOString());
  assert.equal(sweepRemoteHistory(state, NOW + DAY), false, "the next minute has nothing to do");
  assert.equal(historySweepPending(state, NOW + DAY), false);
  assert.equal(sweepRemoteHistory(state, NOW + REMOTE_HISTORY_RETENTION_MS), true, "and the detached row runs out thirty days after it was first seen");
  assert.deepEqual(rowsOf(state, ADA), {});
});
