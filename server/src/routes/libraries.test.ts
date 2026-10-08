import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { artworks } from "../artwork-cache.js";
import { messageKeyOf } from "../errors.js";
import { mergeGrants } from "../library-grants.js";
import type { LibraryMetaStore } from "../library-meta-store.js";
import type { LibraryOps } from "../library-ops.js";
import type { LibraryHealth } from "../library-probe.js";
import type { LibraryRecord, RootGrant } from "../libraries.js";
import type { Store } from "../store.js";
import type { UserRecord } from "../users.js";
import { registerLibrariesRoutes, type LibrariesDeps } from "./libraries.js";

interface Harness {
  base: string;
  /** Makes the session stop resolving, the way a sign-out everywhere or a switched-off
   *  account does. `after` lets it answer the handler's own first read and nothing after. */
  loseSession: (after: number) => void;
  disable: (id: string) => void;
  viewed: Array<{ id: string; health: LibraryHealth; stats: { titles: number; files: number; bytes: number }; admin: boolean }>;
  enqueued: unknown[];
  invalidated: string[];
  stored: () => LibraryRecord[];
  userGrants: () => RootGrant[];
  allGrants: () => RootGrant[];
  settings(): { defaultMovieLibrary: string; defaultSeriesLibrary: string };
  /** How many writes are waiting for `releaseWrites`, so a test can interleave two of them. */
  pendingWrites(): number;
  holdWrites(): void;
  /** Stops holding and lets everything held so far run. */
  resumeWrites(): void;
  releaseWrites(): void;
  close(): Promise<void>;
}

const library = (id: string, order: number): LibraryRecord => ({
  id, name: `Library ${id}`, type: "mixed", root: `/media/${id}`, enabled: true, order,
  addedAt: "2024-01-01T00:00:00.000Z", writeArtwork: false,
});

const ADA = "usr_00000001";
const BOB = "usr_00000002";
const admin = { id: ADA, username: "ada", role: "admin" } as unknown as UserRecord;
const ordinary = { id: BOB, username: "bob", role: "user" } as unknown as UserRecord;

const stats = new Map([["alpha", { titles: 3, files: 4, bytes: 5 }]]);

/** The routes take everything they need from the context, so the app here is a real express
 *  instance over fake collaborators that record what they were asked to do. */
const mount = async (
  records: LibraryRecord[] = [library("alpha", 0)],
  env: RootGrant[] = [],
  departed: Array<{ id: string; root: string; removedAt: string }> = [],
): Promise<Harness> => {
  let sessionReads: number | undefined;
  // `users` lives in the state, not only behind `store.users()`: a mutator reads the state,
  // and the write-time role check is one of the things that does.
  const state = { libraries: records, users: [admin, ordinary], grants: [] as RootGrant[], departed, settings: { defaultMovieLibrary: "", defaultSeriesLibrary: "" } };
  const viewed: Harness["viewed"] = [];
  const enqueued: unknown[] = [];
  const invalidated: string[] = [];
  // A write can be held, so two requests can both read the state before either mutator runs.
  let held: Array<() => void> = [];
  let holding = false;
  const store = {
    libraries: () => state.libraries,
    users: () => state.users,
    grants: () => state.grants,
    departed: () => state.departed,
    settings: () => state.settings,
    update: async (mutate: (value: typeof state) => void) => {
      if (holding) {
        await new Promise<void>((resolve, reject) => {
          held.push(() => { try { mutate(state); resolve(); } catch (error) { reject(error); } });
        });
        return;
      }
      mutate(state);
    },
  } as unknown as Store;
  const deps: LibrariesDeps = {
    store,
    needsSetup: () => false,
    currentSession: () => undefined,
    currentUser: (req) => {
      if (sessionReads !== undefined && sessionReads-- <= 0) return undefined;
      return req.header("x-user") === BOB ? ordinary : admin;
    },
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    stopUserSessions: async () => undefined,
    requireAccess: () => undefined,
    stopContentAccess: async () => undefined,
    grantRows: async () => mergeGrants(env, state.grants).map((grant) => ({ ...grant, writable: true })),
    healthOf: (record) => ({ unreachable: record.id === "alpha", readOnly: record.id === "beta", realRoot: record.root, caseInsensitive: false }),
    invalidateAutoScan: (libraryId) => { invalidated.push(libraryId); },
    invalidateLibrary: () => undefined,
    libraryGrants: () => mergeGrants(env, state.grants),
    libraryStats: async () => stats,
    libraryView: (record, health, totals, admin) => {
      viewed.push({ id: record.id, health, stats: totals, admin });
      return { id: record.id, name: record.name, unreachable: health.unreachable, readOnly: health.readOnly, ...totals };
    },
    progressOf: () => ({}),
    refreshLibraryHealth: async () => new Map(),
    libraryProbe: {
      probe: async (root: string) => ({ unreachable: false, readOnly: false, realRoot: root, caseInsensitive: false }),
      cached: async (root: string) => ({ unreachable: false, readOnly: false, realRoot: root, caseInsensitive: false }),
      invalidate: () => undefined,
    },
    metaStore: { qualifiedMeta: () => ({}), forget: async () => undefined } as unknown as LibraryMetaStore,
    libraryOps: { enqueue: async (operation: unknown) => { enqueued.push(operation); return { id: "op-1" }; } } as unknown as LibraryOps,
  };
  const app = express();
  app.use(express.json());
  registerLibrariesRoutes(app, deps);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error), messageKey: messageKeyOf(error) });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    viewed,
    enqueued,
    invalidated,
    stored: () => state.libraries,
    settings: () => state.settings,
    userGrants: () => state.grants,
    loseSession: (after: number) => { sessionReads = after; },
    disable: (id: string) => { state.users = state.users.map((user) => user.id === id ? { ...user, disabled: true } : user); },
    allGrants: () => mergeGrants(env, state.grants),
    pendingWrites: () => held.length,
    holdWrites: () => { holding = true; },
    releaseWrites: () => { const waiting = held; held = []; for (const run of waiting) run(); },
    resumeWrites: () => { holding = false; const waiting = held; held = []; for (const run of waiting) run(); },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

const api = (base: string, pathname: string, init: { method?: string; body?: unknown; user?: string } = {}) =>
  fetch(`${base}${pathname}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.user ? { "x-user": init.user } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

const failure = async (response: Response) => await response.json() as { error?: string; messageKey?: string };

test("GET /api/libraries passes every record through libraryView with its health and stats", async (t) => {
  const harness = await mount([library("beta", 2), library("alpha", 0)]);
  t.after(harness.close);
  const response = await api(harness.base, "/api/libraries");
  assert.equal(response.status, 200);
  const body = await response.json() as Array<{ id: string; unreachable?: boolean; readOnly?: boolean; titles?: number; files?: number; bytes?: number }>;
  assert.deepEqual(body.map((item) => item.id), ["alpha", "beta"], "the listing follows the display order");
  assert.deepEqual(body.map((item) => item.unreachable), [true, false]);
  assert.deepEqual(body.map((item) => item.readOnly), [false, true]);
  assert.deepEqual(body.map((item) => [item.titles, item.files, item.bytes]), [[3, 4, 5], [0, 0, 0]]);
  assert.deepEqual(harness.viewed.map((item) => item.id), ["alpha", "beta"]);
  assert.deepEqual(harness.viewed[0].health, { unreachable: true, readOnly: false, realRoot: "/media/alpha", caseInsensitive: false });
  assert.deepEqual(harness.viewed[0].stats, { titles: 3, files: 4, bytes: 5 });
  assert.deepEqual(harness.viewed[1].stats, { titles: 0, files: 0, bytes: 0 });
});

test("GET /api/libraries answers an ordinary user with the libraries granted to them", async (t) => {
  const harness = await mount([library("alpha", 0), { ...library("beta", 1), visibleTo: [BOB] }]);
  t.after(harness.close);

  const administrator = await (await api(harness.base, "/api/libraries")).json() as Array<{ id: string }>;
  assert.deepEqual(administrator.map((item) => item.id), ["alpha", "beta"], "an administrator sees every library");

  const user = await (await api(harness.base, "/api/libraries", { user: BOB })).json() as Array<{ id: string }>;
  assert.deepEqual(user.map((item) => item.id), ["beta"], "a user sees only what was granted to them");
});

test("GET /api/libraries tells the view whether the caller may be shown a root", async (t) => {
  const harness = await mount([{ ...library("alpha", 0), visibleTo: [BOB] }]);
  t.after(harness.close);

  await api(harness.base, "/api/libraries");
  await api(harness.base, "/api/libraries", { user: BOB });

  assert.deepEqual(harness.viewed.map((item) => item.admin), [true, false],
    "only an administrator is offered the path the library lives at on the host");
});

test("PATCH /api/libraries/:id sets visibleTo and collapses duplicates", async (t) => {
  const harness = await mount([library("alpha", 0)]);
  t.after(harness.close);
  const response = await api(harness.base, "/api/libraries/alpha", { method: "PATCH", body: { visibleTo: [BOB, BOB] } });
  assert.equal(response.status, 200);
  assert.deepEqual(harness.stored()[0]!.visibleTo, [BOB]);
});

test("PATCH /api/libraries/:id refuses an account that does not exist", async (t) => {
  const harness = await mount([library("alpha", 0)]);
  t.after(harness.close);
  const response = await api(harness.base, "/api/libraries/alpha", { method: "PATCH", body: { visibleTo: ["usr_ffffffff"] } });
  assert.equal(response.status, 400);
  const body = await failure(response);
  assert.equal(body.messageKey, "err.unknownUser");
  assert.equal(body.error, "That account does not exist.");
  assert.equal(harness.stored()[0]!.visibleTo, undefined, "a refused id leaves the library as it was");
});

test("PATCH /api/libraries/:id keeps a dormant grant the request cannot name", async (t) => {
  const harness = await mount([{ ...library("alpha", 0), visibleTo: [ADA, BOB] }]);
  t.after(harness.close);
  // ADA holds that grant from before the promotion. The dashboard hides the grant pane for an
  // administrator, so the list it sends names the ordinary accounts only, and taking the
  // request literally would throw away the one thing a demotion has to give back.
  const cleared = await api(harness.base, "/api/libraries/alpha", { method: "PATCH", body: { visibleTo: [] } });
  assert.equal(cleared.status, 200);
  assert.deepEqual(harness.stored()[0]!.visibleTo, [ADA]);

  const echoed = await api(harness.base, "/api/libraries/alpha", { method: "PATCH", body: { visibleTo: [ADA, BOB] } });
  assert.equal(echoed.status, 200, "sending the dormant id back is not a grant being made");
  assert.deepEqual(harness.stored()[0]!.visibleTo, [ADA, BOB]);
});

test("PATCH /api/libraries/:id refuses an administrator's id", async (t) => {
  const harness = await mount([library("alpha", 0)]);
  t.after(harness.close);
  const response = await api(harness.base, "/api/libraries/alpha", { method: "PATCH", body: { visibleTo: [ADA] } });
  assert.equal(response.status, 400);
  assert.equal((await failure(response)).messageKey, "err.adminAlwaysSees");
  assert.equal(harness.stored()[0]!.visibleTo, undefined);
});

test("PATCH /api/libraries/:id refuses an unknown id", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const response = await api(harness.base, "/api/libraries/nobody", { method: "PATCH", body: { name: "Renamed" } });
  assert.equal(response.status, 404);
  const body = await failure(response);
  assert.equal(body.messageKey, "err.libraryNotFound");
  assert.equal(body.error, "The library was not found.");
});

test("a PATCH that names one field leaves another a queued PATCH set", async (t) => {
  const harness = await mount([library("alpha", 0)]);
  t.after(harness.close);
  harness.holdWrites();

  // Both requests read the record before either write runs, so the second patch must not carry
  // the first one's untouched fields back over it.
  const renamed = api(harness.base, "/api/libraries/alpha", { method: "PATCH", body: { name: "Renamed" } });
  while (harness.pendingWrites() < 1) await new Promise((resolve) => setImmediate(resolve));
  const typed = api(harness.base, "/api/libraries/alpha", { method: "PATCH", body: { type: "movie" } });
  while (harness.pendingWrites() < 2) await new Promise((resolve) => setImmediate(resolve));
  harness.releaseWrites();

  const [first, second] = await Promise.all([renamed, typed]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(harness.stored()[0]!.name, "Renamed", "a field the second request never named was written over");
  assert.equal(harness.stored()[0]!.type, "movie");
});

test("a default claimed behind a queued type change is checked against the type it lands on", async (t) => {
  const harness = await mount([library("alpha", 0)]);
  t.after(harness.close);
  harness.holdWrites();

  // Both requests pass the early check over a mixed library; the first then makes it a series
  // library, and the second must not make that the default for films.
  const typed = api(harness.base, "/api/libraries/alpha", { method: "PATCH", body: { type: "series" } });
  while (harness.pendingWrites() < 1) await new Promise((resolve) => setImmediate(resolve));
  const claimed = api(harness.base, "/api/libraries/alpha", { method: "PATCH", body: { defaultMovie: true } });
  while (harness.pendingWrites() < 2) await new Promise((resolve) => setImmediate(resolve));
  harness.releaseWrites();

  const [first, second] = await Promise.all([typed, claimed]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 400);
  assert.equal((await failure(second)).messageKey, "err.libraryDefaultType");
  assert.equal(harness.stored()[0]!.type, "series");
  assert.equal(harness.settings().defaultMovieLibrary, "", "a series library became the default for films");
});

test("DELETE /api/libraries/:id refuses to remove the last library", async (t) => {
  const harness = await mount([library("only", 0)]);
  t.after(harness.close);
  const response = await api(harness.base, "/api/libraries/only", { method: "DELETE" });
  assert.equal(response.status, 409);
  assert.equal((await failure(response)).messageKey, "err.libraryLast");
  assert.deepEqual(harness.stored().map((record) => record.id), ["only"]);
});

test("DELETE /api/libraries/:id keeps the thumbnails, and forget drops the directory and its index", async (t) => {
  const keep = "lib_aaaaaaaa";
  const gone = "lib_bbbbbbbb";
  // A third library stays behind: the last one cannot be removed, and both actions here are
  // removals.
  const harness = await mount([library(keep, 0), library(gone, 1), library("lib_cccccccc", 2)]);
  const dataDir = await mkdtemp(path.join(tmpdir(), "libraries-artwork-"));
  // The route reads the artwork cache singleton, so this test points it at a temp directory
  // and puts it back afterwards; the harness itself does not expose a cache handle.
  const singleton = artworks as unknown as { dir: string };
  const previousDir = singleton.dir;
  singleton.dir = dataDir;
  t.after(async () => {
    singleton.dir = previousDir;
    await harness.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const put = async (libraryId: string) => {
    const file = artworks.file(`${libraryId}/Films/Film/Film.mkv`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "thumbnail");
    await artworks.written(file);
    return file;
  };
  const index = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(path.join(dataDir, "index.json"), "utf8")) as Record<string, unknown>;

  const kept = await put(keep);
  const dropped = await put(gone);
  await artworks.flush();

  assert.equal((await api(harness.base, `/api/libraries/${keep}`, { method: "DELETE" })).status, 204);
  assert.ok((await stat(kept)).isFile(), "removing keeps the thumbnails for a later reattachment");
  assert.ok(Object.keys(await index()).some((name) => name.startsWith(`${keep}${path.sep}`)), "and their index entries");

  assert.equal((await api(harness.base, `/api/libraries/${gone}?forget=1`, { method: "DELETE" })).status, 204);
  await artworks.flush();
  await assert.rejects(stat(dropped), "forgetting removes the library's thumbnail directory");
  assert.ok(!Object.keys(await index()).some((name) => name.startsWith(`${gone}${path.sep}`)), "and its index entries");
});

/** A root the picker would accept: inside the grant, and a real folder. */
const grantedRoot = async (name: string) => {
  const root = await mkdtemp(path.join(tmpdir(), `libraries-${name}-`));
  const folders = [path.join(root, "films"), path.join(root, "shows")];
  for (const folder of folders) await mkdir(folder);
  return { root, films: folders[0]!, shows: folders[1]! };
};

test("POST /api/libraries persists the automatic metadata switch and hands the new id over", async (t) => {
  const { root, films, shows } = await grantedRoot("create");
  const harness = await mount([library("alpha", 0)], [{ path: root, source: "env", grantedAt: "2024-01-01T00:00:00.000Z" }]);
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const off = await api(harness.base, "/api/libraries", { method: "POST", body: { name: "Films", type: "movie", root: films, autoScanMetadata: false } });
  assert.equal(off.status, 201);
  const created = harness.stored().at(-1)!;
  assert.equal(created.autoScanMetadata, false);
  assert.deepEqual(harness.invalidated, [created.id], "a fresh library gets a fresh baseline");

  const omitted = await api(harness.base, "/api/libraries", { method: "POST", body: { name: "Shows", type: "series", root: shows } });
  assert.equal(omitted.status, 201);
  const second = harness.stored().at(-1)!;
  assert.equal(second.autoScanMetadata, true, "a request that omits the switch means on");
  assert.deepEqual(harness.invalidated, [created.id, second.id]);
});

test("POST /api/libraries hands a re-added folder's remembered id to the scanner", async (t) => {
  const { root, films } = await grantedRoot("resume");
  const real = await realpath(films);
  const harness = await mount(
    [library("alpha", 0)],
    [{ path: root, source: "env", grantedAt: "2024-01-01T00:00:00.000Z" }],
    [{ id: "lib_deadbeef", root: real, removedAt: new Date().toISOString() }],
  );
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });

  const response = await api(harness.base, "/api/libraries", { method: "POST", body: { name: "Back", type: "mixed", root: films } });
  assert.equal(response.status, 201);
  assert.equal(harness.stored().at(-1)!.id, "lib_deadbeef", "the folder takes its old id back");
  assert.deepEqual(harness.invalidated, ["lib_deadbeef"]);
});

test("two creates that queued together take different display orders", async (t) => {
  const { root, films, shows } = await grantedRoot("order");
  const harness = await mount([library("alpha", 0)], [{ path: root, source: "env", grantedAt: "2024-01-01T00:00:00.000Z" }]);
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });
  harness.holdWrites();

  const first = api(harness.base, "/api/libraries", { method: "POST", body: { name: "Films", type: "movie", root: films } });
  while (harness.pendingWrites() < 1) await new Promise((resolve) => setImmediate(resolve));
  const second = api(harness.base, "/api/libraries", { method: "POST", body: { name: "Shows", type: "series", root: shows } });
  // The second one waits on the root lock, not on a held write: let it get there, then go.
  for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.pendingWrites(), 1, "a second write that changes a root waits for the first");
  harness.resumeWrites();
  await Promise.all([first, second]);

  const orders = harness.stored().map((record) => record.order).sort((a, b) => a - b);
  assert.deepEqual(orders, [0, 1, 2], "the second create took the order the first one already had");
});

test("two creates of the same folder that queued together make one library, not two", async (t) => {
  const { root, films } = await grantedRoot("twice");
  const real = await realpath(films);
  const harness = await mount(
    [library("alpha", 0)],
    [{ path: root, source: "env", grantedAt: "2024-01-01T00:00:00.000Z" }],
    [{ id: "lib_deadbeef", root: real, removedAt: new Date().toISOString() }],
  );
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });
  harness.holdWrites();

  const first = api(harness.base, "/api/libraries", { method: "POST", body: { name: "Back", type: "mixed", root: films } });
  while (harness.pendingWrites() < 1) await new Promise((resolve) => setImmediate(resolve));
  const second = api(harness.base, "/api/libraries", { method: "POST", body: { name: "Again", type: "mixed", root: films } });
  // The second one waits on the root lock, not on a held write: let it get there, then go.
  for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.pendingWrites(), 1, "a second write that changes a root waits for the first");
  harness.resumeWrites();
  const answers = await Promise.all([first, second]);

  assert.deepEqual(answers.map((answer) => answer.status).sort(), [201, 400]);
  const refused = answers.find((answer) => answer.status === 400)!;
  assert.equal(((await refused.json()) as { messageKey?: string }).messageKey, "err.libraryRootTaken");
  const ids = harness.stored().map((record) => record.id);
  assert.equal(ids.filter((id) => id === "lib_deadbeef").length, 1, "the remembered id is taken once");
  assert.equal(harness.stored().length, 2, "alpha and the one re-added folder");
});

test("two edits that move two libraries to one folder together leave one of them there", async (t) => {
  const { root, films } = await grantedRoot("both");
  const harness = await mount([library("alpha", 0), library("beta", 1)], [{ path: root, source: "env", grantedAt: "2024-01-01T00:00:00.000Z" }]);
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });
  harness.holdWrites();

  const first = api(harness.base, "/api/libraries/alpha", { method: "PATCH", body: { root: films } });
  while (harness.pendingWrites() < 1) await new Promise((resolve) => setImmediate(resolve));
  const second = api(harness.base, "/api/libraries/beta", { method: "PATCH", body: { root: films } });
  // The second one waits on the root lock, not on a held write: let it get there, then go.
  for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.pendingWrites(), 1, "a second write that changes a root waits for the first");
  harness.resumeWrites();
  const answers = await Promise.all([first, second]);

  assert.deepEqual(answers.map((answer) => answer.status).sort(), [200, 400]);
  const real = await realpath(films);
  const onFilms = harness.stored().filter((record) => record.root === films || record.root === real);
  assert.equal(onFilms.length, 1, "one library over the folder, not two");
});

test("two edits that reach one folder by two spellings together leave one library there", async (t) => {
  if (process.platform === "win32") { t.skip("a symlink needs developer mode on Windows"); return; }
  const { root, films } = await grantedRoot("alias");
  const alias = path.join(root, "alias");
  await symlink(films, alias);
  const harness = await mount([library("alpha", 0), library("beta", 1)], [{ path: root, source: "env", grantedAt: "2024-01-01T00:00:00.000Z" }]);
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });
  harness.holdWrites();

  const first = api(harness.base, "/api/libraries/alpha", { method: "PATCH", body: { root: alias } });
  while (harness.pendingWrites() < 1) await new Promise((resolve) => setImmediate(resolve));
  const second = api(harness.base, "/api/libraries/beta", { method: "PATCH", body: { root: films } });
  // The second one waits on the root lock, not on a held write: let it get there, then go.
  for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.pendingWrites(), 1, "a second write that changes a root waits for the first");
  harness.resumeWrites();
  const answers = await Promise.all([first, second]);
  assert.deepEqual(answers.map((answer) => answer.status).sort(), [200, 400], "the second spelling of the same folder is refused");
});

test("PATCH /api/libraries/:id persists the automatic metadata switch and invalidates it when it moves", async (t) => {
  const harness = await mount([library("alpha", 0)]);
  t.after(harness.close);

  const off = await api(harness.base, "/api/libraries/alpha", { method: "PATCH", body: { autoScanMetadata: false } });
  assert.equal(off.status, 200);
  assert.equal(harness.stored()[0]!.autoScanMetadata, false);
  assert.deepEqual(harness.invalidated, ["alpha"]);

  const renamed = await api(harness.base, "/api/libraries/alpha", { method: "PATCH", body: { name: "Renamed" } });
  assert.equal(renamed.status, 200);
  assert.equal(harness.stored()[0]!.autoScanMetadata, false, "a patch that does not mention the switch leaves it alone");
  assert.deepEqual(harness.invalidated, ["alpha"], "and does not buy the library a run of its own");

  const on = await api(harness.base, "/api/libraries/alpha", { method: "PATCH", body: { autoScanMetadata: true } });
  assert.equal(on.status, 200);
  assert.equal(harness.stored()[0]!.autoScanMetadata, true);
  assert.deepEqual(harness.invalidated, ["alpha", "alpha"], "switching back on gives the library a fresh baseline");

  const disabled = await api(harness.base, "/api/libraries/alpha", { method: "PATCH", body: { enabled: false } });
  assert.equal(disabled.status, 200);
  assert.deepEqual(harness.invalidated, ["alpha", "alpha", "alpha"]);
});

test("PATCH /api/libraries/:id leaves an absent switch absent, which reads as on", async (t) => {
  const harness = await mount([library("alpha", 0)]);
  t.after(harness.close);
  const response = await api(harness.base, "/api/libraries/alpha", { method: "PATCH", body: { name: "Renamed" } });
  assert.equal(response.status, 200);
  assert.equal(harness.stored()[0]!.autoScanMetadata, undefined, "a record written before the switch keeps no field");
  assert.deepEqual(harness.invalidated, []);
});

test("a non-boolean automatic metadata switch is refused on creation and on an edit", async (t) => {
  const harness = await mount([library("alpha", 0)]);
  t.after(harness.close);

  const created = await api(harness.base, "/api/libraries", { method: "POST", body: { name: "Films", type: "movie", root: "/media/films", autoScanMetadata: "no" } });
  assert.equal(created.status, 400);
  assert.equal((await failure(created)).messageKey, "err.invalidRequest");
  assert.deepEqual(harness.invalidated, [], "a refused request invalidates nothing");

  const patched = await api(harness.base, "/api/libraries/alpha", { method: "PATCH", body: { autoScanMetadata: 1 } });
  assert.equal(patched.status, 400);
  assert.equal((await failure(patched)).messageKey, "err.invalidRequest");
  assert.equal(harness.stored()[0]!.autoScanMetadata, undefined);
});

test("POST /api/libraries/grants refuses a relative path", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const response = await api(harness.base, "/api/libraries/grants", { method: "POST", body: { path: "media/films" } });
  assert.equal(response.status, 400);
  assert.equal((await failure(response)).messageKey, "err.libraryRootAbsolute");
  assert.deepEqual(harness.userGrants(), []);
});

test("DELETE /api/libraries/grants cannot remove an operator grant", async (t) => {
  const env: RootGrant[] = [{ path: "/media", source: "env", grantedAt: "2024-01-01T00:00:00.000Z" }];
  const harness = await mount([library("alpha", 0)], env);
  t.after(harness.close);
  const response = await api(harness.base, "/api/libraries/grants", { method: "DELETE", body: { path: "/media" } });
  assert.equal(response.status, 404);
  assert.equal((await failure(response)).messageKey, "err.grantNotFound");
  assert.deepEqual(harness.userGrants(), [], "the operator's grant is not the store's to drop");
  assert.deepEqual(harness.allGrants().map((grant) => grant.path), ["/media"], "the operator's grant is still in force");
});

test("revoking a grant disables only the libraries the write finds under it", async (t) => {
  const harness = await mount([{ ...library("alpha", 0), root: "/srv/media/films" }]);
  t.after(harness.close);
  harness.userGrants().push({ path: "/srv/media", source: "user", grantedAt: "2024-01-01T00:00:00.000Z" });
  harness.holdWrites();

  const revoking = api(harness.base, "/api/libraries/grants", { method: "DELETE", body: { path: "/srv/media" } });
  while (harness.pendingWrites() < 1) await new Promise((resolve) => setImmediate(resolve));
  // The library moves out of the revoked root while the revocation waits.
  harness.stored()[0]!.root = "/elsewhere/films";
  harness.releaseWrites();

  assert.equal((await revoking).status, 200);
  assert.equal(harness.stored()[0]!.enabled, true, "a library the write no longer finds under the root was switched off anyway");
});

test("POST /api/libraries/:id/reroot refuses without moveContent", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const response = await api(harness.base, "/api/libraries/alpha/reroot", { method: "POST", body: { root: "/media/moved" } });
  assert.equal(response.status, 400);
  assert.equal((await failure(response)).messageKey, "err.invalidRequest");
  assert.deepEqual(harness.enqueued, []);
});

test("the write-time check runs through the route, and refuses rather than failing", async (t) => {
  const harness = await mount([library("alpha", 0)]);
  t.after(harness.close);

  // The account is switched off after the request has already resolved its actor -- which is
  // every case the check exists for, and the point at which the session also stops resolving.
  // Reaching the write on a role that has been taken away must answer 403, and it must be the
  // refusal rather than a crash: the guard reads the captured actor against the list as it is
  // now, so neither half of the comparison can quietly be the same record.
  harness.disable(ADA);
  harness.loseSession(1);

  const response = await api(harness.base, "/api/libraries/alpha", { method: "PATCH", body: { visibleTo: [BOB] } });
  assert.equal(response.status, 403, `expected a refusal, got ${response.status}`);
  assert.equal((await failure(response)).messageKey, "err.notAllowed");
  assert.deepEqual(harness.stored()[0]?.visibleTo, undefined, "the edit landed on a role the account no longer had");
});

test("POST /api/libraries/grants adds no nested grant for a folder a grant already covers", async (t) => {
  const outer = await mkdtemp(path.join(tmpdir(), "stremio-grant-"));
  const elsewhere = await mkdtemp(path.join(tmpdir(), "stremio-grant-"));
  t.after(() => Promise.all([rm(outer, { recursive: true, force: true }), rm(elsewhere, { recursive: true, force: true })]));
  await mkdir(path.join(outer, "Films", "Kids"), { recursive: true });
  const env: RootGrant[] = [{ path: outer, source: "env", grantedAt: "2024-01-01T00:00:00.000Z" }];
  const harness = await mount([], env);
  t.after(harness.close);

  const nested = await api(harness.base, "/api/libraries/grants", { method: "POST", body: { path: path.join(outer, "Films", "Kids") } });
  assert.equal(nested.status, 201);
  assert.deepEqual(harness.userGrants(), [], "the operator's grant already reaches it");

  const outside = await api(harness.base, "/api/libraries/grants", { method: "POST", body: { path: elsewhere } });
  assert.equal(outside.status, 201);
  assert.deepEqual(harness.userGrants().map((grant) => grant.path), [path.resolve(elsewhere)]);

  const inside = await api(harness.base, "/api/libraries/grants", { method: "POST", body: { path: elsewhere + "/" } });
  assert.equal(inside.status, 201);
  assert.equal(harness.userGrants().length, 1, "asking again for the same folder adds nothing");
});
