import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

/** The move rules have no unit seam: the route, `assertMoveType`, `transferLibraryItem`
 *  and `parseLibraryOp` all live in `index.ts`, which starts the app the way the
 *  container runs it. So the server is booted here, on a throwaway data directory, and
 *  driven over HTTP -- which is also how the interface reaches these rules. */
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const freePort = () => new Promise<number>((resolve, reject) => {
  const probe = createServer();
  probe.on("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    const port = typeof address === "object" && address ? address.port : 0;
    probe.close(() => (port ? resolve(port) : reject(new Error("No free port"))));
  });
});

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

const season = "Show/Season 1";
const put = async (root: string, relative: string) => {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), "video");
};

interface OpsJob {
  id: string; status: string; done: number; failed: number;
  results: Array<{ path: string; ok: boolean; to?: string; error?: string; errorKey?: string }>;
}

let workDir: string;
let dataDir: string;
let filmsRoot: string;
let showsRoot: string;
let archiveRoot: string;
let nestedRoot: string;
let boxRoot: string;
let aliasRoot: string;
let mixedRoot: string;
let child: ChildProcess;
let log = "";
let base = "";
let cookie = "";
let films = "";
let shows = "";
let archive = "";
let nested = "";
let box = "";
let aliased = "";
let mixed = "";

const api = (pathname: string, init: { method?: string; body?: unknown } = {}) =>
  fetch(`${base}${pathname}`, {
    method: init.method ?? "GET",
    headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

const move = (body: Record<string, unknown>) => api("/api/library/move", { method: "POST", body });

const addLibrary = async (name: string, type: string, root: string) => {
  const response = await api("/api/libraries", { method: "POST", body: { name, type, root } });
  assert.equal(response.status, 201, `could not create the ${name} library`);
  return (await response.json() as { id: string }).id;
};

const enqueue = async (operation: Record<string, unknown>) => {
  const response = await api("/api/library/ops", { method: "POST", body: operation });
  assert.equal(response.status, 202);
  const { id } = await response.json() as { id: string };
  return waitFor(`job ${id} to finish`, async () => {
    const jobs = (await (await api("/api/library/ops")).json() as { jobs: OpsJob[] }).jobs;
    const job = jobs.find((candidate) => candidate.id === id);
    return job && job.status !== "running" && job.status !== "paused" ? job : undefined;
  });
};

/** The stored operation, as the queue would read it back after a restart. */
const storedOperation = (id: string) => waitFor(`job ${id} in the saved queue`, async () => {
  const saved = JSON.parse(await readFile(path.join(dataDir, "library-ops.json"), "utf8")) as {
    jobs: Array<{ id: string; operation: Record<string, unknown> }>;
  };
  return saved.jobs.find((job) => job.id === id)?.operation;
});

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "stremio-move-"));
  dataDir = path.join(workDir, "data");
  const granted = path.join(workDir, "roots");
  filmsRoot = path.join(granted, "Filmy");
  showsRoot = path.join(granted, "Serie");
  archiveRoot = path.join(granted, "Archiv");
  // A second library rooted two levels inside `Archiv`, so the folder `Archiv` holds it.
  nestedRoot = path.join(archiveRoot, "Archiv", "Serialy");
  // A library whose only child is rooted at a symlink into its tree. The configured spelling
  // reads as a folder beside `Box`, and only the folder it points at is inside it.
  boxRoot = path.join(granted, "Box");
  aliasRoot = path.join(granted, "Alias");
  mixedRoot = path.join(granted, "Smisene");
  await mkdir(dataDir, { recursive: true });
  // Seeded the way the e2e fixture seeds it: without this the first boot reaches for
  // the default addons, which a unit suite must not do.
  await writeFile(path.join(dataDir, "state.json"), JSON.stringify({ addons: [], defaultsInstalled: true }, null, 2));

  // A folder holding a season is a series; a video at the root of a mixed library is a
  // film. The typed libraries decide their own kind, the mixed one reads the structure.
  await put(showsRoot, `${season}/01 - Refused.mkv`);
  await put(showsRoot, `${season}/02 - Confirmed.mkv`);
  await put(showsRoot, `${season}/03 - Agreeing.mkv`);
  await put(showsRoot, `${season}/04 - Agreeing confirmed.mkv`);
  await put(showsRoot, `${season}/05 - Mixed.mkv`);
  await put(showsRoot, `${season}/06 - Mixed confirmed.mkv`);
  await put(showsRoot, `${season}/07 - Queued.mkv`);
  await put(showsRoot, `${season}/08 - Queued confirmed.mkv`);
  await put(showsRoot, `${season}/09 - Copied.mkv`);
  await put(showsRoot, `${season}/10 - Copied confirmed.mkv`);
  await put(archiveRoot, "Second Show/Season 1/01 - Pilot.mkv");
  await put(nestedRoot, "Season 1/01 - Nested.mkv");
  await put(boxRoot, "Archiv/Aliased/Season 1/01 - Aliased.mkv");
  await symlink(path.join(boxRoot, "Archiv", "Aliased"), aliasRoot);
  await put(filmsRoot, "Volne/Film.mkv");
  await put(mixedRoot, "Document.mkv");
  await mkdir(filmsRoot, { recursive: true });

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", "tsx", path.join(serverDir, "src", "index.ts")], {
    cwd: serverDir,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      DOWNLOAD_DIR: path.join(workDir, "downloads"),
      LIBRARY_ROOTS: granted,
      LIBRARY_AUTO_SCAN: "0",
      ADDON_AUTO_REFRESH: "0",
      LOG_LEVEL: "WARN",
    },
  });
  child.stderr?.on("data", (chunk) => { log += String(chunk); });
  await waitFor("the server to answer", async () => {
    if (child.exitCode !== null) throw new Error(`the server exited with ${child.exitCode}\n${log}`);
    return (await fetch(`${base}/api/status`)).ok ? true : undefined;
  });

  // A fresh data directory has no account, and the interface is the only way in.
  const setup = await api("/api/auth/setup", { method: "POST", body: { username: "mover", password: "move-password" } });
  assert.equal(setup.status, 201, `could not create the account\n${log}`);
  cookie = setup.headers.getSetCookie()[0]!.split(";")[0]!;
  films = await addLibrary("Filmy", "movie", filmsRoot);
  shows = await addLibrary("Serie", "series", showsRoot);
  archive = await addLibrary("Archiv", "series", archiveRoot);
  nested = await addLibrary("Serialy", "series", nestedRoot);
  box = await addLibrary("Box", "mixed", boxRoot);
  aliased = await addLibrary("Aliased", "mixed", aliasRoot);
  mixed = await addLibrary("Smisene", "mixed", mixedRoot);
});

after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

test("a move of another kind is refused, and carries the two kinds back", async () => {
  const item = `${season}/01 - Refused.mkv`;
  const response = await move({ path: `${shows}/${item}`, folder: films });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "A movie library does not take series.",
    messageKey: "err.libraryTypeMismatch",
    vars: { type: "movie", kind: "series" },
  });
  assert.equal(await exists(path.join(filmsRoot, "01 - Refused.mkv")), false, "nothing was written");
  assert.equal(await exists(path.join(showsRoot, item)), true, "nothing left the source library");
});

test("an error without variables answers exactly as it did before", async () => {
  const response = await move({ path: "nikde/nic.mkv", folder: films });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid path.", messageKey: "err.invalidPath" });
});

test("the same move goes through when the request confirms it", async () => {
  const item = `${season}/02 - Confirmed.mkv`;
  const response = await move({ path: `${shows}/${item}`, folder: films, confirmTypeMismatch: true });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { path: `${films}/02 - Confirmed.mkv` });
  assert.equal(await exists(path.join(filmsRoot, "02 - Confirmed.mkv")), true);
  assert.equal(await exists(path.join(showsRoot, item)), false);
});

test("a mixed destination, and a library of the same kind, ignore the flag either way", async () => {
  const agreeing = `${season}/03 - Agreeing.mkv`;
  const agreeingConfirmed = `${season}/04 - Agreeing confirmed.mkv`;
  const loose = `${season}/05 - Mixed.mkv`;
  const looseConfirmed = `${season}/06 - Mixed confirmed.mkv`;
  const outcomes = [
    await move({ path: `${shows}/${agreeing}`, folder: archive }),
    await move({ path: `${shows}/${agreeingConfirmed}`, folder: archive, confirmTypeMismatch: true }),
    await move({ path: `${shows}/${loose}`, folder: mixed }),
    await move({ path: `${shows}/${looseConfirmed}`, folder: mixed, confirmTypeMismatch: true }),
  ];
  assert.deepEqual(outcomes.map((response) => response.status), [200, 200, 200, 200]);
  for (const name of ["03 - Agreeing.mkv", "04 - Agreeing confirmed.mkv"]) {
    assert.equal(await exists(path.join(archiveRoot, name)), true);
  }
  for (const name of ["05 - Mixed.mkv", "06 - Mixed confirmed.mkv"]) {
    assert.equal(await exists(path.join(mixedRoot, name)), true);
  }
});

test("a queued move keeps the confirmation on the operation, and one refused item does not stop the job", async () => {
  const item = `${season}/07 - Queued.mkv`;
  const confirmed = await enqueue({ op: "move", items: [`${shows}/${item}`], target: films, confirmTypeMismatch: true });
  assert.equal(confirmed.status, "completed");
  assert.equal(confirmed.done, 1);
  assert.equal(await exists(path.join(filmsRoot, "07 - Queued.mkv")), true);
  const operation = await storedOperation(confirmed.id);
  assert.equal(operation?.confirmTypeMismatch, true, "a restart reads the confirmation back");

  const refused = `${season}/08 - Queued confirmed.mkv`;
  const job = await enqueue({ op: "move", items: [`${shows}/${refused}`, `${mixed}/Document.mkv`], target: films });
  assert.equal(job.status, "completed", "the job finished rather than failing whole");
  assert.equal(job.failed, 1);
  assert.equal(job.done, 1, "the item behind the refused one still moved");
  assert.equal(job.results[0]?.errorKey, "err.libraryTypeMismatch");
  assert.equal(await exists(path.join(filmsRoot, "08 - Queued confirmed.mkv")), false);
  assert.equal(await exists(path.join(showsRoot, refused)), true);
  assert.equal(await exists(path.join(filmsRoot, "Document.mkv")), true);
  const plain = await storedOperation(job.id);
  assert.equal("confirmTypeMismatch" in (plain ?? {}), false, "nothing infers the flag");
});

test("a queued copy takes the same confirmation", async () => {
  const item = `${season}/09 - Copied.mkv`;
  const refused = await enqueue({ op: "copy", items: [`${shows}/${item}`], target: films });
  assert.equal(refused.failed, 1);
  assert.equal(refused.results[0]?.errorKey, "err.libraryTypeMismatch");
  assert.equal(await exists(path.join(filmsRoot, "09 - Copied.mkv")), false);

  const copy = `${season}/10 - Copied confirmed.mkv`;
  const confirmed = await enqueue({ op: "copy", items: [`${shows}/${copy}`], target: films, confirmTypeMismatch: true });
  assert.equal(confirmed.done, 1);
  assert.equal(await exists(path.join(filmsRoot, "10 - Copied confirmed.mkv")), true);
  assert.equal(await exists(path.join(showsRoot, copy)), true, "a copy leaves the original where it was");
});

const nestedFile = () => path.join(nestedRoot, "Season 1", "01 - Nested.mkv");
/** The folder inside the `Archiv` library that holds the nested library's root. */
const holding = () => `${archive}/Archiv`;

test("a carve-out one level down stays hidden and its own library stays usable", async () => {
  const parent = await api(`/api/library/browse?path=${encodeURIComponent(holding())}`);
  assert.equal(parent.status, 200);
  const listed = (await parent.json() as { items: Array<{ path: string }> }).items.map((item) => item.path);
  assert.equal(listed.includes(`${holding()}/Serialy`), false, "the carve-out row stays hidden");

  const own = await api(`/api/library/browse?path=${encodeURIComponent(nested)}`);
  assert.equal(own.status, 200);
  const ownListed = (await own.json() as { items: Array<{ path: string }> }).items.map((item) => item.path);
  assert.ok(ownListed.length > 0, "the nested library still lists its own season");
});

test("a delete that would take another library with it is refused, and nothing is removed", async () => {
  const response = await api(`/api/library/item?path=${encodeURIComponent(holding())}`, { method: "DELETE" });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "This folder holds another library. Move that library out first.",
    messageKey: "err.libraryHoldsAnother",
  });
  assert.equal(await exists(path.join(archiveRoot, "Archiv")), true, "the folder is still there");
  assert.equal(await exists(nestedFile()), true, "the nested library's file is still there");
});

test("a move and a copy of a folder holding another library are refused", async () => {
  const moved = await move({ path: holding(), folder: films });
  assert.equal(moved.status, 409);
  assert.deepEqual(await moved.json(), {
    error: "This folder holds another library. Move that library out first.",
    messageKey: "err.libraryHoldsAnother",
  });

  const copied = await move({ path: holding(), folder: films, copy: true });
  assert.equal(copied.status, 409);
  assert.equal((await copied.json() as { messageKey: string }).messageKey, "err.libraryHoldsAnother");

  assert.equal(await exists(path.join(filmsRoot, "Archiv")), false, "nothing was written to the destination");
  assert.equal(await exists(path.join(archiveRoot, "Archiv")), true, "the folder did not leave the source");
  assert.equal(await exists(nestedFile()), true, "the nested library's file is still there");
});

test("a queued move and a queued copy are refused the same way", async () => {
  for (const op of ["move", "copy"] as const) {
    const job = await enqueue({ op, items: [holding()], target: films });
    assert.equal(job.failed, 1);
    assert.equal(job.results[0]?.errorKey, "err.libraryHoldsAnother");
  }
  assert.equal(await exists(nestedFile()), true, "the nested library's file is still there");
});

test("a rename of a folder holding another library is refused", async () => {
  const response = await api("/api/library/rename", { method: "POST", body: { path: holding(), name: "Archiv jiny" } });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "This folder holds another library. Move that library out first.",
    messageKey: "err.libraryHoldsAnother",
  });
  assert.equal(await exists(path.join(archiveRoot, "Archiv jiny")), false, "nothing was renamed");
  assert.equal(await exists(nestedFile()), true, "the nested library's file is still there");
});

test("a folder with no library inside it still renames, moves and deletes", async () => {
  const renamed = await api("/api/library/rename", { method: "POST", body: { path: `${films}/Volne`, name: "Volne2" } });
  assert.equal(renamed.status, 200);
  assert.equal(await exists(path.join(filmsRoot, "Volne2", "Film.mkv")), true);

  const moved = await move({ path: `${films}/Volne2`, folder: mixed });
  assert.equal(moved.status, 200);
  assert.deepEqual(await moved.json(), { path: `${mixed}/Volne2` });
  assert.equal(await exists(path.join(mixedRoot, "Volne2", "Film.mkv")), true);

  const deleted = await api(`/api/library/item?path=${encodeURIComponent(`${mixed}/Volne2`)}`, { method: "DELETE" });
  assert.equal(deleted.status, 204);
  assert.equal(await exists(path.join(mixedRoot, "Volne2")), false);
});

/** The folder of the box library that holds the library rooted at the symlink. */
const boxHolding = () => `${box}/Archiv`;
/** The aliased library's own file, reached through the folder it really sits in. */
const aliasedFile = () => path.join(boxRoot, "Archiv", "Aliased", "Season 1", "01 - Aliased.mkv");

test("a child rooted at a symlink into the parent's tree is seen as nested", async () => {
  const parent = await api(`/api/library/browse?path=${encodeURIComponent(boxHolding())}`);
  assert.equal(parent.status, 200);
  const listed = (await parent.json() as { items: Array<{ path: string }> }).items.map((item) => item.path);
  assert.equal(listed.includes(`${boxHolding()}/Aliased`), false, "the folder the alias points at stays hidden");

  // The library rooted at the symlink still reads its own folder, which is the one the parent
  // hides: the alias does not cost it its content.
  const own = await api(`/api/library/browse?path=${encodeURIComponent(aliased)}`);
  assert.equal(own.status, 200);
  const ownListed = (await own.json() as { items: Array<{ path: string }> }).items;
  assert.ok(ownListed.length > 0, "the aliased library lists the season behind the symlink");
});

test("a delete, a move and a rename of the folder holding the aliased library are refused", async () => {
  const deleted = await api(`/api/library/item?path=${encodeURIComponent(boxHolding())}`, { method: "DELETE" });
  assert.equal(deleted.status, 409);
  assert.deepEqual(await deleted.json(), {
    error: "This folder holds another library. Move that library out first.",
    messageKey: "err.libraryHoldsAnother",
  });
  assert.equal(await exists(aliasedFile()), true, "the aliased library's file is still there");

  const moved = await move({ path: boxHolding(), folder: films });
  assert.equal(moved.status, 409);
  assert.equal((await moved.json() as { messageKey: string }).messageKey, "err.libraryHoldsAnother");
  assert.equal(await exists(aliasedFile()), true, "the aliased library's file is still there");

  const renamed = await api("/api/library/rename", { method: "POST", body: { path: boxHolding(), name: "Archiv jiny" } });
  assert.equal(renamed.status, 409);
  assert.equal((await renamed.json() as { messageKey: string }).messageKey, "err.libraryHoldsAnother");
  assert.equal(await exists(aliasedFile()), true, "the aliased library's file is still there");
  assert.equal(await exists(path.join(boxRoot, "Archiv")), true, "the folder itself stayed where it was");
});

test("a folder beside the aliased library is not part of it", async () => {
  await put(boxRoot, "Archiv/Loose/Season 1/01 - Loose.mkv");
  const deleted = await api(`/api/library/item?path=${encodeURIComponent(`${boxHolding()}/Loose`)}`, { method: "DELETE" });
  assert.equal(deleted.status, 204, "the guard engages on the nested library, not on the folder that holds it");
  assert.equal(await exists(path.join(boxRoot, "Archiv", "Loose")), false);
  assert.equal(await exists(aliasedFile()), true, "the aliased library is untouched");
});
