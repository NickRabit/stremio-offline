import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnServer } from "./test-server.js";

test("/api/status reports the search feature as off when the variable is unset", async (t) => {
  const previous = process.env.SEARCH_EVERYWHERE_ENABLED;
  delete process.env.SEARCH_EVERYWHERE_ENABLED;
  t.after(() => {
    if (previous === undefined) delete process.env.SEARCH_EVERYWHERE_ENABLED;
    else process.env.SEARCH_EVERYWHERE_ENABLED = previous;
  });

  const workDir = await mkdtemp(path.join(tmpdir(), "search-flag-"));
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
  const server = await spawnServer({
    DATA_DIR: dataDir,
    DOWNLOAD_DIR: path.join(workDir, "downloads"),
    LIBRARY_AUTO_SCAN: "0",
    ADDON_AUTO_REFRESH: "0",
    ADMIN_USERNAME: "ada",
    ADMIN_PASSWORD: "flag-password",
  });
  try {
    const response = await fetch(`${server.base}/api/status`);
    assert.equal(response.status, 200);
    const body = await response.json() as { status?: string; searchEverywhere?: boolean };
    assert.equal(body.status, "ok");
    assert.equal(body.searchEverywhere, false);

    const login = await fetch(`${server.base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ada", password: "flag-password" }),
    });
    assert.equal(login.status, 200, server.log());
    const cookie = login.headers.getSetCookie()[0]!.split(";")[0]!;
    const preferences = await fetch(`${server.base}/api/search/preferences`, { headers: { cookie } });
    assert.equal(preferences.status, 404, "the new read route is absent while the flag is off");
    const start = await fetch(`${server.base}/api/search/everywhere`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        query: "alien", kind: "all", sources: ["catalog"], slotId: "slot_12345678", generation: 1,
      }),
    });
    assert.equal(start.status, 404, "the session route is absent while the flag is off");
  } finally {
    await server.stop();
    await rm(workDir, { recursive: true, force: true });
  }
});
