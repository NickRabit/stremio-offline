import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { INSTANCE_DIRECTORY } from "./local-backend.js";
import {
  MEDIA_SERVER_KEY_NAME,
  MEDIA_SERVER_SECRETS_DIRECTORY,
  mediaServerKeyPath,
  prepareDesktopMediaKey,
} from "./local-media-key.js";

const tempDir = async (t: TestContext) => {
  const dir = await mkdtemp(path.join(tmpdir(), "local-media-key-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

const keyPath = (dir: string) => path.join(dir, MEDIA_SERVER_KEY_NAME);
const instanceDir = (dir: string) => path.join(dir, INSTANCE_DIRECTORY);
const vaultDir = (dir: string) => path.join(dir, INSTANCE_DIRECTORY, MEDIA_SERVER_SECRETS_DIRECTORY);

const exists = (target: string) => lstat(target).then(() => true, () => false);

test("a first run creates one 32-byte owner-only key beside the instance directory", async (t) => {
  const dir = await tempDir(t);
  const intended = await prepareDesktopMediaKey(dir, {}, process.platform);
  assert.equal(intended, keyPath(dir));
  assert.equal(intended, mediaServerKeyPath(dir, process.platform));
  const info = await lstat(intended);
  assert.equal(info.isFile(), true);
  assert.equal(info.size, 32);
  if (process.platform !== "win32") assert.equal(info.mode & 0o777, 0o600);
  assert.equal(intended.startsWith(instanceDir(dir)), false, "the key stays outside the instance");
  assert.deepEqual(await readdir(dir), [MEDIA_SERVER_KEY_NAME], "no temp file is left behind");
});

test("a new user-data directory is created for the key", async (t) => {
  const parent = await tempDir(t);
  const dir = path.join(parent, "userData");
  const intended = await prepareDesktopMediaKey(dir, {}, process.platform);
  assert.equal((await lstat(intended)).isFile(), true);
  assert.equal((await lstat(dir)).isDirectory(), true);
});

test("the key is stable across restarts and differs between installs", async (t) => {
  const first = await tempDir(t);
  const second = await tempDir(t);
  const firstKey = await readFile(await prepareDesktopMediaKey(first, {}, process.platform));
  const again = await readFile(await prepareDesktopMediaKey(first, {}, process.platform));
  assert.deepEqual(again, firstKey, "the same install keeps its bytes");
  const other = await readFile(await prepareDesktopMediaKey(second, {}, process.platform));
  assert.notDeepEqual(other, firstKey, "two installs get different keys");
  assert.equal(firstKey.length, 32);
});

test("concurrent preparation converges on a single winner", async (t) => {
  const dir = await tempDir(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => prepareDesktopMediaKey(dir, {}, process.platform)));
  for (const result of results) assert.equal(result, keyPath(dir));
  const bytes = await readFile(keyPath(dir));
  assert.equal(bytes.length, 32);
  assert.deepEqual(await readdir(dir), [MEDIA_SERVER_KEY_NAME], "no loser leaves a temp file");
});

test("a non-blank deployment override is returned exactly and nothing is created", async (t) => {
  const dir = await tempDir(t);
  const override = "/run/secrets/media-server.key";
  const result = await prepareDesktopMediaKey(dir, { MEDIA_SERVER_KEY_FILE: override }, process.platform);
  assert.equal(result, override);
  assert.deepEqual(await readdir(dir), [], "an override never touches the user-data directory");
});

test("a blank deployment override falls back to the default path", async (t) => {
  const dir = await tempDir(t);
  const result = await prepareDesktopMediaKey(dir, { MEDIA_SERVER_KEY_FILE: "   " }, process.platform);
  assert.equal(result, keyPath(dir));
  assert.equal((await lstat(result)).isFile(), true);
});

test("an existing key is never rewritten, even when it is corrupt", async (t) => {
  const dir = await tempDir(t);
  const intended = keyPath(dir);
  await writeFile(intended, Buffer.from("short"), { mode: 0o600 });
  assert.equal(await prepareDesktopMediaKey(dir, {}, process.platform), intended);
  assert.deepEqual(await readFile(intended), Buffer.from("short"));
});

test("an existing key with loose permissions is not repaired", async (t) => {
  const dir = await tempDir(t);
  const intended = keyPath(dir);
  const bytes = randomBytes(32);
  await writeFile(intended, bytes, { mode: 0o644 });
  assert.equal(await prepareDesktopMediaKey(dir, {}, process.platform), intended);
  assert.deepEqual(await readFile(intended), bytes);
  if (process.platform !== "win32") assert.equal((await lstat(intended)).mode & 0o777, 0o644);
});

test("a symlink where the key belongs is left alone", async (t) => {
  const dir = await tempDir(t);
  const target = path.join(dir, "elsewhere");
  await writeFile(target, randomBytes(32));
  await symlink(target, keyPath(dir));
  assert.equal(await prepareDesktopMediaKey(dir, {}, process.platform), keyPath(dir));
  assert.equal((await lstat(keyPath(dir))).isSymbolicLink(), true);
});

test("a bound secretRef in the state stops a fresh key", async (t) => {
  const dir = await tempDir(t);
  await mkdir(instanceDir(dir), { recursive: true });
  await writeFile(path.join(instanceDir(dir), "state.json"),
    JSON.stringify({ version: 3, mediaConnections: [{ id: "connection-1", secretRef: "msecret_00000000000000000000000000000001" }] }));
  assert.equal(await prepareDesktopMediaKey(dir, {}, process.platform), keyPath(dir));
  assert.equal(await exists(keyPath(dir)), false);
});

test("a non-empty vault stops a fresh key", async (t) => {
  const dir = await tempDir(t);
  await mkdir(vaultDir(dir), { recursive: true });
  await writeFile(path.join(vaultDir(dir), "msecret_00000000000000000000000000000002"), "envelope");
  assert.equal(await prepareDesktopMediaKey(dir, {}, process.platform), keyPath(dir));
  assert.equal(await exists(keyPath(dir)), false);
});

test("an empty vault and a state without media fields still allow a first key", async (t) => {
  const dir = await tempDir(t);
  await mkdir(vaultDir(dir), { recursive: true });
  await writeFile(path.join(instanceDir(dir), "state.json"), JSON.stringify({ version: 3, addons: [] }));
  const intended = await prepareDesktopMediaKey(dir, {}, process.platform);
  assert.equal((await lstat(intended)).isFile(), true);
});

test("a state that binds no secret and an empty connection list allow a first key", async (t) => {
  const dir = await tempDir(t);
  await mkdir(instanceDir(dir), { recursive: true });
  await writeFile(path.join(instanceDir(dir), "state.json"),
    JSON.stringify({ version: 3, mediaConnections: [{ id: "connection-1", name: "Living room" }] }));
  const intended = await prepareDesktopMediaKey(dir, {}, process.platform);
  assert.equal((await lstat(intended)).isFile(), true);
});

test("a malformed state declines creation", async (t) => {
  const dir = await tempDir(t);
  await mkdir(instanceDir(dir), { recursive: true });
  await writeFile(path.join(instanceDir(dir), "state.json"), "{ not json");
  assert.equal(await prepareDesktopMediaKey(dir, {}, process.platform), keyPath(dir));
  assert.equal(await exists(keyPath(dir)), false);
});

test("an unreadable state path declines creation", async (t) => {
  const dir = await tempDir(t);
  await mkdir(path.join(instanceDir(dir), "state.json"), { recursive: true });
  assert.equal(await prepareDesktopMediaKey(dir, {}, process.platform), keyPath(dir));
  assert.equal(await exists(keyPath(dir)), false);
});

test("a symlinked state declines creation", async (t) => {
  const dir = await tempDir(t);
  await mkdir(instanceDir(dir), { recursive: true });
  const real = path.join(dir, "real-state.json");
  await writeFile(real, JSON.stringify({ version: 3 }));
  await symlink(real, path.join(instanceDir(dir), "state.json"));
  assert.equal(await prepareDesktopMediaKey(dir, {}, process.platform), keyPath(dir));
  assert.equal(await exists(keyPath(dir)), false);
});

test("an unexpected vault path declines creation", async (t) => {
  const first = await tempDir(t);
  await mkdir(instanceDir(first), { recursive: true });
  await writeFile(vaultDir(first), "not a directory");
  assert.equal(await prepareDesktopMediaKey(first, {}, process.platform), keyPath(first));
  assert.equal(await exists(keyPath(first)), false);

  const second = await tempDir(t);
  await mkdir(instanceDir(second), { recursive: true });
  await mkdir(path.join(second, "real-vault"));
  await symlink(path.join(second, "real-vault"), vaultDir(second), "junction");
  assert.equal(await prepareDesktopMediaKey(second, {}, process.platform), keyPath(second));
  assert.equal(await exists(keyPath(second)), false);
});

test("a symlinked instance declines creation", async (t) => {
  const dir = await tempDir(t);
  await mkdir(path.join(dir, "real-instance"), { recursive: true });
  await symlink(path.join(dir, "real-instance"), instanceDir(dir), "junction");
  assert.equal(await prepareDesktopMediaKey(dir, {}, process.platform), keyPath(dir));
  assert.equal(await exists(keyPath(dir)), false);
});

test("a user-data directory that is a symlink or a file declines creation", async (t) => {
  const linked = await tempDir(t);
  const real = path.join(linked, "real");
  await mkdir(real);
  const linkDir = path.join(linked, "link");
  await symlink(real, linkDir, "junction");
  const viaLink = await prepareDesktopMediaKey(linkDir, {}, process.platform);
  assert.equal(viaLink, path.join(linkDir, MEDIA_SERVER_KEY_NAME));
  assert.equal(await exists(path.join(linkDir, MEDIA_SERVER_KEY_NAME)), false);
  assert.deepEqual(await readdir(real), [], "nothing is written through the link");

  const file = await tempDir(t);
  const asFile = path.join(file, "userData");
  await writeFile(asFile, "occupied");
  assert.equal(await prepareDesktopMediaKey(asFile, {}, process.platform), path.join(asFile, MEDIA_SERVER_KEY_NAME));
  assert.equal(await exists(path.join(asFile, MEDIA_SERVER_KEY_NAME)), false);
});

test("a decline logs one generic line and never any key material", async (t) => {
  const dir = await tempDir(t);
  await mkdir(vaultDir(dir), { recursive: true });
  await writeFile(path.join(vaultDir(dir), "msecret_00000000000000000000000000000003"), "envelope");
  const logs: string[] = [];
  await prepareDesktopMediaKey(dir, {}, process.platform, (line) => logs.push(line));
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /not created/);
  assert.equal(logs[0]!.includes(dir), false, "no path from the install leaks into the log");
  assert.equal(/[A-Za-z0-9+/]{43}=/.test(logs[0]!), false, "no base64 key material in the log");
  assert.equal(/[0-9a-f]{64}/.test(logs[0]!), false, "no hex key material in the log");
});

test("a successful first run and a deployment override log nothing", async (t) => {
  const dir = await tempDir(t);
  const first: string[] = [];
  await prepareDesktopMediaKey(dir, {}, process.platform, (line) => first.push(line));
  assert.deepEqual(first, []);
  const override: string[] = [];
  await prepareDesktopMediaKey(dir, { MEDIA_SERVER_KEY_FILE: "/run/secrets/key" }, process.platform, (line) => override.push(line));
  assert.deepEqual(override, []);
});
