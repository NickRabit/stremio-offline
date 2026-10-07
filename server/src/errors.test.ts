import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { hashPassword } from "./auth.js";
import { AppError, classifyError, explainedError, type ErrorCategory } from "./errors.js";
import { DebridError } from "./debrid.js";
import { ResourceError } from "./media-resources.js";
import { RestrictedError } from "./restricted.js";
import { spawnServer, type SpawnedServer } from "./test-server.js";

test("the table classifies a representative key into every category", () => {
  const cases: Array<[string, ErrorCategory]> = [
    ["err.noMatchingSource", "source"],
    ["err.debridTimeout", "network"],
    ["err.noSpace", "storage"],
    ["err.pathMissing", "library"],
    ["err.playbackSessionGone", "playback"],
    ["err.conversionFailed", "transcode"],
    ["err.addonNotFound", "addon"],
    ["err.restricted", "authentication"],
    ["err.debridNotConfigured", "configuration"],
  ];
  for (const [key, category] of cases) {
    const classification = classifyError(new AppError("failed", key));
    assert.equal(classification.category, category, key);
    assert.ok(
      ["automatic", "manual", "action", "permanent"].includes(classification.retry),
      `${key} carries a known retry disposition`,
    );
  }
});

test("a Real-Debrid answer is explained and classified by its status", () => {
  assert.deepEqual(classifyError(new DebridError("The Real-Debrid token is not valid.", 401, "bad_token")), { category: "configuration", retry: "action" });
  assert.deepEqual(classifyError(new DebridError("The Real-Debrid account is not premium.")), { category: "source", retry: "manual" });
  assert.deepEqual(classifyError(new DebridError("Real-Debrid is not answering right now, trying again.", 503, "service_unavailable")), { category: "network", retry: "automatic" });
  assert.equal(explainedError(new DebridError("The Real-Debrid account is not premium.")), true, "a sentence the server wrote gets no reference");
  assert.equal(explainedError(new Error("boom")), false);
  assert.equal(explainedError(new AppError("The item was not found.", "err.itemNotFound")), true);
});

test("a body-parser failure shaped like a resource refusal still gets a reference", () => {
  const inflate = Object.assign(new Error("incorrect header check"), { code: "Z_DATA_ERROR", status: 400 });
  assert.equal(explainedError(inflate), false);
  assert.equal(explainedError(new ResourceError(410, "RESOURCE_EXPIRED")), true);
});

test("a key or code naming something on Object.prototype is not a classification", () => {
  const result = classifyError({ messageKey: "toString", code: "constructor" });
  assert.equal(typeof result.category, "string");
  assert.equal(typeof result.retry, "string");
});

test("an unknown exception classifies as internal with a manual retry", () => {
  assert.deepEqual(classifyError(new Error("boom")), { category: "internal", retry: "manual" });
  assert.deepEqual(classifyError("not an error"), { category: "internal", retry: "manual" });
  assert.deepEqual(classifyError(undefined), { category: "internal", retry: "manual" });
  // A runtime error carries a string code but no status, so it is not mistaken for a ResourceError.
  assert.deepEqual(classifyError(Object.assign(new Error("gone"), { code: "ENOENT" })), { category: "internal", retry: "manual" });
});

test("an AppError with an unlisted key falls back to configuration and action", () => {
  assert.deepEqual(classifyError(new AppError("failed", "err.notYetClassified")), { category: "configuration", retry: "action" });
});

test("a ResourceError classifies as its code says", () => {
  assert.deepEqual(classifyError(new ResourceError(401, "AUTH_REQUIRED")), { category: "authentication", retry: "action" });
  assert.deepEqual(classifyError(new ResourceError(404, "RESOURCE_NOT_FOUND")), { category: "source", retry: "permanent" });
  assert.deepEqual(classifyError(new ResourceError(429, "RESOURCE_LIMIT")), { category: "source", retry: "manual" });
});

test("a RestrictedError classifies as authentication", () => {
  assert.deepEqual(classifyError(new RestrictedError()), { category: "authentication", retry: "action" });
});

const ADMIN = "usr_00000001";
let workDir: string;
let dataDir: string;
let server: SpawnedServer;
let base = "";

const api = (pathname: string, body: string) =>
  fetch(`${base}${pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body });

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "stremio-errors-"));
  dataDir = path.join(workDir, "data");
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "state.json"), JSON.stringify({
    schemaVersion: 3,
    addons: [],
    defaultsInstalled: true,
    settings: {},
    libraries: [],
    users: [{
      id: ADMIN, username: "ada", passwordHash: await hashPassword("admin-password"), secret: ADMIN.padEnd(64, "0"),
      role: "admin", createdAt: "2026-01-01T00:00:00.000Z",
      permissions: { downloadToLibrary: true, downloadToDevice: true }, permissionsVersion: 0,
    }],
    userData: { [ADMIN]: { prefs: {}, favorites: [], watchlist: {}, progress: {}, watchedSeries: {} } },
  }, null, 2));
  server = await spawnServer({
    DATA_DIR: dataDir,
    DOWNLOAD_DIR: path.join(workDir, "downloads"),
    LIBRARY_AUTO_SCAN: "0",
    ADDON_AUTO_REFRESH: "0",
  });
  base = server.base;
});

after(async () => {
  await server?.stop();
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

test("an AppError answer carries category and retry and its old fields unchanged", async () => {
  const response = await api("/api/auth/setup", "{}");
  assert.equal(response.status, 400, server.log());
  const body = await response.json() as { error?: string; messageKey?: string; category?: string; retry?: string; reference?: string };
  assert.equal(body.error, "An account already exists.");
  assert.equal(body.messageKey, "err.setupDone");
  assert.equal(body.category, "configuration");
  assert.equal(body.retry, "permanent");
  assert.equal("reference" in body, false, "a known failure carries no correlation id");
});

test("an unknown exception carries a reference equal to the sent request id", async () => {
  const response = await api("/api/auth/setup", "{ this is not json");
  assert.equal(response.status, 400, server.log());
  const requestId = response.headers.get("x-request-id");
  assert.ok(requestId, "the server sends its request id back");
  const body = await response.json() as { error?: string; category?: string; retry?: string; reference?: string };
  assert.equal(body.category, "internal");
  assert.equal(body.retry, "manual");
  assert.equal(body.reference, requestId);
  assert.ok(server.log().includes(requestId), "the id also appears in the log line");
});
