import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { preserveDamaged, readStateFile } from "./state-file.js";

const tempDir = () => mkdtemp(path.join(tmpdir(), "state-file-"));

test("an absent file reads as absent", async () => {
  const dir = await tempDir();
  try {
    assert.deepEqual(await readStateFile(path.join(dir, "missing.json")), { kind: "absent" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a file reads back its bytes", async () => {
  const dir = await tempDir();
  try {
    const file = path.join(dir, "state.json");
    await writeFile(file, "hello");
    assert.deepEqual(await readStateFile(file), { kind: "read", raw: "hello" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a directory at the path is unreadable and not absent", async () => {
  const dir = await tempDir();
  try {
    const file = path.join(dir, "state.json");
    await mkdir(file);
    const result = await readStateFile(file);
    assert.equal(result.kind, "unreadable");
    assert.notEqual((result as { error: NodeJS.ErrnoException }).error.code, "ENOENT");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("preserveDamaged keeps the exact bytes beside the file", async () => {
  const dir = await tempDir();
  try {
    const file = path.join(dir, "state.json");
    const now = new Date("2026-10-05T12:34:56.789Z");
    const first = await preserveDamaged(file, "the original bytes", now);
    assert.equal(path.dirname(first), dir);
    assert.match(path.basename(first), /^state\.json\.damaged-2026-10-05T12-34-56-789Z-[0-9a-f]{6}$/);
    assert.equal(await readFile(first, "utf8"), "the original bytes");
    if (process.platform !== "win32") assert.equal((await stat(first)).mode & 0o777, 0o600);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("two preserveDamaged calls in the same millisecond produce two files", async () => {
  const dir = await tempDir();
  try {
    const file = path.join(dir, "state.json");
    const now = new Date("2026-10-05T12:34:56.789Z");
    const first = await preserveDamaged(file, "one", now);
    const second = await preserveDamaged(file, "two", now);
    assert.notEqual(first, second);
    assert.equal(await readFile(first, "utf8"), "one");
    assert.equal(await readFile(second, "utf8"), "two");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
