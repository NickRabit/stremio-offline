import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { DeviceTransfers } from "../device-transfers.js";
import type { DownloadQueue } from "../downloads.js";
import { AppError, messageKeyOf } from "../errors.js";
import type { LibraryRecord } from "../libraries.js";
import { defaultDownloadSettings, type MediaInfo } from "../naming.js";
import type { Store, UserPrefs } from "../store.js";
import type { DownloadTargetSettings } from "../types.js";
import type { UserRecord } from "../users.js";
import { registerDownloadRoutes, type DownloadsDeps } from "./downloads.js";

interface Harness {
  base: string;
  transfers: DeviceTransfers;
  added: Array<{ title: string; ownerUserId?: string; settings?: DownloadTargetSettings }>;
  actions: string[];
  moves: Array<{ id: string; direction: number }>;
  viewed: Array<{ id?: string; media?: MediaInfo; target?: string }>;
  pending: Array<{ selection?: { addonKeys?: string[]; targetSettings?: DownloadTargetSettings }; ownerUserId?: string }>;
  close(): Promise<void>;
}

/** A stream addon the bulk handler accepts: enabled, not a catalogue, with save rules. */
const streamAddon = (key: string, options: { enabled?: boolean; role?: string; allowedUsers?: string[] } = {}) => ({
  key,
  enabled: options.enabled ?? true,
  role: options.role ?? "source",
  ...(options.allowedUsers ? { allowedUsers: options.allowedUsers } : {}),
  manifest: { id: key, name: key },
  downloadSettings: defaultDownloadSettings(),
});

const ADA = "usr_00000001";
const BOB = "usr_00000002";

/** The folders an explicit target may name have to exist, so every library gets a real root. */
const MEDIA = mkdtempSync(path.join(tmpdir(), "routes-downloads-"));
process.on("exit", () => rmSync(MEDIA, { recursive: true, force: true }));
/** One configured library, shaped the way the store keeps it. */
const library = (id: string, type: "movie" | "series" | "mixed", extra: Partial<LibraryRecord> = {}): LibraryRecord => {
  const root = path.join(MEDIA, id);
  // "Sci-Fi  Classics" is named with two spaces on purpose: it is what the tidying a rule's
  // subfolder gets would collapse, so it proves an explicit target hands the name back as it
  // stands. A colon would say the same and is what the naming tests use, but Windows refuses
  // it in a path, and these folders are created for real.
  for (const folder of ["Kino", "S", "Sci-Fi  Classics"]) mkdirSync(path.join(root, folder), { recursive: true });
  return { id, name: id, type, root, enabled: true, order: 0, addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: true, ...extra };
};
/** A record shaped the way the store keeps one, so the flags the check must not read are on it. */
const account = (id: string, role: "admin" | "user", downloadToLibrary: boolean): UserRecord => ({
  id, username: role === "admin" ? "ada" : "bob", role, createdAt: "2026-01-01T00:00:00.000Z",
  permissions: { downloadToLibrary, downloadToDevice: true }, permissionsVersion: 0,
} as unknown as UserRecord);
/** The administrator a migrated install has: the flags say false and the role is what grants. */
const admin = account(ADA, "admin", false);
const ordinary = account(BOB, "user", true);
const denied = account(BOB, "user", false);

/** The routes take everything they need from the context, so the app here is a real express
 *  instance over fake collaborators that record what they were asked to do. */
const mount = async (
  addons: unknown[] = [streamAddon("stream-addon")],
  options: { viewer?: UserRecord; jobs?: Array<{ id: string; ownerUserId?: string }>; libraries?: unknown[] } = {},
): Promise<Harness> => {
  const jobs = options.jobs ?? [{ id: "job-1", ownerUserId: ADA }, { id: "job-2", ownerUserId: ADA }];
  const transfers = new DeviceTransfers();
  const added: Array<{ title: string; ownerUserId?: string; settings?: DownloadTargetSettings }> = [];
  const actions: string[] = [];
  const moves: Array<{ id: string; direction: number }> = [];
  const viewed: Array<{ id?: string; media?: MediaInfo; target?: string }> = [];
  const pending: Array<{ selection?: { addonKeys?: string[]; targetSettings?: DownloadTargetSettings }; ownerUserId?: string }> = [];
  /** What the queue does with an id it does not hold, so a foreign job can be compared with one. */
  const require = (name: string, id: string) => {
    if (!jobs.some((job) => job.id === id)) throw new AppError("The item was not found.", "err.itemNotFound");
    actions.push(`${name}:${id}`);
  };
  const queue = {
    snapshot: () => ({ jobs, halt: null }),
    list: () => jobs,
    add: async (title: string, _stream: unknown, _media: unknown, settings: DownloadTargetSettings, ownerUserId?: string) => {
      added.push({ title, ownerUserId, settings });
      return { id: "job-1", target: "Movies/Film/Film.mkv" };
    },
    addPending: async (_title: string, source: { selection?: { addonKeys?: string[] } }, _media: unknown, ownerUserId?: string) => {
      pending.push({ ...source, ownerUserId });
      return { id: "job-1" };
    },
    pause: async (id: string) => { require("pause", id); },
    resume: async (id: string) => { require("resume", id); },
    retry: async (id: string) => { require("retry", id); },
    move: async (id: string, direction: number) => { moves.push({ id, direction }); },
    remove: async (id: string) => { require("remove", id); },
    clearCompleted: async () => undefined,
  };
  const deps: DownloadsDeps = {
    store: { addons: () => addons, libraries: () => options.libraries ?? [] } as unknown as Store,
    needsSetup: () => false,
    currentSession: () => undefined,
    currentUser: () => options.viewer ?? admin,
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    stopUserSessions: async () => undefined,
    requireAccess: () => undefined,
    stopContentAccess: async () => undefined,
    queue: queue as unknown as DownloadQueue,
    deviceTransfers: transfers,
    jobView: <T extends { media?: MediaInfo; target?: string }>(job: T) => {
      viewed.push(job);
      return { ...job, viewed: true } as T;
    },
    sourceOf: () => ({}),
    mediaSource: () => undefined,
    posterOf: (value) => value ? String(value) : undefined,
    rememberTitle: async () => undefined,
    titleKey: () => ".",
    saveCatalogPoster: () => undefined,
    libraryKey: (value) => value,
    cachedMeta: async () => null,
    prefsOf: () => ({ uiLanguage: "en" }) as UserPrefs,
  };
  const app = express();
  app.use(express.json());
  registerDownloadRoutes(app, deps);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error), messageKey: messageKeyOf(error) });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    transfers,
    added,
    actions,
    moves,
    viewed,
    pending,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

const api = (base: string, pathname: string, init: { method?: string; body?: unknown } = {}) =>
  fetch(`${base}${pathname}`, {
    method: init.method ?? "GET",
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

const keyOf = async (response: Response) => ((await response.json()) as { messageKey?: string }).messageKey;

const episodes = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `ep-${index}` }));

/** A response the registry can wrap and dispose of without a socket behind it. */
class OpenResponse extends EventEmitter {
  statusCode = 200;
  writableFinished = false;
  private headers: Record<string, string | number> = {};
  setHeader(name: string, value: string | number) { this.headers[name.toLowerCase()] = value; return this; }
  getHeader(name: string) { return this.headers[name.toLowerCase()]; }
  write(_chunk: unknown) { return true; }
  end(_chunk?: unknown) { this.writableFinished = true; this.emit("close"); return this; }
  destroy() { this.emit("close"); }
}

const attachTransfer = (transfers: DeviceTransfers, ticketId: string, userId: string, username: string) => {
  transfers.attach(ticketId, { userId, username, filename: `${ticketId}.mkv`, source: "library" }, new OpenResponse() as unknown as express.Response);
};

test("GET /api/downloads returns the snapshot with every job passed through jobView", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const response = await api(harness.base, "/api/downloads");
  assert.equal(response.status, 200);
  const body = await response.json() as { jobs: Array<{ id: string; viewed?: boolean }>; halt: unknown };
  assert.equal(body.halt, null);
  assert.deepEqual(body.jobs.map((job) => job.viewed), [true, true]);
  assert.deepEqual(harness.viewed.map((job) => job.id), ["job-1", "job-2"]);
});

test("GET /api/downloads shows an ordinary user only their own device transfers", async (t) => {
  const harness = await mount([streamAddon("stream-addon")], { viewer: ordinary });
  t.after(harness.close);
  attachTransfer(harness.transfers, "t-ada", ADA, "ada");
  attachTransfer(harness.transfers, "t-bob", BOB, "bob");

  const response = await api(harness.base, "/api/downloads");
  const body = await response.json() as { deviceTransfers: Array<{ userId: string; username?: string; state: string }> };
  assert.deepEqual(body.deviceTransfers.map((row) => row.userId), [BOB], "another account's transfer is invisible");
  assert.equal(body.deviceTransfers[0].state, "running");
  assert.equal("username" in body.deviceTransfers[0], false, "an ordinary user never sees a username");
});

test("GET /api/downloads shows an administrator every device transfer with usernames", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  attachTransfer(harness.transfers, "t-ada", ADA, "ada");
  attachTransfer(harness.transfers, "t-bob", BOB, "bob");

  const response = await api(harness.base, "/api/downloads");
  const body = await response.json() as { deviceTransfers: Array<{ userId: string; username?: string }> };
  assert.deepEqual(body.deviceTransfers.map((row) => row.userId).sort(), [ADA, BOB].sort());
  assert.deepEqual(body.deviceTransfers.map((row) => row.username).sort(), ["ada", "bob"]);
});

test("POST /api/downloads/bulk refuses an empty episode list", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const response = await api(harness.base, "/api/downloads/bulk", { method: "POST", body: { title: "Show", episodes: [] } });
  assert.equal(response.status, 400);
  assert.equal(await keyOf(response), "err.missingEpisodes");
});

test("POST /api/downloads/bulk refuses more than 500 episodes", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const response = await api(harness.base, "/api/downloads/bulk", { method: "POST", body: { title: "Show", episodes: episodes(501) } });
  assert.equal(response.status, 400);
  assert.equal(await keyOf(response), "err.tooManyEpisodes");
});

test("POST /api/downloads/bulk refuses a selection with no enabled stream addon", async (t) => {
  // The addon is there, but it is a catalogue: a stream cannot come from it.
  const harness = await mount([streamAddon("catalog-addon", { role: "catalog" })]);
  t.after(harness.close);
  const response = await api(harness.base, "/api/downloads/bulk", {
    method: "POST",
    body: { title: "Show", episodes: episodes(1), selection: { addonKeys: ["catalog-addon"] } },
  });
  assert.equal(response.status, 400);
  assert.equal(await keyOf(response), "err.missingDownloadSources");
});

test("POST /api/downloads/bulk refuses a selection with no audio language", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const response = await api(harness.base, "/api/downloads/bulk", {
    method: "POST",
    body: { title: "Show", episodes: episodes(1), selection: { addonKeys: ["stream-addon"] } },
  });
  assert.equal(response.status, 400);
  assert.equal(await keyOf(response), "err.missingAudioLanguage");
});

test("POST /api/downloads/bulk refuses addons the caller may not use and queues only from the allowed ones", async (t) => {
  const harness = await mount(
    [streamAddon("open", { allowedUsers: [BOB] }), streamAddon("shut")],
    { viewer: ordinary },
  );
  t.after(harness.close);

  const refused = await api(harness.base, "/api/downloads/bulk", {
    method: "POST",
    body: { title: "Show", episodes: episodes(1), selection: { addonKeys: ["shut"], audioLanguage: "en" } },
  });
  assert.equal(refused.status, 400);
  assert.equal(await keyOf(refused), "err.missingDownloadSources", "naming only a disallowed addon leaves nothing to pick from");

  const mixed = await api(harness.base, "/api/downloads/bulk", {
    method: "POST",
    body: { title: "Show", episodes: episodes(1), selection: { addonKeys: ["shut", "open"], audioLanguage: "en" } },
  });
  assert.equal(mixed.status, 201);
  assert.deepEqual(harness.pending.map((source) => source.selection?.addonKeys), [["open"]], "the disallowed key never reaches the queue");
});

test("POST /api/downloads/bulk refuses required subtitles without a subtitle language", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const response = await api(harness.base, "/api/downloads/bulk", {
    method: "POST",
    body: { title: "Show", episodes: episodes(1), selection: { addonKeys: ["stream-addon"], audioLanguage: "en", subtitleMode: "required" } },
  });
  assert.equal(response.status, 400);
  assert.equal(await keyOf(response), "err.missingSubtitleLanguage");
});

test("POST /api/downloads/:id/move passes -1 for a negative direction and +1 for anything else", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  for (const direction of [-1, -5, 1, 7, undefined]) {
    const response = await api(harness.base, "/api/downloads/job-1/move", { method: "POST", body: { direction } });
    assert.equal(response.status, 204, String(direction));
  }
  assert.deepEqual(harness.moves, [
    { id: "job-1", direction: -1 },
    { id: "job-1", direction: -1 },
    { id: "job-1", direction: 1 },
    { id: "job-1", direction: 1 },
    { id: "job-1", direction: 1 },
  ]);
});

test("GET /api/downloads shows an administrator every job and a user only their own", async (t) => {
  const jobs = [{ id: "job-1", ownerUserId: ADA }, { id: "job-2", ownerUserId: BOB }];
  const administrator = await mount(undefined, { viewer: admin, jobs });
  t.after(administrator.close);
  const all = await (await api(administrator.base, "/api/downloads")).json() as { jobs: Array<{ id: string }>; halt: unknown };
  assert.deepEqual(all.jobs.map((job) => job.id), ["job-1", "job-2"], "an administrator sees every job");
  assert.equal(all.halt, null, "the queue-wide fields describe the queue, not a job");

  const user = await mount(undefined, { viewer: ordinary, jobs });
  t.after(user.close);
  const mine = await (await api(user.base, "/api/downloads")).json() as { jobs: Array<{ id: string }> };
  assert.deepEqual(mine.jobs.map((job) => job.id), ["job-2"], "a user sees only the jobs they asked for");
});

test("acting on somebody else's job answers exactly like an id that is not there", async (t) => {
  const harness = await mount(undefined, { viewer: ordinary, jobs: [{ id: "job-1", ownerUserId: ADA }] });
  t.after(harness.close);
  const actions: Array<{ method: string; path: string; body?: unknown }> = [
    { method: "POST", path: "/api/downloads/job-1/pause" },
    { method: "POST", path: "/api/downloads/job-1/resume" },
    { method: "POST", path: "/api/downloads/job-1/retry" },
    { method: "POST", path: "/api/downloads/job-1/move", body: { direction: 1 } },
    { method: "DELETE", path: "/api/downloads/job-1" },
  ];
  for (const { method, path, body } of actions) {
    const foreign = await api(harness.base, path, { method, body });
    const unknown = await api(harness.base, path.replace("job-1", "job-not-here"), { method, body });
    assert.equal(foreign.status, 404, `${method} ${path}`);
    assert.equal(foreign.status, unknown.status, `${method} ${path} answers with the same status`);
    const foreignBody = await foreign.json() as { messageKey?: string };
    assert.equal(foreignBody.messageKey, "err.itemNotFound", `${method} ${path}`);
    assert.deepEqual(foreignBody, await unknown.json(), `${method} ${path} gives nothing away`);
  }
  assert.deepEqual(harness.actions, [], "the queue is never asked to act on a job the caller does not own");
  assert.deepEqual(harness.moves, [], "a foreign job is never reordered");
});

test("POST /api/downloads/:id/move reorders the caller's own job, and an administrator may reorder anyone's", async (t) => {
  const jobs = [{ id: "job-ada", ownerUserId: ADA }, { id: "job-bob", ownerUserId: BOB }];
  const user = await mount(undefined, { viewer: ordinary, jobs });
  t.after(user.close);
  assert.equal((await api(user.base, "/api/downloads/job-bob/move", { method: "POST", body: { direction: -1 } })).status, 204);
  assert.deepEqual(user.moves, [{ id: "job-bob", direction: -1 }]);

  const administrator = await mount(undefined, { viewer: admin, jobs });
  t.after(administrator.close);
  assert.equal((await api(administrator.base, "/api/downloads/job-bob/move", { method: "POST", body: { direction: 1 } })).status, 204);
  assert.deepEqual(administrator.moves, [{ id: "job-bob", direction: 1 }]);
});

test("POST /api/downloads refuses an account without the library permission and queues nothing", async (t) => {
  const harness = await mount(undefined, { viewer: denied });
  t.after(harness.close);
  const response = await api(harness.base, "/api/downloads", { method: "POST", body: { title: "Film" } });
  assert.equal(response.status, 403);
  assert.equal(await keyOf(response), "err.downloadLibraryNotAllowed");
  assert.deepEqual(harness.added, [], "nothing is queued");
});

test("POST /api/downloads/bulk refuses an account without the library permission", async (t) => {
  const harness = await mount(undefined, { viewer: denied });
  t.after(harness.close);
  const response = await api(harness.base, "/api/downloads/bulk", {
    method: "POST",
    body: { title: "Show", episodes: episodes(1), selection: { addonKeys: ["stream-addon"], audioLanguage: "en" } },
  });
  assert.equal(response.status, 403);
  assert.equal(await keyOf(response), "err.downloadLibraryNotAllowed");
  assert.deepEqual(harness.pending, [], "nothing is queued");
});

test("an administrator queues onto the NAS whatever the stored flags say", async (t) => {
  // The flags are what an ordinary user is granted; an administrator passes by role alone,
  // and a migrated administrator's stored flags need not say true.
  assert.equal(admin.permissions.downloadToLibrary, false);
  const harness = await mount(undefined, { viewer: admin });
  t.after(harness.close);
  const response = await api(harness.base, "/api/downloads", { method: "POST", body: { title: "Film" } });
  assert.equal(response.status, 201);
  assert.deepEqual(harness.added.map((job) => job.ownerUserId), [ADA], "the job records who asked for it");
});

test("POST /api/downloads accepts an explicit target and queues it with the job", async (t) => {
  const harness = await mount(undefined, { libraries: [library("lib_movies", "movie")] });
  t.after(harness.close);
  const response = await api(harness.base, "/api/downloads", {
    method: "POST",
    body: { title: "Film", target: { libraryId: "lib_movies", subfolder: "Kino", layout: "flat" } },
  });
  assert.equal(response.status, 201);
  assert.deepEqual(harness.added[0]?.settings, { subfolder: "Kino", layout: "flat", libraryId: "lib_movies", explicit: true });
});

test("an explicit folder keeps its name as it is on disk", async (t) => {
  const harness = await mount(undefined, { libraries: [library("lib_movies", "movie")] });
  t.after(harness.close);
  const response = await api(harness.base, "/api/downloads", {
    method: "POST",
    body: { title: "Film", target: { libraryId: "lib_movies", subfolder: "Sci-Fi  Classics" } },
  });
  assert.equal(response.status, 201);
  assert.equal(harness.added[0]?.settings?.subfolder, "Sci-Fi  Classics");
});

test("POST /api/downloads refuses an unusable explicit target and queues nothing", async (t) => {
  const cases: Array<{ library?: LibraryRecord; target: unknown; key: string }> = [
    { target: { libraryId: "lib_missing" }, key: "err.libraryNotFound" },
    { target: { libraryId: "" }, key: "err.invalidDownloadTarget" },
    { target: "nope", key: "err.invalidDownloadTarget" },
    { library: library("lib_shows", "series"), target: { libraryId: "lib_shows" }, key: "err.libraryTypeMismatch" },
    { library: library("lib_off", "movie", { enabled: false }), target: { libraryId: "lib_off" }, key: "err.libraryNotWritable" },
    { library: library("lib_ro", "movie", { readOnly: true }), target: { libraryId: "lib_ro" }, key: "err.libraryNotWritable" },
    { library: library("lib_away", "movie", { unreachable: true }), target: { libraryId: "lib_away" }, key: "err.libraryNotWritable" },
    { library: library("lib_movies", "movie"), target: { libraryId: "lib_movies", subfolder: ".." }, key: "err.subfolderDots" },
    { library: library("lib_movies", "movie"), target: { libraryId: "lib_movies", subfolder: "Nowhere" }, key: "err.targetFolderMissing" },
  ];
  for (const [index, item] of cases.entries()) {
    const harness = await mount(undefined, { libraries: item.library ? [item.library] : [] });
    t.after(harness.close);
    const response = await api(harness.base, "/api/downloads", { method: "POST", body: { title: "Film", target: item.target } });
    assert.equal(response.status, 400, `case ${index}`);
    assert.equal(await keyOf(response), item.key, `case ${index}`);
    assert.deepEqual(harness.added, [], `case ${index} queues nothing`);
  }
});

test("a library invisible to the caller answers exactly like one that does not exist", async (t) => {
  const harness = await mount(undefined, { viewer: ordinary, libraries: [library("lib_private", "movie", { visibleTo: [] })] });
  t.after(harness.close);
  const invisible = await api(harness.base, "/api/downloads", { method: "POST", body: { title: "Film", target: { libraryId: "lib_private" } } });
  const missing = await api(harness.base, "/api/downloads", { method: "POST", body: { title: "Film", target: { libraryId: "lib_nope" } } });
  assert.equal(invisible.status, 400);
  assert.equal(invisible.status, missing.status);
  const invisibleBody = await invisible.json() as { messageKey?: string };
  assert.deepEqual(invisibleBody, await missing.json(), "the two answers give nothing away");
  assert.equal(invisibleBody.messageKey, "err.libraryNotFound");
  assert.deepEqual(harness.added, []);
});

test("POST /api/downloads refuses an explicit target for an account without the library permission", async (t) => {
  const harness = await mount(undefined, { viewer: denied, libraries: [library("lib_movies", "movie")] });
  t.after(harness.close);
  const response = await api(harness.base, "/api/downloads", { method: "POST", body: { title: "Film", target: { libraryId: "lib_movies" } } });
  assert.equal(response.status, 403);
  assert.equal(await keyOf(response), "err.downloadLibraryNotAllowed");
  assert.deepEqual(harness.added, []);
});

test("POST /api/downloads/bulk stores an explicit target in the selection", async (t) => {
  const harness = await mount(undefined, { libraries: [library("lib_shows", "series", { visibleTo: [] })] });
  t.after(harness.close);
  const response = await api(harness.base, "/api/downloads/bulk", {
    method: "POST",
    body: {
      title: "Show", episodes: episodes(1),
      selection: { addonKeys: ["stream-addon"], audioLanguage: "en" },
      target: { libraryId: "lib_shows", subfolder: "S", layout: "flat" },
    },
  });
  assert.equal(response.status, 201);
  assert.deepEqual(harness.pending[0]?.selection?.targetSettings, { subfolder: "S", layout: "flat", libraryId: "lib_shows", explicit: true });
});

test("POST /api/downloads/bulk refuses an unusable explicit target and queues nothing", async (t) => {
  const harness = await mount(undefined, { libraries: [] });
  t.after(harness.close);
  const response = await api(harness.base, "/api/downloads/bulk", {
    method: "POST",
    body: {
      title: "Show", episodes: episodes(1),
      selection: { addonKeys: ["stream-addon"], audioLanguage: "en" },
      target: { libraryId: "lib_missing" },
    },
  });
  assert.equal(response.status, 400);
  assert.equal(await keyOf(response), "err.libraryNotFound");
  assert.deepEqual(harness.pending, []);
});
