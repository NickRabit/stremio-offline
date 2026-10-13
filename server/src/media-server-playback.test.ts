import assert from "node:assert/strict";
import test from "node:test";
import { MediaResources, type ResourceOwner } from "./media-resources.js";
import { MediaServerPlaybackGuard, readMediaServerPlaybackConfig } from "./media-server-playback.js";
import { sealRemoteContent } from "./media-server-reference.js";
import type { MediaServerSources } from "./media-server-sources.js";
import type { ActiveTransfer } from "./revocation.js";

const owner: ResourceOwner = { userId: "usr_00000001", sid: "sid-1", expiresAt: Date.now() + 3_600_000 };

const sealedFor = (sourceId: string): string => sealRemoteContent({
  provider: "jellyfin", serverId: "server-1", accountId: "account-1", itemId: "item-1",
  connectionId: `mconn_${"a".repeat(32)}`, libraryId: `rlib_${"b".repeat(32)}`,
  generation: 2, mediaSourceId: sourceId,
  owner: { userId: owner.userId, sid: owner.sid, expiresAt: owner.expiresAt, secretStamp: "c".repeat(64) },
});

interface Rig {
  guard: MediaServerPlaybackGuard;
  resources: MediaResources;
  playbackOwners: Map<string, { owner: ResourceOwner; resourceId: string }>;
  activeMedia: Set<ActiveTransfer>;
  revoked: string[];
  calls: string[];
  peak: () => number;
  lastSignal: () => AbortSignal | undefined;
  setAuthorize(fn: (stream: unknown, who: ResourceOwner, signal?: AbortSignal) => Promise<void>): void;
}

const rig = (config = { intervalMs: 30_000, timeoutMs: 5_000 }, clock?: () => number): Rig => {
  const resources = new MediaResources();
  const playbackOwners = new Map<string, { owner: ResourceOwner; resourceId: string }>();
  const activeMedia = new Set<ActiveTransfer>();
  const revoked: string[] = [];
  const calls: string[] = [];
  let live = 0;
  let peak = 0;
  let signal: AbortSignal | undefined;
  let impl: (stream: unknown, who: ResourceOwner, signal?: AbortSignal) => Promise<void> = async () => undefined;
  const rigged = {
    authorize: async (stream: unknown, who: ResourceOwner, given?: AbortSignal) => {
      calls.push((stream as { url?: string }).url ?? "");
      signal = given;
      live += 1;
      peak = Math.max(peak, live);
      try { return await impl(stream, who, given); } finally { live -= 1; }
    },
  } as unknown as MediaServerSources;
  const guard = new MediaServerPlaybackGuard({
    sources: rigged, resources, playbackOwners, activeMedia,
    revocations: { stopResource: async (id: string) => { revoked.push(id); resources.remove(id); } },
    ...(clock ? { clock } : {}),
  }, config);
  return { guard, resources, playbackOwners, activeMedia, revoked, calls, peak: () => peak, lastSignal: () => signal, setAuthorize: (fn) => { impl = fn; } };
};

const addRemote = (r: Rig, index: number): string => {
  const resource = r.resources.mediaStream({ url: sealedFor(`v${index}`) }, owner);
  r.playbackOwners.set(`remote-${index}`, { owner, resourceId: resource.resourceId });
  return resource.resourceId;
};

const addLocal = (r: Rig, index: number): string => {
  const resource = r.resources.mediaStream({ url: `https://example.test/${index}.mp4` }, owner);
  r.playbackOwners.set(`local-${index}`, { owner, resourceId: resource.resourceId });
  return resource.resourceId;
};

test("the config reader bounds the cadence and fails startup on an invalid value", () => {
  assert.deepEqual(readMediaServerPlaybackConfig({} as NodeJS.ProcessEnv), { intervalMs: 30_000, timeoutMs: 5_000 });
  assert.deepEqual(readMediaServerPlaybackConfig({ MEDIA_SERVER_REVALIDATE_MS: "1000", MEDIA_SERVER_REVALIDATE_TIMEOUT_MS: "500" } as NodeJS.ProcessEnv), { intervalMs: 1_000, timeoutMs: 500 });
  for (const bad of ["0", "-1", "1.5", "30001", "abc", " 5"]) {
    assert.throws(() => readMediaServerPlaybackConfig({ MEDIA_SERVER_REVALIDATE_MS: bad } as NodeJS.ProcessEnv), /MEDIA_SERVER_REVALIDATE_MS/, bad);
  }
  assert.throws(() => readMediaServerPlaybackConfig({ MEDIA_SERVER_REVALIDATE_TIMEOUT_MS: "5001" } as NodeJS.ProcessEnv), /MEDIA_SERVER_REVALIDATE_TIMEOUT_MS/);
});

test("a denied remote resource is stopped and an unrelated one is left alone", async () => {
  const r = rig();
  const remote = addRemote(r, 0);
  const local = addLocal(r, 1);
  r.setAuthorize(async (stream) => { if ((stream as { url?: string }).url === sealedFor("v0")) throw new Error("denied"); });
  await r.guard.cycle();
  assert.deepEqual(r.revoked, [remote]);
  assert.equal(r.resources.get(local, owner.sid, "media").stream.url, "https://example.test/1.mp4", "the local resource stays");
});

test("only remote resources are checked: 130 ordinary rows never consume a slot", async () => {
  const r = rig();
  const locals: string[] = [];
  for (let index = 0; index < 130; index += 1) locals.push(addLocal(r, index));
  const remote = addRemote(r, 999);
  await r.guard.cycle();
  assert.equal(r.calls.length, 1, "only the remote row was authorized");
  assert.deepEqual(r.revoked, [], "no ordinary resource is touched");
  assert.ok(locals.every((id) => r.resources.get(id, owner.sid, "media")), "all ordinary rows survive");
  assert.ok(r.resources.get(remote, owner.sid, "media"));
});

test("more than the tracked bound of remote resources fails closed for them all", async () => {
  const r = rig();
  const ids: string[] = [];
  for (let index = 0; index < 129; index += 1) ids.push(addRemote(r, index));
  await r.guard.cycle();
  assert.equal(r.revoked.length, 129);
  assert.deepEqual([...r.revoked].sort(), [...ids].sort());
  assert.equal(r.calls.length, 0, "no remote resource was authorized when overloaded");
});

test("a resource seen as remote and then removed is denied", async () => {
  const r = rig();
  const remote = addRemote(r, 0);
  await r.guard.cycle();
  assert.deepEqual(r.revoked, []);
  r.resources.remove(remote);
  await r.guard.cycle();
  assert.deepEqual(r.revoked, [remote]);
});

test("close aborts in-flight checks at once and does not deny on the way out", async () => {
  const r = rig({ intervalMs: 30_000, timeoutMs: 5_000 });
  addRemote(r, 0);
  r.setAuthorize(() => new Promise<void>(() => undefined));
  const cycle = r.guard.cycle();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await r.guard.close();
  await cycle;
  assert.equal(r.lastSignal()?.aborted, true, "the in-flight signal was aborted");
  assert.deepEqual(r.revoked, [], "shutting down is not a denial");
});

test("four checks run in parallel and the deadline is measured from the cycle start", async () => {
  const r = rig({ intervalMs: 30_000, timeoutMs: 60 });
  for (let index = 0; index < 8; index += 1) addRemote(r, index);
  r.setAuthorize(() => new Promise((resolve) => setTimeout(resolve, 40)));
  const started = Date.now();
  await r.guard.cycle();
  assert.equal(r.peak(), 4, "at most four checks run at once");
  assert.ok(Date.now() - started < 250, "queued checks do not extend past the shared deadline");
  assert.ok(r.revoked.length >= 4, "the wave that starts near the deadline is denied");
});

test("a check that ignores the abort signal is still stopped at the deadline", async () => {
  const r = rig({ intervalMs: 30_000, timeoutMs: 20 });
  const remote = addRemote(r, 0);
  r.setAuthorize(() => new Promise<void>(() => undefined));
  await r.guard.cycle();
  assert.deepEqual(r.revoked, [remote]);
});

test("close is idempotent and stops scheduling", async () => {
  const r = rig();
  r.guard.start();
  await r.guard.close();
  await r.guard.close();
  addRemote(r, 0);
  await r.guard.cycle();
  assert.deepEqual(r.revoked, [], "a closed guard does not check");
});
