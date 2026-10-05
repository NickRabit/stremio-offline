import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnServer, type SpawnedServer } from "./test-server.js";

/** What a queued move does when the server stopped in the middle of it. The rules live in
 *  `index.ts`, so the server is booted, stopped, its data directory edited by hand the way a
 *  crash would have left it, and booted again -- which is the only way to see the resume. */

const waitFor = async <T>(what: string, read: () => Promise<T | undefined>, timeout = 30_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

const exists = async (file: string) => Boolean(await stat(file).catch(() => undefined));

const USERNAME = "recoverer";
const PASSWORD = "recover-password";
const SEASON = "Show/Season 1";
const ITEM = `${SEASON}/01 - X.mkv`;
const TARGET_NAME = "01 - X.mkv";

interface OpsJob {
  id: string; status: string; done: number; failed: number;
  results: Array<{ path: string; ok: boolean; to?: string; error?: string; errorKey?: string }>;
}

interface Env {
  workDir: string;
  dataDir: string;
  aRoot: string;
  bRoot: string;
  server?: SpawnedServer;
  base: string;
  cookie: string;
  a: string;
  b: string;
}

const api = (env: Env, pathname: string, init: { method?: string; body?: unknown } = {}) =>
  fetch(`${env.base}${pathname}`, {
    method: init.method ?? "GET",
    headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...(env.cookie ? { cookie: env.cookie } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

const spawn = async (env: Env) => {
  env.server = await spawnServer({
    DATA_DIR: env.dataDir,
    DOWNLOAD_DIR: path.join(env.workDir, "downloads"),
    LIBRARY_ROOTS: path.join(env.workDir, "roots"),
    LIBRARY_AUTO_SCAN: "0",
    ADDON_AUTO_REFRESH: "0",
  });
  env.base = env.server.base;
};

const newEnv = async (): Promise<Env> => {
  const workDir = await mkdtemp(path.join(tmpdir(), "stremio-recovery-"));
  const dataDir = path.join(workDir, "data");
  const roots = path.join(workDir, "roots");
  const env: Env = { workDir, dataDir, aRoot: path.join(roots, "A"), bRoot: path.join(roots, "B"), base: "", cookie: "", a: "", b: "" };
  await mkdir(dataDir, { recursive: true });
  // Seeded the way the e2e fixture seeds it: without this the first boot reaches for the
  // default addons, which a unit suite must not do.
  await writeFile(path.join(dataDir, "state.json"), JSON.stringify({ addons: [], defaultsInstalled: true }, null, 2));
  await mkdir(path.dirname(path.join(env.aRoot, ITEM)), { recursive: true });
  await mkdir(env.bRoot, { recursive: true });
  await writeFile(path.join(env.aRoot, ITEM), "video");
  return env;
};

const addLibrary = async (env: Env, name: string, root: string) => {
  const response = await api(env, "/api/libraries", { method: "POST", body: { name, type: "series", root } });
  assert.equal(response.status, 201, `could not create the ${name} library\n${env.server?.log()}`);
  return (await response.json() as { id: string }).id;
};

/** The first boot: create the account and the two series libraries. */
const bootFresh = async (env: Env) => {
  await spawn(env);
  const setup = await api(env, "/api/auth/setup", { method: "POST", body: { username: USERNAME, password: PASSWORD } });
  assert.equal(setup.status, 201, `could not create the account\n${env.server!.log()}`);
  env.cookie = setup.headers.getSetCookie()[0]!.split(";")[0]!;
  env.a = await addLibrary(env, "A", env.aRoot);
  env.b = await addLibrary(env, "B", env.bRoot);
};

/** A later boot on the same data directory, signing in again if the cookie stopped working. */
const bootAgain = async (env: Env) => {
  await spawn(env);
  const probe = await api(env, "/api/libraries");
  if (probe.status === 401) {
    const login = await api(env, "/api/auth/login", { method: "POST", body: { username: USERNAME, password: PASSWORD } });
    assert.equal(login.status, 200, `could not sign in again\n${env.server!.log()}`);
    env.cookie = login.headers.getSetCookie()[0]!.split(";")[0]!;
  } else {
    assert.equal(probe.status, 200, `the library list did not load\n${env.server!.log()}`);
  }
};

/** A favourite, a resume position and a manual match on the item, the way a person's own
 *  rows got there. Stopping the server flushes the match to disk. */
const seedState = async (env: Env) => {
  const from = `${env.a}/${ITEM}`;
  assert.equal((await api(env, "/api/library/favorite", { method: "POST", body: { path: from, favorite: true } })).status, 200);
  assert.equal((await api(env, "/api/progress", { method: "POST", body: { key: `file:${from}`, path: from, position: 120, duration: 3600, title: "X" } })).status, 204);
  const matched = await api(env, "/api/library/match", { method: "POST", body: { path: from, type: "series", id: "tt0000001" } });
  assert.equal(matched.status, 200, `the manual match was refused\n${env.server!.log()}`);
};

/** What the crash left in the queue: a running move job whose item carried a record. */
const writeCrashJob = async (env: Env, data: Record<string, unknown>) => {
  const item = `${env.a}/${ITEM}`;
  await writeFile(path.join(env.dataDir, "library-ops.json"), JSON.stringify({
    version: 1,
    jobs: [{
      id: "recover-1", operation: { op: "move", items: [item], target: env.b }, op: "move",
      status: "running", total: 1, done: 0, failed: 0, bytes: 0, bytesTotal: 0, current: item,
      startedAt: new Date().toISOString(), results: [], step: { item, data },
    }],
  }, null, 2));
};

const finishedJob = (env: Env) => waitFor("the recovered job to finish", async () => {
  const jobs = (await (await api(env, "/api/library/ops")).json() as { jobs: OpsJob[] }).jobs;
  const job = jobs.find((candidate) => candidate.id === "recover-1");
  return job && job.status !== "running" && job.status !== "paused" ? job : undefined;
});

const favouritePaths = async (env: Env) =>
  ((await (await api(env, "/api/library/favorites")).json()) as { items: Array<{ path: string }> }).items.map((item) => item.path);

const progressAt = async (env: Env, key: string) => (await api(env, `/api/progress/${encodeURIComponent(key)}`)).json();

const identityOf = async (env: Env, target: string) =>
  (await (await api(env, `/api/library/identity?path=${encodeURIComponent(target)}`)).json()) as { bound?: { id?: string } };

/** The favourite rows as they sit in the state file: the browse route skips a path that is
 *  not on disk, so a stored star for a gone file can only be read back here. */
const storedFavorites = async (env: Env) => {
  const state = JSON.parse(await readFile(path.join(env.dataDir, "state.json"), "utf8")) as {
    userData?: Record<string, { favorites?: string[] }>;
  };
  return Object.values(state.userData ?? {}).flatMap((data) => data.favorites ?? []);
};
/** The state a completed cross-library move has to show: everything under the new path. */
const assertMovedState = async (env: Env) => {
  const from = `${env.a}/${ITEM}`;
  const to = `${env.b}/${TARGET_NAME}`;
  const stars = await favouritePaths(env);
  assert.ok(stars.includes(to), "the star follows the item");
  assert.ok(!stars.includes(from), "the old path is not a favourite any more");
  assert.notEqual(await progressAt(env, `file:${to}`), null, "the position is under the new key");
  assert.equal(await progressAt(env, `file:${from}`), null, "the old key holds nothing");
  assert.equal((await identityOf(env, to)).bound?.id, "tt0000001", "the moved item resolves to the matched title");
};

const removeItem = (env: Env) => rm(path.join(env.aRoot, ITEM), { force: true });
const moveItemToTarget = (env: Env) => rename(path.join(env.aRoot, ITEM), path.join(env.bRoot, TARGET_NAME));

const withEnv = async (run: (env: Env) => Promise<void>) => {
  const env = await newEnv();
  try { await run(env); }
  finally {
    await env.server?.stop();
    await rm(env.workDir, { recursive: true, force: true });
  }
};

test("a published record finishes a move whose bytes already reached the target", async () => {
  await withEnv(async (env) => {
    await bootFresh(env);
    await seedState(env);
    await env.server!.stop();
    await moveItemToTarget(env);
    await writeCrashJob(env, {
      phase: "published", copy: false, from: `${env.a}/${ITEM}`, to: `${env.b}/${TARGET_NAME}`,
      carried: [`${env.a}/${ITEM}`], cover: `${env.a}/Show`,
    });
    await bootAgain(env);
    const job = await finishedJob(env);
    assert.equal(job.status, "completed");
    assert.equal(job.done, 1);
    assert.equal(job.results[0]?.ok, true, JSON.stringify(job.results));
    assert.equal(await exists(path.join(env.bRoot, TARGET_NAME)), true, "the file stays at the target");
    assert.equal(await exists(path.join(env.aRoot, ITEM)), false, "the source stays gone");
    await assertMovedState(env);
  });
});

test("a moving record whose source is gone and target exists is finished", async () => {
  await withEnv(async (env) => {
    await bootFresh(env);
    await seedState(env);
    await env.server!.stop();
    await moveItemToTarget(env);
    await writeCrashJob(env, {
      phase: "moving", copy: false, from: `${env.a}/${ITEM}`, to: `${env.b}/${TARGET_NAME}`,
      carried: [`${env.a}/${ITEM}`], cover: `${env.a}/Show`,
    });
    await bootAgain(env);
    const job = await finishedJob(env);
    assert.equal(job.status, "completed");
    assert.equal(job.done, 1);
    assert.equal(job.results[0]?.ok, true, JSON.stringify(job.results));
    assert.equal(await exists(path.join(env.bRoot, TARGET_NAME)), true, "the file is at the target");
    await assertMovedState(env);
  });
});

test("a moving record that never landed runs the move from the start", async () => {
  await withEnv(async (env) => {
    await bootFresh(env);
    await seedState(env);
    await env.server!.stop();
    await writeCrashJob(env, {
      phase: "moving", copy: false, from: `${env.a}/${ITEM}`, to: `${env.b}/${TARGET_NAME}`,
      carried: [`${env.a}/${ITEM}`], cover: `${env.a}/Show`,
    });
    await bootAgain(env);
    const job = await finishedJob(env);
    assert.equal(job.status, "completed");
    assert.equal(job.done, 1);
    assert.equal(job.results[0]?.ok, true, JSON.stringify(job.results));
    assert.equal(job.results[0]?.to, `${env.b}/${TARGET_NAME}`);
    assert.equal(await exists(path.join(env.bRoot, TARGET_NAME)), true, "the file moved to the target");
    assert.equal(await exists(path.join(env.aRoot, ITEM)), false, "the file left the source");
    await assertMovedState(env);
  });
});

test("a moving record with the bytes at both ends leaves both files and finishes", async () => {
  await withEnv(async (env) => {
    await bootFresh(env);
    await seedState(env);
    await env.server!.stop();
    // A copy landed; the source was not removed before the crash.
    await copyFile(path.join(env.aRoot, ITEM), path.join(env.bRoot, TARGET_NAME));
    await writeCrashJob(env, {
      phase: "moving", copy: false, from: `${env.a}/${ITEM}`, to: `${env.b}/${TARGET_NAME}`,
      carried: [`${env.a}/${ITEM}`], cover: `${env.a}/Show`,
    });
    await bootAgain(env);
    const job = await finishedJob(env);
    assert.equal(job.status, "completed");
    assert.equal(job.done, 1);
    assert.equal(job.results[0]?.ok, true, JSON.stringify(job.results));
    assert.equal(await exists(path.join(env.aRoot, ITEM)), true, "the interrupted move deletes nothing");
    assert.equal(await exists(path.join(env.bRoot, TARGET_NAME)), true, "the target is still there");
    await assertMovedState(env);
  });
});

test("a moving record with the bytes at neither end fails and leaves the old path alone", async () => {
  await withEnv(async (env) => {
    await bootFresh(env);
    await seedState(env);
    const from = `${env.a}/${ITEM}`;
    await env.server!.stop();
    await removeItem(env);
    await writeCrashJob(env, {
      phase: "moving", copy: false, from, to: `${env.b}/${TARGET_NAME}`,
      carried: [from], cover: `${env.a}/Show`,
    });
    await bootAgain(env);
    const job = await finishedJob(env);
    assert.equal(job.status, "failed");
    assert.equal(job.failed, 1);
    assert.equal(job.results[0]?.errorKey, "err.pathMissing");
    const stars = await storedFavorites(env);
    assert.ok(stars.includes(from), "the favourite still names the old path");
    assert.ok(!stars.includes(`${env.b}/${TARGET_NAME}`), "nothing was written for the new path");
  });
});

test("a first move over a stale row at the target still carries the item's own match", async () => {
  await withEnv(async (env) => {
    await bootFresh(env);
    // A folder of the same name was matched in B and then deleted outside the app, so B
    // still remembers a binding for a path nothing holds.
    const stale = path.join(env.bRoot, "Show", "Season 1", "old.mkv");
    await mkdir(path.dirname(stale), { recursive: true });
    await writeFile(stale, "video");
    const staleMatch = await api(env, "/api/library/match", { method: "POST", body: { path: `${env.b}/Show/Season 1/old.mkv`, type: "series", id: "tt0000009" } });
    assert.equal(staleMatch.status, 200, `the stale match was refused\n${env.server!.log()}`);
    await rm(path.join(env.bRoot, "Show"), { recursive: true, force: true });
    await seedState(env);

    const queued = await api(env, "/api/library/ops", { method: "POST", body: { op: "move", items: [`${env.a}/Show`], target: env.b } });
    assert.equal(queued.status, 202);
    const { id } = await queued.json() as { id: string };
    const job = await waitFor("the move to finish", async () => {
      const jobs = (await (await api(env, "/api/library/ops")).json() as { jobs: OpsJob[] }).jobs;
      const found = jobs.find((candidate) => candidate.id === id);
      return found && found.status !== "running" && found.status !== "paused" ? found : undefined;
    });
    assert.equal(job.done, 1, JSON.stringify(job.results));
    assert.equal((await identityOf(env, `${env.b}/${ITEM}`)).bound?.id, "tt0000001", "the arriving folder's own match replaces the stale one");
  });
});
