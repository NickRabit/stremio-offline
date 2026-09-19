import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { messageKeyOf } from "../errors.js";
import { ResourceError, type ResourceOwner } from "../media-resources.js";
import type { Store } from "../store.js";
import type { StreamItem } from "../types.js";
import type { UserPermissions, UserRecord } from "../users.js";
import { registerDeviceRoutes, type DeviceDeps } from "./device.js";

const ADA: ResourceOwner = { sid: "sid-ada", expiresAt: Date.now() + 60_000 };
const BOB: ResourceOwner = { sid: "sid-bob", expiresAt: Date.now() + 60_000 };
const TTL = 24 * 60 * 60_000;
const SOURCE = "Movies/Some Movie.mkv";
const ADA_ID = "usr_00000001";
const BOB_ID = "usr_00000002";

interface Harness {
  base: string;
  tickets: DeviceDeps["deviceDownloadTickets"];
  /** The rights of the ordinary account, so a test can take one away mid-flight. */
  permissions: UserPermissions;
  close(): Promise<void>;
}

/** The two routes keep the tickets in a map the server owns, so the harness hands over a real
 *  one and remembers which session a request speaks for. */
const mount = async (): Promise<Harness> => {
  const dir = await mkdtemp(path.join(tmpdir(), "routes-device-"));
  const file = path.join(dir, "Some Movie.mkv");
  await writeFile(file, "movie bytes");
  const tickets: DeviceDeps["deviceDownloadTickets"] = new Map();
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
    countBytes: () => undefined,
    deviceDownloadTickets: tickets,
    DEVICE_TICKET_TTL: TTL,
    httpSourceOf: async () => ({ url: `file://${SOURCE}` }) as StreamItem,
    libraryTarget: async (value: string) => {
      if (value !== SOURCE) throw new ResourceError(404, "RESOURCE_NOT_FOUND");
      return file;
    },
    mediaSource: () => undefined,
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
    permissions,
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
