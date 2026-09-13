import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createLibraryProbe } from "./library-probe.js";

const temp = async (t: { after: (fn: () => Promise<void>) => void }) => {
  const dir = await mkdtemp(path.join(tmpdir(), "probe-"));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  return dir;
};

test("a writable directory is reachable and writable", async (t) => {
  const dir = await temp(t);
  const probe = createLibraryProbe();
  assert.deepEqual(await probe.probe(dir), { unreachable: false, readOnly: false });
  assert.deepEqual(await probe.probe(path.join(dir, "missing")), { unreachable: true, readOnly: false });
  await writeFile(path.join(dir, "file.mkv"), "");
  assert.deepEqual(await probe.probe(path.join(dir, "file.mkv")), { unreachable: true, readOnly: false }, "a root is a directory");
});

test("a directory that refuses the probe file reads as read-only", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root writes anywhere");
  const dir = await temp(t);
  await chmod(dir, 0o500);
  const probe = createLibraryProbe();
  assert.deepEqual(await probe.probe(dir), { unreachable: false, readOnly: true });
});

test("the answer is cached until the TTL passes", async (t) => {
  const dir = await temp(t);
  let clock = 1_000;
  const probe = createLibraryProbe({ ttlMs: 30_000, now: () => clock });
  assert.deepEqual(await probe.cached(dir), { unreachable: false, readOnly: false });

  await rm(dir, { recursive: true, force: true });
  assert.deepEqual(await probe.cached(dir), { unreachable: false, readOnly: false }, "the poll does not stat the mount again");

  clock += 30_000;
  assert.deepEqual(await probe.cached(dir), { unreachable: true, readOnly: false });
});

test("an operation that failed on I/O drops the cached answer", async (t) => {
  const dir = await temp(t);
  const probe = createLibraryProbe();
  assert.deepEqual(await probe.cached(dir), { unreachable: false, readOnly: false });
  await rm(dir, { recursive: true, force: true });
  probe.invalidate(dir);
  assert.deepEqual(await probe.cached(dir), { unreachable: true, readOnly: false });
});
