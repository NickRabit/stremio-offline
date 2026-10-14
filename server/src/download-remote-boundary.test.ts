import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DownloadQueue, isRemoteDownloadSource, ownerMayDownload, type DownloadSelection } from "./downloads.js";
import { AppError } from "./errors.js";
import type { LibraryRecord } from "./libraries.js";
import { isRemoteDownloadReference, type RemoteDownloadReference } from "./media-server-download.js";
import { sealRemoteContent } from "./media-server-reference.js";
import type { MediaConnectionRecord, RemoteLibraryRecord } from "./media-server-types.js";
import { defaultDownloadSettings } from "./naming.js";
import type { StreamItem } from "./types.js";
import type { UserRecord } from "./users.js";

process.env.ALLOW_PRIVATE_ADDONS = "1";

const LIBRARY_ID = "lib_d10ad10a";
const library = (root: string): LibraryRecord => ({
  id: LIBRARY_ID, name: "Downloads", type: "mixed", root, enabled: true, order: 0,
  addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: false, visibleTo: ["usr_00000001"],
});

const admin: Pick<UserRecord, "id" | "role" | "disabled" | "permissions"> = {
  id: "usr_00000001", role: "admin", permissions: { downloadToLibrary: true, downloadToDevice: true },
};

const selection = (libraryId: string): DownloadSelection => ({
  addonKeys: ["addon"], sourceStrategy: "priority", audioLanguage: "en", subtitleMode: "off",
  targetSettings: { subfolder: "", layout: "structured", libraryId, explicit: true },
});

const remoteUrls = ["media-server:forged", "media-server:", "media-server:AAAA.BBBB"];

test("every media-server attempt is recognised, valid or forged", () => {
  for (const url of remoteUrls) assert.equal(isRemoteDownloadSource({ url }), true, url);
  assert.equal(isRemoteDownloadSource({ url: "https://example.test/a.mp4" }), false);
  assert.equal(isRemoteDownloadSource(undefined), false);
});

test("ownerMayDownload refuses a remote source even for an administrator", () => {
  const root = "/tmp/remote-boundary";
  const scope = { owner: admin, addons: [], libraries: [library(root)] };
  assert.equal(ownerMayDownload(scope, { stream: { url: "https://example.test/a.mp4" } as StreamItem }), true);
  for (const url of remoteUrls) {
    assert.equal(ownerMayDownload(scope, { stream: { url } as StreamItem }), false, url);
  }
  assert.equal(ownerMayDownload(scope, { subtitle: { url: "media-server:forged" } }), false, "a forged remote subtitle is refused");
  assert.equal(ownerMayDownload(scope, { libraryId: `rlib_${"a".repeat(32)}` }), false, "a remote library id is never a target");
});

test("the queue refuses a remote stream before any admission or queue effect", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stremio-remote-boundary-"));
  const downloads = path.join(dir, "downloads");
  const target = library(downloads);
  const queue = new DownloadQueue(() => 1, () => 1, path.join(dir, "data"), downloads, {
    libraries: () => [target], defaultLibrary: () => target, retryDelay: () => 30,
  });
  try {
    await queue.load();
    for (const url of remoteUrls) {
      await assert.rejects(queue.add("Remote", { url } as StreamItem, undefined, defaultDownloadSettings().movie), (error: unknown) =>
        error instanceof AppError && error.messageKey === "library.readOnly" && error.status === 403, url);
    }
    assert.deepEqual(queue.snapshot().jobs, [], "nothing reached the queue");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a lazy job cannot smuggle a remote library id as its target", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stremio-remote-boundary-"));
  const downloads = path.join(dir, "downloads");
  const target = library(downloads);
  const queue = new DownloadQueue(() => 1, () => 1, path.join(dir, "data"), downloads, {
    libraries: () => [target], defaultLibrary: () => target, retryDelay: () => 30,
  });
  try {
    await queue.load();
    await assert.rejects(
      queue.addPending("Show", { type: "series", videoId: "tt1", selection: selection(`rlib_${"a".repeat(32)}`) }),
      (error: unknown) => error instanceof AppError && error.messageKey === "library.readOnly" && error.status === 403,
    );
    assert.deepEqual(queue.snapshot().jobs, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const CONNECTION = `mconn_${"a".repeat(32)}`;
const REMOTE_LIBRARY = `rlib_${"b".repeat(32)}`;

const connection = (over: Partial<MediaConnectionRecord> = {}): MediaConnectionRecord => ({
  id: CONNECTION, provider: "jellyfin", name: "Home", baseUrl: "http://media.example",
  allowLan: false, allowLoopback: false, serverId: "server-1", accountId: "account-1",
  enabled: true, generation: 1, secretRef: `msecret_${"f".repeat(32)}`, addedAt: "2026-01-01T00:00:00.000Z", ...over,
});

const remoteLibrary = (over: Partial<RemoteLibraryRecord> = {}): RemoteLibraryRecord => ({
  id: REMOTE_LIBRARY, connectionId: CONNECTION, remoteId: "remote-1", name: "Movies", type: "movie",
  enabled: true, order: 0, allowedUsers: ["usr_00000001"], showOnHome: true, showInContinueWatching: true, ...over,
});

const remoteReference = (over: Partial<RemoteDownloadReference> = {}): RemoteDownloadReference => ({
  schemaVersion: 1, ownerUserId: copyOwner.id, connectionId: CONNECTION, libraryId: REMOTE_LIBRARY,
  generation: 1, provider: "jellyfin", serverId: "server-1", accountId: "account-1",
  itemId: "item-1", mediaSourceId: "v1", ...over,
});

/** An ordinary account that may queue: the remote grant and the local library are its own. */
const copyOwner: Pick<UserRecord, "id" | "role" | "disabled" | "permissions"> = {
  id: "usr_00000001", role: "user", permissions: { downloadToLibrary: true, downloadToDevice: true },
};

const remoteScope = (over: { library?: RemoteLibraryRecord; connection?: MediaConnectionRecord } = {}) => ({
  owner: copyOwner,
  addons: [],
  libraries: [library("/tmp/remote-boundary")],
  remoteAccess: {
    users: () => [{ id: copyOwner.id, role: "user", permissions: copyOwner.permissions } as unknown as UserRecord],
    mediaConnections: () => [over.connection ?? connection()],
    remoteLibraries: () => [over.library ?? remoteLibrary()],
  },
});

const markerStream = (): StreamItem => ({ url: "remote-download:original", name: "Movie.mkv" } as StreamItem);

test("the owner-bound check allows a granted remote copy and refuses a forged one", () => {
  const scope = remoteScope();
  assert.equal(ownerMayDownload(scope, { libraryId: LIBRARY_ID, stream: markerStream(), remoteDownload: remoteReference() }), true,
    "a granted original may be copied into a local library");
  assert.equal(ownerMayDownload({ ...scope, libraries: [] }, { libraryId: LIBRARY_ID, stream: markerStream(), remoteDownload: remoteReference() }), false,
    "a deleted destination cannot keep a running remote copy writable");
  assert.equal(ownerMayDownload({ ...scope, libraries: [{ ...scope.libraries[0]!, visibleTo: [] }] }, { libraryId: LIBRARY_ID, stream: markerStream(), remoteDownload: remoteReference() }), false,
    "a withdrawn local grant refuses the copy despite an active remote grant");
  assert.equal(ownerMayDownload(scope, { stream: markerStream(), remoteDownload: remoteReference() }), false,
    "a remote copy without a concrete local destination is refused");
  assert.equal(ownerMayDownload(scope, { libraryId: LIBRARY_ID, stream: markerStream(), remoteDownload: remoteReference({ ownerUserId: "usr_00000009" }) }), false,
    "a reference for another account is refused");
  assert.equal(ownerMayDownload(scope, { libraryId: LIBRARY_ID, stream: markerStream(), remoteDownload: { ...remoteReference(), schemaVersion: 2 } as unknown as RemoteDownloadReference }), false,
    "a malformed reference is refused");
  assert.equal(ownerMayDownload(scope, { libraryId: LIBRARY_ID, stream: markerStream(), remoteDownload: { ...remoteReference(), sid: "sid-a" } as unknown as RemoteDownloadReference }), false,
    "a reference carrying extra session fields is refused");
  assert.equal(ownerMayDownload(remoteScope({ connection: connection({ generation: 2 }) }), { libraryId: LIBRARY_ID, stream: markerStream(), remoteDownload: remoteReference() }), false,
    "a changed generation is refused");
  assert.equal(ownerMayDownload(remoteScope({ library: remoteLibrary({ allowedUsers: [] }) }), { libraryId: LIBRARY_ID, stream: markerStream(), remoteDownload: remoteReference() }), false,
    "a withdrawn grant is refused");
  assert.equal(ownerMayDownload({ owner: copyOwner, addons: [], libraries: [library("/tmp/remote-boundary")] }, { libraryId: LIBRARY_ID, stream: markerStream(), remoteDownload: remoteReference() }), false,
    "without remote access records every remote job is refused");
});

test("a sealed address that does not match its reference is refused at admission", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stremio-remote-pair-"));
  const downloads = path.join(dir, "downloads");
  const target = library(downloads);
  const queue = new DownloadQueue(() => 1, () => 1, path.join(dir, "data"), downloads, {
    libraries: () => [target], defaultLibrary: () => target,
    remoteDownload: { current: () => true, open: async () => new Response(null), revalidate: async () => undefined },
  });
  try {
    await queue.load();
    const ref = remoteReference();
    const otherSeal = sealRemoteContent({
      provider: "jellyfin", serverId: "server-1", accountId: "account-1", itemId: "item-OTHER",
      connectionId: CONNECTION, libraryId: REMOTE_LIBRARY, generation: 1, mediaSourceId: "v1",
      owner: { userId: admin.id, sid: "sid-a", expiresAt: Number.MAX_SAFE_INTEGER, secretStamp: "d".repeat(64) },
    });
    await assert.rejects(
      queue.add("Movie", { url: otherSeal } as StreamItem, undefined, defaultDownloadSettings().movie, admin.id, ref),
      (error: unknown) => error instanceof AppError && error.messageKey === "library.readOnly",
      "a seal that names another item cannot carry this reference",
    );
    assert.deepEqual(queue.snapshot().jobs, []);
    assert.equal(isRemoteDownloadReference(ref), true);
  } finally {
    await queue.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
