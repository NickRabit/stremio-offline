import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { spawnServer, type SpawnedServer } from "./test-server.js";

interface OpsJob {
  id: string;
  status: string;
  pauseReason?: string;
  done: number;
  failed: number;
  results: Array<{ path: string; ok: boolean; to?: string; errorKey?: string }>;
}

const waitFor = async <T>(what: string, read: () => Promise<T | undefined>, timeout = 30_000): Promise<T> => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

const exists = async (file: string) => Boolean(await stat(file).catch(() => undefined));
const put = async (root: string, relative: string, contents = "video") => {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), contents);
};

let workDir: string;
let dataDir: string;
let root: string;
let pausedRoot: string;
let server: SpawnedServer;
let base = "";
let cookie = "";
let libraryId = "";
let pausedLibraryId = "";
let ownerUserId = "";

const api = (pathname: string, init: { method?: string; body?: unknown } = {}) =>
  fetch(`${base}${pathname}`, {
    method: init.method ?? "GET",
    headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

const jobs = async () => (await (await api("/api/library/ops")).json() as { jobs: OpsJob[] }).jobs;
const enqueue = async (body: Record<string, unknown>) => {
  const response = await api("/api/library/ops", { method: "POST", body });
  if (response.status !== 202) assert.fail(await response.text());
  return (await response.json() as { id: string }).id;
};
const terminal = (id: string) => waitFor(`job ${id} to finish`, async () =>
  (await jobs()).find((job) => job.id === id && job.status !== "running" && job.status !== "paused"));

const addLibrary = async (name: string, rootPath: string) => {
  const response = await api("/api/libraries", { method: "POST", body: { name, type: "movie", root: rootPath } });
  if (response.status !== 201) assert.fail(await response.text());
  return (await response.json() as { id: string }).id;
};

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "stremio-rename-ops-"));
  dataDir = path.join(workDir, "data");
  root = path.join(workDir, "Films");
  pausedRoot = path.join(workDir, "Paused");
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "state.json"), JSON.stringify({ addons: [], defaultsInstalled: true }, null, 2));
  await put(root, "Heat.mkv");
  await put(root, "Heat.en.srt", "subtitle");
  await put(pausedRoot, "Ronin.mkv");
  server = await spawnServer({
    DATA_DIR: dataDir,
    DOWNLOAD_DIR: path.join(workDir, "downloads"),
    LIBRARY_ROOTS: workDir,
    LIBRARY_AUTO_SCAN: "0",
    ADDON_AUTO_REFRESH: "0",
  });
  base = server.base;
  const setup = await api("/api/auth/setup", { method: "POST", body: { username: "renamer", password: "rename-password" } });
  if (setup.status !== 201) assert.fail(await setup.text());
  cookie = setup.headers.getSetCookie()[0]!.split(";")[0]!;
  libraryId = await addLibrary("Films", root);
  pausedLibraryId = await addLibrary("Paused", pausedRoot);
  const users = await (await api("/api/users")).json() as Array<{ id: string }>;
  ownerUserId = users[0]!.id;
});

after(async () => {
  await server?.stop();
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

test("an executed rename moves the video and its sidecar and answers the destination key", async () => {
  const source = `${libraryId}/Heat.mkv`;
  const destination = `${libraryId}/Thief.mkv`;
  const id = await enqueue({ op: "rename", items: [source], names: { [source]: "Thief.mkv" } });
  const job = await terminal(id);
  assert.equal(job.status, "completed", JSON.stringify(job));
  assert.deepEqual(job.results, [{ path: source, ok: true, to: destination }]);
  assert.equal(await exists(path.join(root, "Thief.mkv")), true);
  assert.equal(await exists(path.join(root, "Thief.en.srt")), true);
  assert.equal(await exists(path.join(root, "Heat.mkv")), false);
});

test("a target that appeared after enqueue fails that item and leaves its source alone", async () => {
  await server.stop();
  const source = `${pausedLibraryId}/Ronin.mkv`;
  await writeFile(path.join(pausedRoot, "Thief.mkv"), "occupied");
  await writeFile(path.join(dataDir, "library-ops.json"), JSON.stringify({
    version: 2,
    jobs: [{
      id: "job_rename_late_target",
      operation: { op: "rename", items: [source], names: { [source]: "Thief.mkv" }, ownerUserId },
      op: "rename",
      status: "paused",
      pauseReason: "queue",
      total: 1,
      done: 0,
      failed: 0,
      bytes: 0,
      bytesTotal: 0,
      startedAt: new Date().toISOString(),
      notifyPending: true,
      results: [],
    }],
  }, null, 2), { mode: 0o600 });
  server = await spawnServer({
    DATA_DIR: dataDir,
    DOWNLOAD_DIR: path.join(workDir, "downloads"),
    LIBRARY_ROOTS: workDir,
    LIBRARY_AUTO_SCAN: "0",
    ADDON_AUTO_REFRESH: "0",
  });
  base = server.base;
  const job = await terminal("job_rename_late_target");
  assert.equal(job.status, "failed", JSON.stringify(job));
  assert.equal(job.results[0]?.errorKey, "err.nameTaken");
  assert.equal(await readFile(path.join(pausedRoot, "Ronin.mkv"), "utf8"), "video");
  assert.equal(await readFile(path.join(pausedRoot, "Thief.mkv"), "utf8"), "occupied");
});

test("a replay after the destination exists answers it without renaming again", async () => {
  await server.stop();
  const source = `${libraryId}/Thief.mkv`;
  const destination = `${libraryId}/Final.mkv`;
  await rename(path.join(root, "Thief.mkv"), path.join(root, "Final.mkv"));
  await rename(path.join(root, "Thief.en.srt"), path.join(root, "Final.en.srt"));
  await writeFile(path.join(dataDir, "library-ops.json"), JSON.stringify({
    version: 2,
    jobs: [{
      id: "job_rename_replay",
      operation: { op: "rename", items: [source], names: { [source]: "Final.mkv" }, ownerUserId },
      op: "rename",
      status: "running",
      total: 1,
      done: 0,
      failed: 0,
      bytes: 0,
      bytesTotal: 0,
      current: source,
      step: { item: source, data: { from: source, to: destination } },
      startedAt: new Date().toISOString(),
      notifyPending: true,
      results: [],
    }],
  }, null, 2), { mode: 0o600 });
  server = await spawnServer({
    DATA_DIR: dataDir,
    DOWNLOAD_DIR: path.join(workDir, "downloads"),
    LIBRARY_ROOTS: workDir,
    LIBRARY_AUTO_SCAN: "0",
    ADDON_AUTO_REFRESH: "0",
  });
  base = server.base;
  const job = await terminal("job_rename_replay");
  assert.equal(job.status, "completed", `${JSON.stringify(job)}\n${server.log()}`);
  assert.deepEqual(job.results, [{ path: source, ok: true, to: destination }]);
  assert.equal(await readFile(path.join(root, "Final.mkv"), "utf8"), "video");
  assert.equal(await readFile(path.join(root, "Final.en.srt"), "utf8"), "subtitle");
});
