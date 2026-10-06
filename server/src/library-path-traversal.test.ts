import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { hashPassword } from "./auth.js";
import { spawnServer, type SpawnedServer } from "./test-server.js";

/** The traversal has no unit seam: the route turns a request value into a key and reads it
 *  from the disk, so the server is booted with one library the ordinary account may see and
 *  a picture that belongs to no library at all. */

const ADMIN = "usr_00000001";
const USER = "usr_00000002";
const GRANTED = "lib_00000001";
const HIDDEN = "lib_00000002";

const INSIDE = "GRANTED-POSTER-BYTES";
const HIDDEN_POSTER = "HIDDEN-LIBRARY-POSTER";
const OUTSIDE = "PRIVATE-PHOTO-BYTES";

let workDir: string;
let dataDir: string;
let grantedRoot: string;
let hiddenRoot: string;
let server: SpawnedServer;
let base = "";
let userCookie = "";

const api = (pathname: string, init: { method?: string; body?: unknown; cookie?: string } = {}) =>
  fetch(`${base}${pathname}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.cookie ? { cookie: init.cookie } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

const text = async (response: Response) => Buffer.from(await response.arrayBuffer()).toString("utf8");

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "stremio-traversal-"));
  dataDir = path.join(workDir, "data");
  grantedRoot = path.join(workDir, "roots", "Filmy");
  hiddenRoot = path.join(workDir, "roots", "Tajne");
  await mkdir(dataDir, { recursive: true });
  await mkdir(grantedRoot, { recursive: true });
  await mkdir(hiddenRoot, { recursive: true });
  await writeFile(path.join(grantedRoot, "Heat.mkv"), "video");
  await writeFile(path.join(grantedRoot, "Heat.jpg"), INSIDE);
  await writeFile(path.join(hiddenRoot, "Secret.mkv"), "video");
  await writeFile(path.join(hiddenRoot, "poster.jpg"), HIDDEN_POSTER);
  // No library root contains this: reaching it means leaving every granted root behind.
  await writeFile(path.join(workDir, "private.jpg"), OUTSIDE);

  const account = async (id: string, username: string, password: string, role: "admin" | "user") => ({
    id, username, passwordHash: await hashPassword(password), secret: id.padEnd(64, "0"), role,
    createdAt: "2026-01-01T00:00:00.000Z",
    permissions: { downloadToLibrary: role === "admin", downloadToDevice: true },
    permissionsVersion: 0,
  });
  const personal = () => ({ prefs: {}, favorites: [], watchlist: {}, progress: {}, watchedSeries: {} });
  await writeFile(path.join(dataDir, "state.json"), JSON.stringify({
    schemaVersion: 3,
    addons: [],
    defaultsInstalled: true,
    settings: {},
    libraries: [
      { id: GRANTED, name: "Filmy", type: "mixed", root: grantedRoot, enabled: true, order: 0, addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: false, visibleTo: [USER] },
      { id: HIDDEN, name: "Tajne", type: "mixed", root: hiddenRoot, enabled: true, order: 1, addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: false },
    ],
    users: [
      await account(ADMIN, "ada", "admin-password", "admin"),
      await account(USER, "bob", "user-password", "user"),
    ],
    userData: { [ADMIN]: personal(), [USER]: personal() },
  }, null, 2));

  server = await spawnServer({
    DATA_DIR: dataDir,
    DOWNLOAD_DIR: path.join(workDir, "downloads"),
    LIBRARY_ROOTS: path.join(workDir, "roots"),
    LIBRARY_AUTO_SCAN: "0",
    ADDON_AUTO_REFRESH: "0",
  });
  base = server.base;

  const login = await api("/api/auth/login", { method: "POST", body: { username: "bob", password: "user-password" } });
  assert.equal(login.status, 200, `could not sign in as bob\n${server.log()}`);
  userCookie = login.headers.getSetCookie()[0]!.split(";")[0]!;
});

after(async () => {
  await server?.stop();
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

test("thumb still serves the artwork of a file inside a granted root", async () => {
  const response = await api(`/api/library/thumb?path=${encodeURIComponent(`${GRANTED}/Heat.mkv`)}`, { cookie: userCookie });
  assert.equal(response.status, 200, `the ordinary path is served\n${server.log()}`);
  assert.equal(await text(response), INSIDE);
});

test("thumb refuses a file traversal and answers like a missing picture", async () => {
  const response = await api(`/api/library/thumb?path=${encodeURIComponent(`${GRANTED}/../../private.jpg`)}`, { cookie: userCookie });
  assert.equal(response.status, 404, `a path that leaves the root is not a picture\n${server.log()}`);
  assert.equal((await text(response)).includes(OUTSIDE), false, "the outside file's bytes never travel");
});

test("thumb refuses a folder traversal and answers like a missing picture", async () => {
  const response = await api(`/api/library/thumb?dir=${encodeURIComponent(`${GRANTED}/../Tajne`)}`, { cookie: userCookie });
  assert.equal(response.status, 404, `a folder outside the root is not a picture\n${server.log()}`);
  assert.equal((await text(response)).includes(HIDDEN_POSTER), false, "another library's poster never travels");
});

test("thumb refuses a key traversal and answers like a missing picture", async () => {
  const response = await api(`/api/library/thumb?key=${encodeURIComponent(`${GRANTED}/../../private.jpg`)}`, { cookie: userCookie });
  assert.equal(response.status, 404);
  assert.equal((await text(response)).includes(OUTSIDE), false);
});
