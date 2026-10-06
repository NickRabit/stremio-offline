import assert from "node:assert/strict";
import { createWriteStream, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { DownloadQueue, isPlaylist } from "./downloads.js";
import { AppError } from "./errors.js";
import { relativeWithin, type LibraryRecord } from "./libraries.js";
import { defaultDownloadSettings } from "./naming.js";
import { torrentKey } from "./download-selection.js";

const MB = 1024 * 1024;
const GiB = 1024 ** 3;
const TOTAL = 120 * MB;
const DROP_AFTER = 51 * MB;

process.env.ALLOW_PRIVATE_ADDONS = "1";

const send = async (res: NodeJS.WritableStream, bytes: number) => {
  const chunk = Buffer.alloc(Math.min(MB, bytes));
  for (let sent = 0; sent < bytes; ) {
    const size = Math.min(chunk.length, bytes - sent);
    const piece = size === chunk.length ? chunk : chunk.subarray(0, size);
    if (!res.write(piece)) await new Promise((resolve) => res.once("drain", resolve));
    sent += size;
  }
};

const waitFor = async (queue: DownloadQueue, predicate: () => boolean, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout: ${JSON.stringify(queue.snapshot())}`);
};

const LIBRARY_ID = "lib_d10ad10a";
/** A queue refuses a download no library accepts, so every test queue has one library rooted
 *  at the download directory -- the shape a migrated install has. */
const downloadLibrary = (root: string): LibraryRecord => ({
  id: LIBRARY_ID, name: "Downloads", type: "mixed", root, enabled: true, order: 0,
  addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: false,
});
const queuedFile = (downloads: string, target: string) => path.join(downloads, relativeWithin(LIBRARY_ID, target));

const tempQueue = async (hooks: ConstructorParameters<typeof DownloadQueue>[4] = {}) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const downloads = path.join(directory, "downloads");
  const library = downloadLibrary(downloads);
  const queue = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloads, {
    retryDelay: () => 30,
    stallInitialMs: 5_000,
    stallTransferMs: 5_000,
    libraries: () => [library],
    defaultLibrary: () => library,
    ...hooks,
  });
  await queue.load();
  return { directory, queue, downloads };
};

const listen = (handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) => new Promise<{ server: Server; port: number }>((resolve) => {
  const server = createServer((req, res) => { void handler(req, res); });
  server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port }));
});

const flakyServer = () => new Promise<{ server: Server; port: number; drops: () => number }>((resolve) => {
  let drops = 0;
  const server = createServer(async (req, res) => {
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? "");
    if (!range) {
      res.writeHead(200, { "content-length": String(TOTAL), "content-type": "video/mp4" });
      await send(res, DROP_AFTER);
      drops += 1;
      req.socket.destroy();
      return;
    }
    const offset = Number(range[1]);
    res.writeHead(206, { "content-length": String(TOTAL - offset), "content-range": `bytes ${offset}-${TOTAL - 1}/${TOTAL}` });
    await send(res, TOTAL - offset);
    res.end();
  });
  server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port, drops: () => drops }));
});

test("after an outage and a resumed transfer the retry budget comes back", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const { server, port, drops } = await flakyServer();
  const downloads = path.join(directory, "downloads");
  const library = downloadLibrary(downloads);
  const manager = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloads, {
    libraries: () => [library],
    defaultLibrary: () => library,
  });
  try {
    await manager.load();
    await manager.add("Pokus", { url: `http://127.0.0.1:${port}/video.mp4` });
    await waitFor(manager, () => {
      const job = manager.list()[0];
      return job.status === "completed" || job.status === "failed";
    }, 60_000);
    const job = manager.list()[0];
    assert.equal(drops(), 1, "the server should have cut the connection exactly once");
    assert.equal(job.status, "completed", `the download should have finished, status: ${job.status} ${job.error ?? ""}`);
    assert.ok(job.startedAt);
    assert.ok(job.completedAt);
    assert.ok(Date.parse(job.completedAt) >= Date.parse(job.startedAt));
    assert.equal(job.retryCount, 0, "after a resumed transfer the retry budget should be full again");
    assert.equal((await stat(queuedFile(downloads, job.target))).size, TOTAL);
  } finally {
    await manager.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

const countingServer = (bytes = 2 * MB) => new Promise<{ server: Server; port: number; peak: () => number }>((resolve) => {
  let inflight = 0; let peak = 0;
  const server = createServer(async (_req, res) => {
    inflight += 1; peak = Math.max(peak, inflight);
    res.writeHead(200, { "content-length": String(bytes), "content-type": "video/mp4" });
    await new Promise((done) => setTimeout(done, 300));
    await send(res, bytes);
    res.end();
    inflight -= 1;
  });
  server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port, peak: () => peak }));
});

const runThree = async (perProvider: number) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const { server, port, peak } = await countingServer();
  const downloads = path.join(directory, "downloads");
  const library = downloadLibrary(downloads);
  const queue = new DownloadQueue(() => 4, () => perProvider, path.join(directory, "data"), downloads, {
    libraries: () => [library],
    defaultLibrary: () => library,
  });
  try {
    await queue.load();
    for (const name of ["Prvni", "Druhy", "Treti"]) await queue.add(name, { url: `http://127.0.0.1:${port}/${name}.mp4` });
    await waitFor(queue, () => queue.list().every((job) => job.status === "completed" || job.status === "failed"), 30_000);
    assert.deepEqual(queue.list().map((job) => job.status), ["completed", "completed", "completed"]);
    return peak();
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
};

test("only the allowed number of transfers runs from one provider", async () => {
  assert.equal(await runThree(1), 1, "at one, transfers from a single host must not meet");
});

test("a higher per-provider limit lets transfers run side by side again", async () => {
  assert.equal(await runThree(2), 2, "at two, exactly two should run at once");
});

test("a queue reports a transfer only while one is running", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const { server, port } = await countingServer(MB);
  const downloads = path.join(directory, "downloads");
  const library = downloadLibrary(downloads);
  const queue = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloads, {
    libraries: () => [library],
    defaultLibrary: () => library,
  });
  try {
    await queue.load();
    assert.equal(queue.transferring(), false, "nothing queued, nothing moving");
    await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4` });
    await waitFor(queue, () => queue.transferring());
    assert.equal(queue.transferring(), true, "a job in flight is a transfer");
    await waitFor(queue, () => queue.list()[0]?.status === "completed", 30_000);
    assert.equal(queue.transferring(), false, "a finished job is not");
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the same source cannot be queued twice", async () => {
  const { directory, queue } = await tempQueue();
  try {
    const url = "http://127.0.0.1:1/film.mkv";
    const first = await queue.add("Film", { url });
    await queue.pause(first.id);
    await assert.rejects(() => queue.add("Film", { url }), /already in the queue/);
    await assert.rejects(() => queue.add("A different title", { url }), /already in the queue/, "the source decides, not the title");
    const other = await queue.add("Another film", { url: "http://127.0.0.1:1/other.mkv" });
    await queue.pause(other.id);
    assert.equal(queue.list().length, 2);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a save rule sends the file into the library it names", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const downloadDir = path.join(directory, "downloads");
  const archiveRoot = path.join(directory, "archive");
  const archive = { id: "lib_12345678", name: "Archive", type: "movie" as const, root: archiveRoot, enabled: true, order: 0, addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: true };
  const downloads = downloadLibrary(downloadDir);
  const size = 4096;
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
    void send(res, size).then(() => res.end());
  });
  const queue = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloadDir, {
    stallInitialMs: 5_000, stallTransferMs: 5_000,
    libraryRetryMs: 20, libraryWaitMs: 500,
    libraries: () => [archive, downloads],
    defaultLibrary: () => downloads,
    libraryState: async (libraryId) => libraryId === archive.id ? archive : undefined,
  });
  await queue.load();
  try {
    const job = await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4` }, undefined, { subfolder: "", layout: "structured", libraryId: archive.id });
    assert.equal(job.target, "lib_12345678/Film/Film.mp4", "the job stores the qualified target");
    await waitFor(queue, () => queue.list()[0]?.status === "completed");
    assert.equal((await stat(path.join(archiveRoot, "Film", "Film.mp4"))).size, size, "it landed in the library the rule named");
    await assert.rejects(stat(path.join(downloadDir, "Film", "Film.mp4")), "and not in the download directory");

    // A rule that names a library this instance does not have waits for the re-add first, and
    // takes the default once that window has passed -- a queue that waits for ever is not
    // honest either. The pause is read through the queue rather than off the snapshot `add`
    // returned: `add` writes its state before it answers, and with a window shorter than that
    // write a slow machine resumes the job first, which is how this once reported `queued`.
    const fallback = await queue.add("Other", { url: `http://127.0.0.1:${port}/other.mp4` }, undefined, { subfolder: "", layout: "structured", libraryId: "lib_99999999" });
    await waitFor(queue, () => queue.list().find((item) => item.id === fallback.id)?.status === "paused");
    const waiting = queue.list().find((item) => item.id === fallback.id)!;
    assert.equal(waiting.pauseReason, "library", "it waits for the library to come back");
    assert.equal(waiting.target, "", "and no name is chosen while it waits");
    await waitFor(queue, () => queue.list().find((item) => item.id === fallback.id)?.status === "completed");
    assert.equal((await stat(path.join(downloadDir, "Other", "Other.mp4"))).size, size);
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a rule whose library is away waits for it instead of landing somewhere else", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const downloadDir = path.join(directory, "downloads");
  const archiveRoot = path.join(directory, "archive");
  const archive = { id: "lib_12345678", name: "Archive", type: "movie" as const, root: archiveRoot, enabled: true, order: 0, addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: true };
  const fallbackLibrary = { ...archive, id: "lib_aaaaaaaa", name: "Downloads", root: downloadDir };
  let away = true;
  const size = 4096;
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
    void send(res, size).then(() => res.end());
  });
  const queue = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloadDir, {
    stallInitialMs: 5_000, stallTransferMs: 5_000, libraryRetryMs: 30,
    libraries: () => [away ? { ...archive, unreachable: true } : archive, fallbackLibrary],
    defaultLibrary: () => fallbackLibrary,
    libraryState: async (libraryId) => libraryId === archive.id ? (away ? { ...archive, unreachable: true } : archive) : undefined,
  });
  await queue.load();
  try {
    const job = await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4` }, undefined, { subfolder: "", layout: "structured", libraryId: archive.id });
    assert.equal(job.status, "paused", "the job waits for its library");
    assert.equal((queue.list()[0] as { pauseReason?: string }).pauseReason, "library");
    assert.equal(queue.list()[0]!.target, "", "no name is chosen while the disk is away");
    await new Promise((resolve) => setTimeout(resolve, 120));
    await assert.rejects(stat(path.join(downloadDir, "Film", "Film.mp4")), "and nothing lands in the fallback library");

    // Plugging the disk back in resumes the job by itself, into the library the rule names.
    away = false;
    await waitFor(queue, () => queue.list()[0]?.status === "completed");
    assert.equal(queue.list()[0]!.target, "lib_12345678/Film/Film.mp4");
    assert.equal((await stat(path.join(archiveRoot, "Film", "Film.mp4"))).size, size);
    await assert.rejects(stat(path.join(downloadDir, "Film", "Film.mp4")), "the fallback stays empty");
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a job waits for a removed library and finishes there once it is added again", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const downloadDir = path.join(directory, "downloads");
  const archiveRoot = path.join(directory, "archive");
  const archive = { id: "lib_12345678", name: "Archive", type: "movie" as const, root: archiveRoot, enabled: true, order: 0, addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: true };
  // Removed, not broken: the record is gone from the list until somebody adds the folder back.
  let removed = true;
  const size = 4096;
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
    void send(res, size).then(() => res.end());
  });
  const queue = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloadDir, {
    stallInitialMs: 5_000, stallTransferMs: 5_000, libraryRetryMs: 20, libraryWaitMs: 60_000,
    libraries: () => removed ? [] : [archive],
    libraryState: async (libraryId) => removed ? undefined : (libraryId === archive.id ? archive : undefined),
  });
  await queue.load();
  try {
    const job = await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4` }, undefined, { subfolder: "", layout: "structured", libraryId: archive.id });
    assert.equal(job.status, "paused", "a removed library is waited for, not worked around");
    assert.equal(job.target, "", "and no name is chosen meanwhile");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(queue.list()[0]!.status, "paused", "the patience is minutes, not ticks");

    // Adding the folder again gives the library its id back (state.departed), and the job
    // continues into it rather than into the default.
    removed = false;
    await waitFor(queue, () => queue.list()[0]?.status === "completed");
    assert.equal(queue.list()[0]!.target, "lib_12345678/Film/Film.mp4");
    assert.equal((await stat(path.join(archiveRoot, "Film", "Film.mp4"))).size, size);
    await assert.rejects(stat(path.join(downloadDir, "Film", "Film.mp4")), "nothing landed in the download directory");
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a job whose owner lost the right pauses with the permission reason and runs once it is back", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const downloads = path.join(directory, "downloads");
  const library = downloadLibrary(downloads);
  const size = 4096;
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
    void send(res, size).then(() => res.end());
  });
  let allowed = false;
  const queue = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloads, {
    stallInitialMs: 5_000, stallTransferMs: 5_000,
    libraries: () => [library],
    defaultLibrary: () => library,
    ownerAllowed: () => allowed,
  });
  await queue.load();
  try {
    const job = await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4` });
    await waitFor(queue, () => queue.list()[0]?.status === "paused");
    const paused = queue.list()[0]!;
    assert.equal(paused.pauseReason, "permission", "a missing right pauses the job instead of failing it");
    assert.equal(paused.errorKey, "download.pausedNoPermission");
    await assert.rejects(stat(path.join(downloads, "Film", "Film.mp4")), "nothing is written while the right is gone");

    allowed = true;
    await queue.resume(job.id);
    await waitFor(queue, () => queue.list()[0]?.status === "completed");
    assert.equal((await stat(queuedFile(downloads, queue.list()[0]!.target))).size, size);
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an explicitly chosen library that never comes back fails the job instead of taking the default", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const downloadDir = path.join(directory, "downloads");
  const archiveRoot = path.join(directory, "archive");
  const archive = { id: "lib_12345678", name: "Archive", type: "movie" as const, root: archiveRoot, enabled: true, order: 0, addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: true };
  // The default library is right here and takes the kind, so falling back would be possible --
  // which is exactly what an explicit choice must not do.
  const downloads = downloadLibrary(downloadDir);
  const size = 4096;
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
    void send(res, size).then(() => res.end());
  });
  const queue = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloadDir, {
    stallInitialMs: 5_000, stallTransferMs: 5_000, libraryRetryMs: 20, libraryWaitMs: 60,
    libraries: () => [downloads],
    defaultLibrary: () => downloads,
    libraryState: async () => undefined,
  });
  await queue.load();
  try {
    const job = await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4` }, undefined, { subfolder: "", layout: "structured", libraryId: archive.id, explicit: true });
    await waitFor(queue, () => queue.list().find((item) => item.id === job.id)?.status === "paused");
    assert.equal(queue.list().find((item) => item.id === job.id)?.pauseReason, "library", "a removed library is waited for first");
    await waitFor(queue, () => queue.list().find((item) => item.id === job.id)?.status === "failed");
    assert.equal(queue.list().find((item) => item.id === job.id)?.errorKey, "err.chosenLibraryGone", "past the deadline it fails rather than lands elsewhere");
    await assert.rejects(stat(path.join(downloadDir, "Film", "Film.mp4")), "nothing lands in the default library");
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a series download no library accepts is refused before it is queued", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const downloadDir = path.join(directory, "downloads");
  const films = { id: "lib_f11f5000", name: "Films", type: "movie" as const, root: path.join(directory, "films"), enabled: true, order: 0, addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: true };
  const queue = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloadDir, { libraries: () => [films] });
  await queue.load();
  try {
    await assert.rejects(
      () => queue.add("Show", { url: "http://127.0.0.1:1/show-s01e01.mp4" }, { kind: "episode", title: "Show", season: 1, episode: 1 }),
      (error: unknown) => {
        assert.ok(error instanceof AppError, `the refusal has to be an AppError, got ${String(error)}`);
        assert.equal(error.messageKey, "err.noLibraryForSeries");
        return true;
      });
    assert.deepEqual(queue.list(), [], "a refused download is not queued");
    assert.deepEqual(await readdir(downloadDir), [], "and nothing is written to the download directory");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a debrid download no library accepts is refused at the same point", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const downloadDir = path.join(directory, "downloads");
  const films = { id: "lib_f11f5000", name: "Films", type: "movie" as const, root: path.join(directory, "films"), enabled: true, order: 0, addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: true };
  const queue = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloadDir, {
    libraries: () => [films],
    debrid: { configured: () => true, advance: async () => ({ ready: false, torrentId: "rd1", progress: 0, status: "queued" }) },
  });
  await queue.load();
  try {
    await assert.rejects(
      () => queue.add("Show", { infoHash: "59e11cef8c2152ac73681092844ebd3db19025bc", fileIdx: 0 }, { kind: "episode", title: "Show", season: 1, episode: 1 }),
      (error: unknown) => {
        assert.ok(error instanceof AppError, `the refusal has to be an AppError, got ${String(error)}`);
        assert.equal(error.messageKey, "err.noLibraryForSeries");
        return true;
      });
    assert.deepEqual(queue.list(), [], "a refused torrent is not queued either");
    assert.deepEqual(await readdir(downloadDir), [], "and nothing is written to the download directory");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a pending job no library accepts fails when the queue resolves it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const downloadDir = path.join(directory, "downloads");
  const filmsRoot = path.join(directory, "films");
  const films = { id: "lib_f11f5000", name: "Films", type: "movie" as const, root: filmsRoot, enabled: true, order: 0, addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: true };
  const queue = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloadDir, { libraries: () => [films] });
  queue.setResolver(async () => ({ stream: { url: "http://127.0.0.1:1/show-s01e01.mp4" }, settings: defaultDownloadSettings() }));
  await queue.load();
  try {
    await queue.addPending("Show", { type: "series", videoId: "tt1:1:1" }, { kind: "episode", title: "Show", season: 1, episode: 1 });
    await waitFor(queue, () => queue.list()[0]?.status === "failed");
    const job = queue.list()[0];
    assert.equal(job.errorKey, "err.noLibraryForSeries");
    assert.equal(job.target, "", "no name is chosen when there is nowhere to write");
    assert.deepEqual(await readdir(downloadDir), [], "nothing is written to the download directory");
    await assert.rejects(stat(filmsRoot), "and nothing into the library that does not take the kind");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a mixed library takes both kinds", async () => {
  const size = 4096;
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
    void send(res, size).then(() => res.end());
  });
  const { directory, queue, downloads } = await tempQueue();
  try {
    const film = await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4` });
    const episode = await queue.add("Show", { url: `http://127.0.0.1:${port}/show.mp4` }, { kind: "episode", title: "Show", season: 1, episode: 1 });
    assert.equal(film.status, "queued", "the film is accepted");
    assert.equal(episode.status, "queued", "and so is the episode");
    await waitFor(queue, () => queue.list().every((job) => job.status === "completed"));
    assert.equal((await stat(queuedFile(downloads, film.target))).size, size, "the film landed in the mixed library");
    assert.equal((await stat(queuedFile(downloads, episode.target))).size, size, "and so did the episode");
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a job whose library never comes back fails when no library takes its kind", async () => {
  const size = 4096;
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
    void send(res, size).then(() => res.end());
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const downloadDir = path.join(directory, "downloads");
  const films = { id: "lib_f11f5000", name: "Films", type: "movie" as const, root: path.join(directory, "films"), enabled: true, order: 0, addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: true };
  const gone = "lib_g0ne0001";
  let filmsReachable = false;
  const queue = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloadDir, {
    stallInitialMs: 5_000, stallTransferMs: 5_000,
    libraryRetryMs: 20, libraryWaitMs: 500,
    // The series library the first job names was removed; the film library is merely away.
    libraries: () => [filmsReachable ? films : { ...films, unreachable: true }],
    libraryState: async (libraryId) => libraryId === films.id ? (filmsReachable ? films : { ...films, unreachable: true }) : undefined,
  });
  await queue.load();
  try {
    const first = await queue.add("Show", { url: `http://127.0.0.1:${port}/show.mp4` }, { kind: "episode", title: "Show", season: 1, episode: 1 }, { subfolder: "", layout: "structured", libraryId: gone });
    const second = await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4` }, undefined, { subfolder: "", layout: "structured", libraryId: films.id });
    assert.equal(first.status, "paused", "the job waits for the library that went away");
    assert.equal(second.status, "paused", "and so does the one behind it");

    // The film library comes back; the series library does not, and no library here takes series.
    filmsReachable = true;
    await waitFor(queue, () => {
      const jobs = queue.list();
      return jobs.find((job) => job.id === first.id)?.status === "failed" && jobs.find((job) => job.id === second.id)?.status === "completed";
    });
    const failed = queue.list().find((job) => job.id === first.id)!;
    assert.equal(failed.errorKey, "err.noLibraryForSeries");
    assert.equal(failed.pauseReason, undefined, "it is a failure, not a pause");
    assert.deepEqual(await readdir(downloadDir), [], "it did not fall back to the download directory");
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a job queued before libraries keeps its unqualified target under the download directory", async () => {
  const size = 8192;
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const data = path.join(directory, "data");
  const downloads = path.join(directory, "downloads");
  await mkdir(data, { recursive: true });
  await mkdir(downloads, { recursive: true });
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
    res.end(Buffer.alloc(size, 5));
  });
  await writeFile(path.join(data, "downloads.json"), JSON.stringify([{
    id: "legacy", title: "Legacy", status: "queued", target: "Legacy/Legacy.mp4", received: 0, speed: 0,
    createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z",
    stream: { url: `http://127.0.0.1:${port}/legacy.mp4` },
  }]));
  const queue = new DownloadQueue(() => 1, () => 1, data, downloads, { libraries: () => [] });
  try {
    await queue.load();
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed");
    assert.equal(queue.list()[0].status, "completed", queue.list()[0].error);
    assert.equal((await stat(path.join(downloads, "Legacy", "Legacy.mp4"))).size, size);
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a clean close short of Content-Length is retried from the .part file", async () => {
  const size = 32 * 1024;
  const drop = 8 * 1024;
  let requests = 0;
  const { server, port } = await listen(async (req, res) => {
    requests += 1;
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? "");
    if (!range) {
      res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
      await send(res, drop);
      res.end();
      return;
    }
    const offset = Number(range[1]);
    res.writeHead(206, { "content-length": String(size - offset), "content-range": `bytes ${offset}-${size - 1}/${size}` });
    await send(res, size - offset);
    res.end();
  });
  const { directory, queue, downloads } = await tempQueue({ stallTransferMs: 200, stallInitialMs: 200 });
  try {
    await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4` });
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed");
    const job = queue.list()[0];
    assert.equal(job.status, "completed", job.error);
    assert.ok(requests >= 2, "the short first response must be followed by a Range resume");
    assert.equal((await stat(queuedFile(downloads, job.target))).size, size);
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a clean close without a known size is not treated as finished", async () => {
  const { server, port } = await listen(async (_req, res) => {
    res.writeHead(200, { "content-type": "video/mp4" });
    await send(res, 4096);
    res.end();
  });
  const { directory, queue } = await tempQueue();
  try {
    await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4`, behaviorHints: { videoSize: 40_000 } });
    await waitFor(queue, () => queue.list()[0].status === "failed" || queue.list()[0].retryCount === 3);
    const job = queue.list()[0];
    assert.notEqual(job.status, "completed");
    assert.match(job.error ?? "", /ended early|does not match|retry/);
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("ENOSPC pauses the queue and leaves later jobs untouched", async () => {
  let hits = 0;
  const { server, port } = await listen((_req, res) => {
    hits += 1;
    res.writeHead(200, { "content-length": "4096", "content-type": "video/mp4" });
    res.end(Buffer.alloc(4096));
  });
  const boom = () => new Writable({
    write(_chunk, _enc, cb) {
      cb(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }) as NodeJS.ErrnoException);
    },
  });
  const { directory, queue } = await tempQueue({
    createWriteStream: () => boom(),
    freeSpace: async () => ({ freeBytes: 0, totalBytes: 8 * GiB }),
  });
  try {
    await queue.add("Prvni", { url: `http://127.0.0.1:${port}/a.mp4` });
    await queue.add("Druhy", { url: `http://127.0.0.1:${port}/b.mp4` });
    await waitFor(queue, () => queue.haltInfo()?.reason === "storage");
    assert.equal(queue.list()[0].status, "paused");
    assert.equal(queue.list()[0].pauseReason, "storage");
    assert.equal(queue.list()[1].status, "queued");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(hits, 1, "the second job must not start while storage is halted");
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the queue resumes by itself once free space returns", async () => {
  const size = 4096;
  let failWrite = true;
  let freeBytes = 0;
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
    res.end(Buffer.alloc(size));
  });
  const { directory, queue, downloads } = await tempQueue({
    spaceCheckMs: 40,
    freeSpace: async () => ({ freeBytes, totalBytes: 8 * GiB }),
    createWriteStream: (file, options) => failWrite
      ? new Writable({ write(_c, _e, cb) { cb(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }) as NodeJS.ErrnoException); } })
      : createWriteStream(file, options),
  });
  try {
    await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4` });
    await waitFor(queue, () => queue.haltInfo()?.reason === "storage");
    failWrite = false;
    freeBytes = 8 * GiB;
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed");
    assert.equal(queue.list()[0].status, "completed", queue.list()[0].error);
    assert.equal(queue.haltInfo(), null);
    assert.equal((await stat(queuedFile(downloads, queue.list()[0].target))).size, size);
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a 206 that restarts at byte 0 does not append onto the .part file", async () => {
  const size = 16 * 1024;
  const drop = 4 * 1024;
  const { server, port } = await listen(async (req, res) => {
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? "");
    if (!range) {
      res.writeHead(200, { "content-length": String(size) });
      res.end(Buffer.alloc(drop, 1));
      return;
    }
    res.writeHead(206, { "content-length": String(size), "content-range": `bytes 0-${size - 1}/${size}` });
    res.end(Buffer.alloc(size, 2));
  });
  const { directory, queue, downloads } = await tempQueue({ stallTransferMs: 200, stallInitialMs: 200 });
  try {
    await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4` });
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed");
    const job = queue.list()[0];
    assert.equal(job.status, "completed", job.error);
    const body = await readFile(queuedFile(downloads, job.target));
    assert.equal(body.length, size);
    assert.ok(body.every((byte) => byte === 2), "the restarted payload must replace the partial, not follow it");
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("notBefore stops pump from retrying immediately", async () => {
  let hits = 0;
  const { server, port } = await listen((_req, res) => {
    hits += 1;
    res.writeHead(429, { "retry-after": "60" });
    res.end();
  });
  const { directory, queue } = await tempQueue({ retryDelay: (_count, after) => after ?? 60_000 });
  try {
    await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4` });
    await waitFor(queue, () => (queue.list()[0].retryCount ?? 0) >= 1);
    const hitsAfterFirst = hits;
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(hits, hitsAfterFirst, "Retry-After must be honoured");
    assert.equal(queue.list()[0].status, "queued");
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a name taken by a folder sends the finished download to (2)", async () => {
  const size = 4096;
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
    res.end(Buffer.alloc(size, 3));
  });
  const { directory, queue, downloads } = await tempQueue({
    // By the time the commit looks for the name, it is a folder holding a file. That is the
    // shape an older copy of the film still open in a player makes on Windows.
    createWriteStream: (file, options) => {
      if (file.endsWith(".part")) {
        const target = file.slice(0, -".part".length);
        mkdirSync(target, { recursive: true });
        writeFileSync(path.join(target, "held.mkv"), "an older copy");
      }
      return createWriteStream(file, options);
    },
  });
  try {
    await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4` });
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed");
    const job = queue.list()[0];
    assert.equal(job.status, "completed", job.error ?? "");
    assert.equal(job.target, `${LIBRARY_ID}/Film/Film (2).mp4`, "the taken name sends it to the next one");
    assert.equal(await readFile(path.join(downloads, "Film", "Film.mp4", "held.mkv"), "utf8"), "an older copy", "the older copy is untouched");
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a downloading job is requeued from the .part file after load", async () => {
  const size = 8192;
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const data = path.join(directory, "data");
  const downloads = path.join(directory, "downloads");
  await mkdir(data, { recursive: true });
  await mkdir(downloads, { recursive: true });
  await writeFile(path.join(downloads, "Film.mp4.part"), Buffer.alloc(2048, 9));
  const { server, port } = await listen((req, res) => {
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? "");
    assert.ok(range, "the restored job must send Range");
    assert.equal(Number(range![1]), 2048);
    res.writeHead(206, { "content-length": String(size - 2048), "content-range": `bytes 2048-${size - 1}/${size}` });
    res.end(Buffer.alloc(size - 2048, 8));
  });
  await writeFile(path.join(data, "downloads.json"), JSON.stringify([{
    id: "job-1", title: "Film", status: "downloading", target: "Film.mp4", received: 2048, total: size,
    speed: 100, createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z",
    stream: { url: `http://127.0.0.1:${port}/film.mp4` },
  }]));
  const restored = new DownloadQueue(() => 1, () => 1, data, downloads, { retryDelay: () => 30 });
  try {
    await restored.load();
    await waitFor(restored, () => restored.list()[0].status === "completed" || restored.list()[0].status === "failed");
    assert.equal(restored.list()[0].status, "completed", restored.list()[0].error);
    assert.equal((await stat(path.join(downloads, "Film.mp4"))).size, size);
  } finally {
    await restored.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP 404 fails a direct job and moves a lazy job to the next source", async () => {
  let goodHits = 0;
  const { server, port } = await listen((req, res) => {
    if (req.url === "/missing.mp4") { res.writeHead(404); res.end(); return; }
    goodHits += 1;
    res.writeHead(200, { "content-length": "2048" });
    res.end(Buffer.alloc(2048));
  });
  const { directory, queue } = await tempQueue();
  try {
    await queue.add("Primo", { url: `http://127.0.0.1:${port}/missing.mp4` });
    await waitFor(queue, () => queue.list()[0].status === "failed");
    assert.match(queue.list()[0].error ?? "", /HTTP 404/);

    queue.setResolver(async ({ tried }) => {
      const url = tried.includes(`http://127.0.0.1:${port}/missing.mp4`)
        ? `http://127.0.0.1:${port}/ok.mp4`
        : `http://127.0.0.1:${port}/missing.mp4`;
      return { stream: { url }, settings: defaultDownloadSettings() };
    });
    await queue.addPending("Díl", { type: "series", videoId: "tt1" }, { kind: "episode", title: "Show", season: 1, episode: 1 });
    await waitFor(queue, () => queue.list().some((job) => job.title === "Díl" && (job.status === "completed" || job.status === "failed")));
    const lazy = queue.list().find((job) => job.title === "Díl")!;
    assert.equal(lazy.status, "completed", lazy.error);
    assert.ok(goodHits >= 1);
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a smart job stores selected addon subtitles beside the completed episode", async () => {
  const { server, port } = await listen((req, res) => {
    if (req.url === "/episode.srt") {
      res.writeHead(200, { "content-type": "application/x-subrip" });
      res.end("1\n00:00:01,000 --> 00:00:02,000\nAhoj\n");
      return;
    }
    res.writeHead(200, { "content-length": "2048", "content-type": "video/mp4" });
    res.end(Buffer.alloc(2048));
  });
  const { directory, queue, downloads } = await tempQueue();
  try {
    queue.setResolver(async () => ({
      stream: { url: `http://127.0.0.1:${port}/episode.mp4`, addonKey: "source" },
      subtitle: { url: `http://127.0.0.1:${port}/episode.srt`, lang: "cs" },
      resolution: { checkedCandidates: 1, audioLanguage: "cs", audioTrack: 0, subtitleLanguage: "cs", subtitleSource: "addon", subtitleStatus: "ready" },
      settings: defaultDownloadSettings(),
    }));
    await queue.addPending("Díl", { type: "series", videoId: "tt1:1:1", selection: {
      addonKeys: ["source"], sourceStrategy: "priority", audioLanguage: "cs", subtitleMode: "required",
      subtitleLanguage: "cs", targetSettings: defaultDownloadSettings().series,
    } }, { kind: "episode", title: "Show", season: 1, episode: 1 });
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed");
    assert.equal(queue.list()[0].status, "completed", queue.list()[0].error);
    assert.match(await readFile(path.join(downloads, "Show", "01 serie", "Show - S01E01.cs.vtt"), "utf8"), /WEBVTT[\s\S]*00:00:01\.000[\s\S]*Ahoj/);
  } finally {
    await queue.stop(); server.close(); await rm(directory, { recursive: true, force: true });
  }
});

const HASH = "59e11cef8c2152ac73681092844ebd3db19025bc";

test("a torrent waits on Real-Debrid then downloads over HTTP without taking a slot", async () => {
  const payload = Buffer.alloc(32 * 1024, 7);
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(payload.length), "content-type": "video/mp4" });
    res.end(payload);
  });
  let calls = 0;
  let ready = false;
  const { directory, queue, downloads } = await tempQueue({
    debridPollMs: 20,
    debrid: {
      configured: () => true,
      advance: async () => {
        calls += 1;
        if (!ready) return { ready: false, torrentId: "rd1", progress: 40, status: "downloading" };
        return { ready: true, torrentId: "rd1", url: `http://127.0.0.1:${port}/movie.mp4`, filename: "Movie.mkv" };
      },
    },
  });
  try {
    const waiting = await queue.add("Film", { infoHash: HASH, fileIdx: 0, name: "1080p" });
    assert.equal(waiting.status, "waiting");
    await queue.add("Http", { url: `http://127.0.0.1:${port}/other.mp4` });
    await waitFor(queue, () => queue.list().some((job) => job.title === "Http" && job.status === "completed"));
    assert.equal(queue.list().find((job) => job.title === "Film")?.status, "waiting");
    ready = true;
    await waitFor(queue, () => queue.list().every((job) => job.status === "completed"));
    const torrent = queue.list().find((job) => job.title === "Film")!;
    assert.equal(torrent.status, "completed");
    assert.equal(torrent.debridProgress, 100);
    assert.equal((await stat(queuedFile(downloads, torrent.target))).size, payload.length);
    assert.ok(calls >= 2);
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("the same infoHash is not queued twice", async () => {
  const { directory, queue } = await tempQueue({
    debrid: { configured: () => true, advance: async () => ({ ready: false, torrentId: "rd1", progress: 1, status: "queued" }) },
  });
  try {
    await queue.add("Film", { infoHash: HASH, fileIdx: 0 });
    await assert.rejects(queue.add("Film", { infoHash: HASH, fileIdx: 0 }), /already in the queue/);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a queued source owned by another account does not refuse the caller", async () => {
  const { directory, queue } = await tempQueue();
  try {
    const url = "http://127.0.0.1:1/film.mkv";
    const first = await queue.add("Film", { url }, undefined, undefined, "user1");
    await queue.pause(first.id);
    const second = await queue.add("Film", { url }, undefined, undefined, "user2");
    await queue.pause(second.id);
    assert.equal(queue.list().length, 2, "each account holds its own job for the same source");
    await assert.rejects(() => queue.add("Film", { url }, undefined, undefined, "user1"), /already in the queue/, "the owner is still refused its own source");
    await assert.rejects(() => queue.add("Film", { url }, undefined, undefined, "user2"), /already in the queue/, "and so is the other owner against its own job");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the same infoHash owned by another account does not refuse the caller", async () => {
  const { directory, queue } = await tempQueue({
    debrid: { configured: () => true, advance: async () => ({ ready: false, torrentId: "rd1", progress: 1, status: "queued" }) },
  });
  try {
    await queue.add("Film", { infoHash: HASH, fileIdx: 0 }, undefined, undefined, "user1");
    await queue.add("Film", { infoHash: HASH, fileIdx: 0 }, undefined, undefined, "user2");
    assert.equal(queue.list().length, 2, "each account holds its own torrent for the same infoHash");
    await assert.rejects(() => queue.add("Film", { infoHash: HASH, fileIdx: 0 }, undefined, undefined, "user1"), /already in the queue/);
    await assert.rejects(() => queue.add("Film", { infoHash: HASH, fileIdx: 0 }, undefined, undefined, "user2"), /already in the queue/);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a pending source owned by another account does not refuse the caller", async () => {
  const { directory, queue } = await tempQueue();
  try {
    const first = await queue.addPending("Show", { type: "series", videoId: "tt1:1:1" }, undefined, "user1");
    await queue.pause(first!.id);
    const second = await queue.addPending("Show", { type: "series", videoId: "tt1:1:1" }, undefined, "user2");
    await queue.pause(second!.id);
    assert.equal(queue.list().length, 2, "each account holds its own pending job");
    assert.equal(await queue.addPending("Show", { type: "series", videoId: "tt1:1:1" }, undefined, "user1"), undefined, "the same account repeating the same source is skipped");
    const typed = await queue.addPending("Show", { type: "movie", videoId: "tt1:1:1" }, undefined, "user1");
    assert.ok(typed, "a different type is a different source, even for the same account");
    assert.equal(queue.list().length, 3);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a completed file refuses another account only when it can see the library", async () => {
  const size = 4096;
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
    void send(res, size).then(() => res.end());
  });
  const url = `http://127.0.0.1:${port}/film.mp4`;
  try {
    let visible = false;
    const { directory, queue } = await tempQueue({ ownerSeesLibrary: () => visible });
    try {
      const first = await queue.add("Film", { url }, undefined, undefined, "user1");
      await waitFor(queue, () => queue.list().find((job) => job.id === first.id)?.status === "completed", 30_000);
      assert.ok(await queue.add("Film", { url }, undefined, undefined, "user2"), "a file the asker cannot see does not refuse the other account");
      visible = true;
      await assert.rejects(() => queue.add("Film", { url }, undefined, undefined, "user3"), /already in the library/, "a file the asker can see does refuse the other account");
    } finally {
      await queue.stop();
      await rm(directory, { recursive: true, force: true });
    }

    // Without the hook the safe answer stands on its own: the other account is never told.
    const { directory: plain, queue: without } = await tempQueue();
    try {
      const first = await without.add("Film", { url }, undefined, undefined, "user1");
      await waitFor(without, () => without.list().find((job) => job.id === first.id)?.status === "completed", 30_000);
      assert.ok(await without.add("Film", { url }, undefined, undefined, "user2"), "without the hook the other account is not refused");
    } finally {
      await without.stop();
      await rm(plain, { recursive: true, force: true });
    }
  } finally {
    server.close();
  }
});

test("a legacy job without an owner belongs to the migrated administrator", async () => {
  const { directory, queue } = await tempQueue({ legacyOwnerId: () => "admin1" });
  try {
    const url = "http://127.0.0.1:1/film.mkv";
    const legacy = await queue.add("Film", { url });
    await queue.pause(legacy.id);
    assert.equal(queue.list().find((job) => job.id === legacy.id)?.ownerUserId, "admin1", "the job resolves to the migrated administrator");
    await assert.rejects(() => queue.add("Film", { url }, undefined, undefined, "admin1"), /already in the queue/, "the migrated administrator is refused its own legacy job");
    assert.ok(await queue.add("Film", { url }, undefined, undefined, "user2"), "another account is not refused by the legacy job");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a dropped Real-Debrid call is retried instead of failing the job", async () => {
  let calls = 0;
  const { directory, queue } = await tempQueue({
    debridPollMs: 20,
    debridRetryMs: 20,
    debrid: {
      configured: () => true,
      advance: async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("fetch failed");
        return { ready: false, torrentId: "rd1", progress: 10, status: "downloading" };
      },
    },
  });
  try {
    await queue.add("Film", { infoHash: HASH, fileIdx: 0 });
    await waitFor(queue, () => calls >= 2 && queue.list()[0].status === "waiting");
    assert.equal(queue.list()[0].status, "waiting");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a torrent without a token is refused", async () => {
  const { directory, queue } = await tempQueue();
  try {
    await assert.rejects(queue.add("Film", { infoHash: HASH }), /Real-Debrid/);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a malformed queue file is copied aside and the queue starts empty", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const data = path.join(directory, "data");
  const downloads = path.join(directory, "downloads");
  await mkdir(data, { recursive: true });
  const state = path.join(data, "downloads.json");
  const original = "{not-json";
  await writeFile(state, original);
  const library = downloadLibrary(downloads);
  const open = (dir: string) => new DownloadQueue(() => 1, () => 1, dir, downloads, { libraries: () => [library], defaultLibrary: () => library });
  const queue = open(data);
  try {
    await queue.load();
    assert.deepEqual(queue.list(), [], "a state that cannot be parsed loads as an empty queue");
    const damaged = (await readdir(data)).filter((name) => name.startsWith("downloads.json.damaged-"));
    assert.equal(damaged.length, 1, "the original bytes are copied aside under a unique name");
    assert.equal(await readFile(path.join(data, damaged[0]!), "utf8"), original);
    assert.deepEqual(JSON.parse(await readFile(state, "utf8")), [], "the queue file is now a valid empty list");

    // A second malformed file makes a second copy and never touches the first.
    await writeFile(state, "{still-broken");
    const second = open(data);
    try {
      await second.load();
      const copies = (await readdir(data)).filter((name) => name.startsWith("downloads.json.damaged-"));
      assert.equal(copies.length, 2, "a later malformed file is copied aside too");
      assert.equal(await readFile(path.join(data, damaged[0]!), "utf8"), original, "the first copy keeps its bytes");
    } finally {
      await second.stop();
    }
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unreadable queue file blocks new work and is left as it is", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const data = path.join(directory, "data");
  const downloads = path.join(directory, "downloads");
  await mkdir(data, { recursive: true });
  const state = path.join(data, "downloads.json");
  await mkdir(state);
  const library = downloadLibrary(downloads);
  const queue = new DownloadQueue(() => 1, () => 1, data, downloads, { libraries: () => [library], defaultLibrary: () => library });
  try {
    await queue.load();
    assert.deepEqual(queue.list(), []);
    await assert.rejects(queue.add("Film", { url: "http://example.test/film.mp4" }), (error: AppError) => error.messageKey === "err.queueUnreadable");
    assert.equal((await stat(state)).isDirectory(), true, "the unreadable path is still the directory it was");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("two downloads admitted at once get different target files", async () => {
  const { directory, queue } = await tempQueue();
  try {
    const [first, second] = await Promise.all([
      queue.add("Film", { url: "http://example.test/one.mp4" }),
      queue.add("Film", { url: "http://example.test/two.mp4" }),
    ]);
    assert.equal(queue.list().length, 2, "both clicks land as one job each");
    assert.notEqual(first.target, second.target, "the two jobs never carry the same name");
    assert.ok(first.target && second.target);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a double-click on the same source yields one job and one refusal", async () => {
  const { directory, queue } = await tempQueue();
  try {
    const results = await Promise.allSettled([
      queue.add("Film", { url: "http://example.test/same.mp4" }),
      queue.add("Film", { url: "http://example.test/same.mp4" }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one click becomes a job");
    assert.equal(rejected.length, 1, "the other is refused");
    assert.equal((rejected[0]!.reason as AppError).messageKey, "err.sourceQueued");
    assert.equal(queue.list().length, 1, "only one job is in the list");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("two jobs resuming at once never take the same target name", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const downloadDir = path.join(directory, "downloads");
  const archiveRoot = path.join(directory, "archive");
  const archive = { id: "lib_12345678", name: "Archive", type: "movie" as const, root: archiveRoot, enabled: true, order: 0, addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: true };
  let away = true;
  const size = 4096;
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
    void send(res, size).then(() => res.end());
  });
  const queue = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloadDir, {
    stallInitialMs: 5_000, stallTransferMs: 5_000, libraryRetryMs: 60_000,
    libraries: () => away ? [] : [archive],
    defaultLibrary: () => archive,
    libraryState: async (libraryId) => away ? undefined : (libraryId === archive.id ? archive : undefined),
  });
  await queue.load();
  const settings = { subfolder: "", layout: "structured" as const, libraryId: archive.id };
  try {
    const first = await queue.add("Film", { url: `http://127.0.0.1:${port}/one.mp4` }, undefined, settings);
    const second = await queue.add("Film", { url: `http://127.0.0.1:${port}/two.mp4` }, undefined, settings);
    assert.equal(first.status, "paused");
    assert.equal(second.status, "paused");
    assert.equal(first.target, "");
    assert.equal(second.target, "");

    // The library is back, and both jobs resume in the same turn: the free-name search of one
    // must see the name the other is about to claim.
    away = false;
    await Promise.all([queue.resume(first.id), queue.resume(second.id)]);
    const [a, b] = queue.list();
    assert.ok(a!.target && b!.target);
    assert.notEqual(a!.target, b!.target, "the two names must differ");
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an admission that cannot be persisted is refused and leaves nothing behind", async () => {
  let failing = false;
  const { directory, queue } = await tempQueue({
    writeState: async (file, data) => {
      if (failing) throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
      await writeFile(file, data);
    },
  });
  const stored = async () => JSON.parse(await readFile(path.join(directory, "data", "downloads.json"), "utf8")) as Array<{ id: string; follow?: unknown }>;
  try {
    failing = true;
    await assert.rejects(queue.add("Film", { url: "http://127.0.0.1:1/film.mkv" }), (error: AppError) => error.messageKey === "err.queueNotSaved");
    await assert.rejects(queue.addPending("Ep", { type: "series", videoId: "v1" }), (error: AppError) => error.messageKey === "err.queueNotSaved");
    assert.deepEqual(queue.list(), [], "a refused admission leaves no job in memory");

    failing = false;
    const again = await queue.add("Film", { url: "http://127.0.0.1:1/film.mkv" });
    await queue.pause(again.id);
    assert.ok((await stored()).some((job) => job.id === again.id), "the job reaches the file once the write can land");

    // A follow that cannot be saved is rolled back to the one the job already had.
    await queue.adopt(again.id, { followId: "old", episodeKey: "s1e1", intent: "old" });
    failing = true;
    await assert.rejects(
      queue.adopt(again.id, { followId: "new", episodeKey: "s1e1", intent: "new" }),
      (error: AppError) => error.messageKey === "err.queueNotSaved",
    );
    assert.deepEqual(queue.get(again.id)!.follow, { followId: "old", episodeKey: "s1e1", intent: "old" }, "the old follow stays");
    failing = false;
    await queue.stop();
    assert.deepEqual((await stored()).find((job) => job.id === again.id)?.follow, { followId: "old", episodeKey: "s1e1", intent: "old" }, "and the file keeps it too");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a removal that cannot be saved keeps the row and its partial file", async () => {
  let failing = false;
  const { directory, queue, downloads } = await tempQueue({
    writeState: async (file, data) => {
      if (failing) throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
      await writeFile(file, data);
    },
  });
  const stored = async () => JSON.parse(await readFile(path.join(directory, "data", "downloads.json"), "utf8")) as Array<{ id: string }>;
  try {
    const job = await queue.add("Film", { url: "http://127.0.0.1:1/film.mkv" });
    await queue.pause(job.id);
    const partial = `${queuedFile(downloads, job.target)}.part`;
    await mkdir(path.dirname(partial), { recursive: true });
    await writeFile(partial, "half a film");

    failing = true;
    await assert.rejects(queue.remove(job.id), (error: AppError) => error.messageKey === "err.queueNotSaved");
    assert.ok(queue.get(job.id), "the row stays in the queue");
    assert.equal(await readFile(partial, "utf8"), "half a film", "the partial file is still there to resume from");

    failing = false;
    await queue.remove(job.id);
    assert.equal(queue.get(job.id), undefined);
    assert.equal(existsSync(partial), false, "a removal that lands takes the partial file with it");
    assert.deepEqual(await stored(), []);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("clearing history that cannot be saved keeps the finished rows", async () => {
  let failing = false;
  const size = 128;
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
    void send(res, size).then(() => res.end());
  });
  const { directory, queue } = await tempQueue({
    writeState: async (file, data) => {
      if (failing) throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
      await writeFile(file, data);
    },
  });
  try {
    const job = await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4` });
    await waitFor(queue, () => queue.get(job.id)?.status === "completed", 30_000);
    failing = true;
    await assert.rejects(queue.clearCompleted(), (error: AppError) => error.messageKey === "err.queueNotSaved");
    assert.equal(queue.get(job.id)?.status, "completed", "the finished row is kept");
    failing = false;
    await queue.clearCompleted();
    assert.deepEqual(queue.list(), []);
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a write queued after a failed admission does not store the refused job", async () => {
  let failOnce = false;
  let queue!: DownloadQueue;
  const setup = await tempQueue({
    writeState: async (file, data) => {
      if (failOnce) {
        failOnce = false;
        // Another mutation queues its own save while this one is failing.
        void queue.clearCompleted();
        throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
      }
      await writeFile(file, data);
    },
  });
  queue = setup.queue;
  try {
    failOnce = true;
    await assert.rejects(queue.add("Film", { url: "http://127.0.0.1:1/film.mkv" }), (error: AppError) => error.messageKey === "err.queueNotSaved");
    await queue.stop();
    const stored = JSON.parse(await readFile(path.join(setup.directory, "data", "downloads.json"), "utf8")) as unknown[];
    assert.deepEqual(stored, [], "the refused job never reaches the file");
    assert.deepEqual(queue.list(), []);
  } finally {
    await queue.stop();
    await rm(setup.directory, { recursive: true, force: true });
  }
});

test("a write already waiting before an admission does not store the job if the admission fails", async () => {
  const calls: Array<"hold" | "write" | "fail"> = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const { directory, queue } = await tempQueue({
    writeState: async (file, data) => {
      const plan = calls.shift();
      if (plan === "hold") await held;
      if (plan === "fail") throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
      await writeFile(file, data);
    },
  });
  try {
    const existing = await queue.add("Other", { url: "http://127.0.0.1:1/other.mkv" });
    await queue.pause(existing.id);
    // The first save is held on the disk and a second one waits behind it; then the
    // admission queues its own write, which fails.
    calls.push("hold", "write", "fail");
    const first = queue.pause(existing.id);
    const second = queue.pause(existing.id);
    const admission = queue.add("Film", { url: "http://127.0.0.1:1/film.mkv" });
    release();
    await assert.rejects(admission, (error: AppError) => error.messageKey === "err.queueNotSaved");
    await Promise.all([first, second]);
    await queue.stop();
    const stored = JSON.parse(await readFile(path.join(directory, "data", "downloads.json"), "utf8")) as Array<{ id: string }>;
    assert.deepEqual(stored.map((job) => job.id), [existing.id], "only the job that was admitted is on disk");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

const SEGMENTED_TOTAL = 48 * MB;
const byteAt = (position: number) => position % 251;
const filled = (from: number, length: number) => Buffer.from(Array.from({ length }, (_unused, index) => byteAt(from + index)));

/** Serves byte ranges, and every byte says where in the file it belongs, so a segment written
 *  to the wrong offset cannot pass unnoticed. */
const rangeServer = (options: { total?: number; ranges?: boolean; cutAt?: number; probeOnly?: boolean } = {}) => new Promise<{
  server: Server; port: number; peak: () => number; requests: () => string[];
}>((resolve) => {
  const total = options.total ?? SEGMENTED_TOTAL;
  let inflight = 0; let peak = 0; let cut = options.cutAt != null;
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    requests.push(req.headers.range ?? "");
    const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    // `probeOnly` is the source that answers the one-byte probe honestly and every real range
    // with the whole file -- the lie that makes the probe promise a plan the transfer cannot keep.
    const probe = Boolean(match && match[1] === "0" && match[2] === "0");
    if (!match || options.ranges === false || (options.probeOnly && !probe)) {
      res.writeHead(200, { "content-length": String(total), "content-type": "video/mp4" });
      // Paced the way the range branch is, and stopping the moment the client gives up. A
      // segment request answered with the whole file is a body nobody wants: written in one
      // synchronous burst, four of those queue the file four times over and hold the loop
      // long enough for the stall detector to fire before the fallback is even reached.
      for (let sent = 0; sent < total; sent += MB) {
        if (res.destroyed) return;
        res.write(filled(sent, Math.min(MB, total - sent)));
        await new Promise((done) => setTimeout(done, 1));
      }
      res.end();
      return;
    }
    inflight += 1; peak = Math.max(peak, inflight);
    const from = Number(match[1]);
    const to = match[2] ? Number(match[2]) : total - 1;
    res.writeHead(206, { "content-length": String(to - from + 1), "content-range": `bytes ${from}-${to}/${total}` });
    for (let sent = from; sent <= to; sent += 64 * 1024) {
      const length = Math.min(64 * 1024, to - sent + 1);
      if (cut && options.cutAt != null && sent + length > from + options.cutAt) { cut = false; req.socket.destroy(); inflight -= 1; return; }
      res.write(filled(sent, length));
      await new Promise((done) => setTimeout(done, 1));
    }
    res.end();
    inflight -= 1;
  });
  server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port, peak: () => peak, requests: () => requests }));
});

const assertContent = async (file: string, total: number) => {
  const data = await readFile(file);
  assert.equal(data.length, total);
  for (let position = 0; position < total; position += 7919) {
    assert.equal(data[position], byteAt(position), `byte ${position} came from the wrong place in the file`);
  }
};

test("a file is fetched over several connections and lands byte for byte", async () => {
  const { directory, queue, downloads } = await tempQueue({ segments: () => 3 });
  const { server, port, peak } = await rangeServer();
  try {
    const job = await queue.add("Segmented", { url: `http://127.0.0.1:${port}/film.mkv` });
    await waitFor(queue, () => queue.list()[0].status !== "downloading" && queue.list()[0].status !== "queued", 60_000);
    const done = queue.list()[0];
    assert.equal(done.status, "completed", done.error ?? "");
    assert.equal(done.segments, undefined, "a finished download keeps no plan");
    assert.equal(peak(), 3, "all three segments should have run at once");
    await assertContent(queuedFile(downloads, job.target), SEGMENTED_TOTAL);
  } finally {
    await queue.stop(); server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a source that ignores ranges is downloaded over one stream", async () => {
  const { directory, queue, downloads } = await tempQueue({ segments: () => 4 });
  const { server, port, peak } = await rangeServer({ ranges: false });
  try {
    const job = await queue.add("Plain", { url: `http://127.0.0.1:${port}/film.mkv` });
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed", 60_000);
    assert.equal(queue.list()[0].status, "completed", queue.list()[0].error ?? "");
    assert.equal(peak(), 0, "no ranged transfer should have started");
    await assertContent(queuedFile(downloads, job.target), SEGMENTED_TOTAL);
  } finally {
    await queue.stop(); server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a source that lies to the probe and then ignores ranges finishes as one stream", async () => {
  const { directory, queue, downloads } = await tempQueue({ segments: () => 4 });
  const { server, port, requests } = await rangeServer({ probeOnly: true });
  const plans: Array<number | undefined> = [];
  queue.onProgress = (job) => plans.push(job.segments?.length);
  try {
    const job = await queue.add("Mendacious", { url: `http://127.0.0.1:${port}/film.mkv` });
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed", 60_000);
    const done = queue.list()[0];
    assert.equal(done.status, "completed", done.error ?? "");
    assert.equal(done.rangesIgnored, true, "the job has to remember that the source ignores ranges");
    assert.equal(requests().filter((range) => range === "bytes=0-0").length, 1, "the doomed plan must be built exactly once");
    assert.ok(plans.length > 0, "the transfer that succeeds should have reported progress");
    assert.deepEqual([...new Set(plans)], [undefined], "the attempt that succeeds must carry no plan");
    await assertContent(queuedFile(downloads, job.target), SEGMENTED_TOTAL);
  } finally {
    await queue.stop(); server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the part file of an abandoned plan is gone before the single stream writes", async () => {
  const partAtWrite: boolean[] = [];
  const { directory, queue, downloads } = await tempQueue({
    segments: () => 4,
    createWriteStream: (file, options) => { partAtWrite.push(existsSync(file)); return createWriteStream(file, options); },
  });
  const { server, port } = await rangeServer({ probeOnly: true });
  try {
    const job = await queue.add("Mendacious", { url: `http://127.0.0.1:${port}/film.mkv` });
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed", 60_000);
    assert.equal(queue.list()[0].status, "completed", queue.list()[0].error ?? "");
    assert.equal(queue.list()[0].rangesIgnored, true, "the plan has to have been abandoned for this to prove anything");
    assert.deepEqual(partAtWrite, [false], "a part file written at segment offsets must not survive into the single stream");
    await assertContent(queuedFile(downloads, job.target), SEGMENTED_TOTAL);
  } finally {
    await queue.stop(); server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("falling back to one stream does not spend a retry", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const data = path.join(directory, "data");
  const downloads = path.join(directory, "downloads");
  await mkdir(data, { recursive: true });
  await mkdir(downloads, { recursive: true });
  const { server, port } = await rangeServer({ probeOnly: true });
  await writeFile(path.join(data, "downloads.json"), JSON.stringify([{
    id: "job-1", title: "Mendacious", status: "queued", target: "Mendacious.mkv", received: 0, retryCount: 1,
    speed: 0, createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z",
    stream: { url: `http://127.0.0.1:${port}/film.mkv` },
  }]));
  const queue = new DownloadQueue(() => 1, () => 1, data, downloads, { retryDelay: () => 30, segments: () => 4 });
  const seen: number[] = [];
  queue.onProgress = (job) => seen.push(job.retryCount ?? 0);
  try {
    await queue.load();
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed", 60_000);
    assert.equal(queue.list()[0].status, "completed", queue.list()[0].error ?? "");
    assert.ok(seen.length > 0, "the transfer that succeeds should have reported progress");
    assert.deepEqual([...new Set(seen)], [1], "the fallback must leave the retry budget where the connection drops left it");
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a 200 on an unsegmented attempt still fails after three retries", async () => {
  const { directory, queue } = await tempQueue({ segments: () => 4 });
  const ranges: string[] = [];
  let probes = 0;
  const { server, port } = await listen((req, res) => {
    const range = req.headers.range ?? "";
    ranges.push(range);
    if (range === "bytes=0-0") {
      probes += 1;
      res.writeHead(206, { "content-length": "1", "content-range": `bytes 0-0/${SEGMENTED_TOTAL}` });
      res.end(filled(0, 1));
      return;
    }
    // A 200 without a size whose body stops early: the source answers, but never the file.
    res.writeHead(200, { "content-type": "video/mp4" });
    res.write(Buffer.alloc(4096));
    res.end();
  });
  try {
    await queue.add("Mendacious", { url: `http://127.0.0.1:${port}/film.mkv` });
    await waitFor(queue, () => queue.list()[0].status === "failed", 30_000);
    const job = queue.list()[0];
    assert.equal(job.retryCount, 3, "an unsegmented 200 has to spend the retry budget like any other failure");
    assert.equal(job.rangesIgnored, true, "the doomed plan has to be abandoned first");
    assert.equal(probes, 1, "the abandoned plan must not be built again");
    assert.ok(ranges.includes(""), "the attempt that failed has to have been the unsegmented one");
  } finally {
    await queue.stop(); server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a source that lies does not deny ranges to the source that follows it", async () => {
  const { directory, queue, downloads } = await tempQueue({ segments: () => 3 });
  const liar = await listen((req, res) => {
    const range = req.headers.range ?? "";
    if (range === "bytes=0-0") {
      res.writeHead(206, { "content-length": "1", "content-range": `bytes 0-0/${SEGMENTED_TOTAL}` });
      res.end(filled(0, 1));
      return;
    }
    // A 200 whose body stops early: this source answers ranges and the single stream alike without
    // ever sending the file, so the job gives up on it and moves to the next source.
    res.writeHead(200, { "content-type": "video/mp4" });
    res.write(Buffer.alloc(4096));
    res.end();
  });
  const honest = await rangeServer();
  const liarUrl = `http://127.0.0.1:${liar.port}/lie.mkv`;
  queue.setResolver(async ({ tried }) => ({
    stream: { url: tried.includes(liarUrl) ? `http://127.0.0.1:${honest.port}/honest.mkv` : liarUrl },
    settings: defaultDownloadSettings(),
  }));
  try {
    await queue.addPending("Liar", { type: "movie", videoId: "tt2" }, { kind: "movie", title: "Liar" });
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed", 60_000);
    const job = queue.list()[0];
    assert.equal(job.status, "completed", job.error ?? "");
    assert.ok(!job.rangesIgnored, "a flag describing the first source must not reach the second");
    assert.equal(honest.peak(), 3, "the honest source has to be segmented on its own merits");
    await assertContent(queuedFile(downloads, job.target), SEGMENTED_TOTAL);
  } finally {
    await queue.stop(); liar.server.close(); honest.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a segment cut mid-transfer resumes at its own offset", async () => {
  const { directory, queue, downloads } = await tempQueue({ segments: () => 2 });
  const { server, port, requests } = await rangeServer({ cutAt: 2 * MB });
  try {
    const job = await queue.add("Broken", { url: `http://127.0.0.1:${port}/film.mkv` });
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed", 60_000);
    assert.equal(queue.list()[0].status, "completed", queue.list()[0].error ?? "");
    assert.ok(requests().some((range) => /^bytes=[1-9]\d+-\d+$/.test(range)), `a retry should have asked for a later offset: ${requests().join(", ")}`);
    await assertContent(queuedFile(downloads, job.target), SEGMENTED_TOTAL);
  } finally {
    await queue.stop(); server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a paused segmented download keeps its plan and finishes after a resume", async () => {
  const { directory, queue, downloads } = await tempQueue({ segments: () => 2 });
  const { server, port } = await rangeServer();
  try {
    const job = await queue.add("Paused", { url: `http://127.0.0.1:${port}/film.mkv` });
    await waitFor(queue, () => queue.list()[0].received > MB, 30_000);
    await queue.pause(job.id);
    const paused = queue.list()[0];
    assert.equal(paused.status, "paused");
    assert.equal(paused.segments, 2, "the plan has to survive the pause");
    assert.equal((await stat(queuedFile(downloads, `${job.target}.part`))).size, SEGMENTED_TOTAL, "the part file keeps its full size");
    await queue.resume(job.id);
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed", 60_000);
    assert.equal(queue.list()[0].status, "completed", queue.list()[0].error ?? "");
    await assertContent(queuedFile(downloads, job.target), SEGMENTED_TOTAL);
  } finally {
    await queue.stop(); server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a playlist is told apart from a file, whatever the segments are named", () => {
  // The addresses that prompted this: the extension sits after another one, and
  // a query string follows it.
  assert.equal(isPlaylist("https://cdn.example/media/1080.mp4.m3u8"), true);
  assert.equal(isPlaylist("https://cdn.example/a/index.M3U8?token=x"), true);
  assert.equal(isPlaylist("https://cdn.example/video-1080p.mp4"), false);
  assert.equal(isPlaylist("https://cdn.example/clip.vid"), false);
  // A path that merely mentions it is still a file.
  assert.equal(isPlaylist("https://cdn.example/m3u8/clip.mp4"), false);
  assert.equal(isPlaylist("not a url"), false);
});

test("a removal guard that throws refuses the removal and keeps the row", async () => {
  const { directory, queue } = await tempQueue({ beforeRemove: async () => { throw new Error("no removal"); } });
  try {
    const job = await queue.addPending("Show", { type: "series", videoId: "tt1:1:1" }, undefined, "u1");
    await assert.rejects(queue.remove(job!.id), /no removal/);
    assert.ok(queue.get(job!.id), "the row is still there");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("removeMatching tells the guard the removal is an account's", async () => {
  const reasons: string[] = [];
  const { directory, queue } = await tempQueue({ beforeRemove: async (_job, reason) => { reasons.push(reason); } });
  try {
    await queue.addPending("Show", { type: "series", videoId: "tt1:1:1" }, undefined, "u1");
    await queue.removeMatching(() => true);
    assert.deepEqual(reasons, ["account"]);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a clear guard that throws clears nothing", async () => {
  const size = 128;
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
    void send(res, size).then(() => res.end());
  });
  const { directory, queue } = await tempQueue({ beforeClearCompleted: async () => { throw new Error("no clear"); } });
  try {
    const job = await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4` });
    await waitFor(queue, () => queue.list().find((item) => item.id === job.id)?.status === "completed", 30_000);
    await assert.rejects(queue.clearCompleted(), /no clear/);
    assert.equal(queue.list().length, 1, "the finished row is kept");
    assert.equal(queue.list()[0].status, "completed");
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a job's follow survives a save and a load", async () => {
  const { directory, queue } = await tempQueue();
  try {
    const job = await queue.addPending("Show", { type: "series", videoId: "tt1:1:1" }, undefined, "u1", { followId: "f1", episodeKey: "1:1", intent: "f1:1:1:1" });
    await queue.stop();
    const downloads = path.join(directory, "downloads");
    const reopened = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloads, {
      libraries: () => [downloadLibrary(downloads)],
      defaultLibrary: () => downloadLibrary(downloads),
    });
    await reopened.load();
    try {
      assert.deepEqual(reopened.get(job!.id)?.follow, { followId: "f1", episodeKey: "1:1", intent: "f1:1:1:1" });
    } finally {
      await reopened.stop();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a lazy job that finds no source fails with the no-matching-source key", async () => {
  const { directory, queue } = await tempQueue();
  queue.setResolver(async () => undefined);
  try {
    await queue.addPending("Show", { type: "series", videoId: "tt1:1:1" }, { kind: "episode", title: "Show", season: 1, episode: 1 });
    await waitFor(queue, () => queue.list()[0]?.status === "failed");
    assert.equal(queue.list()[0].errorKey, "err.noMatchingSource");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a lazy job falls back to a torrent and downloads it through Real-Debrid", async () => {
  const payload = Buffer.alloc(16 * 1024, 3);
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(payload.length), "content-type": "video/mp4" });
    res.end(payload);
  });
  let ready = false;
  const { directory, queue, downloads } = await tempQueue({
    debridPollMs: 20,
    debrid: {
      configured: () => true,
      advance: async () => ready
        ? { ready: true, torrentId: "rd1", url: `http://127.0.0.1:${port}/movie.mp4`, filename: "Film.mkv" }
        : { ready: false, torrentId: "rd1", progress: 10, status: "downloading" },
    },
  });
  queue.setResolver(async () => ({ stream: { infoHash: HASH, fileIdx: 0, title: "Film 1080p" }, settings: defaultDownloadSettings() }));
  try {
    await queue.addPending("Film", { type: "movie", videoId: "tt9" }, { kind: "movie", title: "Film" });
    await waitFor(queue, () => (queue.list()[0]?.debridProgress ?? 0) > 0, 30_000);
    assert.equal(queue.list()[0].status, "waiting", "the torrent waits for Real-Debrid before any transfer");
    ready = true;
    await waitFor(queue, () => queue.list()[0]?.status === "completed", 30_000);
    const job = queue.list()[0];
    assert.equal(job.status, "completed");
    assert.equal(job.debridProgress, 100);
    assert.equal((await stat(queuedFile(downloads, job.target))).size, payload.length);
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failing torrent on a lazy job tries the next source and finally fails", async () => {
  const first = { infoHash: HASH, fileIdx: 0, title: "Show CZ" };
  const second = { infoHash: "1111111111111111111111111111111111111111", fileIdx: 0, title: "Show CZ" };
  let calls = 0;
  const { directory, queue } = await tempQueue({
    debridPollMs: 20,
    debrid: { configured: () => true, advance: async () => { calls += 1; throw new Error("Real-Debrid refused this torrent."); } },
  });
  queue.setResolver(async ({ tried }) => {
    const next = [first, second].find((stream) => !tried.includes(torrentKey(stream)));
    return next ? { stream: next, settings: defaultDownloadSettings() } : undefined;
  });
  try {
    await queue.addPending("Show", { type: "series", videoId: "tt1" }, { kind: "episode", title: "Show", season: 1, episode: 1 });
    await waitFor(queue, () => queue.list()[0]?.status === "failed", 30_000);
    const job = queue.list()[0];
    assert.equal(job.status, "failed");
    assert.equal(job.errorKey, "err.noMatchingSource");
    assert.equal(calls, 2, "both torrents were handed to Real-Debrid before the job gave up");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a Real-Debrid link that fails over HTTP rules its torrent out, not only its address", async () => {
  const { server, port } = await listen((_req, res) => { res.writeHead(404); res.end(); });
  const first = { infoHash: HASH, fileIdx: 0, title: "Show CZ" };
  const second = { infoHash: "1111111111111111111111111111111111111111", fileIdx: 0, title: "Show CZ" };
  const handed: string[] = [];
  const { directory, queue } = await tempQueue({
    debridPollMs: 20,
    debrid: { configured: () => true, advance: async ({ infoHash }) => {
      handed.push(infoHash);
      return { ready: true, torrentId: `rd-${handed.length}`, url: `http://127.0.0.1:${port}/gone-${handed.length}.mkv`, filename: "Show.S01E01.mkv" };
    } },
  });
  queue.setResolver(async ({ tried }) => {
    const next = [first, second].find((stream) => !tried.includes(torrentKey(stream)));
    return next ? { stream: next, settings: defaultDownloadSettings() } : undefined;
  });
  try {
    await queue.addPending("Show", { type: "series", videoId: "tt1" }, { kind: "episode", title: "Show", season: 1, episode: 1 });
    await waitFor(queue, () => queue.list()[0]?.status === "failed", 30_000);
    assert.equal(queue.list()[0].errorKey, "err.noMatchingSource");
    assert.deepEqual(handed, [first.infoHash, second.infoHash], "each torrent is tried once, then the job gives up");
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the Real-Debrid timeout counts from debridStartedAt rather than createdAt", async () => {
  const payload = Buffer.alloc(8 * 1024, 5);
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(payload.length), "content-type": "video/mp4" });
    res.end(payload);
  });
  const longAgo = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
  const waiting = (debridStartedAt?: string) => [{
    id: "rd-timeout", title: "Film", status: "waiting", target: "Film/Film.mkv", received: 0, speed: 0,
    stream: { infoHash: HASH, fileIdx: 0 }, media: { kind: "movie", title: "Film" },
    debrid: {}, createdAt: longAgo, updatedAt: longAgo, ...(debridStartedAt ? { debridStartedAt } : {}),
  }];
  const boot = async (seeded: unknown[]) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
    const downloads = path.join(directory, "downloads");
    const data = path.join(directory, "data");
    await mkdir(data, { recursive: true });
    await writeFile(path.join(data, "downloads.json"), JSON.stringify(seeded));
    const queue = new DownloadQueue(() => 1, () => 1, data, downloads, {
      libraries: () => [downloadLibrary(downloads)], defaultLibrary: () => downloadLibrary(downloads),
      debridPollMs: 20, debridTimeoutMs: 3_600_000,
      debrid: { configured: () => true, advance: async () => ({ ready: true, torrentId: "rd1", url: `http://127.0.0.1:${port}/movie.mp4`, filename: "Film.mkv" }) },
    });
    await queue.load();
    return { directory, queue, downloads };
  };
  try {
    const fresh = await boot(waiting(new Date().toISOString()));
    try {
      await waitFor(fresh.queue, () => fresh.queue.list()[0]?.status === "completed", 30_000);
      assert.equal(fresh.queue.list()[0].status, "completed", "a recent debridStartedAt keeps a job whose createdAt is old");
      assert.equal((await stat(path.join(fresh.downloads, "Film", "Film.mkv"))).size, payload.length);
    } finally {
      await fresh.queue.stop();
      await rm(fresh.directory, { recursive: true, force: true });
    }
    const stale = await boot(waiting());
    try {
      await waitFor(stale.queue, () => stale.queue.list()[0]?.status === "failed", 30_000);
      assert.equal(stale.queue.list()[0].errorKey, "err.debridTimeout", "without debridStartedAt the old createdAt times it out");
    } finally {
      await stale.queue.stop();
      await rm(stale.directory, { recursive: true, force: true });
    }
  } finally {
    server.close();
  }
});

test("a manual torrent job still fails when Real-Debrid refuses it", async () => {
  const { directory, queue } = await tempQueue({
    debridPollMs: 20,
    debrid: { configured: () => true, advance: async () => { throw new Error("Real-Debrid refused this torrent."); } },
  });
  try {
    await queue.add("Film", { infoHash: HASH, fileIdx: 0 });
    await waitFor(queue, () => queue.list()[0]?.status === "failed", 30_000);
    const job = queue.list()[0];
    assert.equal(job.status, "failed");
    assert.match(job.error ?? "", /refused/);
    assert.equal(queue.list().length, 1, "a manual torrent is not turned back into a pending lazy job");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a season pack file that names another episode is rejected", async () => {
  const payload = Buffer.alloc(4 * 1024, 4);
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(payload.length), "content-type": "video/mp4" });
    res.end(payload);
  });
  const first = { infoHash: HASH, fileIdx: 3, title: "Show CZ" };
  const second = { infoHash: "2222222222222222222222222222222222222222", fileIdx: 4, title: "Show CZ" };
  const filenames = ["Show.S01E05.mkv", "Show.S01E02.mkv"];
  let calls = 0;
  const { directory, queue, downloads } = await tempQueue({
    debridPollMs: 20,
    debrid: {
      configured: () => true,
      advance: async () => {
        const filename = filenames[calls];
        calls += 1;
        return { ready: true, torrentId: "rd1", url: `http://127.0.0.1:${port}/show.mp4`, filename };
      },
    },
  });
  queue.setResolver(async ({ tried }) => {
    const next = [first, second].find((stream) => !tried.includes(torrentKey(stream)));
    return next ? { stream: next, settings: defaultDownloadSettings() } : undefined;
  });
  try {
    await queue.addPending("Show", { type: "series", videoId: "tt1:1:2" }, { kind: "episode", title: "Show", season: 1, episode: 2 });
    await waitFor(queue, () => queue.list()[0]?.status === "completed", 30_000);
    const job = queue.list()[0];
    assert.equal(calls, 2, "the wrong episode is rejected before its link is downloaded");
    assert.equal((await stat(queuedFile(downloads, job.target))).size, payload.length);
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a lazy torrent job that is waiting resumes polling after a restart", async () => {
  const payload = Buffer.alloc(8 * 1024, 9);
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(payload.length), "content-type": "video/mp4" });
    res.end(payload);
  });
  let ready = false;
  let directory = "";
  let downloads = "";
  const boot = async () => {
    const queue = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloads, {
      libraries: () => [downloadLibrary(downloads)], defaultLibrary: () => downloadLibrary(downloads),
      debridPollMs: 20,
      debrid: {
        configured: () => true,
        advance: async () => ready
          ? { ready: true, torrentId: "rd1", url: `http://127.0.0.1:${port}/show.mp4`, filename: "Show.S01E01.mkv" }
          : { ready: false, torrentId: "rd1", progress: 5, status: "downloading" },
      },
    });
    await queue.load();
    return queue;
  };
  try {
    directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
    downloads = path.join(directory, "downloads");
    const first = await boot();
    first.setResolver(async () => ({ stream: { infoHash: HASH, fileIdx: 0, title: "Show CZ" }, settings: defaultDownloadSettings() }));
    await first.addPending("Show", { type: "series", videoId: "tt1:1:1" }, { kind: "episode", title: "Show", season: 1, episode: 1 });
    await waitFor(first, () => first.list()[0]?.status === "waiting", 30_000);
    await first.stop();
    const reopened = await boot();
    try {
      await waitFor(reopened, () => reopened.list()[0]?.status === "waiting", 5_000);
      ready = true;
      await waitFor(reopened, () => reopened.list()[0]?.status === "completed", 30_000);
      const job = reopened.list()[0];
      assert.equal(job.status, "completed");
      assert.equal((await stat(queuedFile(downloads, job.target))).size, payload.length);
    } finally {
      await reopened.stop();
    }
  } finally {
    server.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

test("a file already on disk pushes a job of the same title to (2)", async () => {
  const { directory, queue, downloads } = await tempQueue();
  try {
    // Only the disk holds the name: nothing in the queue does, so the collision is with the file.
    const taken = queuedFile(downloads, `${LIBRARY_ID}/Disk Film/Disk Film.mkv`);
    await mkdir(path.dirname(taken), { recursive: true });
    await writeFile(taken, "");
    const job = await queue.add("Disk Film", { url: "http://127.0.0.1:1/disk-film.mkv" });
    await queue.pause(job.id);
    assert.equal(job.target, `${LIBRARY_ID}/Disk Film/Disk Film (2).mkv`);
    assert.ok(path.basename(queuedFile(downloads, job.target)).includes("(2)"), "the copy carries the suffix");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a .part on disk takes the name so the next job gets (2)", async () => {
  const { directory, queue, downloads } = await tempQueue();
  try {
    // An interrupted transfer leaves only the partial behind, and that is enough to keep the name.
    const partial = queuedFile(downloads, `${LIBRARY_ID}/Part Film/Part Film.mkv`);
    await mkdir(path.dirname(partial), { recursive: true });
    await writeFile(`${partial}.part`, "");
    const job = await queue.add("Part Film", { url: "http://127.0.0.1:1/part-film.mkv" });
    await queue.pause(job.id);
    assert.equal(job.target, `${LIBRARY_ID}/Part Film/Part Film (2).mkv`);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a job already queued takes the name so the next one gets (2)", async () => {
  const { directory, queue } = await tempQueue();
  try {
    const first = await queue.add("Film", { url: "http://127.0.0.1:1/first.mkv" });
    await queue.pause(first.id);
    const second = await queue.add("Film", { url: "http://127.0.0.1:1/second.mkv" });
    await queue.pause(second.id);
    assert.equal(first.target, `${LIBRARY_ID}/Film/Film.mkv`);
    assert.equal(second.target, `${LIBRARY_ID}/Film/Film (2).mkv`);
    assert.notEqual(first.target, second.target);
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a download whose name was taken while it ran is published under (2)", async () => {
  const size = 64 * 1024;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { server, port } = await listen(async (_req, res) => {
    res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
    res.write(Buffer.alloc(size / 2, 7));
    await gate;
    res.end(Buffer.alloc(size / 2, 9));
  });
  const { directory, queue, downloads } = await tempQueue();
  try {
    const job = await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mkv` });
    const taken = queuedFile(downloads, job.target);
    // While the transfer runs only the .part exists, so the name looks free to a move that
    // lands a file of its own there.
    await waitFor(queue, () => existsSync(`${taken}.part`), 10_000);
    const other = Buffer.from("a different film moved in meanwhile");
    await writeFile(taken, other);
    release();
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed");
    const done = queue.list()[0];
    assert.equal(done.status, "completed", done.error ?? "");
    assert.equal(done.target, `${LIBRARY_ID}/Film/Film (2).mkv`, "the name that was taken sends it to the next one");
    assert.deepEqual(await readFile(taken), other, "the file that took the name keeps its own bytes");
    assert.equal((await stat(queuedFile(downloads, done.target))).size, size, "and the download lands beside it");
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the empty placeholder a crash left at the name is taken back, not skipped", async () => {
  const size = 64 * 1024;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { server, port } = await listen(async (_req, res) => {
    res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
    res.write(Buffer.alloc(size / 2, 7));
    await gate;
    res.end(Buffer.alloc(size / 2, 9));
  });
  const { directory, queue, downloads } = await tempQueue();
  try {
    const job = await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mkv` });
    const target = queuedFile(downloads, job.target);
    await waitFor(queue, () => existsSync(`${target}.part`), 10_000);
    // What a stop between the reservation and the rename leaves behind.
    await writeFile(target, "");
    release();
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed");
    const done = queue.list()[0];
    assert.equal(done.status, "completed", done.error ?? "");
    assert.equal(done.target, `${LIBRARY_ID}/Film/Film.mkv`, "the download keeps its own name");
    assert.equal((await stat(target)).size, size);
    assert.deepEqual(await readdir(path.dirname(target)), ["Film.mkv"], "no empty file is left beside a (2)");
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a normal download keeps its own name and leaves no placeholder behind", async () => {
  const size = 8192;
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
    res.end(Buffer.alloc(size, 4));
  });
  const { directory, queue, downloads } = await tempQueue();
  try {
    const job = await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mkv` });
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed");
    assert.equal(queue.list()[0].status, "completed", queue.list()[0].error ?? "");
    assert.equal(queue.list()[0].target, `${LIBRARY_ID}/Film/Film.mkv`, "nothing took the name, so it keeps it");
    const target = queuedFile(downloads, job.target);
    assert.equal((await stat(target)).size, size);
    assert.deepEqual(await readdir(path.dirname(target)), ["Film.mkv"], "no placeholder and no .part are left");
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed final rename leaves no empty placeholder at the target", async () => {
  const { directory, queue, downloads } = await tempQueue({ segments: () => 2, retryDelay: () => 20 });
  // The file the commit would publish is gone the moment the last byte lands: every write is
  // already done and the open handle keeps the unlinked file, but the rename has nothing to
  // move. Deleting it there is deterministic, unlike racing the commit from outside the queue.
  queue.onProgress = (progress) => {
    if (!progress.target || !progress.total || progress.received < progress.total) return;
    try { unlinkSync(`${queuedFile(downloads, progress.target)}.part`); } catch { /* already gone */ }
  };
  const { server, port } = await rangeServer({ total: 32 * MB });
  try {
    const job = await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mkv` });
    const target = queuedFile(downloads, job.target);
    await waitFor(queue, () => queue.list()[0].status === "failed", 60_000);
    await assert.rejects(stat(target), "the empty placeholder must not be left at the target");
    await assert.rejects(stat(`${target}.part`));
  } finally {
    await queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an added job is in downloads.json once add resolves, and so is a pending one", async () => {
  const { directory, queue } = await tempQueue();
  try {
    const direct = await queue.add("Film", { url: "http://127.0.0.1:1/film.mkv" });
    await queue.pause(direct.id);
    const pending = await queue.addPending("Show", { type: "series", videoId: "tt1:1:1" });
    await queue.pause(pending!.id);
    await queue.stop();
    const stored = JSON.parse(await readFile(path.join(directory, "data", "downloads.json"), "utf8")) as Array<Record<string, unknown> & { source?: { videoId?: string } }>;
    const directRow = stored.find((row) => row.id === direct.id)!;
    assert.ok(directRow, "the direct job is saved");
    assert.equal(directRow.target, `${LIBRARY_ID}/Film/Film.mkv`);
    assert.equal(directRow.libraryId, LIBRARY_ID);
    const pendingRow = stored.find((row) => row.id === pending!.id)!;
    assert.ok(pendingRow, "the pending job is saved");
    assert.equal(pendingRow.source?.videoId, "tt1:1:1");
    assert.equal(pendingRow.target, "");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("addPending skips the owner's own duplicate", async () => {
  const { directory, queue } = await tempQueue();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  queue.setResolver(async () => { await gate; return undefined; });
  try {
    const first = await queue.addPending("Show", { type: "series", videoId: "tt1:1:1" }, undefined, "u1");
    const second = await queue.addPending("Show", { type: "series", videoId: "tt1:1:1" }, undefined, "u1");
    assert.ok(first, "the first job is queued");
    assert.equal(second, undefined, "the same owner repeating the same source is skipped");
    assert.equal(queue.list().length, 1, "only one job is kept");
  } finally {
    release();
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("adopt writes the follow and it survives a save and a load", async () => {
  const { directory, queue } = await tempQueue();
  try {
    const job = await queue.add("Film", { url: "http://127.0.0.1:1/film.mkv" });
    await queue.pause(job.id);
    await queue.adopt(job.id, { followId: "f1", episodeKey: "1:1", intent: "f1:1:1:1" });
    await queue.stop();
    const downloads = path.join(directory, "downloads");
    const reopened = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloads, {
      libraries: () => [downloadLibrary(downloads)],
      defaultLibrary: () => downloadLibrary(downloads),
    });
    await reopened.load();
    try {
      assert.deepEqual(reopened.get(job.id)?.follow, { followId: "f1", episodeKey: "1:1", intent: "f1:1:1:1" });
    } finally {
      await reopened.stop();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a queue file that is valid JSON but not a list is copied aside", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const data = path.join(directory, "data");
  const downloads = path.join(directory, "downloads");
  await mkdir(data, { recursive: true });
  const state = path.join(data, "downloads.json");
  const original = '{"jobs":[]}';
  await writeFile(state, original);
  const library = downloadLibrary(downloads);
  const queue = new DownloadQueue(() => 1, () => 1, data, downloads, { libraries: () => [library], defaultLibrary: () => library });
  try {
    await queue.load();
    assert.deepEqual(queue.list(), [], "a state that is not a list loads as an empty queue");
    const damaged = (await readdir(data)).filter((name) => name.startsWith("downloads.json.damaged-"));
    assert.equal(damaged.length, 1);
    assert.equal(await readFile(path.join(data, damaged[0]!), "utf8"), original, "the original bytes are copied aside");
  } finally {
    await queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
