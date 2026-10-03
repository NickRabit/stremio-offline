import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { spawnServer, type SpawnedServer } from "./test-server.js";
import { SCHEMA_VERSION } from "./store.js";

/** `matchLibraryItem` lives in `index.ts` with no unit seam, so binding a folder is driven
 *  over HTTP against a booted server, which is also how the interface reaches it. */

const libraryId = "lib_12345678";

interface LibraryMetaFile {
  meta: Record<string, { type: string; id: string; source?: string; locked?: boolean }>;
  suggestions: Record<string, { type: string; id: string; name: string; score: number }>;
}

let workDir: string;
let dataDir: string;
let root: string;
let server: SpawnedServer;
let base = "";
let cookie = "";

const api = (pathname: string, init: { method?: string; body?: unknown } = {}) =>
  fetch(`${base}${pathname}`, {
    method: init.method ?? "GET",
    headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

const storedMeta = async (): Promise<LibraryMetaFile | undefined> => {
  const raw = await readFile(path.join(dataDir, "library", `${libraryId}.json`), "utf8").catch(() => undefined);
  return raw ? JSON.parse(raw) as LibraryMetaFile : undefined;
};

const waitForMeta = async (accept: (file: LibraryMetaFile) => boolean, timeout = 10_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const file = await storedMeta();
    if (file && accept(file)) return file;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the metadata was never written");
};

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "stremio-bind-"));
  dataDir = path.join(workDir, "data");
  const granted = path.join(workDir, "roots");
  root = path.join(granted, "Serie");
  await mkdir(path.join(root, "Show", "01 serie"), { recursive: true });
  await writeFile(path.join(root, "Show", "01 serie", "01.mkv"), "x");
  await writeFile(path.join(root, "Show", "01 serie", "02.mkv"), "x");
  await mkdir(dataDir, { recursive: true });
  // One series library, plus what a finished scan leaves behind: a scan row for the season
  // folder, its proposal, and a person's own row on one episode.
  await writeFile(path.join(dataDir, "state.json"), JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    libraries: [{
      id: libraryId, name: "Serie", type: "series", root, enabled: true, order: 0,
      addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: false,
    }],
    addons: [],
    defaultsInstalled: true,
    settings: { defaultMovieLibrary: libraryId, defaultSeriesLibrary: libraryId },
  }, null, 2));
  await mkdir(path.join(dataDir, "library"), { recursive: true });
  await writeFile(path.join(dataDir, "library", `${libraryId}.json`), JSON.stringify({
    version: 1,
    meta: {
      "Show/01 serie": { type: "series", id: "tt-old", source: "scan", locked: false },
      "Show/01 serie/02.mkv": { type: "series", id: "tt-old", source: "user", locked: true },
    },
    suggestions: {
      "Show/01 serie": { type: "series", id: "tt-old", name: "Show", score: 90 },
    },
  }, null, 2));
  server = await spawnServer({
    DATA_DIR: dataDir,
    DOWNLOAD_DIR: path.join(workDir, "downloads"),
    LIBRARY_ROOTS: granted,
    LIBRARY_AUTO_SCAN: "0",
    ADDON_AUTO_REFRESH: "0",
  });
  base = server.base;
  const setup = await api("/api/auth/setup", { method: "POST", body: { username: "binder", password: "bind-password" } });
  assert.equal(setup.status, 201, `could not create the account\n${server.log()}`);
  cookie = setup.headers.getSetCookie()[0]!.split(";")[0]!;
});

after(async () => {
  await server?.stop();
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

test("binding a show folder clears the automatic rows inside it and keeps a person's", async () => {
  const response = await api("/api/library/match", { method: "POST", body: { path: `${libraryId}/Show`, type: "series", id: "tt1" } });
  assert.equal(response.status, 200, `${await response.text()}\n${server.log()}`);
  const file = await waitForMeta((candidate) => candidate.meta.Show?.id === "tt1");
  assert.equal(file.meta["Show/01 serie"], undefined, "the scan row of the season folder goes");
  assert.equal(file.suggestions["Show/01 serie"], undefined, "and its proposal");
  assert.equal(file.meta["Show/01 serie/02.mkv"]?.id, "tt-old", "a person's own row stays");
});
