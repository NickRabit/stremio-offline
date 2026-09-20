import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import express from "express";
import { messageKeyOf } from "../errors.js";
import { relativeWithin, resolveLibraryPath, type LibraryRecord } from "../libraries.js";
import type { LibraryAutoScan } from "../library-autoscan.js";
import type { LibraryMetaRecord, LibrarySuggestion } from "../library-match.js";
import type { LibraryMetaStore } from "../library-meta-store.js";
import type { LibraryOp, LibraryOps } from "../library-ops.js";
import { LibraryScan } from "../library-scan.js";
import { mediaResources, type ResourceOwner } from "../media-resources.js";
import type { Store, UserPrefs } from "../store.js";
import type { UserRecord } from "../users.js";
import { registerCurateRoutes, type CurateDeps } from "./curate.js";

const instancePrefs: UserPrefs = {
  uiLanguage: "en", audioLanguage: "en", subtitleLanguage: "en", downloadTitleLanguage: "ui",
  mergeByName: false, streamSort: "recommended", trackProgress: true, showResumeRow: true,
  catalogTileSize: "medium", libraryTileSize: "medium", catalogTileShape: "poster", libraryTileShape: "poster",
};

/** What a request answers with. The instance default above is English, so a handler that
 *  read a preference with no request in hand cannot reach this one. */
const callerPrefs: UserPrefs = { ...instancePrefs, uiLanguage: "cs" };

interface Calls {
  cancelled: string[];
  enqueued: LibraryOp[];
  invalidated: number;
  matched: Array<{ body: Record<string, unknown>; language: string | undefined }>;
  remembered: number;
  unitWalks: number;
}

interface Harness {
  base: string;
  calls: Calls;
  pendingOps: Set<string>;
  scan: LibraryScan;
  close(): Promise<void>;
}

const library = (id: string, root: string, order = 0): LibraryRecord => ({
  id, name: `Library ${id}`, type: "mixed", root, enabled: true, order,
  addedAt: "2024-01-01T00:00:00.000Z", writeArtwork: false,
});

const put = async (root: string, relative: string) => {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), "video");
};

const makeRoot = (prefix: string) => mkdtemp(path.join(tmpdir(), prefix));

/** The scan is the module's own, held in a paused state by a busy host so the run it starts
 *  stays the run a second request meets. Everything else is a fake that records the calls. */
const ADA = "usr_00000001";

const mount = async (options: { libraries?: LibraryRecord[]; records?: Record<string, LibraryMetaRecord>; suggestions?: Record<string, LibrarySuggestion> } = {}): Promise<Harness> => {
  const libraries = options.libraries ?? [library("lib_00000001", "/media/films")];
  const calls: Calls = { cancelled: [], enqueued: [], invalidated: 0, matched: [], remembered: 0, unitWalks: 0 };
  const pendingOps = new Set(["job_1", "job_2"]);
  const dataDir = await makeRoot("stremio-curate-");
  const scan = new LibraryScan({
    dataDir,
    units: async () => { calls.unitWalks += 1; return []; },
    searchAll: async () => ({ items: [] }),
    metadata: async () => null,
    addons: () => [],
    libraryMeta: () => ({}),
    librarySuggestions: () => ({}),
    updateMeta: async () => undefined,
    savePoster: () => undefined,
    deleteGeneratedArt: async () => undefined,
    busy: () => "playback",
    pathExists: async () => true,
    gapMs: 5,
    wakeMs: 20,
  });
  const deps: CurateDeps = {
    store: { libraries: () => libraries, settings: () => ({ tmdbApiKey: undefined }) } as unknown as Store,
    needsSetup: () => false,
    currentSession: () => undefined,
    // A real account, so the owner an operation carries is a value the test can see.
    currentUser: () => ({ id: ADA, username: "ada", role: "admin" } as UserRecord),
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    stopUserAccess: async () => undefined,
    stopUserSessions: async () => undefined,
    requireAccess: () => undefined,
    stopContentAccess: async () => undefined,
    invalidateLibrary: () => { calls.invalidated += 1; },
    libraryAutoScan: { remember: async () => { calls.remembered += 1; } } as unknown as LibraryAutoScan,
    libraryFiles: async () => [],
    libraryOps: {
      cancel: async (id: string) => { calls.cancelled.push(id); return pendingOps.delete(id); },
      enqueue: async (operation: LibraryOp) => { calls.enqueued.push(operation); return { id: "job_new" }; },
      snapshot: () => ({ jobs: [] }),
    } as unknown as LibraryOps,
    libraryScan: scan,
    libraryTarget: async (value: string) => (await resolveLibraryPath(libraries, value))?.absolute ?? value,
    libraryUnits: async () => [],
    matchLibraryItem: async (body, language) => {
      calls.matched.push({ body: body as Record<string, unknown>, language });
      return { key: "Films/Heat.mkv", type: "movie", id: "tt1" };
    },
    metaStore: {
      qualifiedMeta: () => options.records ?? {},
      qualifiedSuggestions: () => options.suggestions ?? {},
      update: async () => undefined,
    } as unknown as LibraryMetaStore,
    ownRecord: () => undefined,
    ownerOf: (): ResourceOwner => ({ userId: "usr_00000001", sid: "sid-1", expiresAt: Date.now() + 60_000 }),
    prefsOf: (req) => (req ? callerPrefs : instancePrefs),
    refreshLibraryHealth: async () => new Map(),
    scheduleMetaBackfill: () => false,
    wirePath: (key) => (libraries.length === 1 ? relativeWithin(libraries[0]!.id, key) : key),
  };
  const app = express();
  app.use(express.json());
  registerCurateRoutes(app, deps);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 400;
    res.status(status).json({
      error: error instanceof Error ? error.message : String(error),
      messageKey: messageKeyOf(error),
    });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    calls,
    pendingOps,
    scan,
    close: async () => {
      await scan.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dataDir, { recursive: true, force: true });
    },
  };
};

const api = (base: string, pathname: string, init: { method?: string; body?: unknown } = {}) =>
  fetch(`${base}${pathname}`, {
    method: init.method ?? "GET",
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

test("POST /api/library/ops enqueues what parseLibraryOp read from the body", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const response = await api(harness.base, "/api/library/ops", {
    method: "POST",
    body: { op: "match", items: ["Films/Heat.mkv", " Films/Heat.mkv "], type: "movie", id: "tt0113277" },
  });

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { id: "job_new" });
  // The account rides along: `favorite` and `forget` write to somebody's own rows, and the
  // job is carried out long after this request is gone.
  assert.deepEqual(harness.calls.enqueued, [
    { op: "match", items: ["Films/Heat.mkv"], type: "movie", id: "tt0113277", ownerUserId: ADA },
  ]);
});

test("POST /api/library/ops refuses a malformed body before the queue sees it", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const empty = await api(harness.base, "/api/library/ops", { method: "POST", body: { op: "move", items: [], target: "Archive" } });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json() as { messageKey?: string }).messageKey, "err.missingLibraryItems");

  const unknown = await api(harness.base, "/api/library/ops", { method: "POST", body: { op: "burn", items: ["Films/Heat.mkv"] } });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json() as { messageKey?: string }).messageKey, "err.invalidLibraryOperation");

  assert.deepEqual(harness.calls.enqueued, [], "the parser refuses it, the queue is never asked");
});

test("DELETE /api/library/ops/:id cancels the named job and nothing else", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const cancelled = await api(harness.base, "/api/library/ops/job_1", { method: "DELETE" });
  assert.equal(cancelled.status, 204);
  assert.deepEqual(harness.calls.cancelled, ["job_1"]);
  assert.deepEqual([...harness.pendingOps], ["job_2"]);

  const unknown = await api(harness.base, "/api/library/ops/job_9", { method: "DELETE" });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json() as { messageKey?: string }).messageKey, "err.libraryOperationMissing");
  assert.deepEqual(harness.calls.cancelled, ["job_1", "job_9"]);
  assert.deepEqual([...harness.pendingOps], ["job_2"]);
});

test("GET /api/library/suggestions answers only what is neither bound nor skipped", async (t) => {
  const harness = await mount({
    records: {
      "lib_00000001/Films/Thief": { type: "movie", id: "tt8", source: "scan" },
      "lib_00000001/Films/Kaly": { type: "movie", id: "", source: "user", skipLookup: true },
    },
    suggestions: {
      "lib_00000001/Films/Heat": { type: "movie", id: "tt1", name: "Heat", score: 80 },
      "lib_00000001/Films/Ronin": { type: "movie", id: "tt2", name: "Ronin", score: 95 },
      "lib_00000001/Films/Thief": { type: "movie", id: "tt3", name: "Thief", score: 99 },
      "lib_00000001/Films/Kaly": { type: "movie", id: "tt4", name: "Kaly", score: 98 },
      "lib_00000001/Films/Zulu": { type: "movie", id: "", name: "", score: 97 },
    },
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/library/suggestions");

  assert.equal(response.status, 200);
  const body = await response.json() as { items: Array<{ key: string; label: string }>; total: number };
  assert.deepEqual(body.items.map((item) => [item.key, item.label]), [["Films/Ronin", "Ronin"], ["Films/Heat", "Heat"]]);
  assert.equal(body.total, 2);
});

test("POST /api/library/scan answers the run already under way instead of starting a second", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const first = await api(harness.base, "/api/library/scan", { method: "POST", body: {} });
  assert.equal(first.status, 200);
  const started = await first.json() as { status: string; startedAt?: string };
  assert.match(started.status, /^(running|paused)$/);
  assert.equal(harness.calls.unitWalks, 1, "the run walks the libraries once");
  assert.equal(harness.calls.invalidated, 1, "the walk is dropped so the run reads the tree as it is now");
  assert.equal(harness.calls.remembered, 1);

  const second = await api(harness.base, "/api/library/scan", { method: "POST", body: { force: true } });
  assert.equal(second.status, 200);
  const again = await second.json() as { startedAt?: string };
  assert.equal(harness.calls.unitWalks, 1, "no second run began");
  assert.equal(again.startedAt, started.startedAt, "the run in progress answered");

  const snapshot = await api(harness.base, "/api/library/scan");
  assert.equal((await snapshot.json() as { startedAt?: string }).startedAt, started.startedAt, "the read form answers the same run");

  const stopped = await api(harness.base, "/api/library/scan/stop", { method: "POST" });
  assert.equal(stopped.status, 204);
  assert.equal((await (await api(harness.base, "/api/library/scan")).json() as { status: string }).status, "idle");
});

test("GET next and previous step through one folder from the one registration", async (t) => {
  // One registration lists both addresses, so neither can drift from the other.
  const source = readFileSync(fileURLToPath(new URL("./curate.ts", import.meta.url)), "utf8");
  assert.equal([...source.matchAll(/app\.get\(\[[^\]]*\/api\/library\/previous\/:sourceId[^\]]*\]/g)].length, 1);

  const root = await makeRoot("stremio-curate-files-");
  await put(root, "Films/Heat.mkv");
  await put(root, "Films/Ronin.mkv");
  await put(root, "Films/Zulu.mkv");
  const harness = await mount({ libraries: [library("lib_00000001", root)] });
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const owner: ResourceOwner = { userId: "usr_00000001", sid: "sid-1", expiresAt: Date.now() + 60_000 };
  const middle = mediaResources.add({ url: "file://lib_00000001/Films/Ronin.mkv" }, owner, "source");

  const next = await api(harness.base, `/api/library/next/${middle}`);
  assert.equal(next.status, 200);
  assert.equal(next.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await next.json(), { path: "lib_00000001/Films/Zulu.mkv", title: "Zulu.mkv" });

  const previous = await api(harness.base, `/api/library/previous/${middle}`);
  assert.equal(previous.status, 200);
  assert.deepEqual(await previous.json(), { path: "lib_00000001/Films/Heat.mkv", title: "Heat.mkv" });

  const last = mediaResources.add({ url: "file://lib_00000001/Films/Zulu.mkv" }, owner, "source");
  assert.deepEqual(await (await api(harness.base, `/api/library/next/${last}`)).json(), null);

  const remote = mediaResources.add({ url: "https://example.test/Heat.mkv" }, owner, "source");
  assert.deepEqual(await (await api(harness.base, `/api/library/next/${remote}`)).json(), null, "a stream that is not a library file has no neighbour");
});

test("POST /api/library/match binds the metadata in the caller's own language", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const response = await api(harness.base, "/api/library/match", { method: "POST", body: { path: "Films/Heat.mkv", type: "movie", id: "tt0113277" } });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { key: "Films/Heat.mkv", type: "movie", id: "tt1" });
  assert.deepEqual(harness.calls.matched, [
    { body: { path: "Films/Heat.mkv", type: "movie", id: "tt0113277" }, language: "cs" },
  ]);
});

test("GET /api/library/identity describes the clicked file", async (t) => {
  const root = await makeRoot("stremio-curate-identity-");
  await put(root, "Films/Heat.mkv");
  const harness = await mount({ libraries: [library("lib_00000001", root)] });
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const response = await api(harness.base, `/api/library/identity?path=${encodeURIComponent("Films/Heat.mkv")}`);

  assert.equal(response.status, 200);
  const body = await response.json() as { path: string; key: string; file: boolean; label: string; kind: string; match: string; parsed: { title: string } };
  // The parse names the folder a file sits in, which for a film folder is the film.
  assert.deepEqual(
    [body.path, body.key, body.file, body.label, body.kind, body.match, body.parsed.title],
    ["Films/Heat.mkv", "Films/Heat.mkv", true, "Heat.mkv", "movie", "unmatched", "Films"],
  );
});

test("POST /api/library/source hands the file and its sidecars to the media resources", async (t) => {
  const root = await makeRoot("stremio-curate-source-");
  await put(root, "Films/It.mkv");
  await put(root, "Films/It.cs.srt");
  await put(root, "Films/It.en.vtt");
  await put(root, "Films/Ronin.cs.srt");
  const harness = await mount({ libraries: [library("lib_00000001", root)] });
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const response = await api(harness.base, "/api/library/source", { method: "POST", body: { path: "Films/It.mkv" } });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.json() as { kind: string; playable: boolean; behaviorHints: { filename?: string }; subtitles: Array<{ lang?: string }> };
  assert.equal(body.kind, "library");
  assert.equal(body.playable, true);
  assert.equal(body.behaviorHints.filename, "It.mkv");
  assert.deepEqual(body.subtitles.map((subtitle) => subtitle.lang).sort(), ["cs", "en"], "only the sidecars of this file, and not the neighbour's");

  const missing = await api(harness.base, "/api/library/source", { method: "POST", body: { path: "Films/Missing.mkv" } });
  assert.equal(missing.status, 404);
});
