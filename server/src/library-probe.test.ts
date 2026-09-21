import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createLibraryProbe, sameVolumeEntry, type LibraryHealth } from "./library-probe.js";

const temp = async (t: { after: (fn: () => Promise<void>) => void }) => {
  const dir = await mkdtemp(path.join(tmpdir(), "probe-"));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  return dir;
};

/** The two facts the callers of the health have always read, apart from the root and the fold. */
const standing = (health: LibraryHealth) => ({ unreachable: health.unreachable, readOnly: health.readOnly });

/** What the process would guess about a volume it could not ask. */
const platformGuess = process.platform === "win32" || process.platform === "darwin";

test("a writable directory is reachable and writable", async (t) => {
  const dir = await temp(t);
  const probe = createLibraryProbe();
  assert.deepEqual(standing(await probe.probe(dir)), { unreachable: false, readOnly: false });
  assert.deepEqual(standing(await probe.probe(path.join(dir, "missing"))), { unreachable: true, readOnly: false });
  await writeFile(path.join(dir, "file.mkv"), "");
  assert.deepEqual(standing(await probe.probe(path.join(dir, "file.mkv"))), { unreachable: true, readOnly: false }, "a root is a directory");
});

test("the probe file is written once and taken away again", async (t) => {
  const dir = await temp(t);
  const probe = createLibraryProbe();
  await probe.probe(dir);
  assert.deepEqual((await readdir(dir)).filter((name) => name.startsWith(".stremio-offline-")), [],
    "the case question rides on the writability probe rather than on a file of its own");
});

test("the answer carries the folder the root really is", async (t) => {
  const dir = await temp(t);
  const target = path.join(dir, "Media");
  const link = path.join(dir, "alias");
  await mkdir(target, { recursive: true });
  await symlink(target, link);
  const probe = createLibraryProbe();
  assert.equal((await probe.probe(target)).realRoot, await realpath(target));
  assert.equal((await probe.probe(link)).realRoot, await realpath(target), "a root reached through a symlink is the folder it points at");
  const missing = path.join(dir, "missing");
  assert.equal((await probe.probe(missing)).realRoot, path.resolve(missing), "a root that cannot be reached is answered as it is spelled");
});

test("the fold is read off the volume, not off the platform", async (t) => {
  const dir = await temp(t);
  const probe = createLibraryProbe();
  const health = await probe.probe(dir);
  // Measured by hand, on the same volume and outside the probe: macOS and Windows fold case,
  // Linux does not, and a bind mount of one inside the other answers for the volume it is.
  const file = path.join(dir, "MixedCaseProbe.tmp");
  await writeFile(file, "");
  const flipped = await stat(path.join(dir, "mixedcaseprobe.tmp")).catch(() => undefined);
  assert.equal(health.caseInsensitive, Boolean(flipped), "this volume folds");
});

test("a root that could not be asked falls back to the platform guess", async (t) => {
  const dir = await temp(t);
  await chmod(dir, 0o500);
  const probe = createLibraryProbe();
  const missing = path.join(dir, "missing");
  assert.equal((await probe.probe(missing)).caseInsensitive, platformGuess, "nothing reached the disk");
  if (process.getuid?.() === 0) return;
  assert.equal((await probe.probe(dir)).caseInsensitive, platformGuess, "a read-only volume cannot be probed either");
});

test("the case rule is one inode on one volume, driven both ways", () => {
  const entry = { ino: 42, dev: 7 };
  assert.equal(sameVolumeEntry(entry, { ino: 42, dev: 7 }), true, "the same file under the other spelling");
  assert.equal(sameVolumeEntry(entry, { ino: 43, dev: 7 }), false, "another inode on the same volume");
  assert.equal(sameVolumeEntry(entry, { ino: 42, dev: 8 }), false, "the same number on another volume");
  assert.equal(sameVolumeEntry(entry, undefined), false, "a spelling that is not there is another name");
  assert.equal(sameVolumeEntry(undefined, entry), false, "and so is one that was never written");
});

test("a directory that refuses the probe file reads as read-only", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root writes anywhere");
  const dir = await temp(t);
  await chmod(dir, 0o500);
  const probe = createLibraryProbe();
  assert.deepEqual(standing(await probe.probe(dir)), { unreachable: false, readOnly: true });
});

test("the answer is cached until the TTL passes", async (t) => {
  const dir = await temp(t);
  let clock = 1_000;
  const probe = createLibraryProbe({ ttlMs: 30_000, now: () => clock });
  assert.deepEqual(standing(await probe.cached(dir)), { unreachable: false, readOnly: false });

  await rm(dir, { recursive: true, force: true });
  assert.deepEqual(standing(await probe.cached(dir)), { unreachable: false, readOnly: false }, "the poll does not stat the mount again");

  clock += 30_000;
  assert.deepEqual(standing(await probe.cached(dir)), { unreachable: true, readOnly: false });
});

test("an operation that failed on I/O drops the cached answer", async (t) => {
  const dir = await temp(t);
  const probe = createLibraryProbe();
  assert.deepEqual(standing(await probe.cached(dir)), { unreachable: false, readOnly: false });
  await rm(dir, { recursive: true, force: true });
  probe.invalidate(dir);
  assert.deepEqual(standing(await probe.cached(dir)), { unreachable: true, readOnly: false });
});
