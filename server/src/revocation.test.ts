import assert from "node:assert/strict";
import { test } from "node:test";
import { AirPlayAccess } from "./airplay-access.js";
import type { DownloadJob } from "./downloads.js";
import { MediaResources, type ResourceOwner } from "./media-resources.js";
import { Revocations, type ActiveTransfer, type RevocationDeps } from "./revocation.js";
import type { DeviceDownloadTicket } from "./media-resources.js";

const owner = (userId: string, sid = `${userId}-phone`): ResourceOwner =>
  ({ userId, sid, expiresAt: Number.MAX_SAFE_INTEGER });

const job = (id: string, ownerUserId: string, extra: Partial<DownloadJob> = {}): DownloadJob => ({
  id, title: id, status: "queued", target: `/lib/${id}.mkv`, received: 0, speed: 0,
  ownerUserId, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  ...extra,
} as DownloadJob);

function harness(jobs: DownloadJob[] = []) {
  const resources = new MediaResources();
  const paused: string[] = [];
  const removed: string[] = [];
  const destroyed: string[] = [];
  const stopped: string[] = [];
  const activeMedia = new Set<ActiveTransfer>();
  const deviceTickets = new Map<string, DeviceDownloadTicket>();
  const playbackOwners = new Map<string, { owner: ResourceOwner; resourceId: string }>();
  const deps: RevocationDeps = {
    resources,
    airplay: new AirPlayAccess(resources),
    playbackOwners,
    activeMedia,
    deviceTickets,
    stopPlayback: async (id) => { stopped.push(id); return undefined; },
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
  return { deps, revocations: new Revocations(deps), paused, removed, destroyed, stopped, activeMedia, deviceTickets, playbackOwners, track };
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
