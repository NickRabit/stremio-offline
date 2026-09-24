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
import { isPathWithin } from "../library.js";
import type { LibraryAutoScan } from "../library-autoscan.js";
import type { LibraryCandidateSource } from "../library-candidates.js";
import type { LibraryMetaRecord, LibrarySuggestion } from "../library-match.js";
import type { TitleUnit } from "../library-match.js";
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
// A real list, so the write-time role check has something to read.
const users: UserRecord[] = [{ id: ADA, username: "ada", role: "admin", secret: "ada-secret" } as UserRecord];

const mount = async (options: {
  libraries?: LibraryRecord[];
  records?: Record<string, LibraryMetaRecord>;
  suggestions?: Record<string, LibrarySuggestion>;
  units?: TitleUnit[];
  searches?: Array<{ query: string; kind: string; year: number | undefined }>;
  activeItems?: () => string[];
  onMetaUpdate?: (file: { suggestions: Record<string, LibrarySuggestion> }) => void;
} = {}): Promise<Harness> => {
  const libraries = options.libraries ?? [library("lib_00000001", "/media/films")];
  const activeItems = options.activeItems ?? (() => []);
  const calls: Calls = { cancelled: [], enqueued: [], invalidated: 0, matched: [], remembered: 0, unitWalks: 0 };
  const pendingOps = new Set(["job_1", "job_2"]);
  const dataDir = await makeRoot("stremio-curate-");
  const scan = new LibraryScan({
    dataDir,
    units: async () => { calls.unitWalks += 1; return []; },
    candidates: { searchLibraryCandidates: async () => [], resolveSelected: async (candidate) => candidate.item, galleryOf: async () => [] },
    metadata: async () => null,
    addons: () => [],
    libraryMeta: () => ({}),
    librarySuggestions: () => ({}),
    updateMeta: async () => undefined,
    savePoster: () => undefined,
    deleteGeneratedArt: async () => undefined,
    busy: () => "playback",
    pathExists: async () => true,
    automaticLibraryEnabled: () => true,
    gapMs: 5,
    wakeMs: 20,
  });
  // What the manual identity search reads: the trusted providers, with the calls recorded
  // so a test can see which of them was asked.
  const proxied = new Map<string, string>();
  const candidates: LibraryCandidateSource & { seen: Array<{ query: string; kind: string; year: number | undefined }> } = {
    seen: options.searches ?? [],
    searchLibraryCandidates: async (query, kind, year) => {
      candidates.seen.push({ query, kind, year });
      return [];
    },
    resolveSelected: async (candidate) => candidate.item,
    galleryOf: async () => [],
  };
  const deps: CurateDeps = {
    candidates,
    store: { libraries: () => libraries, users: () => users, settings: () => ({ tmdbApiKey: undefined }) } as unknown as Store,
    needsSetup: () => false,
    currentSession: () => undefined,
    // A real account, so the owner an operation carries is a value the test can see.
    currentUser: () => users[0],
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    stopUserSessions: async () => undefined,
    requireAccess: () => undefined,
    stopContentAccess: async () => undefined,
    invalidateLibrary: () => { calls.invalidated += 1; },
    libraryAutoScan: { remember: async () => { calls.remembered += 1; } } as unknown as LibraryAutoScan,
    libraryOps: {
      cancel: async (id: string) => { calls.cancelled.push(id); return pendingOps.delete(id); },
      enqueue: async (operation: LibraryOp) => { calls.enqueued.push(operation); return { id: "job_new" }; },
      snapshot: () => ({ jobs: [] }),
    } as unknown as LibraryOps,
    // The same question the server asks: is the key an active job's business, either way round.
    libraryPathBusy: async (keys) => {
      for (const key of keys) {
        const wanted = await resolveLibraryPath(libraries, key);
        if (!wanted) continue;
        for (const item of activeItems()) {
          const active = await resolveLibraryPath(libraries, item);
          if (active && (isPathWithin(active.absolute, wanted.absolute) || isPathWithin(wanted.absolute, active.absolute))) return item;
        }
      }
      return undefined;
    },
    libraryScan: scan,
    libraryTarget: async (value: string) => (await resolveLibraryPath(libraries, value))?.absolute ?? value,
    libraryUnits: async () => options.units ?? [],
    matchLibraryItem: async (body, language) => {
      calls.matched.push({ body: body as Record<string, unknown>, language });
      return { key: "Films/Heat.mkv", type: "movie", id: "tt1" };
    },
    metaStore: {
      qualifiedMeta: () => options.records ?? {},
      qualifiedSuggestions: () => options.suggestions ?? {},
      update: async (libraryId: string, mutator: (file: { meta: Record<string, LibraryMetaRecord>; suggestions: Record<string, LibrarySuggestion> }) => void) => {
        const prefix = `${libraryId}/`;
        const relative = Object.fromEntries(Object.entries(options.suggestions ?? {})
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => [key.slice(prefix.length), value]));
        const file = { meta: {}, suggestions: relative };
        mutator(file);
        options.onMetaUpdate?.(file);
      },
    } as unknown as LibraryMetaStore,
    ownRecord: () => undefined,
    ownerOf: (): ResourceOwner => ({ userId: "usr_00000001", sid: "sid-1", expiresAt: Date.now() + 60_000 }),
    prefsOf: (req) => (req ? callerPrefs : instancePrefs),
    proxyImage: (url) => {
      if (!url) return undefined;
      const known = proxied.get(url);
      if (known) return known;
      const id = `img_${proxied.size + 1}`;
      proxied.set(url, id);
      return id;
    },
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

test("POST /api/library/ops refuses what a running job covers, in either direction", async (t) => {
  const root = await makeRoot("stremio-curate-busy-");
  await put(root, "Films/Heat.mkv");
  await put(root, "Show/01.mkv");
  let active: string[] = [];
  const harness = await mount({ libraries: [library("lib_00000001", root)], activeItems: () => active });
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const enqueue = (items: string[]) => api(harness.base, "/api/library/ops", { method: "POST", body: { op: "delete", items } });

  active = ["Films/Heat.mkv"];
  const busyFile = await enqueue(["Films/Heat.mkv"]);
  assert.equal(busyFile.status, 409);
  assert.equal((await busyFile.json() as { messageKey?: string }).messageKey, "err.pathBusy");
  assert.equal((await enqueue(["Films"])).status, 409, "the folder holding a busy file waits for the same job");
  assert.equal((await enqueue(["Show/01.mkv"])).status, 202, "a job on one item covers nothing else");

  active = ["Films"];
  assert.equal((await enqueue(["Films/Heat.mkv"])).status, 409, "a folder under way covers the file inside it");

  active = [];
  const accepted = await enqueue(["Films/Heat.mkv"]);
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { id: "job_new" });
  assert.deepEqual(harness.calls.enqueued.map((operation) => operation.items), [["Show/01.mkv"], ["Films/Heat.mkv"]],
    "the queue only ever saw what no job was covering");
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
    units: [
      { key: "lib_00000001/Films/Heat", kind: "movie", relative: "Films/Heat", sampleFiles: ["Films/Heat/Heat.mkv"] },
      { key: "lib_00000001/Films/Ronin", kind: "movie", relative: "Films/Ronin", sampleFiles: ["Films/Ronin/Ronin.mkv"] },
      { key: "lib_00000001/Films/Thief", kind: "movie", relative: "Films/Thief", sampleFiles: ["Films/Thief/Thief.mkv"] },
      { key: "lib_00000001/Films/Kaly", kind: "movie", relative: "Films/Kaly", sampleFiles: ["Films/Kaly/Kaly.mkv"] },
    ],
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
  const body = await response.json() as { items: Array<{ key: string; label: string; libraryId: string; library: string; path: string }>; total: number };
  assert.deepEqual(body.items.map((item) => [item.key, item.label, item.library, item.path]), [
    ["Films/Ronin", "Ronin", "Library lib_00000001", "Films/Ronin"],
    ["Films/Heat", "Heat", "Library lib_00000001", "Films/Heat"],
  ]);
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
  const harness = await mount({
    units: [{ key: "lib_00000001/Films/Heat.mkv", kind: "movie", relative: "Films/Heat.mkv", sampleFiles: ["Films/Heat.mkv"] }],
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/library/match", { method: "POST", body: { path: "Films/Heat.mkv", type: "movie", id: "tt0113277" } });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { key: "Films/Heat.mkv", type: "movie", id: "tt1" });
  assert.deepEqual(harness.calls.matched, [
    { body: { path: "Films/Heat.mkv", type: "movie", id: "tt0113277" }, language: "cs" },
  ]);
});

test("POST /api/library/match refuses a confirmation for an item the library no longer holds", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const response = await api(harness.base, "/api/library/match", { method: "POST", body: { path: "Films/Heat.mkv", type: "movie", id: "tt0113277" } });

  assert.equal(response.status, 409);
  assert.equal((await response.json() as { messageKey?: string }).messageKey, "err.titleGone");
  assert.deepEqual(harness.calls.matched, [], "nothing reaches the binding");

  // An unmatch carries no id, so a path that is already gone can still be released.
  const released = await api(harness.base, "/api/library/match", { method: "POST", body: { path: "Films/Heat.mkv", type: "movie", id: "" } });
  assert.equal(released.status, 200);
});

test("GET /api/library/identity describes the clicked file and proxies its suggested poster", async (t) => {
  const root = await makeRoot("stremio-curate-identity-");
  await put(root, "Films/Heat.mkv");
  const harness = await mount({
    libraries: [library("lib_00000001", root)],
    suggestions: {
      "lib_00000001/Films": { type: "movie", id: "tt0111161", name: "The Shawshank Redemption", score: 92, poster: "https://image.tmdb.org/t/p/w500/poster.jpg" },
    },
  });
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const response = await api(harness.base, `/api/library/identity?path=${encodeURIComponent("Films/Heat.mkv")}`);

  assert.equal(response.status, 200);
  const body = await response.json() as { path: string; key: string; file: boolean; label: string; kind: string; match: string; parsed: { title: string }; suggestion?: { poster?: string } };
  // No unit covers the file here, so it stands for itself and the parse reads its own name.
  assert.deepEqual(
    [body.path, body.key, body.file, body.label, body.kind, body.match, body.parsed.title],
    ["Films/Heat.mkv", "Films/Heat.mkv", true, "Heat.mkv", "movie", "unmatched", "Heat"],
  );
  assert.equal(body.suggestion, undefined, "a loose file does not inherit a collection suggestion");
});

test("GET /api/library/identity reads a loose film in a collection from its own file name", async (t) => {
  const root = await makeRoot("stremio-curate-collection-");
  await put(root, "Collection/Heat (1995).mkv");
  const key = "lib_00000001/Collection/Heat (1995).mkv";
  const harness = await mount({
    libraries: [library("lib_00000001", root)],
    // The walk exposes the film as its own unit inside the collection folder.
    units: [{ key, kind: "movie", relative: "Collection/Heat (1995).mkv", sampleFiles: [key] }],
  });
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const response = await api(harness.base, `/api/library/identity?path=${encodeURIComponent("Collection/Heat (1995).mkv")}`);

  assert.equal(response.status, 200);
  const body = await response.json() as { key: string; kind: string; parsed: { title: string; query: string; year?: number } };
  assert.equal(body.key, "Collection/Heat (1995).mkv");
  assert.equal(body.kind, "movie");
  assert.deepEqual(body.parsed, { title: "Heat", query: "Heat", year: 1995 }, "the search must name the film, not the collection folder");
});

test("GET /api/library/identity lets one file's binding beat the folder unit's", async (t) => {
  const root = await makeRoot("stremio-curate-child-binding-");
  await put(root, "Heat/Heat.mkv");
  await put(root, "Heat/Heat (2).mkv");
  const folder = "lib_00000001/Heat";
  const child = "lib_00000001/Heat/Heat.mkv";
  const harness = await mount({
    libraries: [library("lib_00000001", root)],
    units: [{ key: folder, kind: "movie", relative: "Heat", sampleFiles: ["Heat/Heat.mkv", "Heat/Heat (2).mkv"] }],
    records: {
      [folder]: { type: "movie", id: "tt-heat", source: "user", locked: true, name: "Heat", year: "1995" },
      [child]: { type: "movie", id: "tt-ronin", source: "user", locked: true, name: "Ronin", year: "1998" },
    },
    suggestions: { [folder]: { type: "movie", id: "tt-suggested-heat", name: "Heat", score: 92 } },
  });
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const clicked = await api(harness.base, `/api/library/identity?path=${encodeURIComponent("Heat/Heat.mkv")}`);
  assert.equal(clicked.status, 200);
  const body = await clicked.json() as { key: string; match: string; bound?: { id: string }; suggestion?: { id: string } };
  assert.equal(body.key, "Heat", "the dialog still speaks about the unit it would rewrite");
  assert.equal(body.match, "matched");
  assert.equal(body.bound?.id, "tt-ronin", "the file's own binding answers, not the folder's");
  assert.equal(body.suggestion?.id, "tt-suggested-heat", "with no proposal of its own the file falls back to the unit's");

  const sibling = await api(harness.base, `/api/library/identity?path=${encodeURIComponent("Heat/Heat (2).mkv")}`);
  const other = await sibling.json() as { match: string; bound?: { id: string } };
  assert.equal(other.match, "matched");
  assert.equal(other.bound?.id, "tt-heat", "the sibling keeps the folder's binding");
});

test("POST /api/library/match refuses a correction when the current binding has changed", async (t) => {
  const root = await makeRoot("stremio-curate-stale-correction-");
  await put(root, "Films/Heat.mkv");
  const key = "lib_00000001/Films/Heat.mkv";
  const harness = await mount({
    libraries: [library("lib_00000001", root)],
    units: [{ key, kind: "movie", relative: "Films/Heat.mkv", sampleFiles: ["Films/Heat.mkv"] }],
    records: { [key]: { type: "movie", id: "tt-user-choice", source: "user", locked: true } },
    suggestions: { [key]: { type: "movie", id: "tt-proposed", name: "Heat", score: 95, replacesId: "tt-old-scan" } },
  });
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const response = await api(harness.base, "/api/library/match", {
    method: "POST", body: { path: "Films/Heat.mkv", type: "movie", id: "tt-proposed", replacesId: "tt-old-scan" },
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { messageKey?: string }).messageKey, "err.suggestionStale");
  assert.deepEqual(harness.calls.matched, []);
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

test("GET /api/library/suggestions scopes to one library and proxies the candidate poster", async (t) => {
  const harness = await mount({
    libraries: [library("lib_00000001", "/media/films"), library("lib_00000002", "/media/series", 1)],
    units: [
      { key: "lib_00000001/Films/Ronin", kind: "movie", relative: "Films/Ronin", sampleFiles: ["Films/Ronin/Ronin.mkv"] },
      { key: "lib_00000002/Shows/Ted", kind: "series", relative: "Shows/Ted", sampleFiles: ["Shows/Ted/01.mkv"] },
    ],
    suggestions: {
      "lib_00000001/Films/Ronin": { type: "movie", id: "tt0122690", name: "Ronin", score: 88, poster: "https://image.tmdb.org/t/p/w500/r.jpg" },
      "lib_00000002/Shows/Ted": { type: "series", id: "tt0111958", name: "Father Ted", score: 91, poster: "https://image.tmdb.org/t/p/w500/t.jpg" },
    },
  });
  t.after(harness.close);

  const all = await (await api(harness.base, "/api/library/suggestions")).json() as {
    items: Array<{ key: string; libraryId: string; library: string; path: string; suggestion: { poster?: string } }>;
    total: number;
  };
  assert.deepEqual(all.items.map((item) => [item.libraryId, item.library, item.path]), [
    ["lib_00000002", "Library lib_00000002", "Shows/Ted"],
    ["lib_00000001", "Library lib_00000001", "Films/Ronin"],
  ]);
  assert.equal(all.total, 2, "the root shows every reachable library");
  assert.match(all.items[0]!.suggestion.poster ?? "", /^img_/, "the picture goes through the proxy");
  assert.equal(JSON.stringify(all).includes("image.tmdb.org"), false);

  const one = await (await api(harness.base, "/api/library/suggestions?libraryId=lib_00000001")).json() as { items: Array<{ libraryId: string }>; total: number };
  assert.deepEqual(one.items.map((item) => item.libraryId), ["lib_00000001"]);
  assert.equal(one.total, 1);
});

test("GET /api/library/suggestions drops a proposal whose title unit is gone", async (t) => {
  const harness = await mount({
    units: [{ key: "lib_00000001/Films/Ronin", kind: "movie", relative: "Films/Ronin", sampleFiles: ["Films/Ronin/Ronin.mkv"] }],
    suggestions: {
      "lib_00000001/Films/Ronin": { type: "movie", id: "tt0122690", name: "Ronin", score: 88 },
      "lib_00000001/Films/Removed": { type: "movie", id: "tt999", name: "Removed", score: 99 },
    },
  });
  t.after(harness.close);

  const body = await (await api(harness.base, "/api/library/suggestions")).json() as { items: Array<{ key: string }>; total: number };
  assert.deepEqual(body.items.map((item) => item.key), ["Films/Ronin"]);
  assert.equal(body.total, 1, "the count is what the list shows");
});

test("GET /api/library/suggestions hides an unavailable library without losing its rows", async (t) => {
  const away = library("lib_00000002", "/media/series", 1);
  away.unreachable = true;
  const harness = await mount({
    libraries: [library("lib_00000001", "/media/films"), away],
    units: [
      { key: "lib_00000001/Films/Ronin", kind: "movie", relative: "Films/Ronin", sampleFiles: ["Films/Ronin/Ronin.mkv"] },
      { key: "lib_00000002/Shows/Ted", kind: "series", relative: "Shows/Ted", sampleFiles: ["Shows/Ted/01.mkv"] },
    ],
    suggestions: {
      "lib_00000001/Films/Ronin": { type: "movie", id: "tt0122690", name: "Ronin", score: 88 },
      "lib_00000002/Shows/Ted": { type: "series", id: "tt0111958", name: "Father Ted", score: 91 },
    },
  });
  t.after(harness.close);

  const body = await (await api(harness.base, "/api/library/suggestions")).json() as { items: Array<{ libraryId: string }>; total: number };
  assert.deepEqual(body.items.map((item) => item.libraryId), ["lib_00000001"], "an unplugged disk is not a mass deletion");
  assert.equal(body.total, 1);
});

test("GET /api/library/suggestions shows a correction beside the binding it would replace", async (t) => {
  const harness = await mount({
    records: { "lib_00000001/Films/Flashdance": { type: "movie", id: "tt-old", source: "scan", locked: false, name: "Flashdance" } },
    units: [{ key: "lib_00000001/Films/Flashdance", kind: "movie", relative: "Films/Flashdance", sampleFiles: ["Films/Flashdance/a.mkv"] }],
    suggestions: {
      "lib_00000001/Films/Flashdance": {
        type: "movie", id: "tt0085549", name: "Flashdance", year: 1983, score: 100, reason: "correction",
        replacesId: "tt-old", replacesName: "Flashdance (wrong row)",
      },
    },
  });
  t.after(harness.close);

  const body = await (await api(harness.base, "/api/library/suggestions")).json() as {
    items: Array<{ suggestion: { reason?: string; replacesId?: string; replacesName?: string } }>; total: number;
  };
  assert.equal(body.total, 1, "a correction of an unlocked scan binding is a pending proposal");
  assert.equal(body.items[0]!.suggestion.reason, "correction");
  assert.equal(body.items[0]!.suggestion.replacesId, "tt-old");
});

test("GET /api/library/search asks the trusted providers for the entered title", async (t) => {
  const seen: Array<{ query: string; kind: string; year: number | undefined }> = [];
  const harness = await mount({
    units: [{ key: "lib_00000001/Films/Heat", kind: "movie", relative: "Films/Heat", sampleFiles: ["Films/Heat/a.mkv"] }],
    searches: seen,
  });
  t.after(harness.close);

  const response = await api(harness.base, `/api/library/search?${new URLSearchParams({ path: "Films/Heat", query: "Heat", type: "movie", year: "1995" })}`);
  assert.equal(response.status, 200);
  const body = await response.json() as { items: unknown[]; total: number };
  assert.deepEqual(body, { items: [], total: 0 });
  assert.deepEqual(seen, [{ query: "Heat", kind: "movie", year: 1995 }]);

  const empty = await api(harness.base, "/api/library/search?query=");
  assert.equal(empty.status, 200);
  assert.equal(seen.length, 1, "an empty query reaches no provider");
});

test("POST /api/library/scan only rechecks automatic matches for a named library", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const refused = await api(harness.base, "/api/library/scan", { method: "POST", body: { recheckScanBindings: true } });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json() as { messageKey?: string }).messageKey, "err.recheckNeedsLibrary");

  const unknown = await api(harness.base, "/api/library/scan", { method: "POST", body: { recheckScanBindings: true, libraryId: "lib_99999999" } });
  assert.equal(unknown.status, 400);

  const accepted = await api(harness.base, "/api/library/scan", { method: "POST", body: { recheckScanBindings: true, libraryId: "lib_00000001" } });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json() as { recheck?: boolean }).recheck, true);
});

test("a proposal carries its competing candidates and a review reason, without an image address", async (t) => {
  const harness = await mount({
    units: [{ key: "lib_00000001/Films/Heat", kind: "movie", relative: "Films/Heat", sampleFiles: ["Films/Heat/Heat.mkv"] }],
    suggestions: {
      "lib_00000001/Films/Heat": {
        type: "movie", id: "tt0113277", name: "Heat", year: 1995, score: 100, titleSimilarity: 100, reason: "part",
        alternatives: [
          { type: "movie", id: "tt2", name: "Heat Part 2", year: 1997, score: 96, titleSimilarity: 94 },
        ],
      },
    },
  });
  t.after(harness.close);

  const body = await (await api(harness.base, "/api/library/suggestions")).json() as {
    items: Array<{ suggestion: { reason?: string; titleSimilarity?: number; alternatives?: Array<{ id: string; name: string }> } }>;
  };
  assert.equal(body.items[0]!.suggestion.reason, "part");
  assert.deepEqual(body.items[0]!.suggestion.alternatives?.map((item) => item.id), ["tt2"]);
  assert.equal(JSON.stringify(body).includes("image.tmdb.org"), false);
  assert.equal(JSON.stringify(body).includes("poster"), false);
});

test("dismissing a suggestion records a decision the rules will not undo", async (t) => {
  let updated: { suggestions: Record<string, { dismissed?: boolean; id: string }> } | undefined;
  const harness = await mount({
    units: [{ key: "lib_00000001/Films/Heat", kind: "movie", relative: "Films/Heat", sampleFiles: ["Films/Heat/Heat.mkv"] }],
    suggestions: { "lib_00000001/Films/Heat": { type: "movie", id: "tt0113277", name: "Heat", score: 92 } },
    onMetaUpdate: (file) => { updated = file; },
  });
  t.after(harness.close);

  const response = await api(harness.base, `/api/library/suggestion?key=${encodeURIComponent("Films/Heat")}`, { method: "DELETE" });
  assert.equal(response.status, 204);
  assert.equal(updated?.suggestions["Films/Heat"]?.dismissed, true);
  assert.equal(updated?.suggestions["Films/Heat"]?.id, "", "the binding is cleared, keeping only the memory");
  assert.equal(harness.calls.invalidated, 1);
});
