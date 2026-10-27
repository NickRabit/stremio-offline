import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { messageKeyOf } from "../errors.js";
import type { LibraryRecord } from "../libraries.js";
import type { MediaConnectionRecord, RemoteLibraryRecord } from "../media-server-types.js";
import { defaultDownloadSettings } from "../naming.js";
import type { Store } from "../store.js";
import type { AddonRecord } from "../types.js";
import type { UserRecord } from "../users.js";
import { registerSourceProfilesRoutes, type SourceProfilesDeps } from "./source-profiles.js";

const ADMIN = "usr_00000001";
const MEMBER = "usr_00000002";
const OTHER = "usr_00000003";

interface Harness {
  base: string;
  state: {
    users: UserRecord[];
    addons: AddonRecord[];
    libraries: LibraryRecord[];
    mediaConnections: MediaConnectionRecord[];
    remoteLibraries: RemoteLibraryRecord[];
  };
  close(): Promise<void>;
}

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
  key: string,
  options: {
    name?: string;
    role?: AddonRecord["role"];
    enabled?: boolean;
    allowedUsers?: string[];
    resources?: AddonRecord["manifest"]["resources"];
  } = {},
): AddonRecord => ({
  key,
  manifestUrl: `https://private-provider.example/${key}/manifest.json`,
  role: options.role ?? "source",
  enabled: options.enabled ?? true,
  globalSearch: true,
  ...(options.allowedUsers ? { allowedUsers: options.allowedUsers } : {}),
  addedAt: "2026-01-01T00:00:00.000Z",
  manifest: {
    id: `manifest-${key}`,
    name: options.name ?? `Private provider ${key}`,
    version: "1.0.0",
    resources: options.resources ?? [{ name: "stream" }],
  },
  downloadSettings: defaultDownloadSettings(),
});

const localLibrary: LibraryRecord = {
  id: "lib_00000001",
  name: "Local files",
  type: "movie",
  root: "/media/local",
  enabled: true,
  order: 0,
  addedAt: "2026-01-01T00:00:00.000Z",
  writeArtwork: false,
  visibleTo: [MEMBER],
};

const connection: MediaConnectionRecord = {
  id: `mconn_${"1".repeat(32)}`,
  provider: "jellyfin",
  name: "Private connection",
  baseUrl: "http://media.example",
  allowLan: false,
  allowLoopback: false,
  serverId: "server",
  accountId: "account",
  enabled: true,
  generation: 1,
  secretRef: `msecret_${"2".repeat(32)}`,
  addedAt: "2026-01-01T00:00:00.000Z",
};

const remoteLibrary: RemoteLibraryRecord = {
  id: `rlib_${"3".repeat(32)}`,
  connectionId: connection.id,
  remoteId: "remote",
  name: "Private remote library",
  type: "movie",
  enabled: true,
  order: 0,
  allowedUsers: [MEMBER],
  showOnHome: true,
  showInContinueWatching: true,
};

const mount = async (options: {
  addons?: AddonRecord[];
  libraries?: LibraryRecord[];
  remoteLibraries?: RemoteLibraryRecord[];
} = {}): Promise<Harness> => {
  const state: Harness["state"] = {
    users: [
      account(ADMIN, "admin"),
      account(MEMBER, "user"),
      { ...account(OTHER, "user"), disabled: true },
    ],
    addons: options.addons ?? [],
    libraries: options.libraries ?? [],
    mediaConnections: [connection],
    remoteLibraries: options.remoteLibraries ?? [],
  };
  const currentUser = (req: express.Request) => {
    const name = req.header("x-user");
    return state.users.find((user) => user.id === name);
  };
  const deps: SourceProfilesDeps = {
    store: {
      addons: () => state.addons,
      libraries: () => state.libraries,
      remoteLibraries: () => state.remoteLibraries,
      mediaConnections: () => state.mediaConnections,
    } as unknown as Store,
    needsSetup: () => false,
    currentSession: () => undefined,
    currentUser,
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    stopUserSessions: async () => undefined,
    requireAccess: () => undefined,
    stopContentAccess: async () => undefined,
  };
  const app = express();
  app.use(express.json());
  registerSourceProfilesRoutes(app, deps);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error), code: (error as { code?: string }).code, messageKey: messageKeyOf(error) });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    state,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

const api = (base: string, user?: string, method = "GET") =>
  fetch(`${base}/api/source-profiles`, {
    method,
    headers: user ? { "x-user": user } : {},
  });

const rawBody = async (response: Response) => {
  const text = await response.text();
  return { text, body: JSON.parse(text) as Record<string, unknown> };
};

test("GET /api/source-profiles returns the fixed catalogue for an administrator", async (t) => {
  const harness = await mount({
    addons: [addon("private-provider-key", { name: "Private provider name", allowedUsers: [] })],
    libraries: [localLibrary],
    remoteLibraries: [remoteLibrary],
  });
  t.after(harness.close);

  const response = await api(harness.base, ADMIN);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const { text, body } = await rawBody(response);
  assert.deepEqual(Object.keys(body), ["profiles"]);
  const profiles = body.profiles as Array<Record<string, unknown>>;
  assert.deepEqual(profiles.map((profile) => profile.id), [
    "39de76cc-0ca0-4a5e-95ad-08927fb45410",
    "390a8b1a-85f6-4ded-9d7e-701a299720bb",
    "7e15d713-965c-4636-9ed3-3a112c521fe1",
  ]);
  assert.deepEqual(profiles.map((profile) => Object.keys(profile).sort()), [
    ["id", "nameKey", "operations", "policy", "revision"],
    ["id", "nameKey", "operations", "policy", "revision"],
    ["id", "nameKey", "operations", "policy", "revision"],
  ]);
  assert.deepEqual(profiles.map((profile) => profile.operations), [
    ["play", "downloadToDevice"],
    ["play", "downloadToLibrary", "downloadToDevice"],
    ["play", "downloadToLibrary", "downloadToDevice"],
  ]);
  assert.deepEqual(Object.keys(profiles[0]?.policy as Record<string, unknown>).sort(), [
    "constraints",
    "criteria",
    "existingLocalCopy",
    "nextEpisode",
    "schemaVersion",
    "scope",
  ]);
  assert.doesNotMatch(text, /private-provider-key|Private provider name|private-provider\.example/);
  assert.doesNotMatch(text, /Private connection|Private remote library/);
});

test("GET /api/source-profiles follows current addon grants without caching", async (t) => {
  const provider = addon("granted-provider", { allowedUsers: [MEMBER] });
  const harness = await mount({ addons: [provider] });
  t.after(harness.close);

  const first = await api(harness.base, MEMBER);
  assert.equal(first.status, 200);
  assert.deepEqual((await rawBody(first)).body, {
    profiles: SOURCE_PROFILES_EXPECTED,
  });

  provider.allowedUsers = [];
  const second = await api(harness.base, MEMBER);
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { profiles: [] });
});

test("GET /api/source-profiles filters current operation grants", async (t) => {
  const member = account(MEMBER, "user", {
    downloadToLibrary: false,
    downloadToDevice: false,
  });
  const harness = await mount({ addons: [addon("granted-provider", { allowedUsers: [MEMBER] })] });
  harness.state.users = [account(ADMIN, "admin"), member, { ...account(OTHER, "user"), disabled: true }];
  t.after(harness.close);

  const playOnly = await api(harness.base, MEMBER);
  assert.deepEqual(((await playOnly.json()) as { profiles: Array<{ operations: string[] }> }).profiles.map((profile) => profile.operations), [
    ["play"],
    ["play"],
    ["play"],
  ]);

  member.permissions.downloadToLibrary = true;
  const withLibrary = await api(harness.base, MEMBER);
  assert.deepEqual(((await withLibrary.json()) as { profiles: Array<{ operations: string[] }> }).profiles.map((profile) => profile.operations), [
    ["play"],
    ["play", "downloadToLibrary"],
    ["play", "downloadToLibrary"],
  ]);

  member.permissions.downloadToDevice = true;
  const withDevice = await api(harness.base, MEMBER);
  assert.deepEqual(((await withDevice.json()) as { profiles: Array<{ operations: string[] }> }).profiles.map((profile) => profile.operations), [
    ["play", "downloadToDevice"],
    ["play", "downloadToLibrary", "downloadToDevice"],
    ["play", "downloadToLibrary", "downloadToDevice"],
  ]);
});

test("GET /api/source-profiles reports only paths the current member can use", async (t) => {
  const harness = await mount({
    addons: [
      addon("disabled-provider", { enabled: false, allowedUsers: [MEMBER] }),
      addon("catalog-only", { role: "catalog", allowedUsers: [MEMBER] }),
    ],
  });
  t.after(harness.close);

  assert.deepEqual(await (await api(harness.base, MEMBER)).json(), { profiles: [] });

  harness.state.libraries = [localLibrary];
  const local = (await (await api(harness.base, MEMBER)).json()) as { profiles: Array<{ operations: string[] }> };
  assert.deepEqual(local.profiles.map((profile) => profile.operations), [
    ["play", "downloadToDevice"],
    ["play", "downloadToDevice"],
    ["play", "downloadToDevice"],
  ]);

  harness.state.libraries = [];
  harness.state.remoteLibraries = [remoteLibrary];
  const remote = (await (await api(harness.base, MEMBER)).json()) as { profiles: Array<{ operations: string[] }> };
  assert.deepEqual(remote.profiles.map((profile) => profile.operations), [
    ["play", "downloadToDevice"],
    ["play", "downloadToDevice"],
    ["play", "downloadToDevice"],
  ]);

  harness.state.remoteLibraries = [];
  const none = await api(harness.base, MEMBER);
  assert.equal(none.status, 200);
  assert.deepEqual(await none.json(), { profiles: [] });
});

test("GET /api/source-profiles never reveals same-name provider identity", async (t) => {
  const harness = await mount({
    addons: [
      addon("private-key-one", { name: "Same display name", allowedUsers: [MEMBER] }),
      addon("private-key-two", { name: "Same display name", allowedUsers: [OTHER] }),
    ],
  });
  t.after(harness.close);

  const response = await api(harness.base, MEMBER);
  const { text, body } = await rawBody(response);
  assert.equal(response.status, 200);
  assert.equal((body.profiles as unknown[]).length, 3);
  assert.doesNotMatch(text, /private-key-one|private-key-two|Same display name/);
  assert.doesNotMatch(text, /manifest-/);
});

test("GET /api/source-profiles refuses absent and disabled accounts", async (t) => {
  const harness = await mount({ addons: [addon("stream")] });
  t.after(harness.close);

  for (const user of [undefined, OTHER]) {
    const response = await api(harness.base, user);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(((await response.json()) as { code?: string }).code, "AUTH_REQUIRED");
  }
});

test("the catalogue route registers no mutation methods", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  for (const method of ["POST", "PATCH", "DELETE"]) {
    assert.equal((await api(harness.base, ADMIN, method)).status, 404, method);
  }
});

const SOURCE_PROFILES_EXPECTED = [
  {
    id: "39de76cc-0ca0-4a5e-95ad-08927fb45410",
    nameKey: "sourceProfile.recommended",
    revision: 1,
    operations: ["play", "downloadToDevice"],
    policy: {
      schemaVersion: 1,
      scope: { mode: "allAvailable" },
      constraints: {
        sourceKinds: ["localFile", "mediaServerOriginal", "http", "torrent"],
        audio: { mode: "preferred", preferred: { preference: "audio" } },
        subtitles: { mode: "optional", preferred: { preference: "subtitle" } },
      },
      criteria: [
        { kind: "providerClass", order: ["local", "remote", "addon"] },
        { kind: "audioTier" },
        { kind: "providerOrder", from: "viewer" },
        { kind: "size", direction: "desc" },
      ],
      nextEpisode: "profile",
      existingLocalCopy: "meetsRequirements",
    },
  },
  {
    id: "390a8b1a-85f6-4ded-9d7e-701a299720bb",
    nameKey: "sourceProfile.providerPriority",
    revision: 1,
    operations: ["play", "downloadToLibrary", "downloadToDevice"],
    policy: {
      schemaVersion: 1,
      scope: { mode: "allAvailable" },
      constraints: {
        sourceKinds: ["localFile", "mediaServerOriginal", "http", "torrent"],
        audio: { mode: "preferred", preferred: { preference: "audio" } },
        subtitles: { mode: "optional", preferred: { preference: "subtitle" } },
      },
      criteria: [
        { kind: "providerClass", order: ["local", "remote", "addon"] },
        { kind: "providerOrder", from: "viewer" },
        { kind: "audioTier" },
        { kind: "size", direction: "desc" },
      ],
      nextEpisode: "profile",
      existingLocalCopy: "meetsRequirements",
    },
  },
  {
    id: "7e15d713-965c-4636-9ed3-3a112c521fe1",
    nameKey: "sourceProfile.travel",
    revision: 1,
    operations: ["play", "downloadToLibrary", "downloadToDevice"],
    policy: {
      schemaVersion: 1,
      scope: { mode: "allAvailable" },
      constraints: {
        sourceKinds: ["localFile", "http", "mediaServerOriginal"],
        audio: { mode: "preferred", preferred: { preference: "audio" } },
        subtitles: { mode: "optional", preferred: { preference: "subtitle" } },
        heightPixels: { min: 480 },
      },
      criteria: [
        { kind: "audioTier" },
        { kind: "size", direction: "asc" },
        { kind: "providerOrder", from: "viewer" },
      ],
      nextEpisode: "profile",
      existingLocalCopy: "meetsRequirements",
    },
  },
] as const;
