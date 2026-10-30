import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { DeviceTransfers } from "../device-transfers.js";
import { messageKeyOf } from "../errors.js";
import { remoteSecretStamp, sealRemoteContent } from "../media-server-reference.js";
import { MediaServerError } from "../media-server-types.js";
import { mediaResources, ResourceError, type ResourceOwner } from "../media-resources.js";
import type { Store } from "../store.js";
import type { StreamItem } from "../types.js";
import type { UserPermissions, UserRecord } from "../users.js";
import { registerDeviceRoutes, type DeviceDeps } from "./device.js";

const ADA: ResourceOwner = { userId: "usr_00000001", sid: "sid-ada", expiresAt: Date.now() + 60_000 };
const BOB: ResourceOwner = { userId: "usr_00000002", sid: "sid-bob", expiresAt: Date.now() + 60_000 };
const TTL = 24 * 60 * 60_000;
const SOURCE = "Movies/Some Movie.mkv";
const ADA_ID = "usr_00000001";
const BOB_ID = "usr_00000002";

interface Harness {
  base: string;
  tickets: DeviceDeps["deviceDownloadTickets"];
  transfers: DeviceTransfers;
  /** The rights of the ordinary account, so a test can take one away mid-flight. */
  permissions: UserPermissions;
  activities: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

/** The two routes keep the tickets in a map the server owns, so the harness hands over a real
 *  one and remembers which session a request speaks for. */
const mount = async (options: {
  holdLibrary?: (call: number) => Promise<void> | undefined;
  source?: StreamItem;
  /** What the media server answers for a row of its own: a policy that forbids downloading
   *  refuses the ticket the way the live server does. */
  download?: () => Promise<void>;
  open?: () => Promise<Response>;
} = {}): Promise<Harness> => {
  const dir = await mkdtemp(path.join(tmpdir(), "routes-device-"));
  const file = path.join(dir, "Some Movie.mkv");
  await writeFile(file, "movie bytes");
  const activities: Array<Record<string, unknown>> = [];
  const tickets: DeviceDeps["deviceDownloadTickets"] = new Map();
  const transfers = new DeviceTransfers();
  let libraryCalls = 0;
  const ownerOf = (req: express.Request) => (req.header("x-user") === "bob" ? BOB : ADA);
  const permissions: UserPermissions = { downloadToLibrary: false, downloadToDevice: true };
  const account = (id: string, username: string, role: "admin" | "user"): UserRecord => ({
    id, username, role, createdAt: "2026-01-01T00:00:00.000Z",
    permissions: role === "admin" ? { downloadToLibrary: false, downloadToDevice: false } : permissions,
    permissionsVersion: 0,
  } as unknown as UserRecord);
  // The administrator's stored flags are deliberately false: the role is what grants.
  const ada = account(ADA_ID, "ada", "admin");
  const bob = account(BOB_ID, "bob", "user");

  const deps: DeviceDeps = {
    store: { addons: () => [], libraries: () => [] } as unknown as Store,
    needsSetup: () => false,
    currentSession: () => undefined,
    currentUser: (req: express.Request) => (req.header("x-user") === "bob" ? bob : ada),
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    stopUserSessions: async () => undefined,
    requireAccess: () => undefined,
    stopContentAccess: async () => undefined,
    countBytes: () => undefined,
    stats: { activity: { record: (entry: Record<string, unknown>) => activities.push(entry) } } as unknown as DeviceDeps["stats"],
    deviceDownloadTickets: tickets,
    deviceTransfers: transfers,
    DEVICE_TICKET_TTL: TTL,
    httpSourceOf: async () => options.source ?? ({ url: `file://${SOURCE}` } as StreamItem),
    libraryTarget: async (value: string) => {
      await options.holdLibrary?.(++libraryCalls);
      if (value !== SOURCE) throw new ResourceError(404, "RESOURCE_NOT_FOUND");
      return file;
    },
    mediaSource: () => undefined,
    mediaSources: {
      authorize: async (_stream: StreamItem, _owner: ResourceOwner, _signal?: AbortSignal, asked?: { download?: boolean }) => {
        if (asked?.download && options.download) await options.download();
      },
      open: (stream: StreamItem) => options.open ? options.open() : Promise.resolve(new Response(stream.url)),
    } as unknown as DeviceDeps["mediaSources"],
    ownerOf,
    pruneDeviceDownloadTickets: () => {
      const now = Date.now();
      for (const [key, ticket] of tickets) if (ticket.expiresAt <= now) tickets.delete(key);
    },
    statMeta: () => ({ source: "download", provider: "example.test", title: "Some Movie.mkv", kind: "other" }),
    trackMedia: () => undefined,
  };

  const app = express();
  app.use(express.json());
  registerDeviceRoutes(app, deps);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error), messageKey: messageKeyOf(error) });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    tickets,
    transfers,
    permissions,
    activities,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
};

const api = (base: string, pathname: string, init: { method?: string; body?: unknown; user?: "ada" | "bob" } = {}) =>
  fetch(`${base}${pathname}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.user ? { "x-user": init.user } : {}),
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test("POST /api/device-download mints a ticket for the caller that never outlives the session", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const response = await api(harness.base, "/api/device-download", { method: "POST", user: "ada", body: {} });
  assert.equal(response.status, 201);
  const body = await response.json() as { url: string; filename: string };
  assert.equal(body.filename, "Some Movie.mkv");

  const ticket = harness.tickets.get(body.url.replace("/api/device-download/", ""));
  assert.ok(ticket, "the answered URL names the ticket that was stored");
  assert.equal(ticket.owner.sid, ADA.sid, "the ticket is bound to the caller's own session");
  assert.equal(ticket.expiresAt, ADA.expiresAt, "the session expires first, so its deadline wins");
  assert.ok(ticket.expiresAt > Date.now());
  assert.ok(ticket.expiresAt <= Date.now() + TTL);
});

test("GET /api/device-download/:id answers the caller's own ticket and refuses somebody else's", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const minted = await api(harness.base, "/api/device-download", { method: "POST", user: "ada", body: {} });
  const { url } = await minted.json() as { url: string };

  const own = await api(harness.base, url, { user: "ada" });
  assert.equal(own.status, 200);
  assert.equal(await own.text(), "movie bytes");

  const other = await api(harness.base, url, { user: "bob" });
  assert.equal(other.status, 404);
  const body = await other.json() as { messageKey?: string };
  assert.equal(body.messageKey, "err.downloadTicketExpired", "the answer says only that the link is not usable");
});

test("GET /api/device-download/:id drops an expired ticket instead of serving it", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  harness.tickets.set("expired", { owner: ADA, expiresAt: Date.now() - 1, filename: "Some Movie.mkv", source: { kind: "local", path: SOURCE } });

  const response = await api(harness.base, "/api/device-download/expired", { user: "ada" });
  assert.equal(response.status, 404);
  const body = await response.json() as { messageKey?: string };
  assert.equal(body.messageKey, "err.downloadTicketExpired");
  assert.equal(harness.tickets.has("expired"), false, "an expired ticket does not stay in the map");
});

test("POST /api/device-download refuses an account that may not save to the device", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  harness.permissions.downloadToDevice = false;

  const response = await api(harness.base, "/api/device-download", { method: "POST", user: "bob", body: {} });
  assert.equal(response.status, 403);
  assert.equal((await response.json() as { messageKey?: string }).messageKey, "err.downloadDeviceNotAllowed");
  assert.equal(harness.tickets.size, 0, "no ticket is minted");
});

test("taking the device permission away stops a ticket that was already minted", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const minted = await api(harness.base, "/api/device-download", { method: "POST", user: "bob", body: {} });
  assert.equal(minted.status, 201);
  const { url } = await minted.json() as { url: string };
  assert.equal((await api(harness.base, url, { user: "bob" })).status, 200, "the ticket works while the right is there");

  harness.permissions.downloadToDevice = false;
  const refused = await api(harness.base, url, { user: "bob" });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json() as { messageKey?: string }).messageKey, "err.downloadDeviceNotAllowed");
});


test("successful device transfer records its user, while HEAD does not", async (t) => {
  const harness = await mount();
  t.after(() => harness.close());
  const minted = await fetch(`${harness.base}/api/device-download`, { method: "POST", headers: { "content-type": "application/json", "x-user": "bob" }, body: "{}" });
  const ticket = await minted.json() as { url: string };
  await fetch(`${harness.base}${ticket.url}`, { method: "HEAD", headers: { "x-user": "bob" } });
  assert.equal(harness.activities.length, 0);
  const response = await fetch(`${harness.base}${ticket.url}`, { headers: { "x-user": "bob" } });
  await response.text();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.activities.length, 1);
  assert.equal(harness.activities[0].username, "bob");
  assert.equal(harness.activities[0].kind, "device");
  const partial = await fetch(`${harness.base}${ticket.url}`, { headers: { "x-user": "bob", range: "bytes=0-3" } });
  assert.equal(partial.status, 206);
  await partial.text();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.activities[1].partial, true);
  const missing = await fetch(`${harness.base}/api/device-download/missing`, { headers: { "x-user": "bob" } });
  assert.equal(missing.status, 404);
  assert.equal(harness.activities.length, 2);
});

test("a finished library download leaves a completed row in the registry", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const minted = await api(harness.base, "/api/device-download", { method: "POST", user: "bob", body: {} });
  const { url } = await minted.json() as { url: string };

  const response = await api(harness.base, url, { user: "bob" });
  assert.equal(await response.text(), "movie bytes");
  await settle();

  const rows = harness.transfers.list({ id: BOB_ID, role: "user" });
  assert.equal(rows.length, 1, "one row covers the whole download");
  assert.equal(rows[0].state, "completed");
  assert.equal(rows[0].sent, 11);
  assert.equal(rows[0].total, 11);
  assert.equal(rows[0].filename, "Some Movie.mkv");
  assert.equal(rows[0].source, "library");
  assert.equal("username" in rows[0], false, "an ordinary user never sees a username");
});

test("a HEAD request leaves no device transfer row", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const minted = await api(harness.base, "/api/device-download", { method: "POST", user: "bob", body: {} });
  const { url } = await minted.json() as { url: string };

  const response = await api(harness.base, url, { method: "HEAD", user: "bob" });
  assert.equal(response.status, 200);
  await settle();

  assert.deepEqual(harness.transfers.list({ id: BOB_ID, role: "user" }), []);
  assert.deepEqual(harness.transfers.list({ id: ADA_ID, role: "admin" }), []);
});

test("DELETE /api/device-transfers/:id refuses a stranger and stops the owner's transfer", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const minted = await api(harness.base, "/api/device-download", { method: "POST", user: "ada", body: {} });
  const { url } = await minted.json() as { url: string };
  const ticketId = url.replace("/api/device-download/", "");
  const response = await api(harness.base, url, { user: "ada" });
  await response.text();
  await settle();

  const row = harness.transfers.list({ id: ADA_ID, role: "admin" })[0];
  assert.ok(row, "the finished download is visible for ninety seconds");

  const stranger = await api(harness.base, `/api/device-transfers/${row.id}`, { method: "DELETE", user: "bob" });
  assert.equal(stranger.status, 404);
  assert.equal((await stranger.json() as { messageKey?: string }).messageKey, "err.itemNotFound");
  assert.equal(harness.tickets.has(ticketId), true, "a refused abort leaves the ticket alone");

  const owner = await api(harness.base, `/api/device-transfers/${row.id}`, { method: "DELETE", user: "ada" });
  assert.equal(owner.status, 204);
  assert.equal(harness.tickets.has(ticketId), false, "the ticket is deleted with the transfer");
});

test("a request still waiting when its transfer is stopped goes no further", async (t) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  // POST resolves the file once and the first GET once; the second GET waits.
  const harness = await mount({ holdLibrary: (call) => (call === 3 ? held : undefined) });
  t.after(harness.close);
  const minted = await api(harness.base, "/api/device-download", { method: "POST", user: "bob", body: {} });
  const { url } = await minted.json() as { url: string };
  await (await api(harness.base, url, { user: "bob" })).text();
  await settle();

  const waiting = api(harness.base, url, { user: "bob" });
  await settle();
  const row = harness.transfers.list({ id: BOB_ID, role: "user" })[0];
  const stop = await api(harness.base, `/api/device-transfers/${row.id}`, { method: "DELETE", user: "bob" });
  assert.equal(stop.status, 204);
  release();

  const late = await waiting;
  assert.equal(late.status, 404);
  assert.equal((await late.json() as { messageKey?: string }).messageKey, "err.downloadTicketExpired");
  const [after] = harness.transfers.list({ id: BOB_ID, role: "user" });
  assert.equal(after.state, "interrupted");
});

test("DELETE /api/device-transfers clears the caller's finished rows only", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  for (const user of ["ada", "bob"] as const) {
    const minted = await api(harness.base, "/api/device-download", { method: "POST", user, body: {} });
    const { url } = await minted.json() as { url: string };
    await (await api(harness.base, url, { user })).text();
  }
  await settle();

  const cleared = await api(harness.base, "/api/device-transfers", { method: "DELETE", user: "bob" });
  assert.equal(cleared.status, 204);
  assert.deepEqual(harness.transfers.list({ id: BOB_ID, role: "user" }), []);
  assert.equal(harness.transfers.list({ id: ADA_ID, role: "admin" }).length, 1, "ada's row stays");
});

test("a remote original the server never minted is refused, and no ticket is made for it", async (t) => {
  const harness = await mount({ source: { url: "media-server:forged" } });
  t.after(harness.close);

  const response = await api(harness.base, "/api/device-download", { method: "POST", user: "ada", body: {} });
  assert.ok(response.status >= 400, `a forged source is refused, got ${response.status}`);
  assert.equal(harness.tickets.size, 0, "no ticket is minted for a remote original");
});

test("a media server's own original is saved to the device through a ticket like any other row", async (t) => {
  // The sealed address the listing minted: the server reads it itself, so the copy reaches the
  // device the way a copy into a local library does, with the account's right deciding.
  const sealed = sealRemoteContent({
    provider: "jellyfin", serverId: "server-1", accountId: "account-1", itemId: "item-1",
    connectionId: "mconn_00000000000000000000000000000000", libraryId: "rlib_00000000000000000000000000000000",
    generation: 1, mediaSourceId: "v1",
    owner: { userId: ADA_ID, sid: "sid-ada", expiresAt: Date.now() + 60_000, secretStamp: remoteSecretStamp("secret") },
  });
  const harness = await mount({ source: { url: sealed, addonKey: "addon" } });
  t.after(harness.close);

  const response = await api(harness.base, "/api/device-download", { method: "POST", user: "bob", body: { title: "Some Movie" } });
  const minted = await response.json() as { url: string; filename: string };
  assert.equal(response.status, 201, JSON.stringify(minted));
  assert.equal(harness.tickets.size, 1, "a ticket is minted");
  const [ticket] = [...harness.tickets.values()];
  assert.equal(ticket!.source.kind, "remote", "the ticket keeps the sealed source, never the address");
  assert.equal(JSON.stringify(ticket!.source).includes(sealed), true, "the sealed source stays in the server's own map");
  assert.equal(JSON.stringify(minted).includes("media-server:"), false, "the internal address never leaves the server");
});

test("a busy media-server quota is mapped during device download hand-over", async (t) => {
  const sealed = sealRemoteContent({
    provider: "jellyfin", serverId: "server-1", accountId: "account-1", itemId: "item-1",
    connectionId: "mconn_00000000000000000000000000000000", libraryId: "rlib_00000000000000000000000000000000",
    generation: 1, mediaSourceId: "v1",
    owner: { userId: ADA_ID, sid: "sid-ada", expiresAt: Date.now() + 60_000, secretStamp: remoteSecretStamp("secret") },
  });
  const harness = await mount({
    source: { url: sealed, addonKey: "addon" },
    open: () => Promise.reject(new MediaServerError("busy", "x")),
  });
  t.after(harness.close);

  const minted = await api(harness.base, "/api/device-download", { method: "POST", user: "bob", body: { title: "Some Movie" } });
  const { url } = await minted.json() as { url: string };
  const response = await api(harness.base, url, { user: "bob" });
  assert.equal(response.status, 429);
  assert.equal((await response.json() as { messageKey?: string }).messageKey, "err.mediaServerBusy");
});

test("a media server that forbids downloading mints no ticket for its own original", async (t) => {
  // The account's own right is what the app grants; whether the media server lets it download the
  // item is the media server's answer, asked again here rather than trusted from the listing that
  // drew the button. `contentDownloading: false` refuses a playable account exactly like this.
  const sealed = sealRemoteContent({
    provider: "jellyfin", serverId: "server-1", accountId: "account-1", itemId: "item-1",
    connectionId: "mconn_00000000000000000000000000000000", libraryId: "rlib_00000000000000000000000000000000",
    generation: 1, mediaSourceId: "v1",
    owner: { userId: ADA_ID, sid: "sid-ada", expiresAt: Date.now() + 60_000, secretStamp: remoteSecretStamp("secret") },
  });
  const harness = await mount({
    source: { url: sealed, addonKey: "addon" },
    download: () => Promise.reject(new ResourceError(403, "FORBIDDEN")),
  });
  t.after(harness.close);

  const response = await api(harness.base, "/api/device-download", { method: "POST", user: "bob", body: { title: "Some Movie" } });
  assert.equal(response.status, 403, await response.text());
  assert.equal(harness.tickets.size, 0, "no ticket is minted for a row the media server forbids");
});

test("a device HLS transfer gives FFmpeg only an internal proxied URL and releases its claim", async (t) => {
  const addonUrl = "http://127.0.0.1:1/private/master.m3u8?token=addon-secret";
  const harness = await mount({
    source: {
      url: addonUrl,
      behaviorHints: { proxyHeaders: { request: { Authorization: "Bearer addon-secret" } } },
    },
  });
  t.after(harness.close);
  const directory = await mkdtemp(path.join(tmpdir(), "device-ffmpeg-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ffmpeg = path.join(directory, "ffmpeg");
  const logFile = path.join(directory, "ffmpeg-args.jsonl");
  await writeFile(ffmpeg, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_FFMPEG_LOG, JSON.stringify(args) + "\\n");
if (args.includes("-h")) process.stdout.write("extension_picky");
else process.stdout.write("assembled");
`, { mode: 0o755 });
  const previousFfmpeg = process.env.FFMPEG_PATH;
  const previousLog = process.env.FAKE_FFMPEG_LOG;
  const previousPrivate = process.env.ALLOW_PRIVATE_ADDONS;
  process.env.FFMPEG_PATH = ffmpeg;
  process.env.FAKE_FFMPEG_LOG = logFile;
  process.env.ALLOW_PRIVATE_ADDONS = "1";
  t.after(() => {
    if (previousFfmpeg === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previousFfmpeg;
    if (previousLog === undefined) delete process.env.FAKE_FFMPEG_LOG; else process.env.FAKE_FFMPEG_LOG = previousLog;
    if (previousPrivate === undefined) delete process.env.ALLOW_PRIVATE_ADDONS; else process.env.ALLOW_PRIVATE_ADDONS = previousPrivate;
  });

  const minted = await api(harness.base, "/api/device-download", { method: "POST", user: "bob", body: { title: "Movie" } });
  const { url } = await minted.json() as { url: string };
  const response = await api(harness.base, url, { user: "bob" });
  assert.equal(await response.text(), "assembled");

  const invocations = (await readFile(logFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
  const args = invocations.find((item) => item.includes("-i"));
  assert.ok(args);
  const input = args[args.indexOf("-i") + 1]!;
  assert.match(input, /^http:\/\/127\.0\.0\.1:\d+\/api\/media\/[A-Za-z0-9_-]{43}\?token=[a-f0-9]+$/);
  assert.equal(input.includes("addon-secret"), false);
  assert.equal(args.includes("-headers"), false);
  assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "http,tcp,crypto");

  await settle();
  const resourceId = new URL(input).pathname.split("/").pop()!;
  assert.throws(() => mediaResources.get(resourceId, undefined, "media", true), { status: 404 });
});
