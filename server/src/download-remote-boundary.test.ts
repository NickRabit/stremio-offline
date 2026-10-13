import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DownloadQueue, isRemoteDownloadSource, ownerMayDownload, type DownloadSelection } from "./downloads.js";
import { AppError } from "./errors.js";
import type { LibraryRecord } from "./libraries.js";
import { defaultDownloadSettings } from "./naming.js";
import type { StreamItem } from "./types.js";
import type { UserRecord } from "./users.js";

process.env.ALLOW_PRIVATE_ADDONS = "1";

const LIBRARY_ID = "lib_d10ad10a";
const library = (root: string): LibraryRecord => ({
  id: LIBRARY_ID, name: "Downloads", type: "mixed", root, enabled: true, order: 0,
  addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: false,
});

const admin: Pick<UserRecord, "id" | "role" | "disabled" | "permissions"> = {
  id: "usr_00000001", role: "admin", permissions: { downloadToLibrary: true, downloadToDevice: true },
};

const selection = (libraryId: string): DownloadSelection => ({
  addonKeys: ["addon"], sourceStrategy: "priority", audioLanguage: "en", subtitleMode: "off",
  targetSettings: { subfolder: "", layout: "structured", libraryId, explicit: true },
});

const remoteUrls = ["media-server:forged", "media-server:", "media-server:AAAA.BBBB"];

test("every media-server attempt is recognised, valid or forged", () => {
  for (const url of remoteUrls) assert.equal(isRemoteDownloadSource({ url }), true, url);
  assert.equal(isRemoteDownloadSource({ url: "https://example.test/a.mp4" }), false);
  assert.equal(isRemoteDownloadSource(undefined), false);
});

test("ownerMayDownload refuses a remote source even for an administrator", () => {
  const root = "/tmp/remote-boundary";
  const scope = { owner: admin, addons: [], libraries: [library(root)] };
  assert.equal(ownerMayDownload(scope, { stream: { url: "https://example.test/a.mp4" } as StreamItem }), true);
  for (const url of remoteUrls) {
    assert.equal(ownerMayDownload(scope, { stream: { url } as StreamItem }), false, url);
  }
  assert.equal(ownerMayDownload(scope, { subtitle: { url: "media-server:forged" } }), false, "a forged remote subtitle is refused");
  assert.equal(ownerMayDownload(scope, { libraryId: `rlib_${"a".repeat(32)}` }), false, "a remote library id is never a target");
});

test("the queue refuses a remote stream before any admission or queue effect", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stremio-remote-boundary-"));
  const downloads = path.join(dir, "downloads");
  const target = library(downloads);
  const queue = new DownloadQueue(() => 1, () => 1, path.join(dir, "data"), downloads, {
    libraries: () => [target], defaultLibrary: () => target, retryDelay: () => 30,
  });
  try {
    await queue.load();
    for (const url of remoteUrls) {
      await assert.rejects(queue.add("Remote", { url } as StreamItem, undefined, defaultDownloadSettings().movie), (error: unknown) =>
        error instanceof AppError && error.messageKey === "library.readOnly" && error.status === 403, url);
    }
    assert.deepEqual(queue.snapshot().jobs, [], "nothing reached the queue");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a lazy job cannot smuggle a remote library id as its target", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stremio-remote-boundary-"));
  const downloads = path.join(dir, "downloads");
  const target = library(downloads);
  const queue = new DownloadQueue(() => 1, () => 1, path.join(dir, "data"), downloads, {
    libraries: () => [target], defaultLibrary: () => target, retryDelay: () => 30,
  });
  try {
    await queue.load();
    await assert.rejects(
      queue.addPending("Show", { type: "series", videoId: "tt1", selection: selection(`rlib_${"a".repeat(32)}`) }),
      (error: unknown) => error instanceof AppError && error.messageKey === "library.readOnly" && error.status === 403,
    );
    assert.deepEqual(queue.snapshot().jobs, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
