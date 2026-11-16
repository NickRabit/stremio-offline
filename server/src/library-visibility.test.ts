import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { hashPassword } from "./auth.js";
import { spawnServer, type SpawnedServer } from "./test-server.js";

/** Visibility has no unit seam: the predicate is pure, but the backstop lives in
 *  `libraryTarget` inside `index.ts`, which starts the app the way the container runs it.
 *  So the server is booted on a throwaway data directory seeded with two accounts -- no
 *  ordinary user can be created over HTTP yet -- and driven the way the interface drives it. */

const ADMIN = "usr_00000001";
const USER = "usr_00000002";
const USER_BOTH = "usr_00000004";
const GRANTED = "lib_00000001";
const HIDDEN = "lib_00000002";
const NESTED = "lib_00000003";

let workDir: string;
let dataDir: string;
let grantedRoot: string;
let hiddenRoot: string;
let nestedRoot: string;
let server: SpawnedServer;
let base = "";
let adminCookie = "";
let userCookie = "";
let bothCookie = "";

const api = (pathname: string, init: { method?: string; body?: unknown; cookie?: string } = {}) =>
  fetch(`${base}${pathname}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.cookie ? { cookie: init.cookie } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

const signIn = async (username: string, password: string) => {
  const response = await api("/api/auth/login", { method: "POST", body: { username, password } });
  assert.equal(response.status, 200, `could not sign in as ${username}\n${server.log()}`);
  return response.headers.getSetCookie()[0]!.split(";")[0]!;
};

const sameAnswer = async (actual: Response, missing: Response) => {
  assert.equal(actual.status, missing.status);
  const body = async (response: Response) => {
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  };
  assert.deepEqual(await body(actual), await body(missing));
};

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "stremio-visibility-"));
  dataDir = path.join(workDir, "data");
  const roots = path.join(workDir, "roots");
  grantedRoot = path.join(roots, "Filmy");
  hiddenRoot = path.join(roots, "Tajne");
  nestedRoot = path.join(grantedRoot, "Nested");
  await mkdir(dataDir, { recursive: true });
  await mkdir(grantedRoot, { recursive: true });
  await mkdir(hiddenRoot, { recursive: true });
  await mkdir(path.join(nestedRoot, "Season 1"), { recursive: true });
  await mkdir(path.join(nestedRoot, "Alpha"), { recursive: true });
  await mkdir(path.join(nestedRoot, "Beta"), { recursive: true });
  await mkdir(path.join(grantedRoot, "Open"), { recursive: true });
  await writeFile(path.join(grantedRoot, "Heat.mkv"), "video");
  await writeFile(path.join(hiddenRoot, "Secret.mkv"), "video");
  await writeFile(path.join(nestedRoot, "Season 1", "secret.mkv"), "video");
  await writeFile(path.join(nestedRoot, "Season 1", "secret.jpg"), "picture");
  await writeFile(path.join(nestedRoot, "Alpha", "Alpha.mkv"), "video");
  await writeFile(path.join(nestedRoot, "Alpha", "poster.jpg"), "picture");
  await writeFile(path.join(nestedRoot, "Beta", "Beta.mkv"), "video");
  await writeFile(path.join(nestedRoot, "Beta", "poster.jpg"), "picture");
  await writeFile(path.join(grantedRoot, "Open", "Visible.mkv"), "video");

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
      { id: GRANTED, name: "Filmy", type: "mixed", root: grantedRoot, enabled: true, order: 0, addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: false, visibleTo: [USER, USER_BOTH] },
      { id: HIDDEN, name: "Tajne", type: "mixed", root: hiddenRoot, enabled: true, order: 1, addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: false },
      { id: NESTED, name: "Nested", type: "mixed", root: nestedRoot, enabled: true, order: 2, addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: false, visibleTo: [USER_BOTH] },
    ],
    users: [
      await account(ADMIN, "ada", "admin-password", "admin"),
      await account(USER, "bob", "user-password", "user"),
      await account(USER_BOTH, "bea", "both-password", "user"),
    ],
    userData: { [ADMIN]: personal(), [USER]: personal(), [USER_BOTH]: personal() },
  }, null, 2));

  server = await spawnServer({
    DATA_DIR: dataDir,
    DOWNLOAD_DIR: path.join(workDir, "downloads"),
    LIBRARY_ROOTS: roots,
    LIBRARY_AUTO_SCAN: "0",
    ADDON_AUTO_REFRESH: "0",
  });
  base = server.base;

  adminCookie = await signIn("ada", "admin-password");
  userCookie = await signIn("bob", "user-password");
  bothCookie = await signIn("bea", "both-password");
});

after(async () => {
  await server?.stop();
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

test("the list and the browse root show a user only what they were granted", async () => {
  const administrator = await (await api("/api/libraries", { cookie: adminCookie })).json() as Array<{ id: string }>;
  assert.deepEqual(administrator.map((library) => library.id).sort(), [GRANTED, HIDDEN, NESTED].sort(), "an administrator sees every library");

  const user = await (await api("/api/libraries", { cookie: userCookie })).json() as Array<{ id: string }>;
  assert.deepEqual(user.map((library) => library.id), [GRANTED]);

  const root = await (await api("/api/library/browse", { cookie: userCookie })).json() as { items: Array<{ libraryId?: string }> };
  assert.deepEqual(root.items.map((item) => item.libraryId), [GRANTED], "the root lists only the granted library");
});

test("browsing into a library the user may not see answers like one that does not exist", async () => {
  const invisible = await api(`/api/library/browse?path=${encodeURIComponent(HIDDEN)}`, { cookie: userCookie });
  const missing = await api(`/api/library/browse?path=${encodeURIComponent("lib_00000099")}`, { cookie: userCookie });
  assert.equal(invisible.status, missing.status);
  assert.deepEqual(await invisible.json(), await missing.json());
});

/** A hidden nested folder reads as a folder that is not there; only the echoed path differs. */
const sameListing = async (actual: Response, missing: Response) => {
  assert.equal(actual.status, missing.status);
  assert.deepEqual({ ...await actual.json() as object, path: "" }, { ...await missing.json() as object, path: "" });
};

test("browse does not reach a nested library through its parent", async () => {
  const parentSpellings = ["Nested", "Nested/Season 1"];
  for (const relative of parentSpellings) {
    const actual = await api(`/api/library/browse?path=${encodeURIComponent(`${GRANTED}/${relative}`)}`, { cookie: userCookie });
    const missing = await api(`/api/library/browse?path=${encodeURIComponent(`${GRANTED}/Missing/${relative}`)}`, { cookie: userCookie });
    await sameListing(actual, missing);
  }

  const open = await api(`/api/library/browse?path=${encodeURIComponent(`${GRANTED}/Open`)}`, { cookie: userCookie });
  assert.equal(open.status, 200);
  assert.deepEqual((await open.json() as { items: Array<{ path: string }> }).items.map((item) => item.path), [`${GRANTED}/Open/Visible.mkv`]);
});

test("folders do not reach a nested library through its parent", async () => {
  const folders = await api(`/api/library/folders?path=${encodeURIComponent(`${GRANTED}/Nested`)}`, { cookie: userCookie });
  const missingFolders = await api(`/api/library/folders?path=${encodeURIComponent(`${GRANTED}/Missing`)}`, { cookie: userCookie });
  await sameListing(folders, missingFolders);

  const open = await api(`/api/library/folders?path=${encodeURIComponent(`${GRANTED}/Open`)}`, { cookie: userCookie });
  assert.equal(open.status, 200);
});

test("source does not mint a nested file through its parent", async () => {
  const source = await api("/api/library/source", { method: "POST", cookie: userCookie, body: { path: `${GRANTED}/Nested/Season 1/secret.mkv` } });
  const missingSource = await api("/api/library/source", { method: "POST", cookie: userCookie, body: { path: "lib_00000099/Season 1/secret.mkv" } });
  await sameAnswer(source, missingSource);

  const open = await api("/api/library/source", { method: "POST", cookie: userCookie, body: { path: `${GRANTED}/Open/Visible.mkv` } });
  assert.equal(open.status, 200);
});

test("the same carve-out is refused when its spelling differs on a folding volume", async () => {
  const browse = await api(`/api/library/browse?path=${encodeURIComponent(`${GRANTED}/NESTED/Season 1`)}`, { cookie: userCookie });
  const missing = await api(`/api/library/browse?path=${encodeURIComponent(`${GRANTED}/Missing/Season 1`)}`, { cookie: userCookie });
  await sameListing(browse, missing);

  const folders = await api(`/api/library/folders?path=${encodeURIComponent(`${GRANTED}/NESTED`)}`, { cookie: userCookie });
  const missingFolders = await api(`/api/library/folders?path=${encodeURIComponent(`${GRANTED}/Missing`)}`, { cookie: userCookie });
  await sameListing(folders, missingFolders);

  const source = await api("/api/library/source", { method: "POST", cookie: userCookie, body: { path: `${GRANTED}/NESTED/Season 1/secret.mkv` } });
  const missingSource = await api("/api/library/source", { method: "POST", cookie: userCookie, body: { path: "lib_00000099/Season 1/secret.mkv" } });
  await sameAnswer(source, missingSource);
});

test("source, thumb, mosaic, gallery and identity refuse a nested key like a missing one", async () => {
  const key = `${GRANTED}/Nested/Season 1/secret.mkv`;
  const missingKey = "lib_00000099/Season 1/secret.mkv";
  const source = await api("/api/library/source", { method: "POST", cookie: userCookie, body: { path: key } });
  const missingSource = await api("/api/library/source", { method: "POST", cookie: userCookie, body: { path: missingKey } });
  await sameAnswer(source, missingSource);

  for (const route of ["thumb", "gallery", "identity"]) {
    const actual = await api(`/api/library/${route}?path=${encodeURIComponent(key)}`, { cookie: userCookie });
    const missing = await api(`/api/library/${route}?path=${encodeURIComponent(missingKey)}`, { cookie: userCookie });
    await sameAnswer(actual, missing);
  }

  const mosaic = await api(`/api/library/mosaic?key=${encodeURIComponent(`${GRANTED}/Nested`)}`, { cookie: userCookie });
  const missingMosaic = await api(`/api/library/mosaic?key=${encodeURIComponent("lib_00000099")}`, { cookie: userCookie });
  await sameAnswer(mosaic, missingMosaic);
});

test("administrators use either spelling and keep the carve-out mutation guard", async () => {
  const parentKey = `${GRANTED}/Nested/Season 1/secret.mkv`;
  const parentSource = await api("/api/library/source", { method: "POST", cookie: adminCookie, body: { path: parentKey } });
  assert.equal(parentSource.status, 200);

  const nestedSource = await api("/api/library/source", { method: "POST", cookie: adminCookie, body: { path: `${NESTED}/Season 1/secret.mkv` } });
  assert.equal(nestedSource.status, 200);

  const rename = await api("/api/library/rename", {
    method: "POST",
    cookie: adminCookie,
    body: { path: `${GRANTED}/Nested`, name: "Moved" },
  });
  assert.equal(rename.status, 409);
  assert.equal((await rename.json() as { messageKey?: string }).messageKey, "err.libraryHoldsAnother");
});

test("a user granted both libraries reads the nested tree through the parent id", async () => {
  const libraries = await api("/api/libraries", { cookie: bothCookie });
  assert.deepEqual((await libraries.json() as Array<{ id: string }>).map((library) => library.id).sort(), [GRANTED, NESTED].sort());
  const browse = await api(`/api/library/browse?path=${encodeURIComponent(`${GRANTED}/Nested/Season 1`)}`, { cookie: bothCookie });
  assert.equal(browse.status, 200, await browse.clone().text());
  assert.deepEqual((await browse.json() as { items: Array<{ path: string }> }).items.map((item) => item.path),
    [`${GRANTED}/Nested/Season 1/secret.mkv`]);

  const source = await api("/api/library/source", {
    method: "POST",
    cookie: bothCookie,
    body: { path: `${GRANTED}/Nested/Season 1/secret.mkv` },
  });
  assert.equal(source.status, 200);
});

test("a library target ticket stops serving when its path becomes a carve-out", async (t) => {
  const source = await api("/api/library/source", {
    method: "POST",
    cookie: userCookie,
    body: { path: `${GRANTED}/Open/Visible.mkv` },
  });
  assert.equal(source.status, 200);
  const { sourceId } = await source.json() as { sourceId: string };
  const ticket = await api("/api/device-download", { method: "POST", cookie: userCookie, body: { sourceId } });
  assert.equal(ticket.status, 201);
  const { url } = await ticket.json() as { url: string };
  assert.equal((await api(url, { cookie: userCookie })).status, 200);

  const added = await api("/api/libraries", {
    method: "POST",
    cookie: adminCookie,
    body: { name: "Open", type: "mixed", root: path.join(grantedRoot, "Open") },
  });
  assert.equal(added.status, 201);
  const { id } = await added.json() as { id: string };
  t.after(async () => {
    await api(`/api/libraries/${id}?forget=1`, { method: "DELETE", cookie: adminCookie });
  });

  const refused = await api(url, { cookie: userCookie });
  assert.equal(refused.status, 404);
  assert.equal((await refused.json() as { code?: string }).code, "RESOURCE_NOT_FOUND");
});

test("a favourite on a library the user was not granted answers like one that does not exist", async () => {
  const foreign = await api("/api/library/favorite", { method: "POST", cookie: userCookie, body: { path: `${HIDDEN}/Secret.mkv`, favorite: true } });
  const missing = await api("/api/library/favorite", { method: "POST", cookie: userCookie, body: { path: "lib_00000099/Secret.mkv", favorite: true } });
  assert.equal(foreign.status, 400);
  assert.equal(missing.status, 400);
  assert.deepEqual(await foreign.json(), await missing.json());
});

test("the contents summary names only the libraries the caller may see", async () => {
  const user = await (await api("/api/library", { cookie: userCookie })).json() as Array<{ key: string }>;
  assert.ok(user.some((entry) => entry.key.startsWith(`${GRANTED}/`)), "the granted library is summarised");
  assert.ok(user.every((entry) => entry.key.startsWith(`${GRANTED}/`)), "nothing from the hidden one is");

  const administrator = await (await api("/api/library", { cookie: adminCookie })).json() as Array<{ key: string }>;
  assert.ok(administrator.some((entry) => entry.key.startsWith(`${HIDDEN}/`)), "an administrator still sees every library");
});

test("the backstop refuses a file in a library the session has lost", async () => {
  const source = await api("/api/library/source", { method: "POST", cookie: userCookie, body: { path: `${GRANTED}/Heat.mkv` } });
  assert.equal(source.status, 200, `the granted library is readable\n${server.log()}`);
  const { sourceId } = await source.json() as { sourceId: string };

  const ticket = await api("/api/device-download", { method: "POST", cookie: userCookie, body: { sourceId } });
  assert.equal(ticket.status, 201);
  const { url } = await ticket.json() as { url: string };
  assert.equal((await api(url, { cookie: userCookie })).status, 200, "the file is served while the library is visible");

  // The route that hands the file down was not filtered; it is `libraryTarget` that refuses.
  const removed = await api(`/api/libraries/${GRANTED}`, { method: "PATCH", cookie: adminCookie, body: { visibleTo: [] } });
  assert.equal(removed.status, 200);
  const refused = await api(url, { cookie: userCookie });
  assert.equal(refused.status, 404, "the path now answers exactly as one that is not there");
  assert.equal((await refused.json() as { code?: string }).code, "RESOURCE_NOT_FOUND");

  // The same request that took the file away can give it back; the guard reads the grant as
  // it stands at the moment of the read.
  const restored = await api(`/api/libraries/${GRANTED}`, { method: "PATCH", cookie: adminCookie, body: { visibleTo: [USER] } });
  assert.equal(restored.status, 200);
  assert.equal((await api(url, { cookie: userCookie })).status, 200, "granting it again brings the file back");
});

test("an unknown or administrator id is refused rather than written down", async () => {
  const unknown = await api(`/api/libraries/${GRANTED}`, { method: "PATCH", cookie: adminCookie, body: { visibleTo: ["usr_ffffffff"] } });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json() as { messageKey?: string }).messageKey, "err.unknownUser");

  const administrator = await api(`/api/libraries/${GRANTED}`, { method: "PATCH", cookie: adminCookie, body: { visibleTo: [ADMIN] } });
  assert.equal(administrator.status, 400);
  assert.equal((await administrator.json() as { messageKey?: string }).messageKey, "err.adminAlwaysSees");
});
