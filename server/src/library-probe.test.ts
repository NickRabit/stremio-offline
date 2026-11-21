import assert from "node:assert/strict";
import fs from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
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

const countProbeWrites = (t: { after: (fn: () => void) => void }, roots: string[]) => {
  const original = fs.promises.writeFile;
  // Compared as the volume spells them: Windows hands out short (8.3) and long forms of one path.
  const canonical = (dir: string) => { try { return fs.realpathSync.native(dir).toLowerCase(); } catch { return path.resolve(dir).toLowerCase(); } };
  const aliases = new Map(roots.map((root) => [path.resolve(root).toLowerCase(), canonical(root)]));
  const counts = new Map([...aliases.values()].map((root) => [root, 0]));
  const patched = async (...args: Parameters<typeof original>) => {
    const [file] = args;
    const name = typeof file === "string" ? path.basename(file) : "";
    if (typeof file === "string" && name.startsWith(".stremio-offline-") && name.endsWith("-Probe.tmp")) {
      const root = canonical(path.dirname(path.resolve(file)));
      if (counts.has(root)) counts.set(root, counts.get(root)! + 1);
    }
    return Reflect.apply(original, undefined, args);
  };
  const mutable = fs.promises as typeof fs.promises & { writeFile: typeof patched };
  mutable.writeFile = patched;
  syncBuiltinESMExports();
  t.after(() => {
    mutable.writeFile = original;
    syncBuiltinESMExports();
  });
  return (root: string) => counts.get(aliases.get(path.resolve(root).toLowerCase()) ?? canonical(root)) ?? 0;
};

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
  await symlink(target, link, "junction");
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

test("a root that could not be asked folds, whatever the platform would have guessed", async (t) => {
  // Deliberately not the platform guess: that is a fact about the process, and answering a
  // question about a disk with it is the mistake the probe exists to undo. It also hides
  // itself on macOS, where the guess happens to be `true` -- this assertion only bites on a
  // case-sensitive runner, which is what CI is.
  const dir = await temp(t);
  const probe = createLibraryProbe();
  const missing = path.join(dir, "missing");
  assert.equal((await probe.probe(missing)).caseInsensitive, true, "nothing reached the disk");
  // The read-only half is POSIX-only: NTFS keeps no mode that stops the probe writing.
  if (process.platform === "win32") return;
  await chmod(dir, 0o500);
  if (process.getuid?.() === 0) return;
  assert.equal((await probe.probe(dir)).caseInsensitive, true, "a read-only volume cannot be probed either");
});

test("the case rule is one inode on one volume, driven both ways", () => {
  const entry = { ino: 42, dev: 7 };
  assert.equal(sameVolumeEntry(entry, { ino: 42, dev: 7 }), true, "the same file under the other spelling");
  assert.equal(sameVolumeEntry(entry, { ino: 43, dev: 7 }), false, "another inode on the same volume");
  assert.equal(sameVolumeEntry(entry, { ino: 42, dev: 8 }), false, "the same number on another volume");
  assert.equal(sameVolumeEntry(entry, undefined), false, "a spelling that is not there is another name");
  assert.equal(sameVolumeEntry(undefined, entry), false, "and so is one that was never written");
});

test("a directory that refuses the probe file reads as read-only", {
  skip: process.platform === "win32" ? "file modes are not enforced on NTFS" : false,
}, async (t) => {
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

test("a stale read takes the older answer at once and asks the disk again behind it", async (t) => {
  const dir = await temp(t);
  let clock = 1_000;
  const probe = createLibraryProbe({ ttlMs: 30_000, now: () => clock });
  assert.equal(standing(await probe.cached(dir, { stale: true })).unreachable, false, "with nothing held, a stale read still waits");

  await rm(dir, { recursive: true, force: true });
  clock += 30_000;
  assert.equal(standing(await probe.cached(dir, { stale: true })).unreachable, false, "the view is drawn from the last answer");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(standing(await probe.cached(dir, { stale: true })).unreachable, true, "the refresh behind it has landed");
});

test("an operation that failed on I/O drops the cached answer", async (t) => {
  const dir = await temp(t);
  const probe = createLibraryProbe();
  assert.deepEqual(standing(await probe.cached(dir)), { unreachable: false, readOnly: false });
  await rm(dir, { recursive: true, force: true });
  probe.invalidate(dir);
  assert.deepEqual(standing(await probe.cached(dir)), { unreachable: true, readOnly: false });
});

test("reachability refreshes reuse successful volume facts", async (t) => {
  const dir = await temp(t);
  let clock = 1_000;
  const writes = countProbeWrites(t, [dir]);
  const probe = createLibraryProbe({ ttlMs: 30_000, now: () => clock });

  const first = await probe.cached(dir);
  assert.equal(writes(dir), 1);
  clock += 31_000;
  const second = await probe.cached(dir);

  assert.equal(writes(dir), 1);
  assert.equal(second.readOnly, first.readOnly);
  assert.equal(second.caseInsensitive, first.caseInsensitive);
});

test("volume facts are probed again after their TTL", async (t) => {
  const dir = await temp(t);
  let clock = 1_000;
  const writes = countProbeWrites(t, [dir]);
  const probe = createLibraryProbe({ ttlMs: 30_000, volumeTtlMs: 60_000, now: () => clock });

  await probe.cached(dir);
  assert.equal(writes(dir), 1);
  clock += 31_000;
  await probe.cached(dir);
  assert.equal(writes(dir), 1);
  clock += 30_000;
  await probe.cached(dir);
  assert.equal(writes(dir), 2);
});

test("invalidation drops volume facts for one root or all roots", async (t) => {
  const firstRoot = await temp(t);
  const secondRoot = await temp(t);
  let clock = 1_000;
  const writes = countProbeWrites(t, [firstRoot, secondRoot]);
  const probe = createLibraryProbe({ ttlMs: 30_000, now: () => clock });

  await probe.cached(firstRoot);
  await probe.cached(secondRoot);
  probe.invalidate(firstRoot);
  clock += 31_000;
  await probe.cached(firstRoot);
  await probe.cached(secondRoot);
  assert.equal(writes(firstRoot), 2);
  assert.equal(writes(secondRoot), 1);

  probe.invalidate();
  clock += 31_000;
  await probe.cached(firstRoot);
  await probe.cached(secondRoot);
  assert.equal(writes(firstRoot), 3);
  assert.equal(writes(secondRoot), 2);
});

test("a recovered root does not reuse volume facts from before it disappeared", async (t) => {
  const dir = await temp(t);
  let clock = 1_000;
  const writes = countProbeWrites(t, [dir]);
  const probe = createLibraryProbe({ ttlMs: 30_000, now: () => clock });

  await probe.cached(dir);
  await rm(dir, { recursive: true, force: true });
  clock += 31_000;
  assert.equal((await probe.cached(dir)).unreachable, true);
  assert.equal(writes(dir), 1);

  await mkdir(dir);
  clock += 31_000;
  assert.equal((await probe.cached(dir)).unreachable, false);
  assert.equal(writes(dir), 2);
});

test("a failed volume probe is retried on the next reachability refresh", {
  skip: process.platform === "win32"
    ? "file modes are not enforced on NTFS"
    : process.getuid?.() === 0 ? "root writes anywhere" : false,
}, async (t) => {
  const dir = await temp(t);
  let clock = 1_000;
  const writes = countProbeWrites(t, [dir]);
  const probe = createLibraryProbe({ ttlMs: 30_000, now: () => clock });

  await chmod(dir, 0o500);
  assert.equal((await probe.cached(dir)).readOnly, true);
  assert.equal(writes(dir), 1);

  await chmod(dir, 0o700);
  clock += 31_000;
  assert.equal((await probe.cached(dir)).readOnly, false);
  assert.equal(writes(dir), 2);
});

test("invalidating one root does not make another root's refresh write its probe", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-probe-other-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let clock = 0;
  const probe = createLibraryProbe({ now: () => clock });
  await probe.cached(root);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  await settle();
  const before = (await stat(root)).mtimeMs;
  clock += 31_000;
  const refreshing = probe.cached(root);
  probe.invalidate(path.join(tmpdir(), "stremio-probe-elsewhere"));
  await refreshing;
  await settle();
  assert.equal((await stat(root)).mtimeMs, before, "the held volume facts were reused");
});
