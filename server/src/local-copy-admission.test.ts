import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { FoundFile } from "./library.js";
import { libraryPath, type LibraryRecord } from "./libraries.js";
import { listVideos } from "./library.js";
import { titleUnits, type LibraryMetaRecord } from "./library-match.js";
import { findAdequateExistingLocalCopy, hasAdequateExistingLocalCopy } from "./local-copy-admission.js";
import type { MediaInfo } from "./probe.js";
import { parseSourceAdmissionSnapshotV1, type SourceAdmissionSnapshotV1 } from "./source-admission.js";
import type { AudioMode, ExistingLocalCopyPolicy, SubtitleMode } from "./source-policy.js";
import type { UserRecord } from "./users.js";

const OWNER_ID = "usr_00000001";
const LIBRARY_ID = "lib_00000001";
const HTTP_PROVIDER = "addon:http-only";

const owner = (): UserRecord => ({
  id: OWNER_ID,
  username: "owner",
  passwordHash: "",
  secret: "",
  role: "user",
  createdAt: "2026-01-01T00:00:00.000Z",
  permissions: { downloadToLibrary: true, downloadToDevice: true },
  permissionsVersion: 0,
});

const videoInfo = (options: {
  height?: number;
  audio?: Array<string | undefined>;
  subtitles?: Array<string | undefined>;
  duration?: number;
} = {}): MediaInfo => ({
  container: "matroska",
  duration: options.duration ?? 1_200,
  video: { codec: "h264", width: 1_920, height: options.height ?? 1_080 },
  audioTracks: (options.audio ?? ["en"]).map((language, index) => ({
    index,
    codec: "aac",
    ...(language === undefined ? {} : { language }),
  })),
  subtitleTracks: (options.subtitles ?? []).map((language, index) => ({
    index,
    codec: "subrip",
    ...(language === undefined ? {} : { language }),
  })),
});

const snapshot = (options: {
  existingLocalCopy?: ExistingLocalCopyPolicy;
  height?: number;
  audioMode?: AudioMode;
  audio?: string;
  subtitleMode?: SubtitleMode;
  subtitle?: string;
} = {}): SourceAdmissionSnapshotV1 => parseSourceAdmissionSnapshotV1({
  schemaVersion: 1,
  profile: { id: "local-copy-test", revision: 1 },
  operation: "downloadToLibrary",
  providerKeys: [HTTP_PROVIDER],
  policy: {
    schemaVersion: 1,
    scope: { mode: "selected", providerKeys: [HTTP_PROVIDER] },
    constraints: {
      sourceKinds: ["http"],
      audio: {
        mode: options.audioMode ?? "preferred",
        preferred: { code: options.audio ?? "en" },
      },
      subtitles: options.subtitleMode && options.subtitleMode !== "off"
        ? { mode: options.subtitleMode, preferred: { code: options.subtitle ?? "en" } }
        : { mode: "off" },
      ...(options.height === undefined ? {} : { heightPixels: { min: options.height } }),
    },
    criteria: [{ kind: "providerOrder", keys: [HTTP_PROVIDER] }],
    nextEpisode: "profile",
    existingLocalCopy: options.existingLocalCopy ?? "meetsRequirements",
  },
});

const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};

const setup = async (type: "movie" | "series" = "movie") => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-copy-admission-"));
  const library: LibraryRecord = {
    id: LIBRARY_ID,
    name: "Library",
    type,
    root,
    enabled: true,
    order: 0,
    addedAt: "2026-01-01T00:00:00.000Z",
    writeArtwork: false,
    visibleTo: [OWNER_ID],
  };
  const state = {
    users: [owner()],
    libraries: [library],
    records: {} as Record<string, LibraryMetaRecord>,
    files: undefined as FoundFile[] | undefined,
    probeInfo: videoInfo() as MediaInfo | undefined,
  };
  const probeCalls: string[] = [];

  const scan = async () => (await listVideos(root)).map((file) => ({
    ...file,
    relative: libraryPath(LIBRARY_ID, file.relative),
  }));
  const files = async () => state.files ??= await scan();
  const units = async () => {
    const current = await files();
    return state.libraries.flatMap((entry) => titleUnits(current, entry.type));
  };

  const write = async (relative: string, bytes = 100) => {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Buffer.alloc(bytes));
    state.files = undefined;
    return file;
  };

  const has = (admission: SourceAdmissionSnapshotV1, videoId: string) =>
    hasAdequateExistingLocalCopy(
      { ownerUserId: OWNER_ID, type, videoId, sourceAdmission: admission },
      {
        users: () => state.users,
        libraries: () => state.libraries,
        libraryFiles: files,
        libraryUnits: units,
        qualifiedMeta: () => state.records,
        mayDownloadToLibrary: (user) => user.role === "admin" || user.permissions.downloadToLibrary,
        probe: async (file) => {
          probeCalls.push(file);
          return state.probeInfo;
        },
      },
    );
  const find = (admission: SourceAdmissionSnapshotV1, videoId: string) =>
    findAdequateExistingLocalCopy(
      { ownerUserId: OWNER_ID, type, videoId, sourceAdmission: admission },
      {
        users: () => state.users,
        libraries: () => state.libraries,
        libraryFiles: files,
        libraryUnits: units,
        qualifiedMeta: () => state.records,
        mayDownloadToLibrary: (user) => user.role === "admin" || user.permissions.downloadToLibrary,
        probe: async (file) => {
          probeCalls.push(file);
          return state.probeInfo;
        },
      },
    );

  return {
    root,
    state,
    probeCalls,
    write,
    has,
    find,
    scan,
    file: (relative: string) => path.join(root, relative),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

const bindSeries = (harness: Awaited<ReturnType<typeof setup>>, id = "tt1") => {
  harness.state.records[libraryPath(LIBRARY_ID, "Show")] = { type: "series", id, source: "user" };
};

const bindMovie = (harness: Awaited<ReturnType<typeof setup>>, id = "tt1") => {
  harness.state.records[libraryPath(LIBRARY_ID, "Film")] = { type: "movie", id, source: "user" };
};

test("an exact episode in an HTTP-only profile scope is adequate without probing when the policy is any", async () => {
  const harness = await setup("series");
  try {
    await harness.write("Show/S01E01.mkv");
    bindSeries(harness);
    assert.equal(await harness.has(snapshot({ existingLocalCopy: "any" }), "tt1:1:1"), true);
    assert.deepEqual(harness.probeCalls, []);
  } finally {
    await harness.cleanup();
  }
});

test("an adequate local copy returns its qualified key, library and actual size", async () => {
  const harness = await setup("series");
  try {
    await harness.write("Show/S01E01.mkv", 1234);
    bindSeries(harness);
    assert.deepEqual(await harness.find(snapshot({ existingLocalCopy: "any" }), "tt1:1:1"), {
      key: libraryPath(LIBRARY_ID, "Show/S01E01.mkv"),
      libraryId: LIBRARY_ID,
      actualSize: 1234,
    });
    assert.deepEqual(harness.probeCalls, []);
  } finally {
    await harness.cleanup();
  }
});

test("a different episode is not accepted", async () => {
  const harness = await setup("series");
  try {
    await harness.write("Show/S01E01.mkv");
    bindSeries(harness);
    assert.equal(await harness.has(snapshot({ height: 480 }), "tt1:1:2"), false);
    assert.deepEqual(harness.probeCalls, []);
  } finally {
    await harness.cleanup();
  }
});

test("480p and higher satisfy the height requirement while a smaller file does not", async () => {
  const harness = await setup("series");
  try {
    await harness.write("Show/S01E01.mkv");
    bindSeries(harness);
    harness.state.probeInfo = videoInfo({ height: 480 });
    assert.equal(await harness.has(snapshot({ height: 480 }), "tt1:1:1"), true);
    harness.state.probeInfo = videoInfo({ height: 239 });
    assert.equal(await harness.has(snapshot({ height: 480 }), "tt1:1:1"), false);
  } finally {
    await harness.cleanup();
  }
});

test("strict audio requirements use probed track languages", async () => {
  const harness = await setup("series");
  try {
    await harness.write("Show/S01E01.mkv");
    bindSeries(harness);
    harness.state.probeInfo = videoInfo({ audio: ["cs"] });
    assert.equal(await harness.has(snapshot({ audioMode: "strict", audio: "en" }), "tt1:1:1"), false);
    harness.state.probeInfo = videoInfo({ audio: ["cs", "en"] });
    assert.equal(await harness.has(snapshot({ audioMode: "strict", audio: "en" }), "tt1:1:1"), true);
  } finally {
    await harness.cleanup();
  }
});

test("required subtitles accept embedded or supported adjacent tracks and reject their absence", async () => {
  const harness = await setup("series");
  try {
    await harness.write("Show/S01E01.mkv");
    bindSeries(harness);
    harness.state.probeInfo = videoInfo({ subtitles: ["cs"] });
    assert.equal(await harness.has(snapshot({ subtitleMode: "required", subtitle: "cs" }), "tt1:1:1"), true);

    harness.state.probeInfo = videoInfo();
    await harness.write("Show/S01E01.cs.srt", 20);
    assert.equal(await harness.has(snapshot({ subtitleMode: "required", subtitle: "cs" }), "tt1:1:1"), true);

    await unlink(harness.file("Show/S01E01.cs.srt"));
    assert.equal(await harness.has(snapshot({ subtitleMode: "required", subtitle: "cs" }), "tt1:1:1"), false);
  } finally {
    await harness.cleanup();
  }
});

test("a required sidecar is checked as a file again after the video revalidation", async () => {
  const harness = await setup("series");
  try {
    await harness.write("Show/S01E01.mkv");
    const sidecar = await harness.write("Show/S01E01.cs.srt", 20);
    bindSeries(harness);
    const firstAnswer = deferred();
    const finalReadEntered = deferred();
    const releaseFinalRead = deferred();
    let reads = 0;
    let probes = 0;
    const result = findAdequateExistingLocalCopy(
      {
        ownerUserId: OWNER_ID,
        type: "series",
        videoId: "tt1:1:1",
        sourceAdmission: snapshot({ subtitleMode: "required", subtitle: "cs" }),
      },
      {
        users: () => harness.state.users,
        libraries: () => harness.state.libraries,
        libraryFiles: async () => harness.state.files ??= await harness.scan(),
        libraryUnits: async () => titleUnits(await (harness.state.files ??= await harness.scan()), "series"),
        qualifiedMeta: () => harness.state.records,
        mayDownloadToLibrary: (user) => user.role === "admin" || user.permissions.downloadToLibrary,
        probe: async () => {
          probes += 1;
          return videoInfo();
        },
        subtitleSidecars: async () => {
          reads += 1;
          if (reads === 1) firstAnswer.release();
          if (reads === 2) {
            finalReadEntered.release();
            await releaseFinalRead.promise;
          }
          return { stem: "S01E01", names: ["S01E01.cs.srt"] };
        },
      },
    );

    await firstAnswer.promise;
    await finalReadEntered.promise;
    await unlink(sidecar);
    releaseFinalRead.release();

    assert.equal(await result, undefined);
    assert.equal(probes, 1);
  } finally {
    await harness.cleanup();
  }
});

test("failed probes and unknown required facts do not establish adequacy", async () => {
  const harness = await setup("series");
  try {
    await harness.write("Show/S01E01.mkv");
    bindSeries(harness);
    harness.state.probeInfo = undefined;
    assert.equal(await harness.has(snapshot({ height: 480 }), "tt1:1:1"), false);

    harness.state.probeInfo = videoInfo();
    harness.state.probeInfo.video = { codec: "h264", width: 1_920 };
    assert.equal(await harness.has(snapshot({ height: 480 }), "tt1:1:1"), false);
  } finally {
    await harness.cleanup();
  }
});

test("hidden libraries, metadata without a local file, and deleted files are not adequate", async () => {
  const hidden = await setup();
  try {
    await hidden.write("Film/Film.mkv");
    bindMovie(hidden);
    hidden.state.libraries = [{ ...hidden.state.libraries[0]!, visibleTo: [] }];
    assert.equal(await hidden.has(snapshot({ existingLocalCopy: "any" }), "tt1"), false);
    assert.deepEqual(hidden.probeCalls, []);
  } finally {
    await hidden.cleanup();
  }

  const remoteOnly = await setup();
  try {
    bindMovie(remoteOnly);
    remoteOnly.state.files = [];
    assert.equal(await remoteOnly.has(snapshot({ existingLocalCopy: "any" }), "tt1"), false);
  } finally {
    await remoteOnly.cleanup();
  }

  const deleted = await setup();
  try {
    const file = await deleted.write("Film/Film.mkv");
    bindMovie(deleted);
    deleted.state.files = await deleted.scan();
    await unlink(file);
    assert.equal(await deleted.has(snapshot({ existingLocalCopy: "any" }), "tt1"), false);
  } finally {
    await deleted.cleanup();
  }
});

test("a symlink that resolves outside its library is refused", async () => {
  const harness = await setup();
  const outside = await mkdtemp(path.join(os.tmpdir(), "local-copy-outside-"));
  try {
    const outsideFile = path.join(outside, "Film.mkv");
    await writeFile(outsideFile, Buffer.alloc(100));
    await mkdir(harness.file("Film"), { recursive: true });
    await symlink(outsideFile, harness.file("Film/Film.mkv"));
    bindMovie(harness);
    harness.state.files = await harness.scan();
    harness.state.files = [{
      relative: libraryPath(LIBRARY_ID, "Film/Film.mkv"),
      size: 100,
      modified: "2026-01-01T00:00:00.000Z",
    }];
    assert.equal(await harness.has(snapshot({ existingLocalCopy: "any" }), "tt1"), false);
  } finally {
    await harness.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test("revocation or deletion during a deferred probe prevents a skip", async () => {
  const revoked = await setup("series");
  try {
    await revoked.write("Show/S01E01.mkv");
    bindSeries(revoked);
    const entered = deferred();
    const release = deferred();
    let probing = false;
    const validSnapshot = snapshot({ height: 480 });
    const result = findAdequateExistingLocalCopy(
      { ownerUserId: OWNER_ID, type: "series", videoId: "tt1:1:1", sourceAdmission: validSnapshot },
      {
        users: () => revoked.state.users,
        libraries: () => revoked.state.libraries,
        libraryFiles: async () => revoked.state.files ??= await revoked.scan(),
        libraryUnits: async () => titleUnits(await (revoked.state.files ??= await revoked.scan()), "series"),
        qualifiedMeta: () => revoked.state.records,
        mayDownloadToLibrary: (user) => user.role === "admin" || user.permissions.downloadToLibrary,
        probe: async () => {
          probing = true;
          entered.release();
          await release.promise;
          return videoInfo({ height: 1_080 });
        },
      },
    );
    while (!probing) await new Promise((resolve) => setTimeout(resolve, 5));
    revoked.state.users[0]!.disabled = true;
    release.release();
    assert.equal(await result, undefined);
  } finally {
    await revoked.cleanup();
  }

  const deleted = await setup("series");
  try {
    const file = await deleted.write("Show/S01E01.mkv");
    bindSeries(deleted);
    const entered = deferred();
    const release = deferred();
    let probing = false;
    const result = hasAdequateExistingLocalCopy(
      { ownerUserId: OWNER_ID, type: "series", videoId: "tt1:1:1", sourceAdmission: snapshot({ height: 480 }) },
      {
        users: () => deleted.state.users,
        libraries: () => deleted.state.libraries,
        libraryFiles: async () => deleted.state.files ??= await deleted.scan(),
        libraryUnits: async () => titleUnits(await (deleted.state.files ??= await deleted.scan()), "series"),
        qualifiedMeta: () => deleted.state.records,
        mayDownloadToLibrary: (user) => user.role === "admin" || user.permissions.downloadToLibrary,
        probe: async () => {
          probing = true;
          entered.release();
          await release.promise;
          return videoInfo({ height: 1_080 });
        },
      },
    );
    while (!probing) await new Promise((resolve) => setTimeout(resolve, 5));
    await unlink(file);
    release.release();
    assert.equal(await result, false);
  } finally {
    await deleted.cleanup();
  }
});

test("a same-size replacement during a deferred probe is not adequate", async () => {
  const harness = await setup("series");
  const release = deferred();
  try {
    const file = await harness.write("Show/S01E01.mkv");
    bindSeries(harness);
    let probing = false;
    const result = findAdequateExistingLocalCopy(
      { ownerUserId: OWNER_ID, type: "series", videoId: "tt1:1:1", sourceAdmission: snapshot({ height: 480 }) },
      {
        users: () => harness.state.users,
        libraries: () => harness.state.libraries,
        libraryFiles: async () => harness.state.files ??= await harness.scan(),
        libraryUnits: async () => titleUnits(await (harness.state.files ??= await harness.scan()), "series"),
        qualifiedMeta: () => harness.state.records,
        mayDownloadToLibrary: (user) => user.role === "admin" || user.permissions.downloadToLibrary,
        probe: async () => {
          probing = true;
          await release.promise;
          return videoInfo({ height: 1_080 });
        },
      },
    );
    const originalStat = await stat(file);
    while (!probing) await new Promise((resolve) => setTimeout(resolve, 5));
    await rename(file, `${file}.original`);
    await writeFile(file, Buffer.alloc(originalStat.size));
    const replacementStat = await stat(file);
    assert.notEqual(replacementStat.ino, originalStat.ino);
    release.release();
    assert.equal(await result, undefined);
  } finally {
    release.release();
    await harness.cleanup();
  }
});

test("candidate admission stays at 20 files and probing stays at 15", async () => {
  const capped = await setup();
  try {
    const files: FoundFile[] = [];
    for (let index = 0; index < 21; index += 1) {
      const relative = `Film/copy-${String(index).padStart(2, "0")}.mkv`;
      const file = await capped.write(relative, 100 - index);
      files.push({
        relative: libraryPath(LIBRARY_ID, relative),
        size: 100 - index,
        modified: "2026-01-01T00:00:00.000Z",
      });
      if (index < 20) await unlink(file);
    }
    bindMovie(capped);
    capped.state.files = files;
    assert.equal(await capped.has(snapshot({ existingLocalCopy: "any" }), "tt1"), false);
    assert.deepEqual(capped.probeCalls, []);
  } finally {
    await capped.cleanup();
  }

  const probed = await setup();
  try {
    for (let index = 0; index < 20; index += 1) {
      await probed.write(`Film/copy-${String(index).padStart(2, "0")}.mkv`, 100 - index);
    }
    bindMovie(probed);
    probed.state.probeInfo = videoInfo({ height: 240 });
    assert.equal(await probed.has(snapshot({ height: 480 }), "tt1"), false);
    assert.equal(probed.probeCalls.length, 15);
  } finally {
    await probed.cleanup();
  }
});
