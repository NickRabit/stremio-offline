import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import type { DownloadQueue } from "../downloads.js";
import { AppError, messageKeyOf } from "../errors.js";
import { defaultDownloadSettings, type MediaInfo } from "../naming.js";
import type { Store, UserPrefs } from "../store.js";
import type { UserRecord } from "../users.js";
import { registerDownloadRoutes, type DownloadsDeps } from "./downloads.js";

interface Harness {
  base: string;
  added: Array<{ title: string; ownerUserId?: string }>;
  actions: string[];
  moves: Array<{ id: string; direction: number }>;
  viewed: Array<{ id?: string; media?: MediaInfo; target?: string }>;
  pending: Array<{ selection?: { addonKeys?: string[] }; ownerUserId?: string }>;
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
  options: { viewer?: UserRecord; jobs?: Array<{ id: string; ownerUserId?: string }> } = {},
): Promise<Harness> => {
  const jobs = options.jobs ?? [{ id: "job-1", ownerUserId: ADA }, { id: "job-2", ownerUserId: ADA }];
  const added: Array<{ title: string; ownerUserId?: string }> = [];
  const actions: string[] = [];
  const moves: Array<{ id: string; direction: number }> = [];
  const viewed: Array<{ id?: string; media?: MediaInfo; target?: string }> = [];
  const pending: Array<{ selection?: { addonKeys?: string[] }; ownerUserId?: string }> = [];
  /** What the queue does with an id it does not hold, so a foreign job can be compared with one. */
  const require = (name: string, id: string) => {
    if (!jobs.some((job) => job.id === id)) throw new AppError("The item was not found.", "err.itemNotFound");
    actions.push(`${name}:${id}`);
  };
  const queue = {
    snapshot: () => ({ jobs, halt: null }),
    list: () => jobs,
    add: async (title: string, _stream: unknown, _media: unknown, _settings: unknown, ownerUserId?: string) => {
      added.push({ title, ownerUserId });
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
    store: { addons: () => addons, libraries: () => [] } as unknown as Store,
    needsSetup: () => false,
    currentSession: () => undefined,
    currentUser: () => options.viewer ?? admin,
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    stopUserSessions: async () => undefined,
    requireAccess: () => undefined,
    stopContentAccess: async () => undefined,
    queue: queue as unknown as DownloadQueue,
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
    const response = await api(harness.base, "/api/downloads/job-9/move", { method: "POST", body: { direction } });
    assert.equal(response.status, 204, String(direction));
  }
  assert.deepEqual(harness.moves, [
    { id: "job-9", direction: -1 },
    { id: "job-9", direction: -1 },
    { id: "job-9", direction: 1 },
    { id: "job-9", direction: 1 },
    { id: "job-9", direction: 1 },
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
  const actions = [
    { method: "POST", path: "/api/downloads/job-1/pause" },
    { method: "POST", path: "/api/downloads/job-1/resume" },
    { method: "POST", path: "/api/downloads/job-1/retry" },
    { method: "DELETE", path: "/api/downloads/job-1" },
  ];
  for (const { method, path } of actions) {
    const foreign = await api(harness.base, path, { method });
    const unknown = await api(harness.base, path.replace("job-1", "job-not-here"), { method });
    assert.equal(foreign.status, 404, `${method} ${path}`);
    assert.equal(foreign.status, unknown.status, `${method} ${path} answers with the same status`);
    assert.deepEqual(await foreign.json(), await unknown.json(), `${method} ${path} gives nothing away`);
  }
  assert.deepEqual(harness.actions, [], "the queue is never asked to act on a job the caller does not own");
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
