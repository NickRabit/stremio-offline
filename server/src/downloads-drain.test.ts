import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DownloadQueue, type DownloadJob } from "./downloads.js";
import { downloadLibrary, tempQueue, waitFor, windowAt } from "./downloads-test-support.js";

const drainJob = (
  id: string,
  ownerUserId: string | undefined,
  status: DownloadJob["status"] = "queued",
): DownloadJob => {
  const at = "2026-11-12T00:00:00.000Z";
  return {
    id,
    title: id,
    ownerUserId,
    status,
    target: `${id}.mkv`,
    received: 0,
    speed: 0,
    createdAt: at,
    updatedAt: at,
  };
};

test("the snapshot reports the shared cap in Mbit/s", async () => {
  const none = await tempQueue();
  try {
    assert.equal(none.queue.snapshot().speedLimitMbps, null);
  } finally {
    await none.queue.stop();
    await rm(none.directory, { recursive: true, force: true });
  }
  let bytesPerSecond = 20 * 125_000;
  const limited = await tempQueue({ speedLimit: () => bytesPerSecond });
  try {
    assert.equal(limited.queue.snapshot().speedLimitMbps, 20);
    bytesPerSecond = 0;
    assert.equal(limited.queue.snapshot().speedLimitMbps, null);
    bytesPerSecond = 10 * 125_000;
    assert.equal(limited.queue.snapshot().speedLimitMbps, 10);
  } finally {
    await limited.queue.stop();
    await rm(limited.directory, { recursive: true, force: true });
  }
});

test("a finished run keeps the jobs cleared during the run in its drain", async () => {
  const clock = { value: Date.parse("2026-11-12T01:00:00.000Z") };
  const { directory, queue } = await tempQueue({ now: () => clock.value });
  const internal = queue as unknown as {
    jobs: DownloadJob[];
    save(): Promise<void>;
  };
  const first = drainJob("first", "alice");
  const second = drainJob("second", "alice");
  const failed = drainJob("failed", "bob");
  const keeper = drainJob("keeper", "alice");
  try {
    internal.jobs.push(first, second, failed, keeper);
    await internal.save();

    clock.value += 1_000;
    const completedAt = new Date(clock.value).toISOString();
    first.status = "completed";
    first.completedAt = completedAt;
    second.status = "completed";
    second.completedAt = completedAt;
    failed.status = "failed";
    failed.updatedAt = completedAt;
    await internal.save();

    await queue.clearCompleted();
    await queue.remove(keeper.id);

    assert.deepEqual(queue.drainFor({ id: "alice", admin: false }), {
      id: queue.drainFor({ id: "alice", admin: false })!.id,
      at: new Date(clock.value).toISOString(),
      completed: 2,
      failed: 0,
      paused: 0,
    });
    assert.deepEqual(queue.drainFor({ id: "bob", admin: false }), {
      id: queue.drainFor({ id: "bob", admin: false })!.id,
      at: new Date(clock.value).toISOString(),
      completed: 0,
      failed: 1,
      paused: 0,
    });
    assert.equal(queue.drainFor({ id: "carol", admin: false }), null);
    const all = queue.drainFor({ id: "admin", admin: true });
    assert.equal(all?.completed, 2);
    assert.equal(all?.failed, 1);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a later run for another account does not take the earlier account's notice away", async () => {
  const clock = { value: Date.parse("2026-11-12T01:00:00.000Z") };
  const { directory, queue } = await tempQueue({ now: () => clock.value });
  const internal = queue as unknown as { jobs: DownloadJob[]; save(): Promise<void> };
  const alice = drainJob("alice-film", "alice");
  const bob = drainJob("bob-film", "bob");
  try {
    internal.jobs.push(alice);
    await internal.save();
    clock.value += 1_000;
    alice.status = "completed";
    alice.completedAt = new Date(clock.value).toISOString();
    await internal.save();
    const aliceNotice = queue.drainFor({ id: "alice", admin: false });
    assert.equal(aliceNotice?.completed, 1);

    clock.value += 1_000;
    internal.jobs.push(bob);
    await internal.save();
    clock.value += 1_000;
    bob.status = "completed";
    bob.completedAt = new Date(clock.value).toISOString();
    await internal.save();

    assert.deepEqual(queue.drainFor({ id: "alice", admin: false }), aliceNotice, "Alice has not read hers yet");
    assert.equal(queue.drainFor({ id: "bob", admin: false })?.completed, 1);
    assert.notEqual(queue.drainFor({ id: "bob", admin: false })?.id, aliceNotice?.id);
    assert.equal(queue.drainFor({ id: "admin", admin: true })?.completed, 1, "the administrator sees the latest run");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a job that failed, was retried and then paused counts only as paused", async () => {
  const clock = { value: Date.parse("2026-11-12T01:00:00.000Z") };
  const { directory, queue } = await tempQueue({ now: () => clock.value });
  const internal = queue as unknown as { jobs: DownloadJob[]; save(): Promise<void> };
  const flaky = drainJob("flaky", "alice");
  const other = drainJob("other", "alice");
  try {
    internal.jobs.push(flaky, other);
    await internal.save();
    clock.value += 1_000;
    flaky.status = "failed";
    flaky.updatedAt = new Date(clock.value).toISOString();
    await internal.save();
    clock.value += 1_000;
    flaky.status = "queued";
    await internal.save();
    flaky.status = "paused";
    flaky.pauseReason = "user";
    await internal.save();
    clock.value += 1_000;
    other.status = "completed";
    other.completedAt = new Date(clock.value).toISOString();
    await internal.save();

    const drain = queue.drainFor({ id: "alice", admin: false });
    assert.equal(drain?.completed, 1);
    assert.equal(drain?.failed, 0, "the retried job is no longer a failure");
    assert.equal(drain?.paused, 1);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a scheduled pause keeps a run open while a user pause is reported at the end", async () => {
  const clock = { value: Date.parse("2026-11-12T01:00:00.000Z") };
  const { directory, queue } = await tempQueue({ now: () => clock.value });
  const internal = queue as unknown as {
    jobs: DownloadJob[];
    save(): Promise<void>;
  };
  const scheduled = drainJob("scheduled", "alice");
  const paused = drainJob("paused", "alice");
  const completed = drainJob("completed", "alice");
  try {
    internal.jobs.push(scheduled, paused, completed);
    await internal.save();

    clock.value += 1_000;
    scheduled.status = "paused";
    scheduled.pauseReason = "schedule";
    paused.status = "paused";
    paused.pauseReason = "user";
    completed.status = "completed";
    completed.completedAt = new Date(clock.value).toISOString();
    await internal.save();
    assert.equal(queue.drainFor({ id: "alice", admin: false }), null, "the scheduled job has not finished");

    clock.value += 1_000;
    scheduled.status = "completed";
    scheduled.completedAt = new Date(clock.value).toISOString();
    await internal.save();
    assert.deepEqual(queue.drainFor({ id: "alice", admin: false }), {
      id: queue.drainFor({ id: "alice", admin: false })!.id,
      at: new Date(clock.value).toISOString(),
      completed: 2,
      failed: 0,
      paused: 1,
    });
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed job that completes later moves to the completed side of the drain", async () => {
  const clock = { value: Date.parse("2026-11-12T01:00:00.000Z") };
  const { directory, queue } = await tempQueue({ now: () => clock.value });
  const internal = queue as unknown as {
    jobs: DownloadJob[];
    save(): Promise<void>;
  };
  const retried = drainJob("retried", "alice");
  const keeper = drainJob("keeper", "alice");
  try {
    internal.jobs.push(retried, keeper);
    await internal.save();
    clock.value += 1_000;
    retried.status = "failed";
    retried.updatedAt = new Date(clock.value).toISOString();
    await internal.save();

    clock.value += 1_000;
    retried.status = "completed";
    retried.completedAt = new Date(clock.value).toISOString();
    await internal.save();
    await queue.remove(keeper.id);

    const drain = queue.drainFor({ id: "alice", admin: false });
    assert.equal(drain?.completed, 1);
    assert.equal(drain?.failed, 0);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a run whose removed jobs all disappear without finishing records no drain", async () => {
  const { directory, queue } = await tempQueue();
  const internal = queue as unknown as {
    jobs: DownloadJob[];
    save(): Promise<void>;
  };
  const only = drainJob("only", "alice");
  try {
    internal.jobs.push(only);
    await internal.save();
    await queue.remove(only.id);
    assert.equal(queue.drainFor({ id: "alice", admin: true }), null);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed manual raw torrent admitted through addDebrid records a drain", async () => {
  const { directory, queue } = await tempQueue({
    debrid: {
      configured: () => true,
      advance: async () => { throw new Error("Real-Debrid refused this torrent."); },
    },
    debridPollMs: 1,
    debridRetryMs: 1,
  });
  try {
    const added = await queue.add("Raw torrent", { infoHash: "a".repeat(40) }, undefined, undefined, "alice");
    assert.equal(added.status, "waiting");
    await waitFor(queue, () => queue.get(added.id)?.status === "failed", 5_000);
    const drain = queue.drainFor({ id: "alice", admin: false });
    assert.equal(drain?.completed, 0);
    assert.equal(drain?.failed, 1);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a drain older than 24 hours is not reported", async () => {
  const clock = { value: Date.parse("2026-11-12T01:00:00.000Z") };
  const { directory, queue } = await tempQueue({ now: () => clock.value });
  const internal = queue as unknown as {
    jobs: DownloadJob[];
    save(): Promise<void>;
  };
  const completed = drainJob("completed", "alice");
  const keeper = drainJob("keeper", "alice");
  try {
    internal.jobs.push(completed, keeper);
    await internal.save();
    completed.status = "completed";
    completed.completedAt = new Date(clock.value + 1_000).toISOString();
    await internal.save();
    await queue.remove(keeper.id);
    assert.ok(queue.drainFor({ id: "alice", admin: false }));

    clock.value += 24 * 60 * 60_000 + 1;
    assert.equal(queue.drainFor({ id: "alice", admin: false }), null);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a loaded busy queue starts a run that can finish normally", async () => {
  const clock = { value: windowAt(12) };
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const downloads = path.join(directory, "downloads");
  const data = path.join(directory, "data");
  const library = downloadLibrary(downloads);
  await mkdir(data, { recursive: true });
  await writeFile(path.join(data, "downloads.json"), JSON.stringify([drainJob("loaded", "alice")]));
  const queue = new DownloadQueue(() => 1, () => 1, data, downloads, {
    now: () => clock.value,
    downloadWindow: () => ({ start: "01:00", end: "07:00" }),
    timeZone: () => "Europe/Prague",
    libraries: () => [library],
    defaultLibrary: () => library,
  });
  const internal = queue as unknown as {
    jobs: DownloadJob[];
    save(): Promise<void>;
  };
  try {
    await queue.load();
    clock.value += 1_000;
    internal.jobs[0]!.status = "completed";
    internal.jobs[0]!.completedAt = new Date(clock.value).toISOString();
    await internal.save();
    assert.equal(queue.drainFor({ id: "alice", admin: false })?.completed, 1);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("trackRun adds no queue write", async () => {
  let writes = 0;
  const { directory, queue } = await tempQueue({
    writeState: async (file, data) => {
      writes += 1;
      await writeFile(file, data);
    },
  });
  const internal = queue as unknown as {
    jobs: DownloadJob[];
    save(): Promise<void>;
    trackRun(): void;
  };
  try {
    internal.jobs.push(drainJob("queued", "alice"));
    await internal.save();
    const before = writes;
    internal.trackRun();
    internal.trackRun();
    assert.equal(writes, before);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
