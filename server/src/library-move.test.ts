import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { spawnServer, type SpawnedServer } from "./test-server.js";

/** The move rules have no unit seam: the route, `assertMoveType`, `transferLibraryItem`
 *  and `parseLibraryOp` all live in `index.ts`, which starts the app the way the
 *  container runs it. So the server is booted here, on a throwaway data directory, and
 *  driven over HTTP -- which is also how the interface reaches these rules. */

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
/** Whether the alias below could be made: a symlink needs developer mode or admin on Windows. */
let aliasReady = false;
let server: SpawnedServer;
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
  try {
    await symlink(path.join(boxRoot, "Archiv", "Aliased"), aliasRoot);
    aliasReady = true;
  } catch { aliasReady = false; }
  await put(filmsRoot, "Volne/Film.mkv");
  await put(mixedRoot, "Document.mkv");
  await mkdir(filmsRoot, { recursive: true });
  // A folder of its own, so the state a move or a copy carries can be read without touching
  // a fixture another test relies on.
  await put(showsRoot, "Carried Show/Season 1/01 - Carried.mkv");
  await put(showsRoot, "Carried Show/Season 1/02 - Within.mkv");
  await put(showsRoot, "Carried Show/Season 1/03 - Copied.mkv");
  await mkdir(path.join(showsRoot, "Carried Show", "Season 2"), { recursive: true });

  server = await spawnServer({
    DATA_DIR: dataDir,
    DOWNLOAD_DIR: path.join(workDir, "downloads"),
    LIBRARY_ROOTS: granted,
    LIBRARY_AUTO_SCAN: "0",
    ADDON_AUTO_REFRESH: "0",
  });
  base = server.base;

  // A fresh data directory has no account, and the interface is the only way in.
  const setup = await api("/api/auth/setup", { method: "POST", body: { username: "mover", password: "move-password" } });
  assert.equal(setup.status, 201, `could not create the account\n${server.log()}`);
  cookie = setup.headers.getSetCookie()[0]!.split(";")[0]!;
  films = await addLibrary("Filmy", "movie", filmsRoot);
  shows = await addLibrary("Serie", "series", showsRoot);
  archive = await addLibrary("Archiv", "series", archiveRoot);
  nested = await addLibrary("Serialy", "series", nestedRoot);
  box = await addLibrary("Box", "mixed", boxRoot);
  if (aliasReady) aliased = await addLibrary("Aliased", "mixed", aliasRoot);
  mixed = await addLibrary("Smisene", "mixed", mixedRoot);
});

after(async () => {
  await server?.stop();
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

test("a child rooted at a symlink into the parent's tree is seen as nested", async (t) => {
  if (!aliasReady) return t.skip("symlinks need developer mode or admin on Windows");
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

test("a delete, a move and a rename of the folder holding the aliased library are refused", async (t) => {
  if (!aliasReady) return t.skip("symlinks need developer mode or admin on Windows");
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

test("a folder beside the aliased library is not part of it", async (t) => {
  if (!aliasReady) return t.skip("symlinks need developer mode or admin on Windows");
  await put(boxRoot, "Archiv/Loose/Season 1/01 - Loose.mkv");
  const deleted = await api(`/api/library/item?path=${encodeURIComponent(`${boxHolding()}/Loose`)}`, { method: "DELETE" });
  assert.equal(deleted.status, 204, "the guard engages on the nested library, not on the folder that holds it");
  assert.equal(await exists(path.join(boxRoot, "Archiv", "Loose")), false);
  assert.equal(await exists(aliasedFile()), true, "the aliased library is untouched");
});

/** The folder this block drives in its own tests, so no assertion below sees another test's
 *  fixtures. `01` moves across libraries, `02` moves inside `shows`, `03` is copied. */
const carried = (name: string) => `Carried Show/Season 1/${name}`;
const carriedWire = (name: string) => `${shows}/${carried(name)}`;

/** One library's match file, read the way the route debounces it to disk. */
const libraryMeta = async (libraryId: string) => {
  try {
    return JSON.parse(await readFile(path.join(dataDir, "library", `${libraryId}.json`), "utf8")) as {
      version: number; meta: Record<string, { id?: string }>; suggestions: Record<string, unknown>;
    };
  } catch { return undefined; }
};

/** The relative key the manual match wrote for an item at `relative` -- the file's own path,
 *  or the folder unit that covers it. */
const matchedRow = (libraryId: string, relative: string) =>
  waitFor(`the match row for ${relative} in ${libraryId}`, async () => {
    const file = await libraryMeta(libraryId);
    return file && Object.keys(file.meta).find((key) => key === relative || relative.startsWith(`${key}/`));
  }, 10_000);

const starItem = (target: string, wanted: boolean) =>
  api("/api/library/favorite", { method: "POST", body: { path: target, favorite: wanted } });

const favouritePaths = async () =>
  ((await (await api("/api/library/favorites")).json()) as { items: Array<{ path: string }> }).items.map((item) => item.path);

const reportProgress = (target: string) =>
  api("/api/progress", { method: "POST", body: { key: `file:${target}`, path: target, position: 120, duration: 3600, title: "Carried" } });

const progressAt = async (key: string) => (await api(`/api/progress/${encodeURIComponent(key)}`)).json();

const identify = (target: string) =>
  api("/api/library/match", { method: "POST", body: { path: target, type: "series", id: "tt0000001" } });

/** What the server says the item is bound to, read back through the identity route. */
const identityOf = async (target: string) =>
  (await (await api(`/api/library/identity?path=${encodeURIComponent(target)}`)).json()) as { match?: string; bound?: { id?: string } };

test("a queued move into another library carries the item's state", async () => {
  const from = carriedWire("01 - Carried.mkv");
  const relative = carried("01 - Carried.mkv");
  assert.equal((await starItem(from, true)).status, 200);
  assert.equal((await reportProgress(from)).status, 204);
  const identified = await identify(from);
  const sourceRow = await matchedRow(shows, relative);

  const job = await enqueue({ op: "move", items: [from], target: archive });
  assert.equal(job.status, "completed");
  assert.equal(job.done, 1);
  const to = job.results[0]!.to!;
  assert.equal(to, `${archive}/01 - Carried.mkv`, "the item keeps its name across libraries");

  assert.equal(await exists(path.join(archiveRoot, "01 - Carried.mkv")), true, "the file is at the new place");
  assert.equal(await exists(path.join(showsRoot, relative)), false, "the file left the old place");

  const stars = await favouritePaths();
  assert.ok(stars.includes(to), "the star follows the item");
  assert.ok(!stars.includes(from), "the old path is not a favourite any more");

  assert.notEqual(await progressAt(`file:${to}`), null, "the position is under the new key");
  assert.equal(await progressAt(`file:${from}`), null, "the old key holds nothing");

  assert.equal(identified.status, 200, "the manual match is accepted");
  assert.ok(sourceRow, "the match row reached the source library file");
  const destination = await waitFor(`the row in ${archive}`, async () => {
    const found = await libraryMeta(archive);
    return found?.meta["01 - Carried.mkv"]?.id === "tt0000001" ? found : undefined;
  });
  assert.ok(destination, "the match row is in the archive library under the new relative key");
  const source = await libraryMeta(shows);
  assert.equal(source?.meta[relative], undefined, "the row is no longer at the item's old path");
  assert.ok(source?.meta[sourceRow], "the row the item inherited from its folder stays with the folder");
  assert.equal((await identityOf(to)).bound?.id, "tt0000001", "the moved item resolves to the matched title");
});

test("a queued move inside one library carries the item's state", async () => {
  const from = carriedWire("02 - Within.mkv");
  const relative = carried("02 - Within.mkv");
  const movedRelative = "Carried Show/Season 2/02 - Within.mkv";
  assert.equal((await starItem(from, true)).status, 200);
  assert.equal((await reportProgress(from)).status, 204);
  const identified = await identify(from);
  const sourceRow = await matchedRow(shows, relative);

  const job = await enqueue({ op: "move", items: [from], target: `${shows}/Carried Show/Season 2` });
  assert.equal(job.status, "completed");
  assert.equal(job.done, 1);
  const to = job.results[0]!.to!;
  assert.equal(to, `${shows}/${movedRelative}`);

  assert.equal(await exists(path.join(showsRoot, movedRelative)), true, "the file is at the new folder");
  assert.equal(await exists(path.join(showsRoot, relative)), false, "the file left the old folder");

  const stars = await favouritePaths();
  assert.ok(stars.includes(to), "the star follows the item");
  assert.ok(!stars.includes(from), "the old path is not a favourite any more");

  assert.notEqual(await progressAt(`file:${to}`), null, "the position is under the new key");
  assert.equal(await progressAt(`file:${from}`), null, "the old key holds nothing");

  assert.equal(identified.status, 200, "the manual match is accepted");
  assert.ok(sourceRow, "the match row reached the source library file");
  const source = await libraryMeta(shows);
  assert.equal(source?.meta[relative], undefined, "no row is left at the item's old path");
  assert.equal(source?.meta[movedRelative], undefined, "the row did not move: the folder still covers the new path");
  assert.ok(source?.meta[sourceRow], "the row the item inherited from its folder stays with the folder");
  assert.equal((await identityOf(to)).bound?.id, "tt0000001", "the moved item still resolves to the matched title");
});

test("a queued copy into another library leaves the original's state behind", async () => {
  const from = carriedWire("03 - Copied.mkv");
  const relative = carried("03 - Copied.mkv");
  assert.equal((await starItem(from, true)).status, 200);
  assert.equal((await reportProgress(from)).status, 204);
  const identified = await identify(from);
  const sourceRow = await matchedRow(shows, relative);

  const job = await enqueue({ op: "copy", items: [from], target: archive });
  assert.equal(job.status, "completed");
  assert.equal(job.done, 1);
  const to = job.results[0]!.to!;
  assert.equal(to, `${archive}/03 - Copied.mkv`, "the copy keeps its name across libraries");

  assert.equal(await exists(path.join(archiveRoot, "03 - Copied.mkv")), true, "the copy is at the new place");
  assert.equal(await exists(path.join(showsRoot, relative)), true, "the original stays where it was");

  const stars = await favouritePaths();
  assert.ok(stars.includes(from), "the original is still a favourite");
  assert.ok(!stars.includes(to), "the copy is not added as a favourite");

  assert.notEqual(await progressAt(`file:${from}`), null, "the original keeps its position");
  assert.equal(await progressAt(`file:${to}`), null, "the copy has no position of its own");

  assert.equal(identified.status, 200, "the manual match is accepted");
  assert.ok(sourceRow, "the match row reached the source library file");
  const source = await libraryMeta(shows);
  const destination = await libraryMeta(archive);
  assert.ok(source?.meta[sourceRow], "the original's row stays in the source library");
  assert.equal(destination?.meta["03 - Copied.mkv"], undefined, "the copy is not bound in the destination library");
  assert.equal((await identityOf(to)).bound, undefined, "the copy resolves to no title");
});
