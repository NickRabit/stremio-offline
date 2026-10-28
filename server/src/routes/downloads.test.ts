import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { DeviceTransfers } from "../device-transfers.js";
import { ownerMayDownload, type DownloadQueue, type DownloadSelection } from "../downloads.js";
import { AppError, messageKeyOf } from "../errors.js";
import type { LibraryRecord } from "../libraries.js";
import { sealRemoteContent } from "../media-server-reference.js";
import type { RemoteDownloadReference } from "../media-server-download.js";
import type { ResourceOwner } from "../media-resources.js";
import { defaultDownloadSettings, type MediaInfo } from "../naming.js";
import type { SourceAdmissionSnapshotV1 } from "../source-admission.js";
import { defaultTemplateParameters, RULE_PRESETS, SOURCE_PROFILE_IDS, type SourceProfileTemplate } from "../source-profiles.js";
import type { Store, StoredSourceProfile, UserPrefs } from "../store.js";
import type { AddonDownloadSettings, DownloadTargetSettings, StreamItem } from "../types.js";
import type { UserRecord } from "../users.js";
import { registerDownloadRoutes, type DownloadsDeps } from "./downloads.js";

interface Harness {
  base: string;
  transfers: DeviceTransfers;
  added: Array<{ title: string; ownerUserId?: string; settings?: DownloadTargetSettings; stream?: StreamItem; media?: MediaInfo; remoteDownload?: RemoteDownloadReference }>;
  references: Array<{ stream: StreamItem; owner: ResourceOwner }>;
  /** Every sealed source the route re-proved through the sources service before reading a
   *  destination off it. */
  assertions: StreamItem[];
  titles: string[];
  setViewer(viewer: UserRecord): void;
  actions: string[];
  moves: Array<{ id: string; direction: number }>;
  viewed: Array<{ id?: string; media?: MediaInfo; target?: string }>;
  pending: Array<{ type?: string; videoId?: string; selection?: DownloadSelection; media?: MediaInfo; ownerUserId?: string; sourceAdmission?: SourceAdmissionSnapshotV1 }>;
  setAddonAllowedUsers(key: string, allowedUsers: string[]): void;
  setLibraryVisibleTo(id: string, visibleTo: string[]): void;
  close(): Promise<void>;
}

/** A stream addon the bulk handler accepts: enabled, not a catalogue, with save rules. */
const streamAddon = (key: string, options: {
  enabled?: boolean;
  role?: string;
  allowedUsers?: string[];
  downloadSettings?: AddonDownloadSettings;
} = {}) => ({
  key,
  enabled: options.enabled ?? true,
  role: options.role ?? "source",
  ...(options.allowedUsers ? { allowedUsers: options.allowedUsers } : {}),
  manifest: { id: key, name: key, resources: [{ name: "stream" }] },
  downloadSettings: options.downloadSettings ?? defaultDownloadSettings(),
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
  options: {
    viewer?: UserRecord;
    jobs?: Array<{ id: string; ownerUserId?: string }>;
    libraries?: unknown[];
    connections?: unknown[];
    remoteLibraries?: unknown[];
    source?: StreamItem;
    /** The media the route reads for the job's kind, so a native episode can be posed. */
    media?: MediaInfo;
    /** The local defaults a native copy without a configured destination falls back to. */
    settings?: { defaultMovieLibrary?: string; defaultSeriesLibrary?: string };
    downloadReference?: RemoteDownloadReference | (() => Promise<never>);
    /** A viewer the harness switches to while the handle is minted, or while the queue's `add`
     *  awaits, so a withdrawal that lands inside an await can be tested. */
    withdrawOnReference?: UserRecord;
    withdrawOnAdd?: UserRecord;
    /** The library a rule with no library lands in, either fixed or decided by the kind. */
    defaultLibrary?: LibraryRecord | ((kind: "movie" | "series") => LibraryRecord | undefined);
    addonOrder?: string[];
    prefs?: Partial<UserPrefs>;
    onCachedMeta?: () => void | Promise<void>;
    onPending?: (count: number) => void | Promise<void>;
    skipPending?: (count: number) => boolean;
    profiles?: StoredSourceProfile[];
  } = {},
): Promise<Harness> => {
  const jobs = options.jobs ?? [{ id: "job-1", ownerUserId: ADA }, { id: "job-2", ownerUserId: ADA }];
  const transfers = new DeviceTransfers();
  const held = { viewer: options.viewer ?? admin };
  const titles: string[] = [];
  const added: Array<{ title: string; ownerUserId?: string; settings?: DownloadTargetSettings; stream?: StreamItem; media?: MediaInfo; remoteDownload?: RemoteDownloadReference }> = [];
  const references: Array<{ stream: StreamItem; owner: ResourceOwner }> = [];
  const assertions: StreamItem[] = [];
  const actions: string[] = [];
  const moves: Array<{ id: string; direction: number }> = [];
  const viewed: Array<{ id?: string; media?: MediaInfo; target?: string }> = [];
  const pending: Array<{ type?: string; videoId?: string; selection?: DownloadSelection; media?: MediaInfo; ownerUserId?: string; sourceAdmission?: SourceAdmissionSnapshotV1 }> = [];
  const profiles = options.profiles ?? (["recommended", "providerPriority", "travel"] as const).map((template) => ({
    id: SOURCE_PROFILE_IDS[template],
    revision: 1,
    template,
    nameKey: `sourceProfile.${template}`,
    ...(template === "recommended" ? {} : { parameters: defaultTemplateParameters(template) }),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }));
  /** What the queue does with an id it does not hold, so a foreign job can be compared with one. */
  const require = (name: string, id: string) => {
    if (!jobs.some((job) => job.id === id)) throw new AppError("The item was not found.", "err.itemNotFound");
    actions.push(`${name}:${id}`);
  };
  const queue = {
    snapshot: () => ({ jobs, halt: null }),
    list: () => jobs,
    add: async (title: string, stream: StreamItem, media: MediaInfo | undefined, settings: DownloadTargetSettings, ownerUserId?: string, remoteDownload?: RemoteDownloadReference) => {
      added.push({ title, ownerUserId, settings, stream, media, remoteDownload });
      if (options.withdrawOnAdd) held.viewer = options.withdrawOnAdd;
      return { id: "job-1", target: "Movies/Film/Film.mkv" };
    },
    addPending: async (_title: string, source: { type: string; videoId: string; selection?: DownloadSelection }, media: MediaInfo | undefined, ownerUserId?: string, follow?: unknown, sourceAdmission?: SourceAdmissionSnapshotV1) => {
      assert.equal(follow, undefined);
      pending.push({ ...source, media, ownerUserId, sourceAdmission });
      await options.onPending?.(pending.length);
      if (options.skipPending?.(pending.length)) return undefined;
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
    store: {
      addons: () => addons,
      libraries: () => options.libraries ?? [],
      users: () => [held.viewer],
      mediaConnections: () => options.connections ?? [],
      remoteLibraries: () => options.remoteLibraries ?? [],
      settings: () => options.settings ?? {},
      prefs: () => ({ uiLanguage: "en", audioLanguage: "en", subtitleLanguage: "en", ...options.prefs }) as UserPrefs,
      userData: () => ({ addonOrder: options.addonOrder }),
      sourceProfiles: () => profiles,
    } as unknown as Store,
    needsSetup: () => false,
    currentSession: () => undefined,
    currentUser: () => held.viewer,
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    stopUserSessions: async () => undefined,
    requireAccess: () => undefined,
    stopContentAccess: async () => undefined,
    queue: queue as unknown as DownloadQueue,
    mediaSources: {
      assertCurrent: (stream: StreamItem) => { assertions.push(stream); },
      downloadReference: async (stream: StreamItem, owner: ResourceOwner) => {
        references.push({ stream, owner });
        if (options.withdrawOnReference) held.viewer = options.withdrawOnReference;
        const configured = options.downloadReference;
        if (typeof configured === "function") return configured();
        if (configured) return configured;
        throw new AppError("This library is read-only.", "library.readOnly", 403);
      },
    } as unknown as DownloadsDeps["mediaSources"],
    deviceTransfers: transfers,
    jobView: async <T extends { media?: MediaInfo; target?: string }>(job: T) => {
      viewed.push(job);
      return { ...job, viewed: true } as T;
    },
    sourceOf: () => options.source ?? ({} as StreamItem),
    ownerOf: () => ({ userId: ADA, sid: "sid-ada", expiresAt: Number.MAX_SAFE_INTEGER }),
    mediaSource: () => options.media,
    posterOf: (value) => value ? String(value) : undefined,
    rememberTitle: async (target) => { titles.push(target); },
    titleKey: () => ".",
    saveCatalogPoster: () => undefined,
    libraryKey: (value) => value,
    cachedMeta: async () => {
      await options.onCachedMeta?.();
      return null;
    },
    prefsOf: () => ({ uiLanguage: "en", audioLanguage: "en", subtitleLanguage: "en", ...options.prefs }) as UserPrefs,
    // The queue resolves a rule with no library to the default for the kind; tests name it
    // explicitly, and otherwise it is the single configured library.
    defaultDownloadLibrary: (kind) => typeof options.defaultLibrary === "function"
      ? options.defaultLibrary(kind)
      : options.defaultLibrary ?? (options.libraries as LibraryRecord[] | undefined)?.[0],
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
    references,
    assertions,
    titles,
    setViewer: (viewer: UserRecord) => { held.viewer = viewer; },
    actions,
    moves,
    viewed,
    pending,
    setAddonAllowedUsers: (key, allowedUsers) => {
      const addon = addons.find((entry) => (entry as { key?: unknown }).key === key) as { allowedUsers?: string[] } | undefined;
      if (addon) addon.allowedUsers = allowedUsers;
    },
    setLibraryVisibleTo: (id, visibleTo) => {
      const entry = options.libraries?.find((candidate) => (candidate as LibraryRecord).id === id) as LibraryRecord | undefined;
      if (entry) entry.visibleTo = visibleTo;
    },
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
const profileSelection = (profileId: string, revision = 1) => ({ profile: { profileId, revision } });

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

test("GET /api/downloads marks mine only on the administrator's own jobs", async (t) => {
  const harness = await mount([streamAddon("stream-addon")], {
    viewer: admin,
    jobs: [{ id: "job-ada", ownerUserId: ADA }, { id: "job-bob", ownerUserId: BOB }],
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/downloads");
  const body = await response.json() as { jobs: Array<{ id: string; mine?: boolean }> };
  assert.deepEqual(body.jobs.map((job) => [job.id, job.mine]), [["job-ada", true], ["job-bob", false]]);
});

test("GET /api/downloads marks every visible job as mine for an ordinary account", async (t) => {
  const harness = await mount([streamAddon("stream-addon")], {
    viewer: ordinary,
    jobs: [{ id: "job-ada", ownerUserId: ADA }, { id: "job-bob", ownerUserId: BOB }],
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/downloads");
  const body = await response.json() as { jobs: Array<{ id: string; mine?: boolean }> };
  assert.deepEqual(body.jobs.map((job) => [job.id, job.mine]), [["job-bob", true]]);
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

test("characterization: a legacy bulk submission drops duplicate provider keys", async (t) => {
  const harness = await mount(
    [streamAddon("open", { allowedUsers: [BOB] }), streamAddon("shut")],
    { viewer: ordinary },
  );
  t.after(harness.close);

  const response = await api(harness.base, "/api/downloads/bulk", {
    method: "POST",
    body: {
      title: "Show",
      episodes: episodes(1),
      selection: {
        addonKeys: ["shut", "open", "open"],
        sourceStrategy: "largest",
        audioLanguage: "en-US",
      },
    },
  });
  assert.equal(response.status, 201, await response.text());
  const queued = harness.pending[0]!.selection!;
  assert.deepEqual(queued.addonKeys, ["open"]);
  assert.equal(queued.sourceStrategy, "largest");
  assert.equal(queued.audioLanguage, "en");
  assert.equal(queued.audioMode, "listed");
  assert.equal(queued.subtitleMode, "off");
});

test("POST /api/downloads/bulk refuses a selection rule this server cannot express", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const cases = [
    { sourceStrategy: "smallest" },
    { audioMode: "best" },
    { subtitleMode: 3 },
  ];
  for (const extra of cases) {
    const response = await api(harness.base, "/api/downloads/bulk", {
      method: "POST",
      body: {
        title: "Show",
        episodes: episodes(1),
        selection: { addonKeys: ["stream-addon"], audioLanguage: "en", ...extra },
      },
    });
    assert.equal(response.status, 400, JSON.stringify(extra));
    assert.equal(await keyOf(response), "err.selectionUpgradeRequired", JSON.stringify(extra));
  }
  assert.deepEqual(harness.pending, [], "nothing is queued");
});

test("POST /api/downloads/bulk keeps today's defaults when legacy selection modes are omitted", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const response = await api(harness.base, "/api/downloads/bulk", {
    method: "POST",
    body: {
      title: "Show",
      episodes: episodes(1),
      selection: { addonKeys: ["stream-addon"], audioLanguage: "en" },
    },
  });
  assert.equal(response.status, 201, await response.text());
  const queued = harness.pending[0]?.selection;
  assert.equal(queued?.sourceStrategy, "priority");
  assert.equal(queued?.audioMode, "listed");
  assert.equal(queued?.subtitleMode, "off");
});

test("profile bulk materializes Travel in the user's addon order with frozen language preferences", async (t) => {
  const settings = (subfolder: string): AddonDownloadSettings => ({
    movie: { subfolder, layout: "structured" },
    series: { subfolder, layout: "flat" },
  });
  const harness = await mount([
    streamAddon("alpha", { allowedUsers: [BOB], downloadSettings: settings("Alpha") }),
    streamAddon("beta", { allowedUsers: [BOB], downloadSettings: settings("Travel") }),
    streamAddon("shut"),
  ], {
    viewer: ordinary,
    addonOrder: ["beta", "alpha"],
    prefs: { audioLanguage: "Czech", subtitleLanguage: "ENG" },
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/downloads/bulk", {
    method: "POST",
    body: {
      title: "Show",
      episodes: episodes(1),
      selection: profileSelection(SOURCE_PROFILE_IDS.travel),
    },
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.deepEqual(body, { added: 1, skipped: 0 });

  const queued = harness.pending[0]!;
  const snapshot = queued.sourceAdmission!;
  assert.deepEqual(snapshot.profile, { id: SOURCE_PROFILE_IDS.travel, revision: 1, template: "travel" });
  assert.equal(snapshot.operation, "downloadToLibrary");
  assert.deepEqual(snapshot.providerKeys, ["addon:beta", "addon:alpha"]);
  assert.deepEqual(snapshot.policy.constraints.audio, { mode: "preferred", preferred: { code: "cs" } });
  assert.deepEqual(snapshot.policy.constraints.subtitles, { mode: "optional", preferred: { code: "en" } });
  assert.deepEqual(snapshot.policy.constraints.heightPixels, { min: 480 });
  assert.deepEqual(
    snapshot.policy.criteria.find((criterion) => criterion.kind === "providerOrder"),
    { kind: "providerOrder", keys: ["addon:beta", "addon:alpha"] },
  );
  assert.deepEqual(queued.selection?.addonKeys, ["beta", "alpha"]);
  assert.equal(queued.selection?.audioLanguage, "cs");
  assert.equal(queued.selection?.subtitleLanguage, "en");
  assert.deepEqual(queued.selection?.targetSettings, { subfolder: "Travel", layout: "flat" });
});

test("profile bulk reports queue skips separately from added jobs", async (t) => {
  const harness = await mount([streamAddon("stream-addon", { allowedUsers: [BOB] })], {
    viewer: ordinary,
    skipPending: (count) => count === 1,
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/downloads/bulk", {
    method: "POST",
    body: {
      title: "Show",
      episodes: episodes(2),
      selection: profileSelection(SOURCE_PROFILE_IDS.travel),
    },
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { added: 1, skipped: 1 });
});

test("profile bulk materializes Provider Priority and keeps the request target separate", async (t) => {
  const shows = library("lib_shows", "series", { visibleTo: [BOB] });
  const harness = await mount([
    streamAddon("alpha", { allowedUsers: [BOB] }),
    streamAddon("beta", { allowedUsers: [BOB] }),
  ], {
    viewer: ordinary,
    libraries: [shows],
    addonOrder: ["beta", "alpha"],
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/downloads/bulk", {
    method: "POST",
    body: {
      title: "Show",
      episodes: episodes(1),
      selection: profileSelection(SOURCE_PROFILE_IDS.providerPriority),
      target: { libraryId: shows.id, subfolder: "S", layout: "flat" },
    },
  });
  assert.equal(response.status, 201, await response.text());
  const snapshot = harness.pending[0]!.sourceAdmission!;
  assert.deepEqual(snapshot.providerKeys, ["addon:beta", "addon:alpha"]);
  assert.deepEqual(
    snapshot.policy.criteria.find((criterion) => criterion.kind === "providerOrder"),
    { kind: "providerOrder", keys: ["addon:beta", "addon:alpha"] },
  );
  assert.deepEqual(harness.pending[0]?.selection?.targetSettings, {
    subfolder: "S",
    layout: "flat",
    libraryId: shows.id,
    explicit: true,
  });
});

test("a stored Travel variant admits through bulk with its explicit order and height", async (t) => {
  const profile: StoredSourceProfile = {
    id: "6202fb7a-ddf0-4e95-b9c7-202a9c62b35f",
    revision: 1,
    template: "travel",
    name: "Travel 720",
    parameters: {
      scope: { mode: "selected", addonKeys: ["beta", "alpha"] },
      providerOrder: { addonKeys: ["alpha", "beta"] },
      audioMode: "preferred",
      subtitleMode: "optional",
      heightPixels: { min: 720 },
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const harness = await mount([
    streamAddon("alpha", { allowedUsers: [BOB] }),
    streamAddon("beta", { allowedUsers: [BOB] }),
  ], {
    viewer: ordinary,
    addonOrder: ["beta", "alpha"],
    profiles: [profile],
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/downloads/bulk", {
    method: "POST",
    body: {
      title: "Show",
      episodes: episodes(1),
      selection: profileSelection(profile.id),
    },
  });
  assert.equal(response.status, 201, await response.text());
  const snapshot = harness.pending[0]!.sourceAdmission!;
  assert.deepEqual(snapshot.profile, { id: profile.id, revision: 1, template: "travel" });
  assert.deepEqual(snapshot.providerKeys, ["addon:alpha", "addon:beta"]);
  assert.deepEqual(snapshot.policy.constraints.heightPixels, { min: 720 });
});

test("bulk admission materializes every rule preset with the episode size limit", async (t) => {
  const profiles = RULE_PRESETS.map((preset) => ({
    id: preset.id,
    revision: 1,
    template: preset.template,
    nameKey: preset.nameKey,
    parameters: preset.rules,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  })) satisfies StoredSourceProfile[];
  const harness = await mount([streamAddon("rule-addon", { allowedUsers: [BOB] })], {
    viewer: ordinary,
    profiles,
  });
  t.after(harness.close);

  for (const preset of RULE_PRESETS) {
    const response = await api(harness.base, "/api/downloads/bulk", {
      method: "POST",
      body: {
        title: "Show",
        episodes: episodes(1),
        selection: profileSelection(preset.id),
      },
    });
    assert.equal(response.status, 201, await response.text());
    const snapshot = harness.pending.at(-1)!.sourceAdmission!;
    assert.deepEqual(snapshot.profile, { id: preset.id, revision: 1, template: "rules" });
    assert.deepEqual(
      snapshot.policy.constraints.bytes,
      preset.rules.sizeGb.episode.max === null
        ? undefined
        : { max: preset.rules.sizeGb.episode.max * 1_000_000_000 },
    );
  }
});

test("a film queued by a rules profile becomes one lazy movie job with the movie admission", async (t) => {
  const balanced = RULE_PRESETS.find((preset) => preset.id === SOURCE_PROFILE_IDS.balanced)!;
  const harness = await mount([streamAddon("stream-addon", { allowedUsers: [BOB] })], {
    viewer: ordinary,
    profiles: [{
      id: balanced.id,
      revision: 1,
      template: balanced.template,
      nameKey: balanced.nameKey,
      parameters: balanced.rules,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/downloads/bulk", {
    method: "POST",
    body: {
      title: "Heat",
      type: "movie",
      episodes: [{ id: "tt-film" }],
      media: { id: "tt-film", metaType: "movie", poster: "heat.jpg", year: "1995" },
      selection: profileSelection(balanced.id),
    },
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  assert.deepEqual(JSON.parse(text), { added: 1, skipped: 0 });
  assert.equal(harness.pending.length, 1);
  assert.equal(harness.pending[0]?.type, "movie");
  assert.equal(harness.pending[0]?.videoId, "tt-film");
  assert.deepEqual(harness.pending[0]?.media, {
    kind: "movie", title: "Heat", id: "tt-film", metaType: "movie", poster: "heat.jpg", year: 1995,
  });
  assert.deepEqual(harness.pending[0]?.sourceAdmission?.profile, {
    id: balanced.id, revision: 1, template: "rules",
  });
  assert.deepEqual(harness.pending[0]?.sourceAdmission?.policy.constraints.bytes, { max: 15_000_000_000 });
});

test("a film bulk request refuses a legacy source selection", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const response = await api(harness.base, "/api/downloads/bulk", {
    method: "POST",
    body: {
      title: "Heat",
      type: "movie",
      episodes: [{ id: "tt-film" }],
      media: { id: "tt-film", metaType: "movie" },
      selection: { addonKeys: ["stream-addon"], audioLanguage: "en" },
    },
  });
  assert.equal(response.status, 400);
  assert.equal(await keyOf(response), "err.missingDownloadSources");
  assert.deepEqual(harness.pending, []);
});

test("a film bulk request refuses more than one entry or episode numbering", async (t) => {
  const balanced = RULE_PRESETS.find((preset) => preset.id === SOURCE_PROFILE_IDS.balanced)!;
  const harness = await mount([streamAddon("stream-addon", { allowedUsers: [BOB] })], {
    viewer: ordinary,
    profiles: [{
      id: balanced.id,
      revision: 1,
      template: balanced.template,
      nameKey: balanced.nameKey,
      parameters: balanced.rules,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
  });
  t.after(harness.close);

  for (const entries of [
    [{ id: "tt-film" }, { id: "tt-second" }],
    [{ id: "tt-film", season: 1 }],
    [{ id: "tt-film", episode: 1 }],
  ]) {
    const response = await api(harness.base, "/api/downloads/bulk", {
      method: "POST",
      body: {
        title: "Heat",
        type: "movie",
        episodes: entries,
        media: { id: "tt-film", metaType: "movie" },
        selection: profileSelection(balanced.id),
      },
    });
    assert.equal(response.status, 400);
    assert.equal(await keyOf(response), "err.invalidRequest");
  }
  assert.deepEqual(harness.pending, []);
});

test("a stored profile revision bump rejects a stale bulk submission", async (t) => {
  const profile: StoredSourceProfile = {
    id: "755d1c85-c935-47c9-8e23-92b72b942120",
    revision: 2,
    template: "travel",
    name: "Travel second revision",
    parameters: defaultTemplateParameters("travel"),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };
  const harness = await mount([streamAddon("stream-addon", { allowedUsers: [BOB] })], {
    viewer: ordinary,
    profiles: [profile],
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/downloads/bulk", {
    method: "POST",
    body: { title: "Show", episodes: episodes(1), selection: profileSelection(profile.id, 1) },
  });
  assert.equal(response.status, 409);
  assert.equal(await keyOf(response), "err.sourceProfileRevisionStale");
  assert.deepEqual(harness.pending, []);
});

test("a stored Provider priority variant admits HTTP-only ascending policy", async (t) => {
  const profile: StoredSourceProfile = {
    id: "e79b34cb-eec4-4d61-b4ca-b4e12786ad17",
    revision: 1,
    template: "providerPriority",
    name: "Smallest HTTP",
    parameters: {
      scope: { mode: "allAvailable" },
      providerOrder: { from: "viewer" },
      sizeDirection: "asc",
      transfer: ["http"],
      audioMode: "preferred",
      subtitleMode: "optional",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const harness = await mount([streamAddon("stream-addon", { allowedUsers: [BOB] })], {
    viewer: ordinary,
    profiles: [profile],
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/downloads/bulk", {
    method: "POST",
    body: { title: "Show", episodes: episodes(1), selection: profileSelection(profile.id) },
  });
  assert.equal(response.status, 201, await response.text());
  const snapshot = harness.pending[0]!.sourceAdmission!;
  assert.deepEqual(snapshot.profile, {
    id: profile.id,
    revision: 1,
    template: "providerPriority",
  });
  assert.deepEqual(snapshot.policy.constraints.sourceKinds, [
    "localFile",
    "mediaServerOriginal",
    "http",
  ]);
  assert.deepEqual(
    snapshot.policy.criteria.find((criterion) => criterion.kind === "size"),
    { kind: "size", direction: "asc" },
  );
});

test("profile bulk re-admits each job and drops providers revoked before it is queued", async (t) => {
  const settings = (subfolder: string): AddonDownloadSettings => ({
    movie: { subfolder, layout: "structured" },
    series: { subfolder, layout: "flat" },
  });
  let harness!: Harness;
  harness = await mount([
    streamAddon("alpha", { allowedUsers: [BOB], downloadSettings: settings("Alpha") }),
    streamAddon("beta", { allowedUsers: [BOB], downloadSettings: settings("Beta") }),
    streamAddon("gamma", { allowedUsers: [BOB], downloadSettings: settings("Validated") }),
  ], {
    viewer: ordinary,
    addonOrder: ["gamma", "beta", "alpha"],
    onCachedMeta: () => harness.setAddonAllowedUsers("beta", []),
    onPending: (count) => {
      if (count === 1) harness.setAddonAllowedUsers("gamma", []);
    },
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/downloads/bulk", {
    method: "POST",
    body: {
      title: "Show",
      media: { id: "tt1", metaType: "series" },
      episodes: episodes(2),
      selection: profileSelection(SOURCE_PROFILE_IDS.providerPriority),
    },
  });
  assert.equal(response.status, 201, await response.text());
  assert.deepEqual(
    harness.pending.map((job) => job.sourceAdmission?.providerKeys),
    [["addon:gamma", "addon:alpha"], ["addon:alpha"]],
  );
  assert.deepEqual(
    harness.pending.map((job) => job.selection?.addonKeys),
    [["gamma", "alpha"], ["alpha"]],
  );
  assert.deepEqual(
    harness.pending.map((job) => job.selection?.targetSettings),
    [
      { subfolder: "Validated", layout: "flat" },
      { subfolder: "Validated", layout: "flat" },
    ],
  );
});

test("profile bulk re-reads destination rights before each queue addition", async (t) => {
  const shows = library("lib_shows", "series", { visibleTo: [BOB] });
  let harness!: Harness;
  harness = await mount([streamAddon("stream-addon", { allowedUsers: [BOB] })], {
    viewer: ordinary,
    libraries: [shows],
    onPending: (count) => {
      if (count === 1) harness.setLibraryVisibleTo(shows.id, []);
    },
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/downloads/bulk", {
    method: "POST",
    body: {
      title: "Show",
      episodes: episodes(2),
      selection: profileSelection(SOURCE_PROFILE_IDS.travel),
      target: { libraryId: shows.id, subfolder: "S", layout: "flat" },
    },
  });
  assert.equal(response.status, 403);
  assert.equal(await keyOf(response), "err.downloadLibraryNotAllowed");
  assert.equal(harness.pending.length, 1, "the job admitted before the revocation remains queued");
});

test("profile bulk rejects criteria and admission snapshots supplied by the body", async (t) => {
  const harness = await mount([streamAddon("stream-addon")]);
  t.after(harness.close);
  const forged = [
    {
      ...profileSelection(SOURCE_PROFILE_IDS.travel),
      policy: { scope: { mode: "allAvailable" } },
      addonKeys: ["forged"],
      sourceStrategy: "largest",
      audioLanguage: "xx",
    },
    {
      ...profileSelection(SOURCE_PROFILE_IDS.travel),
      sourceAdmission: { schemaVersion: 1 },
    },
  ];

  for (const selection of forged) {
    const response = await api(harness.base, "/api/downloads/bulk", {
      method: "POST",
      body: { title: "Show", episodes: episodes(1), selection },
    });
    assert.equal(response.status, 400);
    assert.equal(await keyOf(response), "err.invalidSourceProfileReference");
  }
  assert.deepEqual(harness.pending, []);
});

test("profile bulk distinguishes stale and unknown references without leaking their identifiers", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const cases = [
    { selection: profileSelection(SOURCE_PROFILE_IDS.travel, 2), status: 409, key: "err.sourceProfileRevisionStale", id: SOURCE_PROFILE_IDS.travel },
    { selection: profileSelection("private-profile-id"), status: 400, key: "err.sourceProfileUnavailable", id: "private-profile-id" },
  ];

  for (const item of cases) {
    const response = await api(harness.base, "/api/downloads/bulk", {
      method: "POST",
      body: { title: "Show", episodes: episodes(1), selection: item.selection },
    });
    assert.equal(response.status, item.status);
    const text = await response.text();
    assert.equal((JSON.parse(text) as { messageKey?: string }).messageKey, item.key);
    assert.equal(text.includes(item.id), false);
  }
  assert.deepEqual(harness.pending, []);
});

test("profile bulk refuses the Recommended profile for library downloads", async (t) => {
  const harness = await mount([streamAddon("stream-addon")]);
  t.after(harness.close);
  const response = await api(harness.base, "/api/downloads/bulk", {
    method: "POST",
    body: {
      title: "Show",
      episodes: episodes(1),
      selection: profileSelection(SOURCE_PROFILE_IDS.recommended),
    },
  });
  assert.equal(response.status, 400);
  assert.equal(await keyOf(response), "err.sourceProfileOperationUnavailable");
  assert.deepEqual(harness.pending, []);
});

test("profile bulk refuses a forbidden account and an empty provider scope", async (t) => {
  const forbidden = await mount([streamAddon("stream-addon")], { viewer: denied });
  t.after(forbidden.close);
  const refused = await api(forbidden.base, "/api/downloads/bulk", {
    method: "POST",
    body: { title: "Show", episodes: episodes(1), selection: profileSelection(SOURCE_PROFILE_IDS.travel) },
  });
  assert.equal(refused.status, 403);
  assert.equal(await keyOf(refused), "err.sourceProfileOperationForbidden");
  assert.deepEqual(forbidden.pending, []);

  const empty = await mount([]);
  t.after(empty.close);
  const unavailable = await api(empty.base, "/api/downloads/bulk", {
    method: "POST",
    body: { title: "Show", episodes: episodes(1), selection: profileSelection(SOURCE_PROFILE_IDS.providerPriority) },
  });
  assert.equal(unavailable.status, 400);
  assert.equal(await keyOf(unavailable), "err.sourceProviderScopeUnavailable");
  assert.deepEqual(empty.pending, []);
});

test("profile bulk maps an unavailable language preference to a keyed error", async (t) => {
  const harness = await mount([streamAddon("stream-addon")], { prefs: { audioLanguage: "xx" } });
  t.after(harness.close);
  const response = await api(harness.base, "/api/downloads/bulk", {
    method: "POST",
    body: { title: "Show", episodes: episodes(1), selection: profileSelection(SOURCE_PROFILE_IDS.travel) },
  });
  assert.equal(response.status, 400);
  assert.equal(await keyOf(response), "err.sourceLanguagePreferenceUnavailable");
  assert.deepEqual(harness.pending, []);
});

test("legacy bulk selection remains lazy and queues without an admission snapshot", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const response = await api(harness.base, "/api/downloads/bulk", {
    method: "POST",
    body: {
      title: "Show",
      episodes: episodes(1),
      selection: { addonKeys: ["stream-addon"], audioLanguage: "en", sourceStrategy: "largest" },
    },
  });
  assert.equal(response.status, 201);
  assert.equal(harness.pending[0]?.sourceAdmission, undefined);
  assert.equal(harness.pending[0]?.selection?.sourceStrategy, "largest");
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

test("POST /api/downloads refuses a default library the account cannot see, and creates no job", async (t) => {
  const hidden = library("lib_private", "movie", { visibleTo: [] });
  const harness = await mount([streamAddon("stream-addon")], { viewer: ordinary, libraries: [hidden], defaultLibrary: hidden });
  t.after(harness.close);
  const response = await api(harness.base, "/api/downloads", { method: "POST", body: { title: "Film" } });
  assert.equal(response.status, 403, "the job is refused at the door, not queued and paused");
  assert.equal(await keyOf(response), "err.downloadLibraryNotAllowed");
  assert.deepEqual(harness.added, [], "nothing is queued");
});

test("POST /api/downloads accepts a visible writable default library and the queue's own check agrees", async (t) => {
  const visible = library("lib_movies", "movie", { visibleTo: [BOB] });
  const harness = await mount([streamAddon("stream-addon")], { viewer: ordinary, libraries: [visible], defaultLibrary: visible });
  t.after(harness.close);
  const response = await api(harness.base, "/api/downloads", { method: "POST", body: { title: "Film" } });
  assert.equal(response.status, 201);
  assert.deepEqual(harness.added[0]?.settings, { subfolder: "", layout: "structured" });
  // The job the queue builds resolves the same library; its own owner-bound check lets it run.
  assert.equal(ownerMayDownload({ owner: ordinary, addons: [], libraries: [visible] }, { stream: {}, libraryId: visible.id }), true,
    "the queue's first check does not pause the job");
});

test("POST /api/downloads/bulk refuses a default library the account cannot see and queues nothing", async (t) => {
  const hidden = library("lib_private", "series", { visibleTo: [] });
  const harness = await mount([streamAddon("stream-addon", { allowedUsers: [BOB] })], { viewer: ordinary, libraries: [hidden], defaultLibrary: hidden });
  t.after(harness.close);
  const response = await api(harness.base, "/api/downloads/bulk", {
    method: "POST",
    body: { title: "Show", episodes: episodes(1), selection: { addonKeys: ["stream-addon"], audioLanguage: "en" } },
  });
  assert.equal(response.status, 403);
  assert.equal(await keyOf(response), "err.downloadLibraryNotAllowed");
  assert.deepEqual(harness.pending, [], "nothing is queued");
});

test("POST /api/downloads/bulk reads the door's kind from the job it builds, not the body's metaType", async (t) => {
  const movieLib = library("lib_movie", "movie", { visibleTo: [BOB] });
  // The series default the queue resolves for every bulk job; the account may not see it.
  const seriesLib = library("lib_series", "series", { visibleTo: [] });
  const byKind = (kind: "movie" | "series") => (kind === "movie" ? movieLib : seriesLib);
  const harness = await mount([streamAddon("stream-addon", { allowedUsers: [BOB] })], { viewer: ordinary, libraries: [movieLib, seriesLib], defaultLibrary: byKind });
  t.after(harness.close);
  const response = await api(harness.base, "/api/downloads/bulk", {
    method: "POST",
    body: {
      title: "Show",
      // The body claims a film, but every job this route adds is an episode: the queue reads
      // it as a series, so the door has to check the series default.
      media: { id: "tt1", metaType: "movie" },
      episodes: episodes(1),
      selection: { addonKeys: ["stream-addon"], audioLanguage: "en" },
    },
  });
  assert.equal(response.status, 403, "the queue's series default decides, not the body's claim");
  assert.equal(await keyOf(response), "err.downloadLibraryNotAllowed");
  assert.deepEqual(harness.pending, [], "nothing is queued");
});

const remoteLibraryRecord = {
  id: `rlib_${"a".repeat(32)}`, connectionId: `mconn_${"b".repeat(32)}`, remoteId: "remote-1",
  name: "Remote Movies", type: "movie", enabled: true, order: 0, allowedUsers: [],
  showOnHome: true, showInContinueWatching: true,
};

const remoteConnectionRecord = {
  id: `mconn_${"b".repeat(32)}`, provider: "jellyfin", name: "Home", baseUrl: "http://media.example",
  allowLan: false, allowLoopback: false, serverId: "server-1", accountId: "account-1",
  enabled: true, generation: 1, secretRef: `msecret_${"c".repeat(32)}`, addedAt: "2026-01-01T00:00:00.000Z",
};

const remoteReference: RemoteDownloadReference = {
  schemaVersion: 1, ownerUserId: ADA, connectionId: remoteConnectionRecord.id, libraryId: remoteLibraryRecord.id,
  generation: 1, provider: "jellyfin", serverId: "server-1", accountId: "account-1", itemId: "item-1", mediaSourceId: "v1",
};

test("POST /api/downloads derives the durable handle from the sealed source, never from the body", async (t) => {
  const sealed = { url: "media-server:forged", name: "Movie.mkv" } as StreamItem;
  const local = library("lib_movies", "movie");
  const harness = await mount([streamAddon("stream-addon")], {
    viewer: admin, libraries: [local], source: sealed, downloadReference: remoteReference,
    connections: [remoteConnectionRecord], remoteLibraries: [remoteLibraryRecord],
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/downloads", {
    method: "POST",
    body: {
      title: "Movie",
      // A body that names its own reference must be ignored: the route mints the handle itself.
      remoteDownload: { ...remoteReference, ownerUserId: BOB },
    },
  });
  assert.equal(response.status, 201, await response.text());
  assert.deepEqual(harness.references.map((entry) => entry.owner.userId), [ADA], "the handle is captured for the session's own owner");
  assert.deepEqual(harness.references[0]?.stream, sealed, "the handle is derived from the sealed source the request resolved");
  assert.deepEqual(harness.added[0]?.remoteDownload, remoteReference, "the queue receives the minted handle");
  assert.equal(harness.added[0]?.stream, sealed, "the queue receives the sealed source, which it scrubs itself");
});

test("POST /api/downloads refuses a remote source the sources service will not mint a handle for", async (t) => {
  const sealed = { url: "media-server:forged" } as StreamItem;
  const local = library("lib_movies", "movie");
  const harness = await mount([streamAddon("stream-addon")], {
    viewer: admin, libraries: [local], source: sealed,
    downloadReference: async () => { throw new AppError("This library is read-only.", "library.readOnly", 403); },
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/downloads", { method: "POST", body: { title: "Movie" } });
  assert.equal(response.status, 403);
  assert.equal(await keyOf(response), "library.readOnly");
  assert.deepEqual(harness.added, [], "a forged sealed source is never queued");
});

test("a remote original can never be pinned as a remote library target", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const response = await api(harness.base, "/api/downloads", {
    method: "POST",
    body: { title: "Movie", target: { libraryId: `rlib_${"e".repeat(32)}` } },
  });
  assert.equal(response.status, 403);
  assert.equal(await keyOf(response), "library.readOnly");
});

test("a bad, hidden or read-only target is refused before any provider call", async (t) => {
  const visible = library("lib_visible", "movie", { visibleTo: [BOB] });
  const hidden = library("lib_hidden", "movie", { visibleTo: [] });
  const readOnly = library("lib_readonly", "movie", { visibleTo: [BOB], readOnly: true });
  for (const target of [
    { libraryId: `rlib_${"e".repeat(32)}` },
    { libraryId: hidden.id },
    { libraryId: readOnly.id },
  ]) {
    const harness = await mount([streamAddon("stream-addon")], {
      viewer: ordinary, libraries: [visible, hidden, readOnly], source: { url: "media-server:forged" } as StreamItem,
      downloadReference: remoteReference, connections: [remoteConnectionRecord], remoteLibraries: [remoteLibraryRecord],
    });
    t.after(harness.close);
    const response = await api(harness.base, "/api/downloads", { method: "POST", body: { title: "Movie", target } });
    assert.ok(response.status >= 400, `target ${JSON.stringify(target)} is refused`);
    assert.deepEqual(harness.references, [], "an invalid destination never contacts the provider");
    assert.deepEqual(harness.added, [], "and nothing is queued");
  }
});

test("a withdrawal while the handle is minted queues nothing", async (t) => {
  const local = library("lib_movies", "movie");
  const harness = await mount([streamAddon("stream-addon")], {
    viewer: admin, libraries: [local], source: { url: "media-server:forged", name: "Movie.mkv" } as StreamItem,
    downloadReference: remoteReference, connections: [remoteConnectionRecord], remoteLibraries: [remoteLibraryRecord],
    withdrawOnReference: denied,
  });
  t.after(harness.close);
  const response = await api(harness.base, "/api/downloads", { method: "POST", body: { title: "Movie" } });
  assert.equal(response.status, 403, "the right is read again after the async proof");
  assert.equal(harness.references.length, 1, "the handle was minted, then the withdrawal was seen");
  assert.deepEqual(harness.added, [], "nothing is queued");
  assert.deepEqual(harness.titles, [], "and no metadata is written");
});

test("a withdrawal during admission writes no metadata", async (t) => {
  const local = library("lib_movies", "movie");
  const harness = await mount([streamAddon("stream-addon")], {
    viewer: admin, libraries: [local], source: { url: "media-server:forged", name: "Movie.mkv" } as StreamItem,
    downloadReference: remoteReference, connections: [remoteConnectionRecord], remoteLibraries: [remoteLibraryRecord],
    withdrawOnAdd: denied,
  });
  t.after(harness.close);
  const response = await api(harness.base, "/api/downloads", { method: "POST", body: { title: "Movie" } });
  assert.equal(response.status, 403, "the right is read once more before the metadata write");
  assert.equal(harness.added.length, 1, "the queue was asked before the second withdrawal was seen");
  assert.deepEqual(harness.titles, [], "no title metadata is written for a withdrawn right");
});


test("a remote copy with no local destination does not contact its provider", async (t) => {
  const harness = await mount([], {
    viewer: admin, libraries: [], source: { url: "media-server:forged", name: "Movie.mkv" } as StreamItem,
    downloadReference: remoteReference,
    connections: [remoteConnectionRecord], remoteLibraries: [remoteLibraryRecord],
  });
  t.after(harness.close);
  const response = await api(harness.base, "/api/downloads", { method: "POST", body: { title: "Movie" } });
  assert.equal(response.status, 400);
  assert.equal(harness.references.length, 0);
  assert.deepEqual(harness.added, []);
});

/** A sealed original the session could genuinely hold, so the route reads its remote library off
 *  the address itself rather than off anything the request body says. */
const sealedNative = (libraryId = remoteLibraryRecord.id, copyKind?: "movie" | "series"): StreamItem => ({
  url: sealRemoteContent({
    provider: "jellyfin", serverId: "server-1", accountId: "account-1", itemId: "item-1",
    connectionId: remoteConnectionRecord.id, libraryId, generation: 1, mediaSourceId: "v1",
    ...(copyKind === undefined ? {} : { copyKind }),
    owner: { userId: BOB, sid: "sid-bob", expiresAt: Number.MAX_SAFE_INTEGER, secretStamp: "d".repeat(64) },
  }),
  name: "Movie.2020.mkv",
});

/** A remote library Bob is granted, so the owner-bound queue check can pass for him. */
const remoteLibraryOfType = (type: "movie" | "series" | "mixed", over: Record<string, unknown> = {}) =>
  ({ ...remoteLibraryRecord, type, allowedUsers: [BOB], ...over });

test("a remote-only rules profile queues a film without an addon", async (t) => {
  const balanced = RULE_PRESETS.find((preset) => preset.id === SOURCE_PROFILE_IDS.balanced)!;
  const harness = await mount([], {
    viewer: ordinary,
    profiles: [{
      id: balanced.id,
      revision: 1,
      template: balanced.template,
      nameKey: balanced.nameKey,
      parameters: balanced.rules,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
    connections: [remoteConnectionRecord],
    remoteLibraries: [remoteLibraryOfType("movie")],
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/downloads/bulk", {
    method: "POST",
    body: {
      title: "Heat",
      type: "movie",
      episodes: [{ id: "tt-film" }],
      media: { id: "tt-film", metaType: "movie" },
      selection: profileSelection(balanced.id),
    },
  });
  assert.equal(response.status, 201, await response.text());
  assert.equal(harness.pending.length, 1);
  assert.equal(harness.pending[0]?.type, "movie");
  assert.deepEqual(harness.pending[0]?.selection?.addonKeys, []);
  assert.deepEqual(harness.pending[0]?.sourceAdmission?.providerKeys, [`remote:${remoteLibraryRecord.id}`]);
});

const bobReference: RemoteDownloadReference = { ...remoteReference, ownerUserId: BOB };

const destinationOf = (harness: Harness) => harness.added[0]?.settings;

/** The two per-kind rules a remote library stores, in the shape the editor saves them. */
const storedRule = (movie: Partial<DownloadTargetSettings> = {}, series: Partial<DownloadTargetSettings> = {}) => ({
  movie: { subfolder: "", layout: "structured" as const, ...movie },
  series: { subfolder: "", layout: "structured" as const, ...series },
});

/** A local library that is hidden, read-only or gone, so a stored destination can be pointed at a
 *  library the admission must refuse. */
const brokenDestinations: Array<[string, (entry: LibraryRecord) => LibraryRecord | undefined]> = [
  ["hidden", (entry) => ({ ...entry, visibleTo: [] })],
  ["read-only", (entry) => ({ ...entry, visibleTo: [BOB], readOnly: true })],
  ["gone", () => undefined],
];

test("a stored rule captures its library, subfolder and layout, and a folder that does not exist yet is fine", async (t) => {
  const films = library("lib_films", "movie", { visibleTo: [BOB] });
  const harness = await mount([], {
    viewer: ordinary, libraries: [films], source: sealedNative(),
    downloadReference: bobReference, connections: [remoteConnectionRecord],
    // The folder "Filmy/2024" is not on disk: an addon rule's folder is created by the queue, so a
    // copy without a manual pick must not treat it as an already-existing directory.
    remoteLibraries: [remoteLibraryOfType("movie", { downloadSettings: storedRule({ subfolder: "Filmy/2024", layout: "flat", libraryId: films.id }) })],
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/downloads", { method: "POST", body: { title: "Movie" } });
  assert.equal(response.status, 201, await response.text());
  assert.deepEqual(destinationOf(harness), { subfolder: "Filmy/2024", layout: "flat", libraryId: films.id });
  assert.equal(destinationOf(harness)?.explicit, undefined, "an automatic destination is not a manual pick");
});

test("an episode copies with the series rule, structured and subfoldered", async (t) => {
  const shows = library("lib_shows", "series", { visibleTo: [BOB] });
  const harness = await mount([], {
    viewer: ordinary, libraries: [shows], source: sealedNative(),
    media: { kind: "episode", title: "The Show", season: 1, episode: 2 },
    downloadReference: bobReference, connections: [remoteConnectionRecord],
    remoteLibraries: [remoteLibraryOfType("series", { downloadSettings: storedRule({}, { subfolder: "Serialy", layout: "structured", libraryId: shows.id }) })],
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/downloads", { method: "POST", body: { title: "Episode" } });
  assert.equal(response.status, 201, await response.text());
  assert.deepEqual(destinationOf(harness), { subfolder: "Serialy", layout: "structured", libraryId: shows.id });
});

test("a mixed remote library's stored rule follows the item's own kind", async (t) => {
  const films = library("lib_films", "movie", { visibleTo: [BOB] });
  const shows = library("lib_shows", "series", { visibleTo: [BOB] });
  const rules = storedRule({ subfolder: "Filmy", layout: "flat", libraryId: films.id }, { subfolder: "Serialy", layout: "structured", libraryId: shows.id });
  const movie = await mount([], {
    viewer: ordinary, libraries: [films, shows], source: sealedNative(),
    downloadReference: bobReference, connections: [remoteConnectionRecord],
    remoteLibraries: [remoteLibraryOfType("mixed", { downloadSettings: rules })],
  });
  t.after(movie.close);
  const movieResponse = await api(movie.base, "/api/downloads", { method: "POST", body: { title: "Movie" } });
  assert.equal(movieResponse.status, 201, await movieResponse.text());
  assert.deepEqual(destinationOf(movie), { subfolder: "Filmy", layout: "flat", libraryId: films.id }, "a film takes the movie slot");

  const episode = await mount([], {
    viewer: ordinary, libraries: [films, shows], source: sealedNative(),
    media: { kind: "episode", title: "The Show", season: 1, episode: 2 },
    downloadReference: bobReference, connections: [remoteConnectionRecord],
    remoteLibraries: [remoteLibraryOfType("mixed", { downloadSettings: rules })],
  });
  t.after(episode.close);
  const episodeResponse = await api(episode.base, "/api/downloads", { method: "POST", body: { title: "Episode" } });
  assert.equal(episodeResponse.status, 201, await episodeResponse.text());
  assert.deepEqual(destinationOf(episode), { subfolder: "Serialy", layout: "structured", libraryId: shows.id }, "an episode takes the series slot");
});

for (const [label, shape] of brokenDestinations) {
  test(`a stored rule whose library is ${label} is refused before the provider is contacted`, async (t) => {
    const configured = `lib_${"a".repeat(8)}`;
    const stored = shape(library(configured, "movie", { visibleTo: [BOB] }));
    const harness = await mount([], {
      viewer: ordinary, libraries: [...(stored ? [stored] : []), library("lib_fallback", "movie", { visibleTo: [BOB] })],
      source: sealedNative(), downloadReference: bobReference, connections: [remoteConnectionRecord],
      remoteLibraries: [remoteLibraryOfType("movie", { downloadSettings: storedRule({ subfolder: "X", libraryId: configured }) })],
    });
    t.after(harness.close);

    const response = await api(harness.base, "/api/downloads", { method: "POST", body: { title: "Movie" } });
    assert.ok(response.status >= 400, `the stored ${label} rule library is refused`);
    assert.deepEqual(harness.references, [], "no provider was contacted before the refusal");
    assert.deepEqual(harness.added, [], "and nothing is substituted for the unusable destination");
  });
}

test("the queue captures the resolved rule, so a later change cannot move the copy", async (t) => {
  const films = library("lib_films", "movie", { visibleTo: [BOB] });
  const other = library("lib_other", "movie", { visibleTo: [BOB] });
  const record = remoteLibraryOfType("movie", { downloadSettings: storedRule({ subfolder: "Filmy", layout: "flat", libraryId: films.id }) }) as Record<string, unknown>;
  const harness = await mount([], {
    viewer: ordinary, libraries: [films, other], source: sealedNative(),
    downloadReference: bobReference, connections: [remoteConnectionRecord],
    remoteLibraries: [record],
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/downloads", { method: "POST", body: { title: "Movie" } });
  assert.equal(response.status, 201, await response.text());
  const captured = destinationOf(harness)!;
  // A later edit of the stored rule is a fresh record; the captured job keeps its own copy.
  record.downloadSettings = storedRule({ subfolder: "Moved", libraryId: other.id });
  assert.deepEqual(captured, { subfolder: "Filmy", layout: "flat", libraryId: films.id });
});

test("a native copy with no target lands in the remote library's configured destination", async (t) => {
  const films = library("lib_films", "movie", { visibleTo: [BOB] });
  const other = library("lib_other", "movie", { visibleTo: [BOB] });
  const harness = await mount([], {
    viewer: ordinary, libraries: [other, films], source: sealedNative(),
    downloadReference: bobReference, connections: [remoteConnectionRecord],
    remoteLibraries: [remoteLibraryOfType("movie", { downloadLibraryId: films.id })],
    settings: { defaultMovieLibrary: other.id },
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/downloads", { method: "POST", body: { title: "Movie" } });
  assert.equal(response.status, 201, await response.text());
  assert.equal(harness.assertions.length, 1, "the sealed identity was re-proved before its library was read");
  assert.equal(destinationOf(harness)?.libraryId, films.id, "the configured handle wins over the kind's default");
  assert.equal(destinationOf(harness)?.explicit, undefined, "configured subfolders use rule naming; native jobs pin the library separately");
  assert.equal(destinationOf(harness)?.layout, "structured");
  assert.equal(destinationOf(harness)?.subfolder, "");
});

test("a movie remote library with no override follows the movie default", async (t) => {
  const films = library("lib_films", "movie", { visibleTo: [BOB] });
  const shows = library("lib_shows", "series", { visibleTo: [BOB] });
  const harness = await mount([], {
    viewer: ordinary, libraries: [shows, films], source: sealedNative(),
    downloadReference: bobReference, connections: [remoteConnectionRecord],
    remoteLibraries: [remoteLibraryOfType("movie")],
    settings: { defaultMovieLibrary: films.id, defaultSeriesLibrary: shows.id },
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/downloads", { method: "POST", body: { title: "Movie" } });
  assert.equal(response.status, 201, await response.text());
  assert.equal(destinationOf(harness)?.libraryId, films.id, "a movie library uses the movie default");
});

test("a series remote library with no override follows the series default", async (t) => {
  const films = library("lib_films", "movie", { visibleTo: [BOB] });
  const shows = library("lib_shows", "series", { visibleTo: [BOB] });
  const harness = await mount([], {
    viewer: ordinary, libraries: [films, shows], source: sealedNative(),
    media: { kind: "episode", title: "The Show", season: 1, episode: 2 },
    downloadReference: bobReference, connections: [remoteConnectionRecord],
    remoteLibraries: [remoteLibraryOfType("series")],
    settings: { defaultMovieLibrary: films.id, defaultSeriesLibrary: shows.id },
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/downloads", { method: "POST", body: { title: "Episode" } });
  assert.equal(response.status, 201, await response.text());
  assert.equal(destinationOf(harness)?.libraryId, shows.id, "a series library uses the series default");
});

test("a mixed remote library prefers the first mixed local library, whatever the kind default is", async (t) => {
  const films = library("lib_films", "movie", { visibleTo: [BOB] });
  const box = library("lib_box", "mixed", { visibleTo: [BOB], order: 3 });
  const harness = await mount([], {
    viewer: ordinary, libraries: [box, films], source: sealedNative(),
    downloadReference: bobReference, connections: [remoteConnectionRecord],
    remoteLibraries: [remoteLibraryOfType("mixed")],
    settings: { defaultMovieLibrary: films.id },
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/downloads", { method: "POST", body: { title: "Movie" } });
  assert.equal(response.status, 201, await response.text());
  assert.equal(destinationOf(harness)?.libraryId, box.id, "mixed content goes to a mixed library");
});

test("an explicit target overrides the configured destination", async (t) => {
  const configured = library("lib_configured", "movie", { visibleTo: [BOB] });
  const picked = library("lib_picked", "movie", { visibleTo: [BOB] });
  const harness = await mount([], {
    viewer: ordinary, libraries: [configured, picked], source: sealedNative(),
    downloadReference: bobReference, connections: [remoteConnectionRecord],
    remoteLibraries: [remoteLibraryOfType("movie", { downloadLibraryId: configured.id })],
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/downloads", {
    method: "POST", body: { title: "Movie", target: { libraryId: picked.id } },
  });
  assert.equal(response.status, 201, await response.text());
  assert.equal(destinationOf(harness)?.libraryId, picked.id, "the viewer's own choice wins");
});

test("a read-only default for the kind is passed over the way the queue already passes it over", async (t) => {
  const readOnly = library("lib_readonly", "movie", { visibleTo: [BOB], readOnly: true });
  const writable = library("lib_writable", "movie", { visibleTo: [BOB], order: 1 });
  const harness = await mount([], {
    viewer: ordinary, libraries: [readOnly, writable], source: sealedNative(),
    downloadReference: bobReference, connections: [remoteConnectionRecord],
    remoteLibraries: [remoteLibraryOfType("movie")],
    settings: { defaultMovieLibrary: readOnly.id },
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/downloads", { method: "POST", body: { title: "Movie" } });
  assert.equal(response.status, 201, await response.text());
  assert.equal(destinationOf(harness)?.libraryId, writable.id, "the kind's rule skips a root no copy may be written to");
});

for (const [label, shape] of brokenDestinations) {
  test(`a configured destination that is ${label} is refused, never swapped for another library`, async (t) => {
    const configured = `lib_${"a".repeat(8)}`;
    const stored = shape(library(configured, "movie", { visibleTo: [BOB] }));
    const fallback = library("lib_fallback", "movie", { visibleTo: [BOB] });
    const harness = await mount([], {
      viewer: ordinary, libraries: [...(stored ? [stored] : []), fallback], source: sealedNative(),
      downloadReference: bobReference, connections: [remoteConnectionRecord],
      remoteLibraries: [remoteLibraryOfType("movie", { downloadLibraryId: configured })],
    });
    t.after(harness.close);

    const response = await api(harness.base, "/api/downloads", { method: "POST", body: { title: "Movie" } });
    assert.ok(response.status >= 400, `the stored ${label} destination is refused`);
    assert.deepEqual(harness.references, [], "no provider was contacted before the refusal");
    assert.deepEqual(harness.added, [], "and the fallback library is never substituted");
  });
}

test("a withdrawal while the native handle is minted leaves nothing queued", async (t) => {
  const films = library("lib_films", "movie", { visibleTo: [BOB] });
  const harness = await mount([], {
    viewer: ordinary, libraries: [films], source: sealedNative(),
    downloadReference: bobReference, connections: [remoteConnectionRecord],
    remoteLibraries: [remoteLibraryOfType("movie", { downloadLibraryId: films.id })],
    withdrawOnReference: denied,
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/downloads", { method: "POST", body: { title: "Movie" } });
  assert.equal(response.status, 403, "the right is read again after the async proof");
  assert.deepEqual(harness.added, [], "the resolved destination does not survive a withdrawal");
});

test("a native series copy without episode metadata still uses the series default", async (t) => {
  const films = library("lib_films", "movie", { visibleTo: [BOB] });
  const shows = library("lib_shows", "series", { visibleTo: [BOB] });
  const harness = await mount([], {
    viewer: ordinary, libraries: [films, shows], source: sealedNative(),
    downloadReference: bobReference, connections: [remoteConnectionRecord],
    remoteLibraries: [remoteLibraryOfType("series")],
    settings: { defaultMovieLibrary: films.id, defaultSeriesLibrary: shows.id },
  });
  t.after(harness.close);
  const response = await api(harness.base, "/api/downloads", { method: "POST", body: { title: "Episode" } });
  assert.equal(response.status, 201, await response.text());
  assert.equal(destinationOf(harness)?.libraryId, shows.id);
});

/** A mixed remote library with a distinct movie and series destination, so a forged body kind
 *  would visibly take the other slot. */
const mixedRules = (films: LibraryRecord, shows: LibraryRecord) =>
  storedRule({ subfolder: "Filmy", layout: "flat", libraryId: films.id }, { subfolder: "Serialy", layout: "structured", libraryId: shows.id });

test("a proved movie cannot be pushed into the series slot by a fabricated body kind", async (t) => {
  const films = library("lib_films", "movie", { visibleTo: [BOB] });
  const shows = library("lib_shows", "series", { visibleTo: [BOB] });
  const rules = mixedRules(films, shows);
  assert.notEqual(rules.movie.libraryId, rules.series.libraryId, "the two slots are distinct");
  const harness = await mount([], {
    viewer: ordinary, libraries: [films, shows], source: sealedNative(remoteLibraryRecord.id, "movie"),
    media: { kind: "episode", title: "The Show", season: 1, episode: 5 },
    downloadReference: bobReference, connections: [remoteConnectionRecord],
    remoteLibraries: [remoteLibraryOfType("mixed", { downloadSettings: rules })],
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/downloads", { method: "POST", body: { title: "Fabricated" } });
  assert.equal(response.status, 201, await response.text());
  assert.deepEqual(destinationOf(harness), { subfolder: "Filmy", layout: "flat", libraryId: films.id }, "the proved movie kind takes the movie slot");
  assert.equal(harness.added[0]?.media?.kind, "movie", "a fabricated episode kind is normalised away");
  assert.equal(harness.added[0]?.media?.title, "The Show", "the caller's own metadata is otherwise kept");
});

test("a proved series episode takes the series slot whatever the body claims", async (t) => {
  const films = library("lib_films", "movie", { visibleTo: [BOB] });
  const shows = library("lib_shows", "series", { visibleTo: [BOB] });
  const rules = mixedRules(films, shows);
  for (const media of [{ kind: "movie" as const, title: "The Show" }, undefined]) {
    const harness = await mount([], {
      viewer: ordinary, libraries: [films, shows], source: sealedNative(remoteLibraryRecord.id, "series"),
      ...(media ? { media } : {}),
      downloadReference: bobReference, connections: [remoteConnectionRecord],
      remoteLibraries: [remoteLibraryOfType("mixed", { downloadSettings: rules })],
    });
    t.after(harness.close);

    const response = await api(harness.base, "/api/downloads", { method: "POST", body: { title: "The Show" } });
    assert.equal(response.status, 201, await response.text());
    assert.deepEqual(destinationOf(harness), { subfolder: "Serialy", layout: "structured", libraryId: shows.id }, "the proved series kind takes the series slot");
    assert.equal(harness.added[0]?.media?.kind, "episode", "the item is queued as an episode");
    assert.equal(harness.added[0]?.media?.title, "The Show", "the episode title falls back to the body and is kept");
  }
});

test("a mixed library without a sealed kind keeps the body-based fallback", async (t) => {
  const films = library("lib_films", "movie", { visibleTo: [BOB] });
  const shows = library("lib_shows", "series", { visibleTo: [BOB] });
  const harness = await mount([], {
    viewer: ordinary, libraries: [films, shows], source: sealedNative(),
    media: { kind: "episode", title: "The Show", season: 1, episode: 2 },
    downloadReference: bobReference, connections: [remoteConnectionRecord],
    remoteLibraries: [remoteLibraryOfType("mixed", { downloadSettings: mixedRules(films, shows) })],
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/downloads", { method: "POST", body: { title: "Episode" } });
  assert.equal(response.status, 201, await response.text());
  assert.deepEqual(destinationOf(harness), { subfolder: "Serialy", layout: "structured", libraryId: shows.id }, "an older seal still follows the body's kind");
});

test("an explicit target still overrides a proved mixed destination", async (t) => {
  const films = library("lib_films", "movie", { visibleTo: [BOB] });
  const box = library("lib_box", "mixed", { visibleTo: [BOB] });
  const harness = await mount([], {
    viewer: ordinary, libraries: [films, box], source: sealedNative(remoteLibraryRecord.id, "movie"),
    downloadReference: bobReference, connections: [remoteConnectionRecord],
    remoteLibraries: [remoteLibraryOfType("mixed", { downloadSettings: storedRule({ subfolder: "Filmy", libraryId: films.id }) })],
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/downloads", { method: "POST", body: { title: "Movie", target: { libraryId: box.id } } });
  assert.equal(response.status, 201, await response.text());
  assert.equal(destinationOf(harness)?.libraryId, box.id, "the viewer's own choice wins over the proved slot");
  assert.equal(destinationOf(harness)?.explicit, true, "and is marked as a manual pick");
});

for (const [label, shape] of brokenDestinations) {
  test(`a proved mixed slot whose library is ${label} is refused before the provider is proved`, async (t) => {
    const configured = `lib_${"a".repeat(8)}`;
    const stored = shape(library(configured, "movie", { visibleTo: [BOB] }));
    const harness = await mount([], {
      viewer: ordinary, libraries: [...(stored ? [stored] : []), library("lib_fallback", "movie", { visibleTo: [BOB] })],
      source: sealedNative(remoteLibraryRecord.id, "movie"), downloadReference: bobReference, connections: [remoteConnectionRecord],
      remoteLibraries: [remoteLibraryOfType("mixed", { downloadSettings: storedRule({ subfolder: "X", libraryId: configured }) })],
    });
    t.after(harness.close);

    const response = await api(harness.base, "/api/downloads", { method: "POST", body: { title: "Movie" } });
    assert.ok(response.status >= 400, `the proved ${label} slot is refused`);
    assert.deepEqual(harness.references, [], "no provider was contacted before the refusal");
    assert.deepEqual(harness.added, [], "and nothing is substituted for the unusable destination");
  });
}
