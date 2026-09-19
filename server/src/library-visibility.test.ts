import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { hashPassword } from "./auth.js";

/** Visibility has no unit seam: the predicate is pure, but the backstop lives in
 *  `libraryTarget` inside `index.ts`, which starts the app the way the container runs it.
 *  So the server is booted on a throwaway data directory seeded with two accounts -- no
 *  ordinary user can be created over HTTP yet -- and driven the way the interface drives it. */
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ADMIN = "usr_00000001";
const USER = "usr_00000002";
const GRANTED = "lib_00000001";
const HIDDEN = "lib_00000002";

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

let workDir: string;
let dataDir: string;
let grantedRoot: string;
let hiddenRoot: string;
let child: ChildProcess;
let log = "";
let base = "";
let adminCookie = "";
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

const signIn = async (username: string, password: string) => {
  const response = await api("/api/auth/login", { method: "POST", body: { username, password } });
  assert.equal(response.status, 200, `could not sign in as ${username}\n${log}`);
  return response.headers.getSetCookie()[0]!.split(";")[0]!;
};

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "stremio-visibility-"));
  dataDir = path.join(workDir, "data");
  const roots = path.join(workDir, "roots");
  grantedRoot = path.join(roots, "Filmy");
  hiddenRoot = path.join(roots, "Tajne");
  await mkdir(dataDir, { recursive: true });
  await mkdir(grantedRoot, { recursive: true });
  await mkdir(hiddenRoot, { recursive: true });
  await writeFile(path.join(grantedRoot, "Heat.mkv"), "video");
  await writeFile(path.join(hiddenRoot, "Secret.mkv"), "video");

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
      LIBRARY_ROOTS: roots,
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

  adminCookie = await signIn("ada", "admin-password");
  userCookie = await signIn("bob", "user-password");
});

after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

test("the list and the browse root show a user only what they were granted", async () => {
  const administrator = await (await api("/api/libraries", { cookie: adminCookie })).json() as Array<{ id: string }>;
  assert.deepEqual(administrator.map((library) => library.id).sort(), [GRANTED, HIDDEN].sort(), "an administrator sees every library");

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

test("the contents summary names only the libraries the caller may see", async () => {
  const user = await (await api("/api/library", { cookie: userCookie })).json() as Array<{ key: string }>;
  assert.ok(user.some((entry) => entry.key.startsWith(`${GRANTED}/`)), "the granted library is summarised");
  assert.ok(user.every((entry) => entry.key.startsWith(`${GRANTED}/`)), "nothing from the hidden one is");

  const administrator = await (await api("/api/library", { cookie: adminCookie })).json() as Array<{ key: string }>;
  assert.ok(administrator.some((entry) => entry.key.startsWith(`${HIDDEN}/`)), "an administrator still sees every library");
});

test("the backstop refuses a file in a library the session has lost", async () => {
  const source = await api("/api/library/source", { method: "POST", cookie: userCookie, body: { path: `${GRANTED}/Heat.mkv` } });
  assert.equal(source.status, 200, `the granted library is readable\n${log}`);
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
