import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { AVATAR_PRESETS } from "../avatar-presets.js";
import { AVATAR_MAX_BYTES, AvatarStore, sniffImage } from "../avatars.js";
import { defaultInstanceSettings, Store } from "../store.js";
import { emptyUserData, findUserById, newUserPermissions, publicUser, type UserRecord } from "../users.js";
import { registerAvatarRoutes } from "./avatars.js";
import type { RouteContext } from "./context.js";

const ADA = "usr_0000000a";
const BOB = "usr_0000000b";
const KID = "usr_0000000c";
const GUEST = "usr_0000000d";

const account = (id: string, over: Partial<UserRecord> = {}): UserRecord => ({
  id, username: id, passwordHash: "x", secret: `secret-${id}`, role: "user",
  createdAt: "2026-01-01T00:00:00.000Z", permissions: newUserPermissions(), permissionsVersion: 0, ...over,
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(32, 3)]);

const mount = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "routes-avatars-"));
  const users = [
    account(ADA, { role: "admin", switcher: true, unlock: "password" }),
    account(BOB, { switcher: true, unlock: "pin", pinHash: "p" }),
    account(KID, { switcher: true, unlock: "none", child: true }),
    account(GUEST),
  ];
  await writeFile(path.join(dir, "state.json"), JSON.stringify({
    schemaVersion: 3, addons: [], settings: defaultInstanceSettings(), defaultsInstalled: true, users,
    userData: Object.fromEntries(users.map((user) => [user.id, emptyUserData()])),
    libraries: [], mediaConnections: [], remoteLibraries: [],
  }));
  const store = new Store(dir, dir);
  await store.load();
  const avatars = new AvatarStore(dir);
  const app = express();
  app.use(express.json());
  const currentUser = (req: express.Request) => {
    const id = req.header("x-user");
    return id ? findUserById(store.users(), id) : undefined;
  };
  registerAvatarRoutes(app, { store, currentUser, avatars } as unknown as RouteContext & { avatars: AvatarStore });
  app.use((error: { status?: number; messageKey?: string; message?: string; type?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({ messageKey: error.messageKey, error: error.message, type: error.type });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (pathname: string, init: { method?: string; user?: string; json?: unknown; image?: Buffer; type?: string } = {}) =>
    fetch(base + pathname, {
      method: init.method ?? "GET",
      headers: {
        ...(init.user ? { "x-user": init.user } : {}),
        ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
        ...(init.image ? { "content-type": init.type ?? "image/png" } : {}),
      },
      body: init.json !== undefined ? JSON.stringify(init.json) : init.image ? new Uint8Array(init.image) : undefined,
    });
  return {
    store, avatars, dir, call,
    close: async () => { server.close(); await once(server, "close"); await rm(dir, { recursive: true, force: true }); },
  };
};

test("the picture type is read from the bytes", () => {
  assert.equal(sniffImage(PNG), "image/png");
  assert.equal(sniffImage(JPEG), "image/jpeg");
  assert.equal(sniffImage(WEBP), "image/webp");
  assert.equal(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), undefined);
  assert.equal(sniffImage(Buffer.from("GIF89a")), undefined);
  assert.equal(sniffImage(Buffer.alloc(0)), undefined);
});

test("the preset list is the built-in set, with a file for every id", async (t) => {
  const h = await mount();
  t.after(h.close);
  const body = await (await h.call("/api/avatar/presets", { user: BOB })).json() as { presets: string[] };
  assert.deepEqual(body.presets, AVATAR_PRESETS);
  assert.equal(new Set(body.presets).size, body.presets.length);
  const files = new Set(await readdir(path.resolve(import.meta.dirname, "../../../web/public/avatars")));
  for (const id of body.presets) assert.ok(files.has(`${id}.svg`), `${id}.svg is missing`);
});

test("an account picks a preset, goes back to its initial, and an unknown id is refused", async (t) => {
  const h = await mount();
  t.after(h.close);
  const picked = await h.call("/api/auth/avatar", { method: "PATCH", user: BOB, json: { preset: "fox" } });
  assert.equal(picked.status, 200);
  assert.deepEqual(await picked.json(), { avatar: { kind: "preset", id: "fox" } });
  assert.deepEqual(publicUser(findUserById(h.store.users(), BOB)!).avatar, { kind: "preset", id: "fox" });

  const unknown = await h.call("/api/auth/avatar", { method: "PATCH", user: BOB, json: { preset: "../../etc/passwd" } });
  assert.equal(unknown.status, 400);
  assert.deepEqual(findUserById(h.store.users(), BOB)!.avatar, { preset: "fox" });

  const cleared = await h.call("/api/auth/avatar", { method: "PATCH", user: BOB, json: { preset: null } });
  assert.deepEqual(await cleared.json(), { avatar: null });
  assert.equal(findUserById(h.store.users(), BOB)!.avatar, undefined);
  assert.equal("avatar" in publicUser(findUserById(h.store.users(), BOB)!), false);

  assert.equal((await h.call("/api/auth/avatar", { method: "PATCH", json: { preset: "fox" } })).status, 401);
});

test("an uploaded picture is stored, served to the profiles that may switch to it and to nobody else", async (t) => {
  const h = await mount();
  t.after(h.close);
  const sent = await h.call("/api/auth/avatar/image", { method: "PUT", user: BOB, image: JPEG, type: "image/png" });
  assert.equal(sent.status, 200);
  const { avatar } = await sent.json() as { avatar: { kind: string; url: string } };
  assert.equal(avatar.kind, "custom");
  assert.match(avatar.url, new RegExp(`^/api/avatar/${BOB}\\?v=[0-9a-f-]{36}$`));

  const own = await h.call(avatar.url, { user: BOB });
  assert.equal(own.status, 200);
  assert.equal(own.headers.get("content-type"), "image/jpeg", "the bytes decide, not the declared type");
  assert.equal(own.headers.get("x-content-type-options"), "nosniff");
  assert.equal(own.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(await own.arrayBuffer()), JPEG);

  assert.equal((await h.call(avatar.url, { user: ADA })).status, 200, "an administrator");
  assert.equal((await h.call(avatar.url, { user: KID })).status, 200, "a child that may switch to a PIN profile");
  assert.equal((await h.call(avatar.url, { user: GUEST })).status, 404, "an account outside the switcher");
  assert.equal((await h.call(avatar.url)).status, 401);
  assert.equal((await h.call(`/api/avatar/${ADA}`, { user: BOB })).status, 404, "an account with no uploaded picture");
  assert.equal((await h.call("/api/avatar/usr_zzzzzzzz", { user: ADA })).status, 404);
});

test("a child's uploaded picture is hidden from another child", async (t) => {
  const h = await mount();
  t.after(h.close);
  await h.store.update((state) => { state.users = [...(state.users ?? []), account("usr_0000000e", { switcher: true, unlock: "none", child: true })]; });
  assert.equal((await h.call(`/api/users/${KID}/avatar/image`, { method: "PUT", user: ADA, image: PNG })).status, 200);
  const url = publicUser(findUserById(h.store.users(), KID)!).avatar as { kind: "custom"; url: string };
  assert.equal((await h.call(url.url, { user: KID })).status, 200);
  assert.equal((await h.call(url.url, { user: "usr_0000000e" })).status, 404, "a child never sees another child's profile");
});

test("a picture that is not PNG, JPEG or WebP, an empty one and one too large are refused", async (t) => {
  const h = await mount();
  t.after(h.close);
  const svg = await h.call("/api/auth/avatar/image", { method: "PUT", user: BOB, image: Buffer.from("<svg onload=alert(1)>"), type: "image/png" });
  assert.equal(svg.status, 400);
  assert.equal((await svg.json() as { messageKey: string }).messageKey, "err.avatarFormat");
  const undeclared = await h.call("/api/auth/avatar/image", { method: "PUT", user: BOB, image: PNG, type: "text/html" });
  assert.equal(undeclared.status, 400);
  const large = await h.call("/api/auth/avatar/image", { method: "PUT", user: BOB, image: Buffer.concat([PNG, Buffer.alloc(AVATAR_MAX_BYTES)]) });
  assert.equal(large.status, 413);
  assert.equal(findUserById(h.store.users(), BOB)!.avatar, undefined);
});

test("only an administrator sets another account's picture, and choosing a preset drops the uploaded file", async (t) => {
  const h = await mount();
  t.after(h.close);
  assert.equal((await h.call(`/api/users/${KID}/avatar`, { method: "PATCH", user: BOB, json: { preset: "panda" } })).status, 403);
  assert.equal((await h.call(`/api/users/${KID}/avatar/image`, { method: "PUT", user: BOB, image: PNG })).status, 403);
  assert.equal(findUserById(h.store.users(), KID)!.avatar, undefined);

  assert.equal((await h.call(`/api/users/${KID}/avatar/image`, { method: "PUT", user: ADA, image: WEBP, type: "image/webp" })).status, 200);
  assert.match((await readdir(path.join(h.dir, "avatars"))).join(","), new RegExp(`^${KID}\\.[0-9a-f-]{36}$`));
  const preset = await h.call(`/api/users/${KID}/avatar`, { method: "PATCH", user: ADA, json: { preset: "panda" } });
  assert.deepEqual(await preset.json(), { avatar: { kind: "preset", id: "panda" } });
  assert.deepEqual(await readdir(path.join(h.dir, "avatars")), [], "the file is gone with the pointer to it");
  assert.equal((await h.call(`/api/users/usr_ffffffff/avatar`, { method: "PATCH", user: ADA, json: { preset: "panda" } })).status, 404);
});

test("changing to a preset only removes the upload it replaced", async (t) => {
  const h = await mount();
  t.after(h.close);
  const upload = async (image: Buffer) => {
    const response = await h.call("/api/auth/avatar/image", { method: "PUT", user: BOB, image });
    assert.equal(response.status, 200);
    return (await response.json() as { avatar: { url: string } }).avatar.url;
  };
  const oldUrl = await upload(PNG);
  const remove = h.avatars.remove.bind(h.avatars);
  const cleanup = new EventEmitter();
  const started = once(cleanup, "started");
  const unblock = once(cleanup, "unblock");
  h.avatars.remove = async (userId, version) => {
    cleanup.emit("started");
    await unblock;
    await remove(userId, version);
  };

  const preset = h.call("/api/auth/avatar", { method: "PATCH", user: BOB, json: { preset: "fox" } });
  try {
    await Promise.race([started, preset.then(() => assert.fail("Preset completed before removing the old upload"))]);
    const newUrl = await upload(JPEG);
    cleanup.emit("unblock");
    assert.equal((await preset).status, 200);
    const current = await h.call(newUrl, { user: BOB });
    assert.equal(current.status, 200);
    assert.deepEqual(Buffer.from(await current.arrayBuffer()), JPEG);
    assert.equal((await h.call(oldUrl, { user: BOB })).status, 404);
    assert.equal((await readdir(path.join(h.dir, "avatars"))).length, 1);
  } finally {
    cleanup.emit("unblock");
    await preset;
  }
});
