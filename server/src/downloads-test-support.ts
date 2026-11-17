import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { DownloadQueue } from "./downloads.js";
import { relativeWithin, type LibraryRecord } from "./libraries.js";
import { buildTemplatePolicy, RULE_PRESETS, SOURCE_PROFILE_IDS } from "./source-profiles.js";
import { rulesPolicy } from "./download-rules.js";
import { materializeSourceAdmissionPolicy, parseSourceAdmissionSnapshotV1, type SourceAdmissionSnapshotV1 } from "./source-admission.js";

process.env.ALLOW_PRIVATE_ADDONS = "1";

export const MB = 1024 * 1024;

export const send = async (res: NodeJS.WritableStream, bytes: number) => {
  const chunk = Buffer.alloc(Math.min(MB, bytes));
  for (let sent = 0; sent < bytes; ) {
    const size = Math.min(chunk.length, bytes - sent);
    const piece = size === chunk.length ? chunk : chunk.subarray(0, size);
    if (!res.write(piece)) {
      await new Promise<void>((resolve) => {
        const done = () => {
          res.off("drain", done);
          res.off("close", done);
          res.off("error", done);
          resolve();
        };
        res.once("drain", done);
        res.once("close", done);
        res.once("error", done);
      });
      if ((res as NodeJS.WritableStream & { destroyed?: boolean }).destroyed) return;
    }
    sent += size;
  }
};

export const waitFor = async (queue: DownloadQueue, predicate: () => boolean, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout: ${JSON.stringify(queue.snapshot())}`);
};

export const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};

export const LIBRARY_ID = "lib_d10ad10a";

export const REMOTE_LIBRARY_ID = `rlib_${"e".repeat(32)}`;

export const REMOTE_ITEM = {
  libraryId: REMOTE_LIBRARY_ID,
  connectionId: `mconn_${"f".repeat(32)}`,
  itemId: "episode-1",
};

export const REMOTE_ITEM_VIDEO_ID = `remote-item:${REMOTE_LIBRARY_ID}:${REMOTE_ITEM.itemId}`;

export const remoteRulesAdmission = (): SourceAdmissionSnapshotV1 => {
  const preset = RULE_PRESETS.find((candidate) => candidate.id === SOURCE_PROFILE_IDS.balanced);
  assert.ok(preset);
  const providerKeys = [`remote:${REMOTE_LIBRARY_ID}`];
  return parseSourceAdmissionSnapshotV1({
    schemaVersion: 1,
    profile: { id: preset.id, revision: 1, template: "rules" },
    operation: "downloadToLibrary",
    providerKeys,
    policy: materializeSourceAdmissionPolicy(
      rulesPolicy(preset.rules, "episode"),
      providerKeys,
      { audioLanguage: "en", subtitleLanguage: "en" },
    ),
  });
};

export const queueAdmission = (): SourceAdmissionSnapshotV1 => parseSourceAdmissionSnapshotV1({
  schemaVersion: 1,
  profile: { id: "queue-local-copy-test", revision: 1, template: "providerPriority" },
  operation: "downloadToLibrary",
  providerKeys: ["addon:http-only"],
  policy: materializeSourceAdmissionPolicy(
    buildTemplatePolicy("providerPriority", {
      scope: { mode: "allAvailable" },
      providerOrder: { from: "viewer" },
      sizeDirection: "desc",
      transfer: ["http"],
      audioMode: "preferred",
      subtitleMode: "off",
    }),
    ["addon:http-only"],
    { audioLanguage: "en" },
  ),
});

/** A queue refuses a download no library accepts, so every test queue has one library rooted
 *  at the download directory -- the shape a migrated install has. */
export const downloadLibrary = (root: string): LibraryRecord => ({
  id: LIBRARY_ID, name: "Downloads", type: "mixed", root, enabled: true, order: 0,
  addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: false,
});

export const queuedFile = (downloads: string, target: string) => path.join(downloads, relativeWithin(LIBRARY_ID, target));

export const tempQueue = async (hooks: ConstructorParameters<typeof DownloadQueue>[4] = {}) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const downloads = path.join(directory, "downloads");
  const library = downloadLibrary(downloads);
  const queue = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), downloads, {
    retryDelay: () => 30,
    stallInitialMs: 5_000,
    stallTransferMs: 5_000,
    libraries: () => [library],
    defaultLibrary: () => library,
    ...hooks,
  });
  await queue.load();
  return { directory, queue, downloads };
};

export const listen = (handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) => new Promise<{ server: Server; port: number }>((resolve) => {
  const server = createServer((req, res) => { void handler(req, res); });
  server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port }));
});

export const HASH = "59e11cef8c2152ac73681092844ebd3db19025bc";

export const SEGMENTED_TOTAL = 48 * MB;

export const byteAt = (position: number) => position % 251;

export const filled = (from: number, length: number) => Buffer.from(Array.from({ length }, (_unused, index) => byteAt(from + index)));

/** Serves byte ranges, and every byte says where in the file it belongs, so a segment written
 *  to the wrong offset cannot pass unnoticed. */
export const rangeServer = (options: { total?: number; ranges?: boolean; cutAt?: number; probeOnly?: boolean } = {}) => new Promise<{
  server: Server; port: number; peak: () => number; requests: () => string[];
}>((resolve) => {
  const total = options.total ?? SEGMENTED_TOTAL;
  let inflight = 0; let peak = 0; let cut = options.cutAt != null;
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    requests.push(req.headers.range ?? "");
    const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    // `probeOnly` is the source that answers the one-byte probe honestly and every real range
    // with the whole file -- the lie that makes the probe promise a plan the transfer cannot keep.
    const probe = Boolean(match && match[1] === "0" && match[2] === "0");
    if (!match || options.ranges === false || (options.probeOnly && !probe)) {
      res.writeHead(200, { "content-length": String(total), "content-type": "video/mp4" });
      // Paced the way the range branch is, and stopping the moment the client gives up. A
      // segment request answered with the whole file is a body nobody wants: written in one
      // synchronous burst, four of those queue the file four times over and hold the loop
      // long enough for the stall detector to fire before the fallback is even reached.
      for (let sent = 0; sent < total; sent += MB) {
        if (res.destroyed) return;
        res.write(filled(sent, Math.min(MB, total - sent)));
        await new Promise((done) => setTimeout(done, 1));
      }
      res.end();
      return;
    }
    inflight += 1; peak = Math.max(peak, inflight);
    const from = Number(match[1]);
    const to = match[2] ? Number(match[2]) : total - 1;
    res.writeHead(206, { "content-length": String(to - from + 1), "content-range": `bytes ${from}-${to}/${total}` });
    for (let sent = from; sent <= to; sent += 64 * 1024) {
      const length = Math.min(64 * 1024, to - sent + 1);
      if (cut && options.cutAt != null && sent + length > from + options.cutAt) { cut = false; req.socket.destroy(); inflight -= 1; return; }
      res.write(filled(sent, length));
      await new Promise((done) => setTimeout(done, 1));
    }
    res.end();
    inflight -= 1;
  });
  server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port, peak: () => peak, requests: () => requests }));
});

export const assertContent = async (file: string, total: number) => {
  const data = await readFile(file);
  assert.equal(data.length, total);
  for (let position = 0; position < total; position += 7919) {
    assert.equal(data[position], byteAt(position), `byte ${position} came from the wrong place in the file`);
  }
};

export const windowAt = (hour: number, minute = 0) =>
  Date.parse(`2026-01-15T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
