import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DownloadQueue } from "./downloads.js";
import { AppError } from "./errors.js";
import { type LibraryRecord } from "./libraries.js";
import { defaultDownloadSettings } from "./naming.js";
import { LIBRARY_ID, deferred, downloadLibrary, listen, queuedFile, send, tempQueue, waitFor } from "./downloads-test-support.js";

test("the queue refuses a destination that became another library's carve-out", async () => {
  const { directory, queue } = await tempQueue({
    ownerAllowed: () => false,
    targetAllowed: (library, relative, ownerUserId) =>
      library.id !== LIBRARY_ID || relative !== "Nested" || ownerUserId !== "hidden-owner",
  });
  try {
    await assert.rejects(
      queue.add(
        "Film",
        { url: "http://127.0.0.1:1/film.mp4" },
        undefined,
        { subfolder: "Nested", layout: "structured", libraryId: LIBRARY_ID },
        "hidden-owner",
      ),
      (error: unknown) => error instanceof AppError && error.messageKey === "err.targetFolderMissing",
    );
    const visible = await queue.add(
      "Film",
      { url: "http://127.0.0.1:1/film2.mp4" },
      undefined,
      { subfolder: "Nested", layout: "structured", libraryId: LIBRARY_ID },
      "visible-owner",
    );
    assert.equal(visible.status, "queued");
    assert.deepEqual(queue.list().map((job) => job.id), [visible.id]);
    // The naming rules put a film in a folder of its own name: a title spelled like the nested
    // library's folder lands inside it without any subfolder being asked for.
    await assert.rejects(
      queue.add(
        "Nested",
        { url: "http://127.0.0.1:1/film3.mp4" },
        undefined,
        { subfolder: "", layout: "structured", libraryId: LIBRARY_ID },
        "hidden-owner",
      ),
      (error: unknown) => error instanceof AppError && error.messageKey === "err.targetFolderMissing",
    );
    assert.deepEqual(queue.list().map((job) => job.id), [visible.id]);
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

test("a job paused for a library while its admission write is held still gets watched", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const downloadDir = path.join(directory, "downloads");
  const downloads = downloadLibrary(downloadDir);
  let hold = false;
  let entered!: () => void;
  const writing = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let asked!: () => void;
  const libraryAsked = new Promise<void>((resolve) => { asked = resolve; });
  // The interval is driven by hand, so the tick lands exactly while the admission write waits.
  t.mock.timers.enable({ apis: ["setInterval"] });
  const queue = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloadDir, {
    libraryRetryMs: 20, libraryWaitMs: 0,
    libraries: () => [downloads],
    defaultLibrary: () => downloads,
    libraryState: async (libraryId) => { if (libraryId === "lib_99999999") asked(); return undefined; },
    writeState: async (file, data) => {
      if (hold) { entered(); await released; }
      await writeFile(file, data);
    },
  });
  await queue.load();
  // Each tick of the watcher starts one wake-up that reads library state and writes the queue;
  // the test awaits that work itself rather than a number of event-loop turns.
  let wake: Promise<unknown> | undefined;
  const wakeLibraries = (queue as any).wakeLibraries.bind(queue);
  (queue as any).wakeLibraries = () => (wake = wakeLibraries());
  try {
    // A slow write already in flight holds the admission's own write -- and the job's way into
    // the list -- behind it, as on the Windows runner.
    hold = true;
    const slow = queue.clearCompleted();
    await writing;
    const adding = queue.add("Other", { url: "http://127.0.0.1:9/other.mp4" }, undefined, { subfolder: "", layout: "structured", libraryId: "lib_99999999" });
    await libraryAsked;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(queue.list().length, 0, "the job is still being admitted");
    t.mock.timers.tick(20);
    hold = false;
    release();
    await slow;
    const job = await adding;
    assert.equal(job.status, "paused");
    for (let tick = 0; tick < 5 && queue.list()[0]?.pauseReason === "library"; tick++) {
      wake = undefined;
      t.mock.timers.tick(20);
      await wake;
    }
    assert.notEqual(queue.list()[0]?.pauseReason, "library", "past the deadline the job takes the default library");
  } finally {
    t.mock.timers.reset();
    await queue.stop();
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

test("a job waits for a removed library and finishes there once it is added again", async (t) => {
  // The retry is an interval: it has to be mocked too, or it fires on real time and the ticks below drive nothing.
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const downloadDir = path.join(directory, "downloads");
  const archiveRoot = path.join(directory, "archive");
  const archive = { id: "lib_12345678", name: "Archive", type: "movie" as const, root: archiveRoot, enabled: true, order: 0, addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: true };
  // Removed, not broken: the record is gone from the list until somebody adds the folder back.
  let removed = true;
  let gateNextLookup = false;
  const gatedLookupEntered = deferred();
  const releaseGatedLookup = deferred();
  let libraryLookups = 0;
  const size = 4096;
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
    void send(res, size).then(() => res.end());
  });
  const queue = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloadDir, {
    stallInitialMs: 5_000, stallTransferMs: 5_000, libraryRetryMs: 20, libraryWaitMs: 60_000,
    libraries: () => removed ? [] : [archive],
    libraryState: async (libraryId) => {
      libraryLookups += 1;
      if (gateNextLookup) {
        gateNextLookup = false;
        gatedLookupEntered.release();
        await releaseGatedLookup.promise;
      }
      return removed ? undefined : (libraryId === archive.id ? archive : undefined);
    },
  });
  // The transfer is real I/O: on a slow disk it takes longer than any fixed number of event-loop turns, so the
  // test waits for the queue's own completion callback, which runs after the completion is persisted.
  const completedOnce = deferred();
  queue.onCompleted = async () => { completedOnce.release(); };
  await queue.load();
  try {
    const job = await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4` }, undefined, { subfolder: "", layout: "structured", libraryId: archive.id });
    assert.equal(job.status, "paused", "a removed library is waited for, not worked around");
    assert.equal(job.target, "", "and no name is chosen meanwhile");
    for (let retry = 0; retry < 4; retry += 1) {
      t.mock.timers.tick(20);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(queue.list()[0]!.status, "paused", "the patience is minutes, not ticks");

    // Adding the folder again gives the library its id back (state.departed), and the job
    // continues into it rather than into the default.
    const lookupsBeforeReturn = libraryLookups;
    removed = false;
    gateNextLookup = true;
    t.mock.timers.tick(20);
    await gatedLookupEntered.promise;
    t.mock.timers.tick(20);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(libraryLookups, lookupsBeforeReturn + 1, "a second retry tick does not overlap the first");
    releaseGatedLookup.release();
    await completedOnce.promise;
    assert.equal(queue.list()[0]?.status, "completed");
    assert.equal(queue.list()[0]!.target, "lib_12345678/Film/Film.mp4");
    assert.equal((await stat(path.join(archiveRoot, "Film", "Film.mp4"))).size, size);
    await assert.rejects(stat(path.join(downloadDir, "Film", "Film.mp4")), "nothing landed in the download directory");
  } finally {
    releaseGatedLookup.release();
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

test("the public job carries a permission pause reason unchanged", async () => {
  const { directory, queue } = await tempQueue({ ownerAllowed: () => false });
  try {
    await queue.add("Film", { url: "http://127.0.0.1:1/film.mp4" });
    await waitFor(queue, () => queue.list()[0]?.status === "paused");
    await queue.stop();
    const stored = JSON.parse(await readFile(path.join(directory, "data", "downloads.json"), "utf8")) as Array<{ pauseReason?: string }>;
    assert.equal(stored[0]?.pauseReason, "permission", "the queue stored the permission reason");
    assert.equal(queue.list()[0]?.pauseReason, stored[0]?.pauseReason, "publicJob passes the reason through unchanged");
  } finally {
    await queue.stop();
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
    stallInitialMs: 5_000, stallTransferMs: 5_000, libraryRetryMs: 20, libraryWaitMs: 500,
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

test("a type change pauses a queued incompatible job while a compatible transfer continues", async () => {
  const size = 4096;
  const filmStarted = deferred();
  const releaseFilm = deferred();
  let episodeRequests = 0;
  const { server, port } = await listen(async (req, res) => {
    res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
    if (req.url === "/film.mp4") {
      res.write(Buffer.alloc(1, 1));
      filmStarted.release();
      await releaseFilm.promise;
      res.end(Buffer.alloc(size - 1, 1));
      return;
    }
    episodeRequests += 1;
    res.end(Buffer.alloc(size, 2));
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const downloads = path.join(directory, "downloads");
  const configured = downloadLibrary(downloads);
  let type: LibraryRecord["type"] = "mixed";
  const current = () => [{ ...configured, type }];
  const queue = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloads, {
    libraries: current,
    defaultLibrary: () => current()[0],
    libraryState: async (libraryId) => current().find((library) => library.id === libraryId),
  });
  await queue.load();
  try {
    const film = await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4` }, { kind: "movie", title: "Film" });
    await filmStarted.promise;
    const episode = await queue.add("Show", { url: `http://127.0.0.1:${port}/episode.mp4` }, { kind: "episode", title: "Show", season: 1, episode: 1 });
    assert.equal(queue.get(film.id)?.status, "downloading");
    assert.equal(queue.get(episode.id)?.status, "queued");

    type = "movie";
    assert.equal(await queue.pauseIncompatibleLibraryJobs(configured.id), 1);
    assert.equal(queue.get(episode.id)?.status, "paused");
    assert.equal(queue.get(episode.id)?.pauseReason, "library");
    assert.equal(queue.get(film.id)?.status, "downloading", "the compatible transfer was not stopped");
    assert.equal(episodeRequests, 0, "the incompatible job never started transferring");

    const destination = queue.get(episode.id)!.target;
    releaseFilm.release();
    await waitFor(queue, () => queue.get(film.id)?.status === "completed");
    type = "series";
    await queue.resume(episode.id);
    assert.equal(queue.get(episode.id)?.target, destination, "resuming keeps the chosen destination");
    await waitFor(queue, () => queue.list().every((job) => job.status === "completed"));
    assert.equal(episodeRequests, 1);
    assert.equal((await stat(queuedFile(downloads, destination))).size, size);
  } finally {
    releaseFilm.release();
    await queue.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("a type change aborts an active transfer, then its restored library resumes in place", async () => {
  const size = 4096;
  const firstStarted = deferred();
  const releaseFirst = deferred();
  let requests = 0;
  const { server, port } = await listen(async (_req, res) => {
    requests += 1;
    res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
    if (requests === 1) {
      res.write(Buffer.alloc(1, 3));
      firstStarted.release();
      await releaseFirst.promise;
      res.end(Buffer.alloc(size - 1, 3));
      return;
    }
    res.end(Buffer.alloc(size, 3));
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const downloads = path.join(directory, "downloads");
  const configured = downloadLibrary(downloads);
  let type: LibraryRecord["type"] = "mixed";
  const current = () => [{ ...configured, type }];
  const queue = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloads, {
    libraries: current,
    defaultLibrary: () => current()[0],
    libraryState: async (libraryId) => current().find((library) => library.id === libraryId),
  });
  await queue.load();
  try {
    const episode = await queue.add("Show", { url: `http://127.0.0.1:${port}/episode.mp4` }, { kind: "episode", title: "Show", season: 1, episode: 1 });
    await firstStarted.promise;
    assert.equal(queue.get(episode.id)?.status, "downloading");

    type = "movie";
    assert.equal(await queue.pauseIncompatibleLibraryJobs(configured.id), 1);
    assert.equal(queue.get(episode.id)?.status, "paused");
    assert.equal(queue.get(episode.id)?.pauseReason, "library");
    assert.equal(queue.transferring(), false, "the callback waited for the aborted transfer to stop");

    const destination = queue.get(episode.id)!.target;
    type = "series";
    releaseFirst.release();
    await queue.resume(episode.id);
    await waitFor(queue, () => queue.get(episode.id)?.status === "completed");
    assert.equal(queue.get(episode.id)?.target, destination);
    assert.equal(requests, 2);
    assert.equal((await stat(queuedFile(downloads, destination))).size, size);
  } finally {
    releaseFirst.release();
    await queue.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
