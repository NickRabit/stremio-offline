import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnServer } from "./test-server.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const until = async (condition: () => boolean, message: string, timeout = 5_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(10);
  }
  throw new Error(message);
};

test("/api/status answers while the FFmpeg capability probe is still running", { skip: process.platform === "win32" }, async (t) => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "startup-capabilities-"));
  t.after(() => rm(workDir, { recursive: true, force: true }));
  const dataDir = path.join(workDir, "data");
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "state.json"), JSON.stringify({
    schemaVersion: 3,
    addons: [],
    defaultsInstalled: true,
    settings: {},
    libraries: [],
    users: [],
    userData: {},
  }));

  const fake = path.join(workDir, "ffmpeg");
  const count = path.join(workDir, "version-count");
  const complete = path.join(workDir, "version-complete");
  // The probe answers when the test says so, not after a timer a busy runner could outlast.
  const gate = path.join(workDir, "release-version");
  await writeFile(fake, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("-version")) {
  fs.appendFileSync(${JSON.stringify(count)}, "version\\n");
  const wait = () => {
    if (!fs.existsSync(${JSON.stringify(gate)})) { setTimeout(wait, 20); return; }
    fs.writeFileSync(${JSON.stringify(complete)}, "done");
    process.stdout.write("ffmpeg version 7.1.1 Copyright (c) 2000-2025 the FFmpeg developers\\n--enable-libx264\\n");
  };
  wait();
} else {
  process.stderr.write("encoder probe failed\\n");
  process.exit(1);
}
`);
  await chmod(fake, 0o755);

  const server = await spawnServer({
    DATA_DIR: dataDir,
    DOWNLOAD_DIR: path.join(workDir, "downloads"),
    FFMPEG_PATH: fake,
    VAAPI_DEVICE: "",
    VIDEOTOOLBOX: "0",
    LIBRARY_AUTO_SCAN: "0",
    ADDON_AUTO_REFRESH: "0",
    ADMIN_USERNAME: "ada",
    ADMIN_PASSWORD: "startup-password",
  });
  try {
    await until(() => existsSync(count), "the capability probe never started");
    assert.equal(existsSync(complete), false, "the version probe is still sleeping");
    const response = await fetch(`${server.base}/api/status`);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { status?: string }).status, "ok");
    assert.equal(existsSync(complete), false, "status answered before the capability probe settled");
    assert.equal((await readFile(count, "utf8")).trim().split("\n").length, 1);
  } finally {
    await writeFile(gate, "");
    await until(() => existsSync(complete), "the capability probe did not finish");
    await server.stop();
  }
});
