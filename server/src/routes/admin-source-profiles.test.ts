import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { DeviceTransfers } from "../device-transfers.js";
import { DownloadQueue, type DownloadSelection } from "../downloads.js";
import { ForbiddenError, roleMiddleware } from "../roles.js";
import { RestrictedError, restrictedMiddleware } from "../restricted.js";
import {
  defaultTemplateParameters,
  SOURCE_PROFILE_IDS,
  type TravelParameters,
} from "../source-profiles.js";
import { Store, type StoredSourceProfile } from "../store.js";
import type { AddonRecord } from "../types.js";
import { emptyUserData, type UserRecord } from "../users.js";
import {
  registerAdminSourceProfilesRoutes,
  type AdminSourceProfilesHandlers,
} from "./admin-source-profiles.js";
import { registerDownloadRoutes, type DownloadsDeps } from "./downloads.js";
import {
  legacySelectionFromAdmission,
  materializeSourceProfileAdmission,
} from "./source-profile-selection.js";
import { registerSourceProfilesRoutes } from "./source-profiles.js";

const ADMIN = "usr_00000001";
const MEMBER = "usr_00000002";
const OTHER = "usr_00000003";
const ADDON = "stream-provider";
const VARIANT = "6202fb7a-ddf0-4e95-b9c7-202a9c62b35f";

const account = (
  id: string,
  role: UserRecord["role"],
  permissions = { downloadToLibrary: true, downloadToDevice: true },
): UserRecord => ({
  id,
  username: id,
  passwordHash: "",
  secret: "secret",
  role,
  createdAt: "2026-01-01T00:00:00.000Z",
  permissions,
  permissionsVersion: 0,
});

const addon = (
  key = ADDON,
  options: {
    allowedUsers?: string[];
    resources?: AddonRecord["manifest"]["resources"];
  } = {},
): AddonRecord => ({
  key,
  manifestUrl: `https://provider.example/${key}/manifest.json`,
  role: "source",
  enabled: true,
  globalSearch: true,
  ...(options.allowedUsers ? { allowedUsers: options.allowedUsers } : {}),
  addedAt: "2026-01-01T00:00:00.000Z",
  manifest: {
    id: `manifest-${key}`,
    name: key,
    version: "1.0.0",
    resources: options.resources ?? [{ name: "stream" }],
  },
  downloadSettings: {
    movie: { subfolder: "", layout: "structured" },
    series: { subfolder: "", layout: "structured" },
  },
});

const travelParameters = (): TravelParameters => ({
  ...defaultTemplateParameters("travel"),
  scope: { mode: "selected", addonKeys: [ADDON] },
});

const variant = (over: Partial<StoredSourceProfile> = {}): StoredSourceProfile => ({
  id: VARIANT,
  revision: 1,
  template: "travel",
  name: "Travel primary",
  parameters: travelParameters(),
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

interface PendingDownload {
  ownerUserId?: string;
  selection?: DownloadSelection;
  sourceAdmission?: unknown;
}

interface Harness {
  base: string;
  dataDir: string;
  store: Store;
  handlers: AdminSourceProfilesHandlers;
  pending: PendingDownload[];
  close(): Promise<void>;
}

const mount = async (options: {
  variants?: StoredSourceProfile[];
  addons?: AddonRecord[];
  gates?: boolean;
  downloads?: boolean;
  profileIds?: string[];
} = {}): Promise<Harness> => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "admin-source-profiles-"));
  const downloads = path.join(dataDir, "downloads");
  const store = new Store(dataDir, downloads);
  await store.load();
  await store.update((state) => {
    state.users = [
      account(ADMIN, "admin"),
      account(MEMBER, "user"),
      account(OTHER, "user"),
    ];
    state.userData = {
      [ADMIN]: emptyUserData(),
      [MEMBER]: emptyUserData(),
      [OTHER]: emptyUserData(),
    };
    state.addons = options.addons ?? [addon()];
    state.sourceProfiles = [...(state.sourceProfiles ?? []), ...(options.variants ?? [])];
  });

  const currentUser = (req: express.Request) =>
    store.users().find((user) => user.id === req.header("x-user"));
  const deps = {
    store,
    needsSetup: () => false,
    currentSession: () => undefined,
    currentUser,
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    stopUserSessions: async () => undefined,
    requireAccess: () => undefined,
    stopContentAccess: async () => undefined,
  };
  const pending: PendingDownload[] = [];
  const app = express();
  app.use(express.json());
  if (options.gates) {
    app.use("/api", roleMiddleware({
      isOpen: () => false,
      isInternal: () => false,
      roleOf: (req) => currentUser(req)?.role,
    }));
    app.use("/api", restrictedMiddleware({
      isOpen: () => false,
      isInternal: () => false,
    }));
  }

  const ids = [...(options.profileIds ?? [])];
  const handlers = registerAdminSourceProfilesRoutes(app, {
    ...deps,
    newProfileId: () => ids.shift() ?? crypto.randomUUID(),
  });
  registerSourceProfilesRoutes(app, deps);
  if (options.downloads) {
    const queue = {
      snapshot: () => ({ jobs: [], halt: null }),
      list: () => [],
      addPending: async (
        _title: string,
        source: { selection?: DownloadSelection },
        _media: unknown,
        ownerUserId?: string,
        _follow?: unknown,
        sourceAdmission?: unknown,
      ) => {
        pending.push({ ownerUserId, selection: source.selection, sourceAdmission });
        return { id: "job-1" };
      },
      pause: async () => undefined,
      resume: async () => undefined,
      retry: async () => undefined,
      move: async () => undefined,
      remove: async () => undefined,
      clearCompleted: async () => undefined,
      add: async () => ({ id: "job-1", target: "" }),
    };
    const downloadDeps: DownloadsDeps = {
      ...deps,
      queue: queue as unknown as DownloadsDeps["queue"],
      mediaSources: {} as DownloadsDeps["mediaSources"],
      deviceTransfers: new DeviceTransfers(),
      jobView: async (job) => job,
      sourceOf: () => ({ url: "https://provider.example/video.mp4" }),
      ownerOf: () => ({ userId: MEMBER, sid: "sid", expiresAt: Number.MAX_SAFE_INTEGER }),
      mediaSource: () => undefined,
      posterOf: () => undefined,
      rememberTitle: async () => undefined,
      titleKey: () => ".",
      saveCatalogPoster: () => undefined,
      libraryKey: (value) => value,
      defaultDownloadLibrary: () => undefined,
      cachedMeta: async () => null,
      prefsOf: (req) => store.prefs(req?.header("x-user")),
    };
    registerDownloadRoutes(app, downloadDeps);
  }
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number }).status
      : 400;
    res.status(status).json({
      error: error instanceof Error ? error.message : String(error),
      messageKey: (error as { messageKey?: string }).messageKey,
    });
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    dataDir,
    store,
    handlers,
    pending,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
};

const api = (
  base: string,
  pathname: string,
  options: { user?: string; method?: string; body?: unknown } = {},
) => fetch(`${base}${pathname}`, {
  method: options.method ?? "GET",
  headers: {
    ...(options.user ? { "x-user": options.user } : {}),
    ...(options.body === undefined ? {} : { "content-type": "application/json" }),
  },
  body: options.body === undefined ? undefined : JSON.stringify(options.body),
});

const messageKey = async (response: Response) =>
  ((await response.json()) as { messageKey?: string }).messageKey;

const directRequest = (
  method: string,
  pathname: string,
  extras: Partial<express.Request> = {},
): express.Request => ({
  method,
  path: pathname,
  params: {},
  query: {},
  body: {},
  header: (name: string) => name.toLowerCase() === "x-user" ? MEMBER : undefined,
  ...extras,
} as unknown as express.Request);

const directResponse = () => {
  const response = {
    setHeader: () => response,
    status: () => response,
    json: () => response,
    end: () => response,
  };
  return response as unknown as express.Response;
};

test("ordinary users are refused by the role gate and by every handler", async (t) => {
  const harness = await mount({ variants: [variant()], gates: true });
  t.after(harness.close);

  const requests = [
    api(harness.base, "/api/admin/source-profiles", { user: MEMBER }),
    api(harness.base, "/api/admin/source-profiles", {
      user: MEMBER,
      method: "POST",
      body: { template: "travel", name: "Other", parameters: travelParameters() },
    }),
    api(harness.base, `/api/admin/source-profiles/${VARIANT}/duplicate`, {
      user: MEMBER,
      method: "POST",
      body: { name: "Other" },
    }),
    api(harness.base, `/api/admin/source-profiles/${VARIANT}`, {
      user: MEMBER,
      method: "PATCH",
      body: { revision: 1, name: "Other" },
    }),
    api(harness.base, `/api/admin/source-profiles/${VARIANT}?revision=1`, {
      user: MEMBER,
      method: "DELETE",
    }),
  ];
  for (const response of await Promise.all(requests)) {
    assert.equal(response.status, 403);
    assert.equal(await messageKey(response), "err.notAllowed");
  }

  const direct = [
    harness.handlers.list,
    harness.handlers.create,
    harness.handlers.duplicate,
    harness.handlers.update,
    harness.handlers.delete,
  ];
  for (const handler of direct) {
    let received: unknown;
    await handler(
      directRequest("POST", "/admin/source-profiles", { params: { id: VARIANT }, query: { revision: "1" } }),
      directResponse(),
      (error) => { received = error; },
    );
    assert.ok(received instanceof ForbiddenError);
  }
});

test("restricted mode refuses every source profile mutation", async (t) => {
  const harness = await mount({ variants: [variant()], gates: true });
  t.after(harness.close);
  process.env.RESTRICTED_MODE = "1";
  t.after(() => { delete process.env.RESTRICTED_MODE; });

  const requests = [
    api(harness.base, "/api/admin/source-profiles", {
      user: ADMIN,
      method: "POST",
      body: { template: "travel", name: "Other", parameters: travelParameters() },
    }),
    api(harness.base, `/api/admin/source-profiles/${VARIANT}/duplicate`, {
      user: ADMIN,
      method: "POST",
      body: { name: "Other" },
    }),
    api(harness.base, `/api/admin/source-profiles/${VARIANT}`, {
      user: ADMIN,
      method: "PATCH",
      body: { revision: 1, parameters: travelParameters() },
    }),
    api(harness.base, `/api/admin/source-profiles/${VARIANT}?revision=1`, {
      user: ADMIN,
      method: "DELETE",
    }),
  ];
  for (const response of await Promise.all(requests)) {
    assert.equal(response.status, 403);
    assert.equal(await messageKey(response), "err.restricted");
  }
});

test("an administrator creates a Travel variant that members can see and bulk-admit", async (t) => {
  const harness = await mount({
    addons: [addon(ADDON, { allowedUsers: [MEMBER] })],
    downloads: true,
  });
  t.after(harness.close);
  const parameters = travelParameters();
  parameters.heightPixels = { min: 720, max: 2160 };

  const created = await api(harness.base, "/api/admin/source-profiles", {
    user: ADMIN,
    method: "POST",
    body: { template: "travel", name: "  Travel 720  ", parameters },
  });
  assert.equal(created.status, 201);
  const profile = await created.json() as StoredSourceProfile;
  assert.equal(profile.name, "Travel 720");
  assert.equal(profile.revision, 1);
  assert.match(profile.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(profile.parameters, parameters);

  const editor = await api(harness.base, "/api/admin/source-profiles", { user: ADMIN });
  assert.equal(editor.status, 200);
  assert.equal(editor.headers.get("cache-control"), "private, no-store");
  const editorBody = await editor.json() as { profiles: StoredSourceProfile[] };
  const editorProfile = editorBody.profiles.find((candidate) => candidate.id === profile.id);
  assert.deepEqual(editorProfile?.parameters, parameters);

  const publicList = await api(harness.base, "/api/source-profiles", { user: MEMBER });
  assert.equal(publicList.status, 200);
  const visible = (await publicList.json() as {
    profiles: Array<{ id: string; name?: string; parameters?: unknown }>;
  }).profiles.find((candidate) => candidate.id === profile.id);
  assert.equal(visible?.name, "Travel 720");
  assert.equal("parameters" in (visible ?? {}), false);

  const bulk = await api(harness.base, "/api/downloads/bulk", {
    user: MEMBER,
    method: "POST",
    body: {
      title: "Show",
      episodes: [{ id: "ep-1", season: 1, episode: 1 }],
      selection: { profile: { profileId: profile.id, revision: 1 } },
    },
  });
  assert.equal(bulk.status, 201);
  assert.equal(harness.pending.length, 1);
  assert.deepEqual(
    (harness.pending[0]?.sourceAdmission as { profile: unknown }).profile,
    { id: profile.id, revision: 1, template: "travel" },
  );
});

test("invalid create attempts leave the profile catalogue unchanged", async (t) => {
  const harness = await mount({ variants: [variant()] });
  t.after(harness.close);
  const before = JSON.stringify(harness.store.sourceProfiles());
  const badParameters: TravelParameters = {
    ...travelParameters(),
    heightPixels: { min: 100 },
  };

  const cases = [
    {
      body: { template: "travel", name: "Invalid", parameters: badParameters },
      status: 400,
      key: "err.sourceProfileInvalid",
    },
    {
      body: {
        template: "travel",
        name: "Unknown addon",
        parameters: {
          ...travelParameters(),
          scope: { mode: "selected", addonKeys: ["missing"] },
        },
      },
      status: 400,
      key: "err.sourceProfileInvalid",
    },
    {
      body: { template: "travel", name: " travel PRIMARY ", parameters: travelParameters() },
      status: 409,
      key: "err.sourceProfileNameTaken",
    },
    {
      body: { template: "recommended", name: "Recommended copy" },
      status: 400,
      key: "err.sourceProfileInvalid",
    },
  ];
  for (const item of cases) {
    const response = await api(harness.base, "/api/admin/source-profiles", {
      user: ADMIN,
      method: "POST",
      body: item.body,
    });
    assert.equal(response.status, item.status, JSON.stringify(item.body));
    assert.equal(await messageKey(response), item.key);
    assert.equal(JSON.stringify(harness.store.sourceProfiles()), before);
  }
});

test("PATCH enforces the revision guard and makes older bulk references stale", async (t) => {
  const harness = await mount({
    variants: [variant()],
    addons: [addon(ADDON, { allowedUsers: [MEMBER] })],
    downloads: true,
  });
  t.after(harness.close);

  const stale = await api(harness.base, `/api/admin/source-profiles/${VARIANT}`, {
    user: ADMIN,
    method: "PATCH",
    body: { revision: 2, parameters: travelParameters() },
  });
  assert.equal(stale.status, 409);
  assert.equal(await messageKey(stale), "err.sourceProfileRevisionStale");
  assert.equal(harness.store.sourceProfiles().find((profile) => profile.id === VARIANT)?.revision, 1);

  const parameters = travelParameters();
  parameters.heightPixels = { min: 720 };
  const patched = await api(harness.base, `/api/admin/source-profiles/${VARIANT}`, {
    user: ADMIN,
    method: "PATCH",
    body: { revision: 1, name: "Travel updated", parameters },
  });
  assert.equal(patched.status, 200);
  const updated = await patched.json() as StoredSourceProfile;
  assert.equal(updated.revision, 2);
  assert.equal(updated.name, "Travel updated");
  assert.deepEqual(updated.parameters, parameters);
  assert.notEqual(updated.updatedAt, "2026-01-01T00:00:00.000Z");

  const bulk = await api(harness.base, "/api/downloads/bulk", {
    user: MEMBER,
    method: "POST",
    body: {
      title: "Show",
      episodes: [{ id: "ep-1", season: 1, episode: 1 }],
      selection: { profile: { profileId: VARIANT, revision: 1 } },
    },
  });
  assert.equal(bulk.status, 409);
  assert.equal(await messageKey(bulk), "err.sourceProfileRevisionStale");
  assert.deepEqual(harness.pending, []);
});

test("built-in profiles allow parameter edits but protect their names, identity and deletion", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const parameters = {
    ...defaultTemplateParameters("travel"),
    heightPixels: { min: 1080 },
  };

  const edited = await api(harness.base, `/api/admin/source-profiles/${SOURCE_PROFILE_IDS.travel}`, {
    user: ADMIN,
    method: "PATCH",
    body: { revision: 1, parameters },
  });
  assert.equal(edited.status, 200);
  const travel = await edited.json() as StoredSourceProfile;
  assert.equal(travel.revision, 2);
  assert.deepEqual(travel.parameters, parameters);
  assert.equal(travel.nameKey, "sourceProfile.travel");

  const rename = await api(harness.base, `/api/admin/source-profiles/${SOURCE_PROFILE_IDS.travel}`, {
    user: ADMIN,
    method: "PATCH",
    body: { revision: 2, name: "Renamed" },
  });
  assert.equal(rename.status, 400);
  assert.equal(await messageKey(rename), "err.sourceProfileBuiltIn");

  const remove = await api(
    harness.base,
    `/api/admin/source-profiles/${SOURCE_PROFILE_IDS.travel}?revision=2`,
    { user: ADMIN, method: "DELETE" },
  );
  assert.equal(remove.status, 400);
  assert.equal(await messageKey(remove), "err.sourceProfileBuiltIn");

  const recommended = await api(
    harness.base,
    `/api/admin/source-profiles/${SOURCE_PROFILE_IDS.recommended}`,
    { user: ADMIN, method: "PATCH", body: { revision: 1 } },
  );
  assert.equal(recommended.status, 400);
  assert.equal(await messageKey(recommended), "err.sourceProfileBuiltIn");
});

test("deleting a variant clears preferences while follows and queued snapshots keep their references", async (t) => {
  const harness = await mount({
    variants: [variant()],
    addons: [addon(ADDON, { allowedUsers: [MEMBER, OTHER] })],
  });
  t.after(harness.close);
  await harness.store.update((state) => {
    state.userData![MEMBER]!.prefs.downloadSourceProfile = VARIANT;
    state.userData![OTHER]!.prefs.downloadSourceProfile = VARIANT;
  });

  const followStore = new (await import("../follows.js")).FollowStore(harness.dataDir);
  await followStore.load();
  const follow = await followStore.create({
    ownerUserId: MEMBER,
    type: "series",
    metaId: "tt1234567",
    name: "Followed show",
  }, Date.now());
  await followStore.update(follow.id, (current) => {
    current.autoDownload = {
      enabledAt: "2026-01-01T00:00:00.000Z",
      startMode: "new",
      selection: {
        addonKeys: [ADDON],
        sourceStrategy: "priority",
        audioLanguage: "en",
        audioMode: "preferred",
        subtitleMode: "optional",
        subtitleLanguage: "en",
        targetSettings: { subfolder: "", layout: "structured" },
      },
      sourceProfile: { profileId: VARIANT, revision: 1 },
    };
  });

  const admission = materializeSourceProfileAdmission(
    { store: harness.store },
    harness.store.users().find((user) => user.id === MEMBER),
    { profileId: VARIANT, revision: 1 },
  );
  const queue = new DownloadQueue(() => 1, () => 1, harness.dataDir, path.join(harness.dataDir, "downloads"));
  queue.setResolver(async () => undefined);
  await queue.load();
  const job = await queue.addPending(
    "Followed show · S01E01",
    {
      type: "series",
      videoId: "ep-1",
      selection: {
        ...legacySelectionFromAdmission(admission),
        targetSettings: { subfolder: "", layout: "structured" },
      },
    },
    undefined,
    MEMBER,
    undefined,
    admission,
  );
  assert.ok(job);

  const removed = await api(harness.base, `/api/admin/source-profiles/${VARIANT}?revision=1`, {
    user: ADMIN,
    method: "DELETE",
  });
  assert.equal(removed.status, 204);
  assert.equal(
    Object.hasOwn(harness.store.userData(MEMBER).prefs, "downloadSourceProfile"),
    false,
  );
  assert.equal(
    Object.hasOwn(harness.store.userData(OTHER).prefs, "downloadSourceProfile"),
    false,
  );
  assert.deepEqual(followStore.get(follow.id)?.autoDownload?.sourceProfile, {
    profileId: VARIANT,
    revision: 1,
  });
  const queued = (queue as unknown as {
    jobs: Array<{ sourceAdmission?: unknown }>;
  }).jobs.find((entry) => entry.sourceAdmission !== undefined);
  assert.deepEqual(queued?.sourceAdmission, admission);
  await queue.stop();

  const persisted = JSON.parse(readFileSync(path.join(harness.dataDir, "state.json"), "utf8")) as {
    deletedSourceProfileIds?: string[];
  };
  assert.ok(persisted.deletedSourceProfileIds?.includes(VARIANT));

  const reloadedFollows = new (await import("../follows.js")).FollowStore(harness.dataDir);
  await reloadedFollows.load();
  assert.deepEqual(reloadedFollows.get(follow.id)?.autoDownload?.sourceProfile, {
    profileId: VARIANT,
    revision: 1,
  });
  const reloaded = new Store(harness.dataDir, path.join(harness.dataDir, "downloads"));
  await reloaded.load();
  assert.equal(reloaded.sourceProfiles().some((profile) => profile.id === VARIANT), false);
});

test("duplicating a built-in creates an equivalent variant with a fresh id", async (t) => {
  const duplicateId = "962eac3f-b7eb-49c8-b9df-27d76f9d2ce1";
  const harness = await mount({ profileIds: [duplicateId] });
  t.after(harness.close);

  const response = await api(
    harness.base,
    `/api/admin/source-profiles/${SOURCE_PROFILE_IDS.providerPriority}/duplicate`,
    {
      user: ADMIN,
      method: "POST",
      body: { name: "Provider backup" },
    },
  );
  assert.equal(response.status, 201);
  const duplicate = await response.json() as StoredSourceProfile;
  assert.equal(duplicate.id, duplicateId);
  assert.notEqual(duplicate.id, SOURCE_PROFILE_IDS.providerPriority);
  assert.equal(duplicate.template, "providerPriority");
  assert.equal(duplicate.name, "Provider backup");
  assert.equal(duplicate.nameKey, undefined);
  assert.equal(duplicate.revision, 1);
  assert.deepEqual(duplicate.parameters, defaultTemplateParameters("providerPriority"));

  const unknown = await api(harness.base, "/api/admin/source-profiles/missing", {
    user: ADMIN,
    method: "PATCH",
    body: { revision: 1 },
  });
  assert.equal(unknown.status, 404);
  assert.equal(await messageKey(unknown), "err.sourceProfileUnavailable");
});
