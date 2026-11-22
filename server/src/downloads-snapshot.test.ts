import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { DownloadStatus, PublicDownload } from "./api-types.js";
import { DownloadQueue, type DownloadJob } from "./downloads.js";

const ADMIN = "usr_admin";
const ORDINARY = "usr_ordinary";
const OTHER = "usr_other";

const ACTIVE: ReadonlySet<DownloadStatus> = new Set([
  "downloading", "checking", "waiting", "queued", "paused",
]);

const job = (id: string, ownerUserId: string | undefined, status: DownloadStatus): DownloadJob => ({
  id,
  title: id,
  ...(ownerUserId === undefined ? {} : { ownerUserId }),
  status,
  target: "",
  received: 0,
  speed: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

test("a filtered snapshot materialises only accepted jobs and keeps their full-queue order", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "stremio-snapshot-"));
  const data = path.join(directory, "data");
  const downloads = path.join(directory, "downloads");
  await mkdir(data, { recursive: true });
  const jobs = [
    ...Array.from({ length: 5_000 }, (_, index) => job(`done-${index}`, index % 2 ? ORDINARY : OTHER, "completed")),
    job("mine-1", ORDINARY, "paused"),
    job("other-1", OTHER, "paused"),
    job("mine-2", ORDINARY, "paused"),
  ];
  await writeFile(path.join(data, "downloads.json"), JSON.stringify(jobs));

  const queue = new DownloadQueue(() => 1, () => 1, data, downloads);
  t.after(async () => {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  });
  await queue.load();

  const prototype = DownloadQueue.prototype as unknown as {
    publicJob(this: DownloadQueue, job: DownloadJob): Omit<PublicDownload, "order">;
  };
  const original = prototype.publicJob;
  let calls = 0;
  prototype.publicJob = function (this: DownloadQueue, candidate: DownloadJob) {
    calls += 1;
    return original.call(this, candidate);
  };

  try {
    const unfiltered = queue.snapshot();
    assert.equal(unfiltered.jobs.length, jobs.length, "snapshot without a predicate still materialises the whole queue");
    assert.equal(calls, jobs.length);

    calls = 0;
    const mine = queue.snapshot((candidate) =>
      ACTIVE.has(candidate.status) && queue.ownerOf(candidate) === ORDINARY
    );
    assert.equal(calls, 2, "only the ordinary user's active jobs are materialised");
    assert.deepEqual(mine.jobs.map((entry) => entry.order), [5_000, 5_002]);

    calls = 0;
    const asAdmin = queue.snapshot((candidate) => ACTIVE.has(candidate.status));
    assert.equal(calls, 3, "only active jobs are materialised for an administrator");
    assert.deepEqual(asAdmin.jobs.map((entry) => entry.order), [5_000, 5_001, 5_002]);
  } finally {
    prototype.publicJob = original;
  }

  const activeForUser = (candidate: DownloadJob) =>
    ACTIVE.has(candidate.status) && queue.ownerOf(candidate) === ORDINARY;
  const activePublicForUser = (candidate: PublicDownload) =>
    ACTIVE.has(candidate.status) && candidate.ownerUserId === ORDINARY;
  const measure = (poll: () => unknown) => {
    const started = performance.now();
    for (let index = 0; index < 200; index += 1) poll();
    return performance.now() - started;
  };
  const before = measure(() => queue.snapshot().jobs.filter(activePublicForUser));
  const after = measure(() => queue.snapshot(activeForUser).jobs);
  t.diagnostic(
    `200 active polls over ${jobs.length} jobs: full snapshots ${before.toFixed(1)} ms, filtered snapshots ${after.toFixed(1)} ms`,
  );
});
