import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { messageKeyOf } from "../errors.js";
import { FollowService, FollowStore, type FollowSourceProfile } from "../follows.js";
import { defaultDownloadLibrary } from "../downloads.js";
import type { DefaultLibrarySettings, LibraryRecord } from "../libraries.js";
import { defaultDownloadSettings } from "../naming.js";
import { materializeSourceAdmissionPolicy, parseSourceAdmissionSnapshotV1, SourceAdmissionRejected, type SourceAdmissionSnapshotV1 } from "../source-admission.js";
import {
  buildTemplatePolicy,
  defaultTemplateParameters,
  SOURCE_PROFILE_DEFINITIONS,
  SOURCE_PROFILE_IDS,
} from "../source-profiles.js";
import type { Store, StoredSourceProfile, UserPrefs } from "../store.js";
import type { UserData, UserRecord } from "../users.js";
import { calendarFeedHandler, registerFollowRoutes, type FollowDeps } from "./follows.js";

const ADA = "usr_00000001";
const BOB = "usr_00000002";
const CARL = "usr_00000003";

const account = (id: string, role: "admin" | "user", downloadToLibrary = true): UserRecord => ({
  id, username: role === "admin" ? "ada" : "bob", role, createdAt: "2026-01-01T00:00:00.000Z",
  permissions: { downloadToLibrary, downloadToDevice: true }, permissionsVersion: 0,
} as unknown as UserRecord);

interface Harness {
  base: string;
  store: FollowStore;
  service: FollowService;
  sourceProfiles: StoredSourceProfile[];
  jobs: Array<{ id: string; status: string; follow?: { followId: string; episodeKey: string; intent: string }; sourceAdmission?: SourceAdmissionSnapshotV1 }>;
  users: Record<string, UserRecord>;
  close(): Promise<void>;
}

const profileAdmission = (profileId: string): SourceAdmissionSnapshotV1 => {
  const definition = SOURCE_PROFILE_DEFINITIONS.find((candidate) => candidate.id === profileId);
  assert.ok(definition);
  const providerKeys = ["addon:admin-addon"];
  return parseSourceAdmissionSnapshotV1({
    schemaVersion: 1,
    profile: { id: profileId, revision: definition.revision },
    operation: "downloadToLibrary",
    providerKeys,
    policy: materializeSourceAdmissionPolicy(
      definition.policy,
      providerKeys,
      { audioLanguage: "en", subtitleLanguage: "en" },
    ),
  });
};

const sourceAdmissionFor = (
  sourceProfile: FollowSourceProfile,
  profiles: readonly StoredSourceProfile[],
): SourceAdmissionSnapshotV1 => {
  const live = profiles.find((profile) => profile.id === sourceProfile.profileId);
  const template = sourceProfile.template ?? live?.template;
  const parameters = sourceProfile.template === undefined ? live?.parameters : sourceProfile.parameters;
  if (sourceProfile.template === undefined && !live) throw new SourceAdmissionRejected("profileUnknown");
  if (sourceProfile.template === undefined && live?.revision !== sourceProfile.revision) {
    throw new SourceAdmissionRejected("profileRevisionStale");
  }
  assert.ok(template);
  const providerKeys = ["addon:stream-addon", "addon:admin-addon"];
  return parseSourceAdmissionSnapshotV1({
    schemaVersion: 1,
    profile: { id: sourceProfile.profileId, revision: sourceProfile.revision, template },
    operation: "downloadToLibrary",
    providerKeys,
    policy: materializeSourceAdmissionPolicy(
      buildTemplatePolicy(template, parameters),
      providerKeys,
      { audioLanguage: "en", subtitleLanguage: "en" },
    ),
  });
};

/** Real express over a real store: the routes take everything from the context, and the
 *  account each request speaks for is named by a header so one server can hold two. */
const mount = async (options: {
  libraries?: LibraryRecord[];
  settings?: DefaultLibrarySettings;
  addons?: unknown[];
  sourceProfiles?: StoredSourceProfile[];
  defaultDownloadLibrary?: (kind: "movie" | "series") => LibraryRecord | undefined;
} = {}): Promise<Harness> => {
  const dir = mkdtempSync(path.join(tmpdir(), "routes-follows-"));
  const store = new FollowStore(dir);
  await store.load();
  const users: Record<string, UserRecord> = { A: account(ADA, "admin"), B: account(BOB, "user"), C: account(CARL, "user", false) };
  const sourceProfiles = options.sourceProfiles ?? (["recommended", "providerPriority", "travel"] as const).map((template) => ({
    id: SOURCE_PROFILE_IDS[template],
    revision: 1,
    template,
    nameKey: `sourceProfile.${template}`,
    ...(template === "recommended" ? {} : { parameters: defaultTemplateParameters(template) }),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }));
  const jobs: Array<{ id: string; status: string; follow?: { followId: string; episodeKey: string; intent: string }; source?: { type: string; videoId: string }; sourceAdmission?: SourceAdmissionSnapshotV1 }> = [];
  let nextId = 1;
  const queue = {
    addPending: async (_title: string, source: { type: string; videoId: string }, _media: unknown, _ownerUserId: string, follow: { followId: string; episodeKey: string; intent: string }, sourceAdmission?: SourceAdmissionSnapshotV1) => {
      const job = { id: `job-${nextId++}`, status: "queued", follow, source: { type: source.type, videoId: source.videoId }, sourceAdmission };
      jobs.push(job);
      return { id: job.id };
    },
    findActiveEpisode: () => undefined,
    adopt: async () => undefined,
    followJobs: () => jobs,
    get: (id: string) => jobs.find((job) => job.id === id),
    retry: async () => undefined,
    remove: async () => undefined,
  };
  const service = new FollowService({
    store,
    now: () => Date.now(),
    owner: (userId) => {
      const user = Object.values(users).find((entry) => entry.id === userId);
      return user ? { id: user.id, role: user.role, disabled: user.disabled } : undefined;
    },
    meta: async (_owner, type, metaId) => ({
      id: metaId, type, name: "Show",
      videos: [{ id: `${metaId}:1:1`, season: 1, episode: 1, name: "Pilot", released: "2024-03-01" }],
    }),
    queue,
    mayDownload: (ownerUserId) => Boolean(Object.values(users).find((entry) => entry.id === ownerUserId)?.permissions.downloadToLibrary),
    admitSourceProfile: (_ownerUserId, sourceProfile) => sourceAdmissionFor(sourceProfile, sourceProfiles),
  });
  const libraries: LibraryRecord[] = options.libraries ?? [{ id: "lib_shows", name: "Shows", type: "series", root: dir, enabled: true, order: 0, addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: false }];
  const settings = options.settings ?? {};
  const addons = options.addons ?? [
    { key: "stream-addon", enabled: true, role: "source", allowedUsers: [BOB], manifest: { id: "stream-addon", name: "Stream", resources: [{ name: "stream" }] }, downloadSettings: defaultDownloadSettings() },
    { key: "admin-addon", enabled: true, role: "source", allowedUsers: [ADA], manifest: { id: "admin-addon", name: "Admin", resources: [{ name: "stream" }] }, downloadSettings: defaultDownloadSettings() },
  ];
  const userData: Record<string, UserData> = {};
  const keyOfReq = (req: express.Request | undefined) => users[String(req?.header("x-as") ?? "A")]?.id ?? ADA;
  const deps: FollowDeps = {
    store: {
      addons: () => addons,
      libraries: () => libraries,
      settings: () => settings,
      mediaConnections: () => [],
      remoteLibraries: () => [],
      sourceProfiles: () => sourceProfiles,
      prefs: () => ({ uiLanguage: "en", audioLanguage: "en", subtitleLanguage: "en" }) as UserPrefs,
      userData: () => ({} as UserData),
    } as unknown as Store,
    needsSetup: () => false,
    currentSession: () => undefined,
    currentUser: (req) => users[String(req.header("x-as") ?? "A")],
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    stopUserSessions: async () => undefined,
    requireAccess: () => undefined,
    stopContentAccess: async () => undefined,
    follows: service,
    followStore: store,
    prefsOf: () => ({ uiLanguage: "en" }) as UserPrefs,
    markersOf: () => ({}),
    dataOf: (req) => userData[keyOfReq(req)] ?? ({} as UserData),
    updateData: async (req, mutate) => {
      const key = keyOfReq(req);
      const data = userData[key] ?? ({} as UserData);
      mutate(data);
      userData[key] = data;
    },
    posterOf: (value) => (value === undefined || value === null ? undefined : String(value)),
    cachedMeta: async () => null,
    defaultDownloadLibrary: options.defaultDownloadLibrary ?? ((kind) => defaultDownloadLibrary(libraries, settings, kind)),
  };
  const app = express();
  app.use(express.json());
  registerFollowRoutes(app, deps);
  // The public feed lives outside `/api` in index.ts; mounted here so its answers can be driven.
  app.get("/calendar/:token.ics", calendarFeedHandler({
    users: () => Object.values(users),
    userData: (id) => userData[id] ?? ({} as UserData),
    followsOf: (id) => store.listForOwner(id),
    languageOf: () => "en",
  }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error), messageKey: messageKeyOf(error) });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    store,
    service,
    sourceProfiles,
    jobs,
    users,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Creating a follow starts its first check in the background, and it writes follows.json
      // when it lands: the directory goes only once the service has settled.
      await service.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

const api = (base: string, pathname: string, init: { method?: string; body?: unknown; as?: string } = {}) =>
  fetch(`${base}${pathname}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.as ? { "x-as": init.as } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

const keyOf = async (response: Response) => ((await response.json()) as { messageKey?: string }).messageKey;

test("a follow belongs to the account that made it", async () => {
  const h = await mount();
  try {
    const created = await api(h.base, "/api/follows", { method: "POST", as: "A", body: { type: "series", id: "tt1", name: "Show" } });
    assert.equal(created.status, 201);
    const follow = await created.json() as { id: string; episodeCount: number };
    assert.equal(follow.episodeCount, 0);

    const mine = await (await api(h.base, "/api/follows", { as: "A" })).json() as { follows: Array<{ id: string }> };
    assert.deepEqual(mine.follows.map((entry) => entry.id), [follow.id]);
    const theirs = await (await api(h.base, "/api/follows", { as: "B" })).json() as { follows: unknown[] };
    assert.deepEqual(theirs.follows, []);

    assert.equal((await api(h.base, `/api/follows/${follow.id}`, { method: "PATCH", as: "B", body: { enabled: false } })).status, 404);
    assert.equal((await api(h.base, `/api/follows/${follow.id}`, { method: "DELETE", as: "B" })).status, 404);
    assert.equal((await api(h.base, `/api/follows/${follow.id}/check`, { method: "POST", as: "B" })).status, 404);
    assert.equal(((await (await api(h.base, "/api/follows/by-meta/series/tt1", { as: "B" })).json()) as { follow: unknown }).follow, null);

    const patch = await api(h.base, `/api/follows/${follow.id}`, { method: "PATCH", as: "A", body: { enabled: false } });
    assert.equal(patch.status, 200);
    assert.equal(((await patch.json()) as { enabled: boolean }).enabled, false);
    assert.ok(((await (await api(h.base, "/api/follows/by-meta/series/tt1", { as: "A" })).json()) as { follow: unknown }).follow);

    assert.equal((await api(h.base, `/api/follows/${follow.id}`, { method: "DELETE", as: "A" })).status, 204);
    assert.equal(((await (await api(h.base, "/api/follows/by-meta/series/tt1", { as: "A" })).json()) as { follow: unknown }).follow, null);
  } finally { await h.close(); }
});

test("a follow records the add-on it was made from", async () => {
  const h = await mount();
  try {
    const created = await (await api(h.base, "/api/follows", { method: "POST", as: "A", body: { type: "series", id: "tt1", name: "Show", addonKey: "quiet" } })).json() as { id: string; addonKey?: string };
    assert.equal(created.addonKey, "quiet");
    const plain = await (await api(h.base, "/api/follows", { method: "POST", as: "A", body: { type: "series", id: "tt2", name: "Other" } })).json() as { addonKey?: string };
    assert.equal(plain.addonKey, undefined);
  } finally { await h.close(); }
});

test("a follow needs a type, an id and a name", async () => {
  const h = await mount();
  try {
    const response = await api(h.base, "/api/follows", { method: "POST", as: "A", body: { type: "series", id: "tt1" } });
    assert.equal(response.status, 400);
    assert.equal(await keyOf(response), "err.followInvalid");
  } finally { await h.close(); }
});

test("a check is throttled and its episodes show up behind the view", async () => {
  const h = await mount();
  try {
    const follow = await (await api(h.base, "/api/follows", { method: "POST", as: "A", body: { type: "series", id: "tt1", name: "Show" } })).json() as { id: string };
    const first = await api(h.base, `/api/follows/${follow.id}/check`, { method: "POST", as: "A" });
    assert.equal(first.status, 200);
    assert.equal(((await first.json()) as { episodeCount: number }).episodeCount, 1);
    const second = await api(h.base, `/api/follows/${follow.id}/check`, { method: "POST", as: "A" });
    assert.equal(second.status, 429);
    assert.equal(await keyOf(second), "err.followCooldown");

    const episodes = await (await api(h.base, "/api/follows/new-episodes", { as: "A" })).json() as { items: unknown[] };
    assert.deepEqual(episodes.items, []);
  } finally { await h.close(); }
});

test("switching a follow to automatic needs the right to queue", async () => {
  const h = await mount();
  try {
    const follow = await (await api(h.base, "/api/follows", { method: "POST", as: "C", body: { type: "series", id: "tt1", name: "Show" } })).json() as { id: string };
    const denied = await api(h.base, `/api/follows/${follow.id}`, {
      method: "PATCH", as: "C",
      body: { autoDownload: { startMode: "new", selection: { addonKeys: ["stream-addon"], audioLanguage: "en" } } },
    });
    assert.equal(denied.status, 403);
    assert.equal(await keyOf(denied), "err.downloadLibraryNotAllowed");

    const allowed = await api(h.base, `/api/follows/${follow.id}`, {
      method: "PATCH", as: "B",
      body: { autoDownload: { startMode: "new", selection: { addonKeys: ["stream-addon"], audioLanguage: "en" } } },
    });
    assert.equal(allowed.status, 404, "the follow belongs to another account");
  } finally { await h.close(); }
});

test("an automatic rule stores an explicit, concrete target", async () => {
  const h = await mount();
  try {
    const follow = await (await api(h.base, "/api/follows", { method: "POST", as: "A", body: { type: "series", id: "tt1", name: "Show" } })).json() as { id: string };
    const response = await api(h.base, `/api/follows/${follow.id}`, {
      method: "PATCH", as: "A",
      body: { autoDownload: { startMode: "new", selection: { addonKeys: ["stream-addon"], audioLanguage: "en" } } },
    });
    assert.equal(response.status, 200, await response.clone().text());
    const view = await response.json() as { autoDownload?: { enabledAt: string; startMode: string; selection: { addonKeys: string[]; targetSettings: Record<string, unknown> } } };
    assert.ok(view.autoDownload?.enabledAt);
    assert.equal(view.autoDownload?.startMode, "new");
    assert.deepEqual(view.autoDownload?.selection.addonKeys, ["stream-addon"]);
    assert.deepEqual(view.autoDownload?.selection.targetSettings, { libraryId: "lib_shows", subfolder: "", layout: "structured", explicit: true });
  } finally { await h.close(); }
});

test("PATCH /api/follows/:id refuses a selection rule the server cannot express and leaves the stored rule unchanged", async () => {
  const h = await mount();
  try {
    const follow = await (await api(h.base, "/api/follows", { method: "POST", as: "A", body: { type: "series", id: "tt1", name: "Show" } })).json() as { id: string };
    const selection = { addonKeys: ["stream-addon"], sourceStrategy: "largest", audioLanguage: "en", audioMode: "strict", subtitleMode: "off" };
    const stored = await api(h.base, `/api/follows/${follow.id}`, {
      method: "PATCH", as: "A",
      body: { autoDownload: { startMode: "new", selection } },
    });
    assert.equal(stored.status, 200, await stored.clone().text());
    const before = structuredClone(h.store.get(follow.id)?.autoDownload);
    assert.equal(before?.selection.sourceStrategy, "largest");

    const refused = await api(h.base, `/api/follows/${follow.id}`, {
      method: "PATCH", as: "A",
      body: { autoDownload: { startMode: "new", selection: { ...selection, sourceStrategy: "smallest" } } },
    });
    assert.equal(refused.status, 400);
    assert.equal(await keyOf(refused), "err.selectionUpgradeRequired");
    assert.deepEqual(h.store.get(follow.id)?.autoDownload, before);
  } finally { await h.close(); }
});

test("a follow stores and exposes an executable source profile reference", async () => {
  const h = await mount();
  try {
    const follow = await (await api(h.base, "/api/follows", {
      method: "POST", as: "A", body: { type: "series", id: "tt1", name: "Show" },
    })).json() as { id: string };
    const response = await api(h.base, `/api/follows/${follow.id}`, {
      method: "PATCH",
      as: "A",
      body: {
        autoDownload: {
          startMode: "new",
          selection: { profile: { profileId: SOURCE_PROFILE_IDS.travel, revision: 1 } },
        },
      },
    });
    assert.equal(response.status, 200, await response.clone().text());
    const view = await response.json() as {
      autoDownload?: {
        sourceProfile?: { profileId: string; revision: number };
        selection: { addonKeys: string[]; audioLanguage: string };
      };
    };
    assert.deepEqual(view.autoDownload?.sourceProfile, { profileId: SOURCE_PROFILE_IDS.travel, revision: 1 });
    assert.deepEqual(view.autoDownload?.selection.addonKeys, ["stream-addon", "admin-addon"]);
    assert.equal(view.autoDownload?.selection.audioLanguage, "en");
    assert.equal(JSON.stringify(view).includes("sourceAdmission"), false);
  } finally { await h.close(); }
});

test("a follow keeps its variant snapshot through edits and deletion until its setup is saved again", async () => {
  const variantId = "4ecf83c6-2228-4a5c-81e5-97a85c3f946f";
  const originalParameters = {
    ...defaultTemplateParameters("travel"),
    heightPixels: { min: 720 },
  };
  const currentParameters = {
    ...defaultTemplateParameters("travel"),
    heightPixels: { min: 1080 },
  };
  const variant: StoredSourceProfile = {
    id: variantId,
    revision: 1,
    template: "travel",
    name: "Kids 720p",
    parameters: originalParameters,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const h = await mount({ sourceProfiles: [variant] });
  try {
    const follow = await (await api(h.base, "/api/follows", {
      method: "POST", as: "A", body: { type: "series", id: "tt1", name: "Show" },
    })).json() as { id: string };
    await h.store.recordCheck(follow.id, {
      episodes: [{ key: "1:1", videoId: "tt1:1:1", season: 1, episode: 1, released: "2024-03-01T00:00:00.000Z", firstSeenAt: "2024-01-01T00:00:00.000Z" }],
      now: Date.parse("2024-04-01T00:00:00.000Z"),
    });

    const configured = await api(h.base, `/api/follows/${follow.id}`, {
      method: "PATCH",
      as: "A",
      body: {
        autoDownload: {
          startMode: "from",
          startSeason: 1,
          startEpisode: 1,
          selection: { profile: { profileId: variantId, revision: 1 } },
        },
      },
    });
    assert.equal(configured.status, 200, await configured.clone().text());
    const configuredView = await configured.json() as { autoDownload: { sourceProfile: Record<string, unknown> } };
    assert.deepEqual(configuredView.autoDownload.sourceProfile, { profileId: variantId, revision: 1 });
    assert.deepEqual(h.store.get(follow.id)?.autoDownload?.sourceProfile, {
      profileId: variantId,
      revision: 1,
      template: "travel",
      parameters: originalParameters,
    });

    h.sourceProfiles.splice(0, 1, {
      ...variant,
      revision: 2,
      parameters: currentParameters,
      updatedAt: "2026-02-01T00:00:00.000Z",
    });
    await h.store.recordCheck(follow.id, {
      episodes: [{ key: "1:2", videoId: "tt1:1:2", season: 1, episode: 2, released: "2024-03-02T00:00:00.000Z", firstSeenAt: "2024-01-01T00:00:00.000Z" }],
      now: Date.parse("2024-04-01T00:00:00.000Z"),
    });
    await h.service.admit(follow.id);
    assert.equal(h.jobs.find((job) => job.follow?.episodeKey === "1:2")?.sourceAdmission?.policy.constraints.heightPixels?.min, 720);
    assert.equal(h.store.get(follow.id)?.episodes["1:2"].download?.state, "queued");

    const resaved = await api(h.base, `/api/follows/${follow.id}`, {
      method: "PATCH",
      as: "A",
      body: {
        autoDownload: {
          startMode: "from",
          startSeason: 1,
          startEpisode: 1,
          selection: { profile: { profileId: variantId, revision: 2 } },
        },
      },
    });
    assert.equal(resaved.status, 200, await resaved.clone().text());
    const resavedView = await resaved.json() as { autoDownload: { sourceProfile: Record<string, unknown> } };
    assert.deepEqual(resavedView.autoDownload.sourceProfile, { profileId: variantId, revision: 2 });
    assert.deepEqual(h.store.get(follow.id)?.autoDownload?.sourceProfile, {
      profileId: variantId,
      revision: 2,
      template: "travel",
      parameters: currentParameters,
    });

    h.sourceProfiles.splice(0, 1);
    await h.store.recordCheck(follow.id, {
      episodes: [{ key: "1:3", videoId: "tt1:1:3", season: 1, episode: 3, released: "2024-03-03T00:00:00.000Z", firstSeenAt: "2024-01-01T00:00:00.000Z" }],
      now: Date.parse("2024-04-01T00:00:00.000Z"),
    });
    await h.service.admit(follow.id);
    assert.equal(h.jobs.find((job) => job.follow?.episodeKey === "1:3")?.sourceAdmission?.policy.constraints.heightPixels?.min, 1080);
    assert.equal(h.store.get(follow.id)?.episodes["1:3"].download?.state, "queued");
    assert.notEqual(h.store.get(follow.id)?.episodes["1:3"].download?.reasonKey, "err.sourceProfileUnavailable");
  } finally { await h.close(); }
});

test("a follow refuses stale, non-executable and graced source profiles", async () => {
  const h = await mount();
  try {
    const follow = await (await api(h.base, "/api/follows", {
      method: "POST", as: "A", body: { type: "series", id: "tt1", name: "Show" },
    })).json() as { id: string };
    const body = (selection: unknown, graceDays?: number) => ({
      autoDownload: {
        startMode: "new",
        ...(graceDays === undefined ? {} : { graceDays }),
        selection,
      },
    });

    const stale = await api(h.base, `/api/follows/${follow.id}`, {
      method: "PATCH", as: "A",
      body: body({ profile: { profileId: SOURCE_PROFILE_IDS.travel, revision: 2 } }),
    });
    assert.equal(stale.status, 409);
    assert.equal(await keyOf(stale), "err.sourceProfileRevisionStale");

    const recommended = await api(h.base, `/api/follows/${follow.id}`, {
      method: "PATCH", as: "A",
      body: body({ profile: { profileId: SOURCE_PROFILE_IDS.recommended, revision: 1 } }),
    });
    assert.equal(recommended.status, 400);
    assert.equal(await keyOf(recommended), "err.sourceProfileOperationUnavailable");

    const graced = await api(h.base, `/api/follows/${follow.id}`, {
      method: "PATCH", as: "A",
      body: body({ profile: { profileId: SOURCE_PROFILE_IDS.travel, revision: 1 } }, 3),
    });
    assert.equal(graced.status, 400);
    assert.equal(await keyOf(graced), "err.followInvalid");
    assert.equal(h.store.get(follow.id)?.autoDownload, undefined);
  } finally { await h.close(); }
});

test("a follow episode view never exposes its admission snapshot", async () => {
  const h = await mount();
  try {
    const follow = await (await api(h.base, "/api/follows", {
      method: "POST", as: "A", body: { type: "series", id: "tt1", name: "Show" },
    })).json() as { id: string };
    const snapshot = profileAdmission(SOURCE_PROFILE_IDS.travel);
    await h.store.update(follow.id, (current) => {
      current.episodes["1:1"] = {
        key: "1:1",
        videoId: "tt1:1:1",
        season: 1,
        episode: 1,
        firstSeenAt: "2024-01-01T00:00:00.000Z",
        download: {
          state: "queued",
          intent: `${follow.id}:1:1:1`,
          generation: 1,
          jobId: "job-1",
          attempts: 0,
          sourceAdmission: snapshot,
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      };
    });

    const response = await api(h.base, `/api/follows/${follow.id}/episodes`, { as: "A" });
    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), /sourceAdmission/);
  } finally { await h.close(); }
});

test("an automatic rule whose default library the account cannot see is refused", async () => {
  const h = await mount();
  try {
    const follow = await (await api(h.base, "/api/follows", { method: "POST", as: "B", body: { type: "series", id: "tt1", name: "Show" } })).json() as { id: string };
    const refused = await api(h.base, `/api/follows/${follow.id}`, {
      method: "PATCH", as: "B",
      body: { autoDownload: { startMode: "new", selection: { addonKeys: ["stream-addon"], audioLanguage: "en" } } },
    });
    assert.equal(refused.status, 403, "the rule is refused at the door, not pinned to a library the account cannot see");
    assert.equal(await keyOf(refused), "err.downloadLibraryNotAllowed");
  } finally { await h.close(); }
});

test("an automatic rule is pinned the way the door and the queue resolve the default", async () => {
  const addedAt = "2026-01-01T00:00:00.000Z";
  const readOnly = { id: "lib_ro", name: "Read only", type: "series", root: "", enabled: true, order: 0, addedAt, writeArtwork: false, readOnly: true, visibleTo: [BOB] } as LibraryRecord;
  const writable = { id: "lib_rw", name: "Writable", type: "series", root: "", enabled: true, order: 1, addedAt, writeArtwork: false, visibleTo: [BOB] } as LibraryRecord;
  // The instance default points at the read-only library; the door and the queue both skip it
  // for the first writable one, so the rule must be pinned there too rather than to a library
  // the queue would pause on its first check.
  const h = await mount({ libraries: [readOnly, writable], settings: { defaultSeriesLibrary: readOnly.id } });
  try {
    const follow = await (await api(h.base, "/api/follows", { method: "POST", as: "B", body: { type: "series", id: "tt1", name: "Show" } })).json() as { id: string };
    const response = await api(h.base, `/api/follows/${follow.id}`, {
      method: "PATCH", as: "B",
      body: { autoDownload: { startMode: "new", selection: { addonKeys: ["stream-addon"], audioLanguage: "en" } } },
    });
    assert.equal(response.status, 200);
    const view = await response.json() as { autoDownload?: { selection: { targetSettings: { libraryId?: string } } } };
    assert.equal(view.autoDownload?.selection.targetSettings.libraryId, writable.id, "the writable library, not the read-only default");
  } finally { await h.close(); }
});

test("an automatic rule whose named library is gone falls back only to a library the owner may use", async () => {
  const addedAt = "2026-01-01T00:00:00.000Z";
  const invisible = { id: "lib_hidden", name: "Hidden", type: "series", root: "", enabled: true, order: 0, addedAt, writeArtwork: false, visibleTo: [] } as LibraryRecord;
  const visible = { id: "lib_shows", name: "Shows", type: "series", root: "", enabled: true, order: 1, addedAt, writeArtwork: false, visibleTo: [BOB] } as LibraryRecord;
  // The addon's rule still names a library that has been removed; the door lets that through
  // (a rule whose library is gone is not itself a refusal), so the fallback the rule is pinned
  // to is the thing that has to be checked -- and the default here is invisible to B.
  const addons = [{
    key: "stream-addon", enabled: true, role: "source", allowedUsers: [BOB], manifest: { id: "stream-addon", name: "Stream" },
    downloadSettings: { movie: { subfolder: "", layout: "structured" }, series: { subfolder: "", layout: "structured", libraryId: "lib_gone" } },
  }];
  const h = await mount({ libraries: [invisible, visible], addons });
  try {
    const follow = await (await api(h.base, "/api/follows", { method: "POST", as: "B", body: { type: "series", id: "tt1", name: "Show" } })).json() as { id: string };
    const refused = await api(h.base, `/api/follows/${follow.id}`, {
      method: "PATCH", as: "B",
      body: { autoDownload: { startMode: "new", selection: { addonKeys: ["stream-addon"], audioLanguage: "en" } } },
    });
    assert.equal(refused.status, 403, "the fallback library is invisible to the account");
    assert.equal(await keyOf(refused), "err.downloadLibraryNotAllowed");
    const listed = await (await api(h.base, "/api/follows", { as: "B" })).json() as { follows: Array<{ id: string; autoDownload?: unknown }> };
    assert.equal(listed.follows.find((entry) => entry.id === follow.id)?.autoDownload, undefined, "no rule is stored");
  } finally { await h.close(); }
});

test("an automatic rule validates the preferred-audio window", async () => {
  const h = await mount();
  try {
    const follow = await (await api(h.base, "/api/follows", { method: "POST", as: "A", body: { type: "series", id: "tt1", name: "Show" } })).json() as { id: string };
    const body = (graceDays: unknown) => ({ autoDownload: { startMode: "new", graceDays, selection: { addonKeys: ["stream-addon"], audioLanguage: "en" } } });
    for (const bad of [-1, 31, 2.5, "later"]) {
      const response = await api(h.base, `/api/follows/${follow.id}`, { method: "PATCH", as: "A", body: body(bad) });
      assert.equal(response.status, 400, String(bad));
      assert.equal(await keyOf(response), "err.followInvalid");
    }
    const stored = await api(h.base, `/api/follows/${follow.id}`, { method: "PATCH", as: "A", body: body(7) });
    assert.equal(stored.status, 200);
    assert.equal(((await stored.json()) as { autoDownload?: { graceDays?: number } }).autoDownload?.graceDays, 7);
    const off = await api(h.base, `/api/follows/${follow.id}`, { method: "PATCH", as: "A", body: body(0) });
    assert.equal(off.status, 200);
    assert.equal(((await off.json()) as { autoDownload?: { graceDays?: number } }).autoDownload?.graceDays, undefined, "zero is stored as no waiting at all");
  } finally { await h.close(); }
});

test("an ahead rule validates the episode count and a film refuses it", async () => {
  const h = await mount();
  try {
    const follow = await (await api(h.base, "/api/follows", { method: "POST", as: "A", body: { type: "series", id: "tt1", name: "Show" } })).json() as { id: string };
    const body = (aheadCount: unknown) => ({ autoDownload: { startMode: "ahead", aheadCount, selection: { addonKeys: ["stream-addon"], audioLanguage: "en" } } });
    for (const bad of [0, 11, 2.5, "later", undefined, null]) {
      const response = await api(h.base, `/api/follows/${follow.id}`, { method: "PATCH", as: "A", body: body(bad) });
      assert.equal(response.status, 400, String(bad));
      assert.equal(await keyOf(response), "err.followInvalid");
    }
    const stored = await api(h.base, `/api/follows/${follow.id}`, { method: "PATCH", as: "A", body: body(5) });
    assert.equal(stored.status, 200);
    const view = await stored.json() as { autoDownload?: { startMode: string; aheadCount?: number } };
    assert.equal(view.autoDownload?.startMode, "ahead");
    assert.equal(view.autoDownload?.aheadCount, 5);

    const film = await (await api(h.base, "/api/follows", { method: "POST", as: "A", body: { type: "movie", id: "tt9", name: "Film" } })).json() as { id: string };
    const rejected = await api(h.base, `/api/follows/${film.id}`, {
      method: "PATCH", as: "A",
      body: { autoDownload: { startMode: "ahead", aheadCount: 3, selection: { addonKeys: ["stream-addon"], audioLanguage: "en" } } },
    });
    assert.equal(rejected.status, 400);
    assert.equal(await keyOf(rejected), "err.followInvalid");
  } finally { await h.close(); }
});

test("preview answers what an ahead rule would download now", async () => {
  const h = await mount();
  try {
    const follow = await (await api(h.base, "/api/follows", { method: "POST", as: "A", body: { type: "series", id: "tt1", name: "Show" } })).json() as { id: string };
    await h.store.recordCheck(follow.id, { episodes: [
      { key: "1:1", videoId: "tt1:1:1", season: 1, episode: 1, released: "2024-03-01T23:59:59.999Z", firstSeenAt: "2024-01-01T00:00:00.000Z" },
      { key: "2:1", videoId: "tt1:2:1", season: 2, episode: 1, released: "2024-04-01T23:59:59.999Z", firstSeenAt: "2024-01-01T00:00:00.000Z" },
    ], now: Date.parse("2024-05-01T00:00:00.000Z") });
    const response = await api(h.base, `/api/follows/${follow.id}/preview?startMode=ahead&aheadCount=2`, { as: "A" });
    assert.equal(response.status, 200);
    const view = await response.json() as { count: number; episodes: Array<{ key: string }> };
    assert.equal(view.count, 2, "with no marker the first two episodes fill the window");
    assert.deepEqual(view.episodes.map((episode) => episode.key), ["1:1", "2:1"]);
    const bad = await api(h.base, `/api/follows/${follow.id}/preview?startMode=ahead&aheadCount=0`, { as: "A" });
    assert.equal(bad.status, 400);
    assert.equal(await keyOf(bad), "err.followInvalid");
  } finally { await h.close(); }
});

test("the follow defaults remember the preferred-audio window", async () => {
  const h = await mount();
  try {
    const put = await api(h.base, "/api/follows/defaults", { method: "PUT", as: "A", body: { mode: "download", graceDays: 14 } });
    assert.equal(put.status, 204);
    const read = await (await api(h.base, "/api/follows/defaults", { as: "A" })).json() as { defaults: { graceDays?: number } };
    assert.equal(read.defaults.graceDays, 14);
    const bad = await api(h.base, "/api/follows/defaults", { method: "PUT", as: "A", body: { mode: "download", graceDays: 40 } });
    assert.equal(bad.status, 400);
    assert.equal(await keyOf(bad), "err.followInvalid");
  } finally { await h.close(); }
});

test("another account's follow answers 404 on every new route", async () => {
  const h = await mount();
  try {
    const follow = await (await api(h.base, "/api/follows", { method: "POST", as: "A", body: { type: "series", id: "tt1", name: "Show" } })).json() as { id: string };
    const routes: Array<{ method: string; path: string }> = [
      { method: "GET", path: `/api/follows/${follow.id}/episodes` },
      { method: "GET", path: `/api/follows/${follow.id}/preview?startMode=new` },
      { method: "POST", path: `/api/follows/${follow.id}/episodes/1:1/skip` },
      { method: "POST", path: `/api/follows/${follow.id}/episodes/1:1/retry` },
    ];
    for (const route of routes) {
      const response = await api(h.base, route.path, { method: route.method, as: "B" });
      assert.equal(response.status, 404, `${route.method} ${route.path}`);
    }
  } finally { await h.close(); }
});

test("follow defaults round-trip and drop unknown keys", async () => {
  const h = await mount();
  try {
    const empty = await (await api(h.base, "/api/follows/defaults", { as: "A" })).json() as { defaults: unknown };
    assert.equal(empty.defaults, null, "nothing stored yet");

    const put = await api(h.base, "/api/follows/defaults", {
      method: "PUT", as: "A",
      body: {
        mode: "download", startMode: "from", unknownTop: "dropped",
        selection: {
          addonKeys: ["stream-addon"], sourceStrategy: "largest", audioLanguage: " en ",
          audioMode: "preferred", subtitleMode: "optional", subtitleLanguage: "cs", unknownInner: 1,
        },
        target: { libraryId: " lib_shows ", subfolder: "Shows", layout: "flat", explicit: true },
      },
    });
    assert.equal(put.status, 204);

    const read = await (await api(h.base, "/api/follows/defaults", { as: "A" })).json() as { defaults: Record<string, unknown> };
    assert.deepEqual(read.defaults, {
      mode: "download", startMode: "from",
      selection: { addonKeys: ["stream-addon"], sourceStrategy: "largest", audioLanguage: "en", audioMode: "preferred", subtitleMode: "optional", subtitleLanguage: "cs" },
      target: { libraryId: "lib_shows", subfolder: "Shows", layout: "flat" },
    });
  } finally { await h.close(); }
});

test("a stale addon key and an invisible library are dropped on read", async () => {
  const h = await mount();
  try {
    const body = {
      mode: "download", startMode: "new",
      selection: { addonKeys: ["stream-addon", "admin-addon", "gone-addon"], sourceStrategy: "priority", audioLanguage: "en", audioMode: "listed", subtitleMode: "off" },
      target: { libraryId: "lib_shows", layout: "structured" },
    };
    assert.equal((await api(h.base, "/api/follows/defaults", { method: "PUT", as: "B", body })).status, 204);
    assert.equal((await api(h.base, "/api/follows/defaults", { method: "PUT", as: "A", body })).status, 204);

    const theirs = await (await api(h.base, "/api/follows/defaults", { as: "B" })).json() as { defaults: { selection: { addonKeys: string[] }; target?: unknown } };
    assert.deepEqual(theirs.defaults.selection.addonKeys, ["stream-addon"], "an addon they may not use and one that is gone are dropped");
    assert.equal(theirs.defaults.target, undefined, "a library they may not see is dropped");

    const admins = await (await api(h.base, "/api/follows/defaults", { as: "A" })).json() as { defaults: { selection: { addonKeys: string[] }; target?: { libraryId: string } } };
    assert.deepEqual(admins.defaults.selection.addonKeys, ["stream-addon", "admin-addon"], "an administrator may use both addons");
    assert.equal(admins.defaults.target?.libraryId, "lib_shows", "an administrator sees the library");
  } finally { await h.close(); }
});

test("an invalid defaults body answers 400", async () => {
  const h = await mount();
  try {
    const bodies = [
      {},
      { mode: "sometimes" },
      { mode: "download", startMode: "later" },
      { mode: "download", selection: { addonKeys: ["stream-addon"] } },
      { mode: "download", target: {} },
      { mode: "download", selection: { addonKeys: Array.from({ length: 51 }, (_unused, index) => `addon-${index}`), sourceStrategy: "priority", audioLanguage: "en", audioMode: "listed", subtitleMode: "off" } },
    ];
    for (const body of bodies) {
      const response = await api(h.base, "/api/follows/defaults", { method: "PUT", as: "A", body });
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(await keyOf(response), "err.followInvalid");
    }
  } finally { await h.close(); }
});

test("GET /api/follows/defaults is not read as a follow id", async () => {
  const h = await mount();
  try {
    assert.equal((await api(h.base, "/api/follows/defaults", { as: "A" })).status, 200);
    assert.equal((await api(h.base, "/api/follows/defaults", { method: "PUT", as: "A", body: { mode: "notify" } })).status, 204);
    const read = await (await api(h.base, "/api/follows/defaults", { as: "A" })).json() as { defaults: { mode: string } };
    assert.equal(read.defaults.mode, "notify");
    // The `:id` routes still treat `defaults` as an id, which is why the two new verbs are registered first.
    assert.equal((await api(h.base, "/api/follows/defaults", { method: "PATCH", as: "A", body: { enabled: false } })).status, 404);
  } finally { await h.close(); }
});

test("the calendar window is validated", async () => {
  const h = await mount();
  try {
    const missing = await api(h.base, "/api/follows/calendar", { as: "A" });
    assert.equal(missing.status, 400);
    assert.equal(await keyOf(missing), "err.followInvalid");

    const reversed = await api(h.base, "/api/follows/calendar?from=2024-04-01&to=2024-03-01", { as: "A" });
    assert.equal(reversed.status, 400);
    assert.equal(await keyOf(reversed), "err.followInvalid");

    const tooWide = await api(h.base, "/api/follows/calendar?from=2024-01-01&to=2024-04-01", { as: "A" });
    assert.equal(tooWide.status, 400, "ninety-one days is more than the window allows");

    const atLimit = await api(h.base, "/api/follows/calendar?from=2024-01-01&to=2024-03-03", { as: "A" });
    assert.equal(atLimit.status, 200, "sixty-two days is allowed");
    const window = await atLimit.json() as { items: unknown[]; undated: unknown[] };
    assert.deepEqual(window.items, []);
    assert.deepEqual(window.undated, []);
  } finally { await h.close(); }
});

test("the calendar reports an uncertain episode without a date apart", async () => {
  const h = await mount();
  try {
    const follow = await (await api(h.base, "/api/follows", { method: "POST", as: "A", body: { type: "series", id: "tt1", name: "Show" } })).json() as { id: string };
    // Let the first check settle, then replace its episode with the shape a TMDB placeholder leaves.
    await api(h.base, `/api/follows/${follow.id}/check`, { method: "POST", as: "A" });
    await h.store.update(follow.id, (current) => {
      current.episodes["1:1"] = { key: "1:1", videoId: "tt1:1:1", season: 1, episode: 1, firstSeenAt: new Date().toISOString(), dateUncertain: true };
    });

    const body = await (await api(h.base, "/api/follows/calendar?from=2024-03-01&to=2024-04-01", { as: "A" })).json() as { items: unknown[]; undated: Array<{ season: number; episode: number; dateUncertain?: boolean }> };
    assert.deepEqual(body.items, []);
    assert.deepEqual(body.undated.map((item) => [item.season, item.episode, item.dateUncertain]), [[1, 1, true]]);
  } finally { await h.close(); }
});

test("another account never sees A's calendar or activity", async () => {
  const h = await mount();
  try {
    const follow = await (await api(h.base, "/api/follows", { method: "POST", as: "A", body: { type: "series", id: "tt1", name: "Show" } })).json() as { id: string };
    assert.equal((await api(h.base, `/api/follows/${follow.id}/check`, { method: "POST", as: "A" })).status, 200);
    const rule = await api(h.base, `/api/follows/${follow.id}`, {
      method: "PATCH", as: "A",
      body: { autoDownload: { startMode: "from", startSeason: 1, startEpisode: 1, selection: { addonKeys: ["stream-addon"], audioLanguage: "en" } } },
    });
    assert.equal(rule.status, 200, "the followed episode is queued so it has a download state");

    const mine = await (await api(h.base, "/api/follows/calendar?from=2024-03-01&to=2024-04-01", { as: "A" })).json() as { items: Array<{ followId: string; season: number; episode: number; state: string }> };
    assert.deepEqual(mine.items.map((item) => [item.followId, item.season, item.episode, item.state]), [[follow.id, 1, 1, "queued"]]);
    const theirs = await (await api(h.base, "/api/follows/calendar?from=2024-03-01&to=2024-04-01", { as: "B" })).json() as { items: unknown[] };
    assert.deepEqual(theirs.items, []);

    const mineActivity = await (await api(h.base, "/api/follows/activity", { as: "A" })).json() as { items: Array<{ episode: number; state: string }> };
    assert.deepEqual(mineActivity.items.map((item) => [item.episode, item.state]), [[1, "queued"]]);
    const theirActivity = await (await api(h.base, "/api/follows/activity", { as: "B" })).json() as { items: unknown[] };
    assert.deepEqual(theirActivity.items, []);
  } finally { await h.close(); }
});

test("only a series or a film can be followed", async () => {
  const h = await mount();
  try {
    const film = await api(h.base, "/api/follows", { method: "POST", as: "A", body: { type: "movie", id: "tt9", name: "Film" } });
    assert.equal(film.status, 201);
    const other = await api(h.base, "/api/follows", { method: "POST", as: "A", body: { type: "channel", id: "c1", name: "Channel" } });
    assert.equal(other.status, 400);
    assert.equal(await keyOf(other), "err.followInvalid");
  } finally { await h.close(); }
});

test("a calendar feed token is created, rotated and revoked", async () => {
  const h = await mount();
  try {
    const initial = await (await api(h.base, "/api/follows/calendar-feed", { as: "A" })).json() as { token: string | null };
    assert.equal(initial.token, null);

    const created = await (await api(h.base, "/api/follows/calendar-feed", { method: "POST", as: "A" })).json() as { token: string };
    assert.equal(typeof created.token, "string");
    assert.ok(created.token.length >= 40, "32 random bytes carry well over 40 characters");
    const read = await (await api(h.base, "/api/follows/calendar-feed", { as: "A" })).json() as { token: string | null };
    assert.equal(read.token, created.token);

    const rotated = await (await api(h.base, "/api/follows/calendar-feed", { method: "POST", as: "A" })).json() as { token: string };
    assert.notEqual(rotated.token, created.token);

    assert.equal((await api(h.base, "/api/follows/calendar-feed", { method: "DELETE", as: "A" })).status, 204);
    const revoked = await (await api(h.base, "/api/follows/calendar-feed", { as: "A" })).json() as { token: string | null };
    assert.equal(revoked.token, null);
  } finally { await h.close(); }
});

test("the public feed is served without a session and heads the right account", async () => {
  const h = await mount();
  try {
    const { token } = await (await api(h.base, "/api/follows/calendar-feed", { method: "POST", as: "A" })).json() as { token: string };
    // A bare fetch: no cookie, no session header, nothing the account routes would accept.
    const response = await fetch(`${h.base}/calendar/${token}.ics`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/calendar; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "private, max-age=900");
    const body = await response.text();
    assert.ok(body.startsWith("BEGIN:VCALENDAR\r\n"));
    assert.ok(body.includes("X-WR-CALNAME:ada – Stremio Offline"));
    assert.ok(body.endsWith("END:VCALENDAR\r\n"));
  } finally { await h.close(); }
});

test("an unknown, revoked or disabled token answers the same bare 404", async () => {
  const h = await mount();
  try {
    assert.equal((await fetch(`${h.base}/calendar/nobody.ics`)).status, 404);

    const { token } = await (await api(h.base, "/api/follows/calendar-feed", { method: "POST", as: "A" })).json() as { token: string };
    assert.equal((await fetch(`${h.base}/calendar/${token}.ics`)).status, 200);
    await api(h.base, "/api/follows/calendar-feed", { method: "DELETE", as: "A" });
    assert.equal((await fetch(`${h.base}/calendar/${token}.ics`)).status, 404, "a revoked token names nobody");

    const { token: bobTokens } = await (await api(h.base, "/api/follows/calendar-feed", { method: "POST", as: "B" })).json() as { token: string };
    h.users.B!.disabled = true;
    assert.equal((await fetch(`${h.base}/calendar/${bobTokens}.ics`)).status, 404, "a disabled account's feed is closed");
  } finally { await h.close(); }
});

test("each token only ever returns its own account's follows", async () => {
  const h = await mount();
  try {
    const now = Date.now();
    const released = new Date(now + 24 * 60 * 60_000).toISOString();
    const firstSeenAt = new Date(now).toISOString();
    const alpha = await h.store.create({ ownerUserId: ADA, type: "series", metaId: "ttA", name: "Alpha" }, now);
    const beta = await h.store.create({ ownerUserId: BOB, type: "series", metaId: "ttB", name: "Beta" }, now);
    await h.store.recordCheck(alpha.id, { episodes: [{ key: "1:1", videoId: "ttA:1:1", season: 1, episode: 1, released, firstSeenAt }], now });
    await h.store.recordCheck(beta.id, { episodes: [{ key: "1:1", videoId: "ttB:1:1", season: 1, episode: 1, released, firstSeenAt }], now });

    const { token: aToken } = await (await api(h.base, "/api/follows/calendar-feed", { method: "POST", as: "A" })).json() as { token: string };
    const { token: bToken } = await (await api(h.base, "/api/follows/calendar-feed", { method: "POST", as: "B" })).json() as { token: string };
    const aFeed = await (await fetch(`${h.base}/calendar/${aToken}.ics`)).text();
    const bFeed = await (await fetch(`${h.base}/calendar/${bToken}.ics`)).text();
    assert.ok(aFeed.includes("Alpha"));
    assert.ok(!aFeed.includes("Beta"), "A's feed never carries B's follows");
    assert.ok(bFeed.includes("Beta"));
    assert.ok(!bFeed.includes("Alpha"), "B's feed never carries A's follows");
  } finally { await h.close(); }
});

test("an administrator may set, change and clear a retention delay", async () => {
  const h = await mount();
  try {
    const follow = await (await api(h.base, "/api/follows", { method: "POST", as: "A", body: { type: "series", id: "tt1", name: "Show" } })).json() as { id: string };
    await api(h.base, `/api/follows/${follow.id}`, { method: "PATCH", as: "A", body: { autoDownload: { startMode: "new", selection: { addonKeys: ["admin-addon"], audioLanguage: "en" } } } });

    const set = await api(h.base, `/api/follows/${follow.id}`, { method: "PATCH", as: "A", body: { retention: { afterWatchedDays: 7 } } });
    assert.equal(set.status, 200);
    assert.equal(((await set.json()) as { autoDownload?: { retention?: { afterWatchedDays: number } } }).autoDownload?.retention?.afterWatchedDays, 7);

    const cleared = await api(h.base, `/api/follows/${follow.id}`, { method: "PATCH", as: "A", body: { retention: null } });
    assert.equal(cleared.status, 200);
    assert.equal(((await cleared.json()) as { autoDownload?: { retention?: unknown } }).autoDownload?.retention, undefined);

    for (const bad of [0, 2, "soon"]) {
      const response = await api(h.base, `/api/follows/${follow.id}`, { method: "PATCH", as: "A", body: { retention: { afterWatchedDays: bad } } });
      assert.equal(response.status, 400, String(bad));
      assert.equal(await keyOf(response), "err.followInvalid");
    }
  } finally { await h.close(); }
});

test("a plain account cannot turn retention on, and a film has nothing to delete", async () => {
  const h = await mount();
  try {
    const mine = await (await api(h.base, "/api/follows", { method: "POST", as: "B", body: { type: "series", id: "tt1", name: "Show" } })).json() as { id: string };
    await api(h.base, `/api/follows/${mine.id}`, { method: "PATCH", as: "B", body: { autoDownload: { startMode: "new", selection: { addonKeys: ["stream-addon"], audioLanguage: "en" } } } });
    const denied = await api(h.base, `/api/follows/${mine.id}`, { method: "PATCH", as: "B", body: { retention: { afterWatchedDays: 7 } } });
    assert.equal(denied.status, 403);
    assert.equal(await keyOf(denied), "err.followRetentionAdmin");

    const film = await (await api(h.base, "/api/follows", { method: "POST", as: "A", body: { type: "movie", id: "tt9", name: "Film" } })).json() as { id: string };
    const rejected = await api(h.base, `/api/follows/${film.id}`, { method: "PATCH", as: "A", body: { retention: { afterWatchedDays: 1 } } });
    assert.equal(rejected.status, 400);
    assert.equal(await keyOf(rejected), "err.followInvalid");
  } finally { await h.close(); }
});
