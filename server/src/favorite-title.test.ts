import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { spawnServer, type SpawnedServer } from "./test-server.js";

/** One star per title has no unit seam: `setLibraryFavorite` lives in `index.ts` beside the store
 *  it writes, so the server is booted on a throwaway data directory and driven the way the
 *  interface drives it. */

let workDir: string;
let server: SpawnedServer;
let base = "";
let cookie = "";
let libraryId = "";

const api = (pathname: string, init: { method?: string; body?: unknown } = {}) =>
  fetch(`${base}${pathname}`, {
    method: init.method ?? "GET",
    headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

/** A path as the interface sends it: two libraries are configured (the download directory's own
 *  and this suite's), so every wire path is qualified. */
const qualified = (relative: string) => `${libraryId}/${relative}`;
const star = (relative: string, favorite: boolean) =>
  api("/api/library/favorite", { method: "POST", body: { path: qualified(relative), favorite } });
const starTitle = (type: string, id: string, favorite: boolean) =>
  api("/api/watchlist", { method: "POST", body: { type, id, favorite } });
const watchlistKeys = async () => ((await (await api("/api/watchlist")).json()) as Array<{ key: string }>).map((entry) => entry.key).sort();
const starredPaths = async () => ((await (await api("/api/library/favorites")).json()) as { items: Array<{ path: string }> }).items.map((item) => item.path).sort();
const rootFavorites = async () => {
  const body = await (await api(`/api/library/browse?path=${encodeURIComponent(libraryId)}`)).json() as { items: Array<{ path: string; favorite: boolean }> };
  return Object.fromEntries(body.items.map((item) => [item.path.slice(libraryId.length + 1), item.favorite]));
};
const bind = (relative: string, id: string, type = "movie") =>
  api("/api/library/match", { method: "POST", body: { path: qualified(relative), type, id } });

const put = async (relative: string) => {
  const file = path.join(workDir, "roots", relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "video");
};

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "stremio-favorite-title-"));
  const roots = path.join(workDir, "roots");
  const dataDir = path.join(workDir, "data");
  await mkdir(dataDir, { recursive: true });
  // Seeded the way the e2e fixture seeds it: without this the first boot reaches for the
  // default addons, which a unit suite must not do.
  await writeFile(path.join(dataDir, "state.json"), JSON.stringify({ addons: [], defaultsInstalled: true }, null, 2));
  await put("Heat/Heat.mkv");
  await put("Copies/Heat.mkv");
  await put("Loose.mkv");
  await put("Dark/Season 1/Dark.S01E02.mkv");

  server = await spawnServer({
    DATA_DIR: dataDir,
    DOWNLOAD_DIR: path.join(workDir, "downloads"),
    LIBRARY_ROOTS: roots,
    LIBRARY_AUTO_SCAN: "0",
    ADDON_AUTO_REFRESH: "0",
  });
  base = server.base;
  const setup = await api("/api/auth/setup", { method: "POST", body: { username: "starrer", password: "star-password" } });
  assert.equal(setup.status, 201, `could not create the account\n${server.log()}`);
  cookie = setup.headers.getSetCookie()[0]!.split(";")[0]!;
  const created = await api("/api/libraries", { method: "POST", body: { name: "Films", type: "mixed", root: roots } });
  assert.equal(created.status, 201, `could not create the library\n${server.log()}`);
  libraryId = ((await created.json()) as { id: string }).id;
});

after(async () => {
  await server?.stop();
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

test("starring a bound folder stars the title, and every copy of it, for both reads", async () => {
  assert.equal((await bind("Heat", "tt1")).status, 200, server.log());
  assert.equal((await bind("Copies", "tt1")).status, 200, server.log());

  assert.equal((await star("Heat", true)).status, 200);

  assert.deepEqual(await watchlistKeys(), ["movie:tt1"], "the one star of the title joins the watchlist");
  assert.deepEqual(await starredPaths(), [`${libraryId}/Heat`], "and the path that was starred keeps its own star");
  assert.deepEqual(await rootFavorites(), { Copies: true, Dark: false, Heat: true, "Loose.mkv": false },
    "another copy of the film wears the same star, an unbound item none");

  // The catalogue's own star is the same star: clearing it clears the copies.
  assert.equal((await starTitle("movie", "tt1", false)).status, 200);
  assert.deepEqual(await watchlistKeys(), []);
  assert.deepEqual(await starredPaths(), []);
  assert.deepEqual(await rootFavorites(), { Copies: false, Dark: false, Heat: false, "Loose.mkv": false });
});

test("unstarring one path of a title clears the title and its other copies", async () => {
  assert.equal((await star("Copies", true)).status, 200);
  assert.equal((await star("Heat", true)).status, 200);
  assert.deepEqual(await starredPaths(), [`${libraryId}/Copies`, `${libraryId}/Heat`]);

  assert.equal((await star("Heat", false)).status, 200);

  assert.deepEqual(await starredPaths(), [], "the other copy loses its star with the title's");
  assert.deepEqual(await watchlistKeys(), [], "and the catalogue keeps no star either");
});

test("a starred episode file stands for its show, and an unbound path stands for itself", async () => {
  assert.equal((await bind("Dark", "tt5", "series")).status, 200, server.log());

  const episode = "Dark/Season 1/Dark.S01E02.mkv";
  assert.equal((await star(episode, true)).status, 200);
  assert.deepEqual(await watchlistKeys(), ["series:tt5"], "the episode is the show");
  assert.deepEqual(await starredPaths(), [`${libraryId}/${episode}`], "the path that was starred keeps its own star");
  const favorites = await (await api("/api/favorites")).json() as { items: Array<{ kind: string; title?: unknown }> };
  assert.equal(favorites.items.length, 1, "the episode and its show are one card");
  assert.deepEqual(favorites.items[0]!.title, { type: "series", id: "tt5" });

  assert.equal((await star("Loose.mkv", true)).status, 200);
  assert.deepEqual(await watchlistKeys(), ["series:tt5"], "a path bound to no title stars only itself");
  assert.deepEqual(await starredPaths(), [`${libraryId}/${episode}`, `${libraryId}/Loose.mkv`]);

  assert.equal((await star("Loose.mkv", false)).status, 200);
  assert.deepEqual(await starredPaths(), [`${libraryId}/${episode}`], "unstarring it leaves the show alone");
  assert.deepEqual(await watchlistKeys(), ["series:tt5"]);
});
