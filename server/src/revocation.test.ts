import assert from "node:assert/strict";
import { test } from "node:test";
import { addonIdentity } from "./addon-identity.js";
import { AirPlayAccess } from "./airplay-access.js";
import { createSession } from "./auth.js";
import type { DownloadJob, DownloadSelection } from "./downloads.js";
import { MediaResources, type ResourceOwner } from "./media-resources.js";
import { remoteSecretStamp, sealRemoteContent } from "./media-server-reference.js";
import type { RemoteDownloadReference } from "./media-server-download.js";
import type { MediaConnectionRecord, RemoteLibraryRecord } from "./media-server-types.js";
import { accessLost, contentOf, Revocations, type AccessSource, type ActiveTransfer, type RevocationDeps } from "./revocation.js";
import type { DeviceDownloadTicket } from "./media-resources.js";
import type { AddonRecord } from "./types.js";
import type { UserRecord } from "./users.js";
import { SOURCE_PROFILE_IDS } from "./source-profiles.js";

const owner = (userId: string, sid = `${userId}-phone`): ResourceOwner =>
  ({ userId, sid, expiresAt: Number.MAX_SAFE_INTEGER });

const job = (id: string, ownerUserId: string, extra: Partial<DownloadJob> = {}): DownloadJob => ({
  id, title: id, status: "queued", target: `/lib/${id}.mkv`, received: 0, speed: 0,
  ownerUserId, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  ...extra,
} as DownloadJob);

const selectionFor = (addonKeys: string[], subtitleMode: DownloadSelection["subtitleMode"] = "off"): DownloadSelection => ({
  addonKeys,
  sourceStrategy: "priority",
  audioLanguage: "en",
  subtitleMode,
  targetSettings: { subfolder: "", layout: "structured" },
});

function harness(jobs: DownloadJob[] = []) {
  const resources = new MediaResources();
  const paused: string[] = [];
  const removed: string[] = [];
  const destroyed: string[] = [];
  const stopped: string[] = [];
  const followsRemoved: string[] = [];
  const activeMedia = new Set<ActiveTransfer>();
  const deviceTickets = new Map<string, DeviceDownloadTicket>();
  const playbackOwners = new Map<string, { owner: ResourceOwner; resourceId: string }>();
  const deps: RevocationDeps = {
    source: { users: () => [], addons: () => [], libraries: () => [], mediaConnections: () => [], remoteLibraries: () => [] },
    resources,
    airplay: new AirPlayAccess(resources),
    playbackOwners,
    activeMedia,
    deviceTickets,
    stopPlayback: async (id) => { stopped.push(id); return undefined; },
    follows: { removeOwner: async (userId) => { followsRemoved.push(userId); return 0; } },
    queue: {
      ownerOf: (candidate) => candidate.ownerUserId,
      pauseMatching: async (match) => {
        const hit = jobs.filter(match);
        for (const one of hit) paused.push(one.id);
        return hit.length;
      },
      removeMatching: async (match) => {
        const hit = jobs.filter(match);
        for (const one of hit) removed.push(one.id);
        return hit.length;
      },
    },
  };
  const track = (transfer: ActiveTransfer) => { activeMedia.add(transfer); return transfer; };
  const airplay = deps.airplay;
  return { deps, revocations: new Revocations(deps), resources, airplay, paused, removed, destroyed, stopped, followsRemoved, activeMedia, deviceTickets, playbackOwners, track };
}

const transfer = (who: ResourceOwner, extra: Partial<ActiveTransfer> = {}): ActiveTransfer => {
  let killed = false;
  return { owner: who, res: { destroy: () => { killed = true; } }, get destroyed() { return killed; }, ...extra } as ActiveTransfer & { destroyed: boolean };
};

test("signing out everywhere reaches what the account holds open and leaves its downloads alone", async () => {
  const jobs = [job("one", "usr_a"), job("two", "usr_b")];
  const h = harness(jobs);
  const mine = h.track(transfer(owner("usr_a")));
  h.playbackOwners.set("play-a", { owner: owner("usr_a"), resourceId: "res-a" });
  h.deviceTickets.set("ticket-a", { owner: owner("usr_a") } as DeviceDownloadTicket);

  await h.revocations.stopUserSessions("usr_a");

  assert.equal((mine as unknown as { destroyed: boolean }).destroyed, true, "the open transfer is cut");
  assert.deepEqual(h.stopped, ["play-a"], "the playback session is stopped");
  assert.equal(h.deviceTickets.size, 0, "the device ticket is dropped");
  assert.deepEqual(h.paused, [], "no download is paused: a queue is not a session");
  assert.deepEqual(h.removed, [], "and none is cancelled");
});

test("disabling an account pauses its downloads as well, because the right is gone", async () => {
  const jobs = [job("one", "usr_a"), job("two", "usr_b")];
  const h = harness(jobs);

  await h.revocations.stopUser("usr_a");

  assert.deepEqual(h.paused, ["one"], "only that account's job pauses");
  assert.deepEqual(h.removed, [], "pausing keeps the queue position; nothing is thrown away");
});

test("deleting an account cancels its unfinished work rather than pausing it", async () => {
  const jobs = [job("one", "usr_a"), job("two", "usr_b")];
  const h = harness(jobs);

  await h.revocations.deleteUser("usr_a");

  assert.deepEqual(h.removed, ["one"]);
  assert.deepEqual(h.paused, [], "a deleted account has nothing to come back to");
});

test("deleting an account also drops the series it followed", async () => {
  const jobs = [job("one", "usr_a"), job("two", "usr_b")];
  const h = harness(jobs);

  await h.revocations.deleteUser("usr_a");

  assert.deepEqual(h.followsRemoved, ["usr_a"], "only the deleted account's follows go with it");
});

test("losing the library permission pauses downloads and leaves playback running", async () => {
  const jobs = [job("one", "usr_a")];
  const h = harness(jobs);
  const watching = h.track(transfer(owner("usr_a")));
  h.playbackOwners.set("play-a", { owner: owner("usr_a"), resourceId: "res-a" });

  const before = { id: "usr_a", role: "user", permissions: { downloadToLibrary: true, downloadToDevice: true } };
  const after = { ...before, permissions: { downloadToLibrary: false, downloadToDevice: true } };
  await h.revocations.permissionsChanged(before as never, after as never);

  assert.deepEqual(h.paused, ["one"], "the queued download pauses");
  assert.deepEqual(h.stopped, [], "the film keeps playing: watching was never in question");
  assert.equal((watching as unknown as { destroyed: boolean }).destroyed, false);
});

test("losing the device permission drops tickets and leaves the queue and playback alone", async () => {
  const jobs = [job("one", "usr_a")];
  const h = harness(jobs);
  h.deviceTickets.set("ticket-a", { owner: owner("usr_a") } as DeviceDownloadTicket);
  h.playbackOwners.set("play-a", { owner: owner("usr_a"), resourceId: "res-a" });

  const before = { id: "usr_a", role: "user", permissions: { downloadToLibrary: true, downloadToDevice: true } };
  const after = { ...before, permissions: { downloadToLibrary: true, downloadToDevice: false } };
  await h.revocations.permissionsChanged(before as never, after as never);

  assert.equal(h.deviceTickets.size, 0, "the ticket is gone");
  assert.deepEqual(h.paused, [], "the NAS queue is a different right");
  assert.deepEqual(h.stopped, [], "and so is playback");
});

test("a sweep for one account does not touch another", async () => {
  const jobs = [job("one", "usr_a"), job("two", "usr_b")];
  const h = harness(jobs);
  const theirs = h.track(transfer(owner("usr_b")));
  h.playbackOwners.set("play-b", { owner: owner("usr_b"), resourceId: "res-b" });

  await h.revocations.stopUser("usr_a");

  assert.equal((theirs as unknown as { destroyed: boolean }).destroyed, false);
  assert.deepEqual(h.stopped, []);
  assert.deepEqual(h.paused, ["one"]);
});

test("a library revocation reaches a lazy job that names the library only in its target settings", async () => {
  const selection: DownloadSelection = {
    addonKeys: ["stream-addon"], sourceStrategy: "priority", audioLanguage: "en", subtitleMode: "off",
    targetSettings: { subfolder: "", layout: "structured", libraryId: "lib_x", explicit: true },
  };
  // No target and no libraryId yet: the chosen library lives only in the selection the job will
  // resolve against, which is where a library revocation has to look for it.
  const lazy = job("lazy", "usr_a", { target: "", source: { type: "series", videoId: "tt1", tried: [], selection } });
  const h = harness([lazy, job("other", "usr_a")]);

  await h.revocations.stopContent({ libraryId: "lib_x" });

  assert.deepEqual(h.paused, ["lazy"], "only the job bound to the revoked library pauses");
});

test("an addon revocation reaches an unresolved job that selected it", async () => {
  const lazy = job("lazy", "usr_a", { target: "", source: { type: "movie", videoId: "tt1", tried: [], selection: selectionFor(["source-a"]) } });
  const h = harness([lazy, job("other", "usr_a")]);

  await h.revocations.stopContent({ userId: "usr_a", addonKey: "source-a" });

  assert.deepEqual(h.paused, ["lazy"]);
});

test("an addon revocation aborts an active legacy lookup without pausing a queued one", async () => {
  const checking = job("checking", "usr_a", {
    status: "checking", target: "", source: { type: "movie", videoId: "tt1", tried: [] },
  });
  const queued = job("queued", "usr_a", {
    target: "", source: { type: "movie", videoId: "tt2", tried: [] },
  });
  const h = harness([checking, queued]);

  await h.revocations.stopContent({ userId: "usr_a", addonKey: "source-a" });

  assert.deepEqual(h.paused, ["checking"]);
});

test("an addon identity sweep pauses only the selected Travel jobs whose identity changed", async () => {
  const account = {
    id: "usr_a",
    username: "a",
    passwordHash: "scrypt$aa$bb",
    secret: "secret",
    role: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    permissions: { downloadToLibrary: true, downloadToDevice: true },
    permissionsVersion: 0,
  } satisfies UserRecord;
  const sourceAddon: AddonRecord = {
    key: "source-a",
    manifestUrl: "https://source.example/manifest.json",
    role: "source",
    enabled: true,
    globalSearch: true,
    allowedUsers: [account.id],
    addedAt: "2026-01-01T00:00:00.000Z",
    downloadSettings: { movie: { subfolder: "", layout: "flat" }, series: { subfolder: "", layout: "flat" } },
    manifest: { id: "source-a", name: "Source", version: "1", resources: ["stream"] },
  };
  const addonState = [sourceAddon];
  const travelAdmission = {
    profile: { id: SOURCE_PROFILE_IDS.travel, revision: 1 },
  } as DownloadJob["sourceAdmission"];
  const selected = { url: "https://media.example/film.mp4", addonKey: sourceAddon.key };
  const legacy = job("legacy", account.id, { stream: selected });
  const fresh = job("fresh", account.id, {
    stream: selected,
    sourceAdmission: travelAdmission,
    sourceStreamAddonIdentity: addonIdentity(sourceAddon),
  });
  const stale = job("stale", account.id, {
    stream: selected,
    sourceAdmission: travelAdmission,
    sourceStreamAddonIdentity: "b".repeat(64),
  });
  const h = harness([legacy, fresh, stale]);
  h.deps.source = { ...h.deps.source, users: () => [account], addons: () => addonState };

  await h.revocations.stopContent({ addonKey: sourceAddon.key });
  assert.deepEqual(h.paused, ["stale"]);

  h.paused.length = 0;
  addonState[0] = { ...sourceAddon, enabled: false };
  await h.revocations.stopContent({ addonKey: sourceAddon.key });
  assert.deepEqual(h.paused, ["legacy", "fresh", "stale"], "existing addon removal sweeps still reach every job");
});

test("an external subtitle revocation aborts active lazy lookup without pausing a queued unrelated job", async () => {
  const subtitle = {
    key: "subtitle-a",
    enabled: false,
    manifest: { resources: [{ name: "subtitles", types: ["movie"] }] },
  } as AddonRecord;
  const checking = job("checking", "usr_a", {
    status: "checking",
    target: "",
    source: { type: "movie", videoId: "tt1", tried: [], selection: selectionFor(["source-b"], "required") },
  });
  const queued = job("queued", "usr_a", {
    target: "",
    source: { type: "movie", videoId: "tt2", tried: [], selection: selectionFor(["source-b"], "required") },
  });
  const h = harness([checking, queued]);
  h.deps.source = { ...h.deps.source, addons: () => [subtitle] };

  await h.revocations.stopContent({ userId: "usr_a", addonKey: "subtitle-a" });

  assert.deepEqual(h.paused, ["checking"]);
});

test("a queue that cannot save the removal does not stop an account from being deleted", async () => {
  const h = harness([job("one", "usr_a")]);
  h.deps.queue.removeMatching = async () => { throw new Error("The download queue could not be saved."); };

  await h.revocations.deleteUser("usr_a");

  assert.deepEqual(h.followsRemoved, ["usr_a"], "the rest of the account still goes");
});

const CONNECTION_A = `mconn_${"a".repeat(32)}`;
const CONNECTION_B = `mconn_${"d".repeat(32)}`;
const REMOTE_LIBRARY = `rlib_${"b".repeat(32)}`;

const remoteSecret = "remote-secret-a";
const remoteSid = "sid-a";

const remoteConnection = (over: Partial<MediaConnectionRecord> = {}): MediaConnectionRecord => ({
  id: CONNECTION_A, provider: "jellyfin", name: "Home", baseUrl: "http://media.example",
  allowLan: false, allowLoopback: false, serverId: "server-1", accountId: "account-1",
  enabled: true, generation: 2, secretRef: `msecret_${"f".repeat(32)}`, addedAt: "2026-01-01T00:00:00.000Z", ...over,
});

const remoteLibrary = (over: Partial<RemoteLibraryRecord> = {}): RemoteLibraryRecord => ({
  id: REMOTE_LIBRARY, connectionId: CONNECTION_A, remoteId: "remote-1", name: "Movies",
  type: "movie", enabled: true, order: 0, allowedUsers: ["usr_a"], showOnHome: true, showInContinueWatching: true, ...over,
});

const remoteUser = (over: Partial<UserRecord> = {}): UserRecord => ({
  id: "usr_a", username: "a", passwordHash: "scrypt$aa$bb", secret: remoteSecret, role: "user",
  createdAt: "2026-01-01T00:00:00.000Z", permissions: { downloadToLibrary: true, downloadToDevice: true },
  permissionsVersion: 0, ...over,
});

const remoteSource = (over: { user?: UserRecord; connection?: MediaConnectionRecord; library?: RemoteLibraryRecord } = {}): AccessSource => ({
  users: () => [over.user ?? remoteUser()],
  addons: () => [],
  libraries: () => [],
  mediaConnections: () => [over.connection ?? remoteConnection()],
  remoteLibraries: () => [over.library ?? remoteLibrary()],
});

const sealedRemote = (who: ResourceOwner, over: { connectionId?: string; secretStamp?: string; expiresAt?: number } = {}) => sealRemoteContent({
  provider: "jellyfin", serverId: "server-1", accountId: "account-1", itemId: "item-1",
  connectionId: over.connectionId ?? CONNECTION_A, libraryId: REMOTE_LIBRARY, generation: 2, mediaSourceId: "v1",
  owner: { userId: who.userId, sid: who.sid, expiresAt: over.expiresAt ?? who.expiresAt, secretStamp: over.secretStamp ?? "c".repeat(64) },
});

test("contentOf resolves a sealed remote stream and refuses a malformed attempt", () => {
  const who = owner("usr_a", remoteSid);
  const content = contentOf({ addonKey: "addon", url: sealedRemote(who) });
  assert.equal(content.libraryId, REMOTE_LIBRARY);
  assert.equal(content.addonKey, "addon");
  assert.ok(content.remote);
  assert.throws(() => contentOf({ url: "media-server:garbage" }), { status: 404 });
});

test("accessLost permits a genuine remote download to a library and re-checks the remote record", () => {
  const secret = remoteSecret;
  const token = createSession(secret, "usr_a", Date.now() + 3_600_000, remoteSid);
  const claim = { userId: "usr_a", sid: remoteSid, token, permissionsVersion: 0 };
  const ref = {
    provider: "jellyfin" as const, serverId: "server-1", accountId: "account-1", itemId: "item-1",
    connectionId: CONNECTION_A, libraryId: REMOTE_LIBRARY, generation: 2, mediaSourceId: "v1",
    owner: { userId: "usr_a", sid: remoteSid, expiresAt: Number.MAX_SAFE_INTEGER, secretStamp: remoteSecretStamp(secret) },
  };
  assert.equal(accessLost(remoteSource(), claim, { remote: ref }), false);
  assert.equal(accessLost(remoteSource(), claim, { remote: ref, libraryId: REMOTE_LIBRARY }), false);
  assert.equal(accessLost(remoteSource(), claim, { remote: ref, permission: "downloadToLibrary" }), false, "a granted remote original may still be copied into a local library");
  assert.equal(accessLost(remoteSource({ user: remoteUser({ secret: "rotated" }) }), claim, { remote: ref }), true, "a password change is caught");
  assert.equal(accessLost(remoteSource({ connection: remoteConnection({ generation: 3 }) }), claim, { remote: ref }), true, "a generation change is caught");
  assert.equal(accessLost(remoteSource({ library: remoteLibrary({ enabled: false }) }), claim, { remote: ref }), true, "a disabled library is caught");
  assert.equal(accessLost(remoteSource(), claim, { remote: { ...ref, owner: { ...ref.owner, sid: "other" } } }), true, "the claim session must own the reference");
});

test("accessLost permits saving a remote original to a device and re-checks the remote record", () => {
  const secret = remoteSecret;
  const token = createSession(secret, "usr_a", Date.now() + 3_600_000, remoteSid);
  const claim = { userId: "usr_a", sid: remoteSid, token, permissionsVersion: 0 };
  const ref = {
    provider: "jellyfin" as const, serverId: "server-1", accountId: "account-1", itemId: "item-1",
    connectionId: CONNECTION_A, libraryId: REMOTE_LIBRARY, generation: 2, mediaSourceId: "v1",
    owner: { userId: "usr_a", sid: remoteSid, expiresAt: Number.MAX_SAFE_INTEGER, secretStamp: remoteSecretStamp(secret) },
  };
  // The device is the same kind of copy as a local library: the account's own right decides, and
  // the session's grant to the original has to hold exactly as it does for the copy or a playback.
  assert.equal(accessLost(remoteSource(), claim, { remote: ref, permission: "downloadToDevice" }), false);
  assert.equal(accessLost(remoteSource({ library: remoteLibrary({ enabled: false }) }), claim, { remote: ref, permission: "downloadToDevice" }), true, "a disabled library is caught");
  assert.equal(accessLost(remoteSource(), claim, { remote: { ...ref, owner: { ...ref.owner, sid: "other" } }, permission: "downloadToDevice" }), true, "the claim session must own the reference");
});

test("a connection sweep stops remote resources, playback and AirPlay without the records", async () => {
  const h = harness([]);
  const who = owner("usr_a", remoteSid);
  const mine = h.resources.add({ url: sealedRemote(who) }, who, "source");
  const other = h.resources.add({ url: sealedRemote(who, { connectionId: CONNECTION_B }) }, who, "source");
  const active = h.track(transfer(who, { resourceId: mine }));
  h.playbackOwners.set("play-remote", { owner: who, resourceId: mine });
  h.playbackOwners.set("play-other", { owner: who, resourceId: other });
  h.airplay.create("play-remote", who, mine);

  await h.revocations.stopContent({ connectionId: CONNECTION_A });

  assert.equal((active as unknown as { destroyed: boolean }).destroyed, true, "the active response is destroyed");
  assert.deepEqual(h.stopped, ["play-remote"], "only the swept connection's playback stops");
  assert.equal(h.airplay.url("play-remote", "http://x/"), "http://x/", "the AirPlay grant is gone");
  assert.throws(() => h.resources.get(mine, who.sid, "source"), { status: 404 });
  assert.equal(h.resources.get(other, who.sid, "source").stream.url !== undefined, true, "the other connection survives");
});

test("stopUnreachable revokes a remote resource whose grant was withdrawn", async () => {
  const h = harness([]);
  const who = owner("usr_a", remoteSid);
  const stream = { url: sealedRemote(who, { secretStamp: remoteSecretStamp(remoteSecret) }) };
  const resourceId = h.resources.add(stream, who, "source");
  const user = remoteUser();
  h.deps.source = remoteSource({ user, library: remoteLibrary({ allowedUsers: [] }) });

  await h.revocations.stopUnreachable(user);

  assert.throws(() => h.resources.get(resourceId, who.sid, "source"), { status: 404 });
});

test("stopResource reaches one resource and its readers, and nothing else", async () => {
  const h = harness([]);
  const who = owner("usr_a", remoteSid);
  const stream = { url: sealedRemote(who) };
  const media = h.resources.mediaStream(stream, who);
  const other = h.resources.mediaStream({ url: "https://other.test/film.mp4" }, who);
  const child = h.resources.add({ url: "https://other.test/sub" }, who, "subtitle", media.resourceId);
  const active = h.track(transfer(who, { resourceId: media.resourceId }));
  const untouched = h.track(transfer(who, { resourceId: other.resourceId }));
  h.playbackOwners.set("play-mine", { owner: who, resourceId: media.resourceId });
  h.playbackOwners.set("play-other", { owner: who, resourceId: other.resourceId });
  h.airplay.create("play-mine", who, media.resourceId);
  h.airplay.create("play-other", who, other.resourceId);

  await h.revocations.stopResource(media.resourceId);

  assert.equal((active as unknown as { destroyed: boolean }).destroyed, true);
  assert.equal((untouched as unknown as { destroyed: boolean }).destroyed, false);
  assert.deepEqual(h.stopped, ["play-mine"], "only the named resource's session stops");
  assert.equal(h.airplay.url("play-mine", "http://x/"), "http://x/", "its AirPlay grant is gone");
  assert.match(h.airplay.url("play-other", "http://x/"), /airplay=/, "the unrelated grant stays");
  assert.throws(() => h.resources.get(media.resourceId, who.sid, "media"), { status: 404 });
  assert.throws(() => h.resources.get(child, who.sid, "subtitle"), { status: 404 }, "the child goes with the parent");
  assert.equal(h.resources.get(other.resourceId, who.sid, "media").stream.url, "https://other.test/film.mp4");
  assert.deepEqual(h.paused, [], "the queue is never touched");
});

const remoteDownload = (over: Partial<RemoteDownloadReference> = {}): RemoteDownloadReference => ({
  schemaVersion: 1, ownerUserId: "usr_a", connectionId: CONNECTION_A, libraryId: REMOTE_LIBRARY,
  generation: 2, provider: "jellyfin", serverId: "server-1", accountId: "account-1",
  itemId: "item-1", mediaSourceId: "v1", ...over,
});

test("a connection sweep pauses the queued remote copy that names it", async () => {
  const h = harness([job("remote", "usr_a", { remoteDownload: remoteDownload() }), job("local", "usr_a")]);

  await h.revocations.stopContent({ connectionId: CONNECTION_A });

  assert.deepEqual(h.paused, ["remote"], "only the copy bound to the swept connection pauses");
});

test("stopUnreachable pauses a remote copy whose grant was withdrawn", async () => {
  const h = harness([job("remote", "usr_a", { remoteDownload: remoteDownload() }), job("other", "usr_a")]);
  const user = remoteUser();
  h.deps.source = remoteSource({ user, library: remoteLibrary({ allowedUsers: [] }) });

  await h.revocations.stopUnreachable(user);

  assert.deepEqual(h.paused, ["remote"], "the withdrawn grant pauses only the remote copy");
});
