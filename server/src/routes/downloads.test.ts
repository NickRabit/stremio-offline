import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import type { DownloadQueue } from "../downloads.js";
import { messageKeyOf } from "../errors.js";
import { defaultDownloadSettings, type MediaInfo } from "../naming.js";
import type { Store, UserPrefs } from "../store.js";
import { registerDownloadRoutes, type DownloadsDeps } from "./downloads.js";

interface Harness {
  base: string;
  moves: Array<{ id: string; direction: number }>;
  viewed: Array<{ id?: string; media?: MediaInfo; target?: string }>;
  close(): Promise<void>;
}

/** A stream addon the bulk handler accepts: enabled, not a catalogue, with save rules. */
const streamAddon = (key: string, options: { enabled?: boolean; role?: string } = {}) => ({
  key,
  enabled: options.enabled ?? true,
  role: options.role ?? "source",
  manifest: { id: key, name: key },
  downloadSettings: defaultDownloadSettings(),
});

/** The routes take everything they need from the context, so the app here is a real express
 *  instance over fake collaborators that record what they were asked to do. */
const mount = async (addons: unknown[] = [streamAddon("stream-addon")]): Promise<Harness> => {
  const moves: Array<{ id: string; direction: number }> = [];
  const viewed: Array<{ id?: string; media?: MediaInfo; target?: string }> = [];
  const queue = {
    snapshot: () => ({ jobs: [{ id: "job-1" }, { id: "job-2" }], halt: null }),
    list: () => [],
    add: async () => ({ id: "job-1", target: "Movies/Film/Film.mkv" }),
    addPending: async () => ({ id: "job-1" }),
    pause: async () => undefined,
    resume: async () => undefined,
    retry: async () => undefined,
    move: async (id: string, direction: number) => { moves.push({ id, direction }); },
    remove: async () => undefined,
    clearCompleted: async () => undefined,
  };
  const deps: DownloadsDeps = {
    store: { addons: () => addons, libraries: () => [] } as unknown as Store,
    needsSetup: () => false,
    currentSession: () => undefined,
    currentUser: () => undefined,
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
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
    moves,
    viewed,
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
