import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  MEDIA_SERVER_KEY_NAME,
  MEDIA_SERVER_SECRETS_DIRECTORY,
  mediaServerKeyPath,
  prepareContainerMediaKey,
  type MediaKeyLog,
} from "./prepare-media-key.js";

const tempDir = async (t: TestContext) => {
  const dir = await mkdtemp(path.join(tmpdir(), "container-media-key-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

const keyPath = (dir: string) => path.join(dir, MEDIA_SERVER_KEY_NAME);
const vaultDir = (dir: string) => path.join(dir, MEDIA_SERVER_SECRETS_DIRECTORY);
const exists = (target: string) => lstat(target).then(() => true, () => false);

const capture = () => {
  const lines: Array<{ level: "INFO" | "WARN"; line: string }> = [];
  const log: MediaKeyLog = (level, line) => lines.push({ level, line });
  return { lines, log };
};

test("a first run creates one 32-byte owner-only key in the data directory", async (t) => {
  const dir = await tempDir(t);
  const { lines, log } = capture();
  const intended = await prepareContainerMediaKey(dir, {}, log);
  assert.equal(intended, keyPath(dir));
  assert.equal(intended, mediaServerKeyPath(dir));
  const info = await lstat(intended);
  assert.equal(info.isFile(), true);
  assert.equal(info.size, 32);
  if (process.platform !== "win32") assert.equal(info.mode & 0o777, 0o600);
  assert.equal(intended.includes(`${path.sep}${MEDIA_SERVER_SECRETS_DIRECTORY}${path.sep}`), false);
  assert.deepEqual(await readdir(dir), [MEDIA_SERVER_KEY_NAME], "no temp file is left behind");
  assert.deepEqual(lines, [{ level: "INFO", line: "Created a new media-server key in the data directory." }]);
  assert.equal(lines[0]?.line.includes(dir), false);
});

test("a missing data directory is created for the key", async (t) => {
  const parent = await tempDir(t);
  const dir = path.join(parent, "data");
  const intended = await prepareContainerMediaKey(dir, {});
  assert.equal((await lstat(intended)).isFile(), true);
  assert.equal((await lstat(dir)).isDirectory(), true);
});

test("the key is stable across restarts and differs between installs", async (t) => {
  const first = await tempDir(t);
  const second = await tempDir(t);
  const firstKey = await readFile(await prepareContainerMediaKey(first, {}));
  const again = await readFile(await prepareContainerMediaKey(first, {}));
  assert.deepEqual(again, firstKey, "the same install keeps its bytes");
  const other = await readFile(await prepareContainerMediaKey(second, {}));
  assert.notDeepEqual(other, firstKey, "two installs get different keys");
  assert.equal(firstKey.length, 32);
});

test("concurrent preparation converges on a single winner", async (t) => {
  const dir = await tempDir(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => prepareContainerMediaKey(dir, {})));
  for (const result of results) assert.equal(result, keyPath(dir));
  const bytes = await readFile(keyPath(dir));
  assert.equal(bytes.length, 32);
  assert.deepEqual(await readdir(dir), [MEDIA_SERVER_KEY_NAME], "no loser leaves a temp file");
});

test("a non-blank deployment override is returned exactly and nothing is created", async (t) => {
  const dir = await tempDir(t);
  const override = "/run/secrets/media-server.key";
  const { lines, log } = capture();
  const result = await prepareContainerMediaKey(dir, { MEDIA_SERVER_KEY_FILE: override }, log);
  assert.equal(result, override);
  assert.deepEqual(await readdir(dir), [], "an override never touches the data directory");
  assert.deepEqual(lines, []);
});

test("a blank deployment override falls back to the default path", async (t) => {
  const dir = await tempDir(t);
  const result = await prepareContainerMediaKey(dir, { MEDIA_SERVER_KEY_FILE: "   " });
  assert.equal(result, keyPath(dir));
  assert.equal((await lstat(result)).isFile(), true);
});

test("an existing key is never rewritten, even when it is corrupt", async (t) => {
  const dir = await tempDir(t);
  const intended = keyPath(dir);
  await writeFile(intended, Buffer.from("short"), { mode: 0o600 });
  const { lines, log } = capture();
  assert.equal(await prepareContainerMediaKey(dir, {}, log), intended);
  assert.deepEqual(await readFile(intended), Buffer.from("short"));
  assert.deepEqual(lines, []);
});

test("an existing key with loose permissions is not repaired", async (t) => {
  const dir = await tempDir(t);
  const intended = keyPath(dir);
  const bytes = randomBytes(32);
  await writeFile(intended, bytes, { mode: 0o644 });
  assert.equal(await prepareContainerMediaKey(dir, {}), intended);
  assert.deepEqual(await readFile(intended), bytes);
  if (process.platform !== "win32") assert.equal((await lstat(intended)).mode & 0o777, 0o644);
});

test("a symlink where the key belongs is left alone", async (t) => {
  const dir = await tempDir(t);
  const target = path.join(dir, "elsewhere");
  await writeFile(target, randomBytes(32));
  await symlink(target, keyPath(dir));
  assert.equal(await prepareContainerMediaKey(dir, {}), keyPath(dir));
  assert.equal((await lstat(keyPath(dir))).isSymbolicLink(), true);
});

test("a bound secretRef in the state stops a fresh key", async (t) => {
  const dir = await tempDir(t);
  await writeFile(path.join(dir, "state.json"),
    JSON.stringify({ version: 3, mediaConnections: [{ id: "connection-1", secretRef: "msecret_00000000000000000000000000000001" }] }));
  const { lines, log } = capture();
  assert.equal(await prepareContainerMediaKey(dir, {}, log), keyPath(dir));
  assert.equal(await exists(keyPath(dir)), false);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.level, "WARN");
  assert.match(lines[0]!.line, /not created/);
  assert.equal(lines[0]!.line.includes(dir), false);
});

test("a non-empty vault stops a fresh key", async (t) => {
  const dir = await tempDir(t);
  await mkdir(vaultDir(dir), { recursive: true });
  await writeFile(path.join(vaultDir(dir), "msecret_00000000000000000000000000000002"), "envelope");
  assert.equal(await prepareContainerMediaKey(dir, {}), keyPath(dir));
  assert.equal(await exists(keyPath(dir)), false);
});

test("an empty vault and a state without media fields still allow a first key", async (t) => {
  const dir = await tempDir(t);
  await mkdir(vaultDir(dir), { recursive: true });
  await writeFile(path.join(dir, "state.json"), JSON.stringify({ version: 3, addons: [] }));
  const intended = await prepareContainerMediaKey(dir, {});
  assert.equal((await lstat(intended)).isFile(), true);
});

test("a state that binds no secret and an empty connection list allow a first key", async (t) => {
  const dir = await tempDir(t);
  await writeFile(path.join(dir, "state.json"),
    JSON.stringify({ version: 3, mediaConnections: [{ id: "connection-1", name: "Living room" }] }));
  const intended = await prepareContainerMediaKey(dir, {});
  assert.equal((await lstat(intended)).isFile(), true);
});

test("a malformed state declines creation", async (t) => {
  const dir = await tempDir(t);
  await writeFile(path.join(dir, "state.json"), "{ not json");
  assert.equal(await prepareContainerMediaKey(dir, {}), keyPath(dir));
  assert.equal(await exists(keyPath(dir)), false);
});

test("an unreadable state path declines creation", async (t) => {
  const dir = await tempDir(t);
  await mkdir(path.join(dir, "state.json"), { recursive: true });
  assert.equal(await prepareContainerMediaKey(dir, {}), keyPath(dir));
  assert.equal(await exists(keyPath(dir)), false);
});

test("a symlinked state declines creation", async (t) => {
  const dir = await tempDir(t);
  const real = path.join(dir, "real-state.json");
  await writeFile(real, JSON.stringify({ version: 3 }));
  await symlink(real, path.join(dir, "state.json"));
  assert.equal(await prepareContainerMediaKey(dir, {}), keyPath(dir));
  assert.equal(await exists(keyPath(dir)), false);
});

test("an unexpected vault path declines creation", async (t) => {
  const first = await tempDir(t);
  await writeFile(vaultDir(first), "not a directory");
  assert.equal(await prepareContainerMediaKey(first, {}), keyPath(first));
  assert.equal(await exists(keyPath(first)), false);

  const second = await tempDir(t);
  await mkdir(path.join(second, "real-vault"));
  await symlink(path.join(second, "real-vault"), vaultDir(second));
  assert.equal(await prepareContainerMediaKey(second, {}), keyPath(second));
  assert.equal(await exists(keyPath(second)), false);
});

test("a data directory that is a symlink or a file declines creation", async (t) => {
  const linked = await tempDir(t);
  const real = path.join(linked, "real");
  await mkdir(real);
  const linkDir = path.join(linked, "link");
  await symlink(real, linkDir);
  const viaLink = await prepareContainerMediaKey(linkDir, {});
  assert.equal(viaLink, path.join(linkDir, MEDIA_SERVER_KEY_NAME));
  assert.equal(await exists(path.join(linkDir, MEDIA_SERVER_KEY_NAME)), false);
  assert.deepEqual(await readdir(real), [], "nothing is written through the link");

  const file = await tempDir(t);
  const asFile = path.join(file, "data");
  await writeFile(asFile, "occupied");
  assert.equal(await prepareContainerMediaKey(asFile, {}), path.join(asFile, MEDIA_SERVER_KEY_NAME));
  assert.equal(await exists(path.join(asFile, MEDIA_SERVER_KEY_NAME)), false);
});

test("a failed prepare logs one generic line and creates nothing", async (t) => {
  const parent = await tempDir(t);
  const blocked = path.join(parent, "not-a-directory");
  await writeFile(blocked, "occupied");
  const dir = path.join(blocked, "data");
  const { lines, log } = capture();
  assert.equal(await prepareContainerMediaKey(dir, {}, log), keyPath(dir));
  assert.equal(await exists(keyPath(dir)), false);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.level, "WARN");
  assert.match(lines[0]!.line, /could not be prepared/);
  assert.equal(/[A-Za-z0-9+/]{43}=/.test(lines[0]!.line), false);
  assert.equal(/[0-9a-f]{64}/.test(lines[0]!.line), false);
});
