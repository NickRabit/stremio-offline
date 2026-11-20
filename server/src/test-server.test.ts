import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnServer } from "./test-server.js";

test("a server that does not listen in time reports how long it ran and what it wrote to stdout", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "spawn-timeout-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // The server logs to stdout, so a boot that stalls has its last step only there: a failure
  // that showed stderr alone said nothing about where a 30-second Windows boot stopped.
  await assert.rejects(
    spawnServer({ DATA_DIR: path.join(dir, "data"), DOWNLOAD_DIR: path.join(dir, "downloads") }, 1),
    (error: Error) => {
      assert.match(error.message, /Timed out waiting for the server to listen after \d+ ms/);
      assert.match(error.message, /--- stdout ---/);
      assert.match(error.message, /--- stderr ---/);
      return true;
    },
  );
});
