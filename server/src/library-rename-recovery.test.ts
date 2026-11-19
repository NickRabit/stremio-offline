import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ART_VARIANTS, artVariantKey } from "./artwork.js";
import { ArtworkCache } from "./artwork-cache.js";
import { captureTransferIdentity } from "./library-recovery.js";
import { spawnServer, type SpawnedServer } from "./test-server.js";

const USERNAME = "recoverer";
const PASSWORD = "recover-password";
const SECOND_USERNAME = "viewer";
const SECOND_PASSWORD = "viewer-password";
const PARENT = "Films";
const SOURCE = `${PARENT}/Heat.mkv`;
const TARGET = `${PARENT}/Thief.mkv`;
const SUBTITLE = `${PARENT}/Heat.en.srt`;
const TARGET_SUBTITLE = `${PARENT}/Thief.en.srt`;

interface Env {
  workDir: string;
  dataDir: string;
  root: string;
  server?: SpawnedServer;
  base: string;
  adminCookie: string;
  userCookie: string;
  libraryId: string;
  adminId: string;
  userId: string;
}

const api = (env: Env, pathname: string, init: { method?: string; body?: unknown; cookie?: string } = {}) =>
  fetch(`${env.base}${pathname}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.cookie ? { cookie: init.cookie } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

const exists = async (file: string) => Boolean(await stat(file).catch(() => undefined));

const newEnv = async (): Promise<Env> => {
  const workDir = await mkdtemp(path.join(tmpdir(), "stremio-rename-recovery-"));
  const dataDir = path.join(workDir, "data");
  const root = path.join(workDir, "library");
  await mkdir(dataDir, { recursive: true });
  await mkdir(path.join(root, PARENT), { recursive: true });
  await writeFile(path.join(dataDir, "state.json"), JSON.stringify({ addons: [], defaultsInstalled: true }, null, 2));
  await writeFile(path.join(root, SOURCE), "original video");
  await writeFile(path.join(root, SUBTITLE), "original subtitle");
  return { workDir, dataDir, root, base: "", adminCookie: "", userCookie: "", libraryId: "", adminId: "", userId: "" };
};

const spawn = async (env: Env) => {
  env.server = await spawnServer({
    DATA_DIR: env.dataDir,
    DOWNLOAD_DIR: path.join(env.workDir, "downloads"),
    LIBRARY_ROOTS: env.root,
    LIBRARY_AUTO_SCAN: "0",
    ADDON_AUTO_REFRESH: "0",
  });
  env.base = env.server.base;
};

const login = async (env: Env, username: string, password: string): Promise<string> => {
  const response = await api(env, "/api/auth/login", { method: "POST", body: { username, password, remember: false } });
  assert.equal(response.status, 200, `could not sign in as ${username}\n${env.server?.log()}`);
  return response.headers.getSetCookie()[0]!.split(";")[0]!;
};

const bootFresh = async (env: Env) => {
  await spawn(env);
  const setup = await api(env, "/api/auth/setup", { method: "POST", body: { username: USERNAME, password: PASSWORD } });
  assert.equal(setup.status, 201, `could not create the administrator\n${env.server!.log()}`);
  env.adminCookie = setup.headers.getSetCookie()[0]!.split(";")[0]!;
  const library = await api(env, "/api/libraries", {
    method: "POST",
    cookie: env.adminCookie,
    body: { name: "Films", type: "mixed", root: env.root },
  });
  assert.equal(library.status, 201, `could not create the library\n${env.server!.log()}`);
  env.libraryId = (await library.json() as { id: string }).id;
  const users = await (await api(env, "/api/users", { cookie: env.adminCookie })).json() as Array<{ id: string; role: string }>;
  env.adminId = users.find((user) => user.role === "admin")!.id;
};

const bootAgain = async (env: Env) => {
  await spawn(env);
  env.adminCookie = await login(env, USERNAME, PASSWORD);
};

const addViewer = async (env: Env) => {
  const created = await api(env, "/api/users", {
    method: "POST",
    cookie: env.adminCookie,
    body: { username: SECOND_USERNAME, password: SECOND_PASSWORD, role: "user" },
  });
  assert.equal(created.status, 201, `could not create the viewer\n${env.server!.log()}`);
  env.userId = (await created.json() as { id: string }).id;
  const granted = await api(env, `/api/libraries/${env.libraryId}`, {
    method: "PATCH",
    cookie: env.adminCookie,
    body: { visibleTo: [env.userId] },
  });
  assert.equal(granted.status, 200, `could not grant the library\n${env.server!.log()}`);
  env.userCookie = await login(env, SECOND_USERNAME, SECOND_PASSWORD);
};

const libraryKey = (env: Env, relative: string) => `${env.libraryId}/${relative}`;
const sourceKey = (env: Env) => libraryKey(env, SOURCE);
const targetKey = (env: Env) => libraryKey(env, TARGET);

const seedState = async (env: Env) => {
  for (const [cookie, position] of [[env.adminCookie, 123], [env.userCookie, 456]] as const) {
    if (!cookie) continue;
    assert.equal((await api(env, "/api/library/favorite", {
      method: "POST", cookie, body: { path: sourceKey(env), favorite: true },
    })).status, 200);
    assert.equal((await api(env, "/api/progress", {
      method: "POST",
      cookie,
      body: { key: `file:${sourceKey(env)}`, path: sourceKey(env), position, duration: 3600, title: "Heat", final: true },
    })).status, 204);
  }
  const matched = await api(env, "/api/library/match", {
    method: "POST",
    cookie: env.adminCookie,
    body: { path: sourceKey(env), type: "movie", id: "tt0113277", scope: "file" },
  });
  assert.equal(matched.status, 200, `the manual match was refused\n${env.server!.log()}`);
};

const artworkFile = (env: Env, key: string, place: "file" | "folder", variant: (typeof ART_VARIANTS)[number]) => {
  const cache = new ArtworkCache(path.join(env.dataDir, "artwork"));
  return cache.file(artVariantKey(place === "folder" ? `dir:${key}` : key, variant));
};

const seedArtwork = async (env: Env) => {
  const bytes = new Map<string, Buffer>();
  for (const variant of ["poster", "wide"] as const) {
    for (const place of ["file", "folder"] as const) {
      const file = artworkFile(env, sourceKey(env), place, variant);
      const picture = Buffer.from(`${place}-${variant}-original`);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, picture);
      bytes.set(`${place}:${variant}`, picture);
    }
  }
  return bytes;
};

const writeIntent = async (env: Env, intent: Record<string, unknown>, duplicate = false) => {
  const directory = path.join(env.dataDir, "library-rename-intents");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const data = JSON.stringify(intent, null, 2);
  await writeFile(path.join(directory, `rename-${String(intent.operationId)}.json`), data, { mode: 0o600 });
  if (duplicate) await writeFile(path.join(directory, "same-intent-copy.json"), data, { mode: 0o600 });
};

const storedRows = (env: Env, domain: string) => {
  const database = new DatabaseSync(path.join(env.dataDir, "application.sqlite"), { readOnly: true });
  try {
    return database.prepare("SELECT user_id, key, data FROM personal_rows WHERE domain = ? ORDER BY user_id, key")
      .all(domain) as Array<{ user_id: string; key: string; data: string }>;
  } finally {
    database.close();
  }
};

const withEnv = async (run: (env: Env) => Promise<void>) => {
  const env = await newEnv();
  try { await run(env); }
  finally {
    await env.server?.stop();
    await rm(env.workDir, { recursive: true, force: true });
  }
};

for (const boundary of ["before", "after"]) {
  test(`a crash ${boundary} renaming the video preserves the bindings on replay`, async (t) => {
    await withEnv(async (env) => {
      await bootFresh(env);
      await addViewer(env);
      await seedState(env);
      await t.waitFor(() => {
        const db = new DatabaseSync(path.join(env.dataDir, "application.sqlite"), { readOnly: true });
        try {
          const rows = db.prepare("SELECT data FROM library_meta WHERE library_id = ? AND kind = 'meta'").all(env.libraryId);
          assert.ok(rows.some(row => String(row.data).includes("tt0113277")));
        } finally {
          db.close();
        }
      }, { timeout: 30_000 });
      const pictures = await seedArtwork(env);
      const sourceIdentity = await captureTransferIdentity(path.join(env.root, SOURCE));
      const subtitleIdentity = await captureTransferIdentity(path.join(env.root, SUBTITLE));
      await env.server!.stop();

      if (boundary === "after") await rename(path.join(env.root, SOURCE), path.join(env.root, TARGET));
      const artwork = [];
      for (const variant of ["poster", "wide"] as const) {
        for (const place of ["file", "folder"] as const) {
          artwork.push({
            place,
            variant,
            sha256: createHash("sha256").update(pictures.get(`${place}:${variant}`)!).digest("hex"),
          });
        }
      }
      const intent = {
        version: 1,
        kind: "rename",
        operationId: "recover-rename-1",
        actorUserId: env.adminId,
        itemKind: "file",
        caseOnly: false,
        phase: "moving",
        from: sourceKey(env),
        to: targetKey(env),
        sourceIdentity,
        publishedIdentity: null,
        sidecars: [{
          from: "Heat.en.srt",
          to: "Thief.en.srt",
          sourceIdentity: subtitleIdentity,
          targetIdentity: null,
        }],
        artwork,
      };
      await writeIntent(env, intent, true);

      await bootAgain(env);
      assert.equal(await exists(path.join(env.root, SOURCE)), false);
      assert.equal(await readFile(path.join(env.root, TARGET), "utf8"), "original video");
      assert.equal(await exists(path.join(env.root, SUBTITLE)), false);
      assert.equal(await readFile(path.join(env.root, TARGET_SUBTITLE), "utf8"), "original subtitle");
      assert.equal(await exists(path.join(env.dataDir, "library-rename-intents", "rename-recover-rename-1.json")), false);
      assert.equal(await exists(path.join(env.dataDir, "library-rename-intents", "same-intent-copy.json")), false);

      for (const [variant, picture] of pictures) {
        const [place, shape] = variant.split(":") as ["file" | "folder", "poster" | "wide"];
        assert.deepEqual(await readFile(artworkFile(env, targetKey(env), place, shape)), picture);
      }

      const identity = await (await api(env, `/api/library/identity?path=${encodeURIComponent(targetKey(env))}`, {
        cookie: env.adminCookie,
      })).json() as { bound?: { id?: string } };
      assert.equal(identity.bound?.id, "tt0113277", "the manual match follows the item");

      for (const [cookie, position] of [[env.adminCookie, 123], [env.userCookie, 456]] as const) {
        const favorites = await (await api(env, "/api/library/favorites", { cookie })).json() as { items: Array<{ path: string }> };
        assert.ok(favorites.items.some((item) => item.path === targetKey(env)), "the favourite follows for every account");
        const progress = await (await api(env, `/api/progress/${encodeURIComponent(`file:${targetKey(env)}`)}`, { cookie })).json() as { position?: number };
        assert.equal(progress.position, position, "the exact resume position follows for every account");
      }

      assert.equal(storedRows(env, "progress").some((row) => row.key === `file:${sourceKey(env)}`), false);
      assert.equal(storedRows(env, "favorites").some((row) => row.data.includes(sourceKey(env))), false);

      // A restored journal can predate the bindings commit.
      await env.server!.stop();
      await writeIntent(env, intent);
      await bootAgain(env);
      assert.equal(await exists(path.join(env.dataDir, "library-rename-intents", "rename-recover-rename-1.json")), false);
      assert.deepEqual(storedRows(env, "progress").filter(row => row.key === `file:${targetKey(env)}`)
        .map(row => JSON.parse(row.data).position).sort(), [123, 456]);
      assert.equal(await readFile(path.join(env.root, TARGET), "utf8"), "original video");
      for (const [variant, picture] of pictures) {
        const [place, shape] = variant.split(":") as ["file" | "folder", "poster" | "wide"];
        assert.deepEqual(await readFile(artworkFile(env, targetKey(env), place, shape)), picture);
      }
    });
  });
}

test("a replaced target leaves data, artwork and the unresolved intent untouched", async () => {
  await withEnv(async (env) => {
    await bootFresh(env);
    await seedState(env);
    const pictures = await seedArtwork(env);
    const sourceIdentity = await captureTransferIdentity(path.join(env.root, SOURCE));
    const subtitleIdentity = await captureTransferIdentity(path.join(env.root, SUBTITLE));
    await env.server!.stop();

    await rename(path.join(env.root, SOURCE), path.join(env.root, TARGET));
    await rm(path.join(env.root, TARGET));
    await writeFile(path.join(env.root, TARGET), "replacement");
    const intent = {
      version: 1,
      kind: "rename",
      operationId: "recover-replaced-target",
      actorUserId: env.adminId,
      itemKind: "file",
      caseOnly: false,
      phase: "moving",
      from: sourceKey(env),
      to: targetKey(env),
      sourceIdentity,
      publishedIdentity: null,
      sidecars: [{
        from: "Heat.en.srt",
        to: "Thief.en.srt",
        sourceIdentity: subtitleIdentity,
        targetIdentity: null,
      }],
      artwork: [],
    };
    await writeIntent(env, intent);

    await bootAgain(env);
    assert.equal(await readFile(path.join(env.root, TARGET), "utf8"), "replacement");
    assert.equal(await readFile(path.join(env.root, SUBTITLE), "utf8"), "original subtitle");
    assert.equal(await exists(path.join(env.root, TARGET_SUBTITLE)), false);
    for (const [variant, picture] of pictures) {
      const [place, shape] = variant.split(":") as ["file" | "folder", "poster" | "wide"];
      assert.deepEqual(await readFile(artworkFile(env, sourceKey(env), place, shape)), picture);
      assert.equal(await exists(artworkFile(env, targetKey(env), place, shape)), false);
    }
    assert.equal(await exists(path.join(env.dataDir, "library-rename-intents", "rename-recover-replaced-target.json")), true);
    assert.ok(storedRows(env, "favorites").some((row) => row.data.includes(sourceKey(env))));
    assert.ok(storedRows(env, "progress").some((row) =>
      row.key === `file:${sourceKey(env)}` && JSON.parse(row.data).position === 123));

    const blocked = await api(env, "/api/library/rename", {
      method: "POST",
      cookie: env.adminCookie,
      body: { path: targetKey(env), name: "Other.mkv" },
    });
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json() as { messageKey?: string }).messageKey, "err.pathBusy");
    assert.equal(await readFile(path.join(env.root, TARGET), "utf8"), "replacement");
  });
});

test("distinct artwork at the destination is preserved and keeps the rename unresolved", async () => {
  await withEnv(async (env) => {
    await bootFresh(env);
    await seedState(env);
    const pictures = await seedArtwork(env);
    const sourceIdentity = await captureTransferIdentity(path.join(env.root, SOURCE));
    const subtitleIdentity = await captureTransferIdentity(path.join(env.root, SUBTITLE));
    await env.server!.stop();

    await rename(path.join(env.root, SOURCE), path.join(env.root, TARGET));
    const destinationPoster = Buffer.from("destination artwork");
    const destinationFile = artworkFile(env, targetKey(env), "file", "poster");
    await writeFile(destinationFile, destinationPoster);
    const artwork = [];
    for (const variant of ["poster", "wide"] as const) {
      for (const place of ["file", "folder"] as const) {
        artwork.push({
          place,
          variant,
          sha256: createHash("sha256").update(pictures.get(`${place}:${variant}`)!).digest("hex"),
        });
      }
    }
    await writeIntent(env, {
      version: 1,
      kind: "rename",
      operationId: "recover-artwork-collision",
      actorUserId: env.adminId,
      itemKind: "file",
      caseOnly: false,
      phase: "moving",
      from: sourceKey(env),
      to: targetKey(env),
      sourceIdentity,
      publishedIdentity: null,
      sidecars: [{
        from: "Heat.en.srt",
        to: "Thief.en.srt",
        sourceIdentity: subtitleIdentity,
        targetIdentity: null,
      }],
      artwork,
    });

    await bootAgain(env);
    assert.equal(await readFile(path.join(env.root, TARGET), "utf8"), "original video");
    assert.deepEqual(await readFile(destinationFile), destinationPoster, "the destination picture is not overwritten");
    for (const [variant, picture] of pictures) {
      const [place, shape] = variant.split(":") as ["file" | "folder", "poster" | "wide"];
      assert.deepEqual(await readFile(artworkFile(env, sourceKey(env), place, shape)), picture, "the source picture is retained");
    }
    assert.equal(await exists(path.join(env.root, SUBTITLE)), true, "metadata work stops before the subtitle is moved");
    assert.equal(await exists(path.join(env.root, TARGET_SUBTITLE)), false);
    assert.ok(storedRows(env, "favorites").some((row) => row.data.includes(sourceKey(env))));
    assert.equal(await exists(path.join(env.dataDir, "library-rename-intents", "rename-recover-artwork-collision.json")), true);
  });
});

test("a folder rename preserves nested artwork and refuses a different destination poster", async () => {
  await withEnv(async env => {
    await bootFresh(env);
    const pictures = await seedArtwork(env);
    const key = libraryKey(env, "Archive/Heat.mkv");
    const destination = artworkFile(env, key, "file", "poster");
    await writeFile(destination, "different poster");
    const request = () => api(env, "/api/library/rename", {
      method: "POST", cookie: env.adminCookie, body: { path: libraryKey(env, PARENT), name: "Archive" },
    });
    assert.equal((await request()).status, 409);
    assert.equal(await readFile(destination, "utf8"), "different poster");
    assert.equal(await readFile(path.join(env.root, SOURCE), "utf8"), "original video");
    assert.deepEqual(await readFile(artworkFile(env, sourceKey(env), "file", "poster")), pictures.get("file:poster"));

    await rm(destination);
    assert.equal((await request()).status, 200);
    for (const [variant, picture] of pictures) {
      const [place, shape] = variant.split(":") as ["file" | "folder", "poster" | "wide"];
      assert.deepEqual(await readFile(artworkFile(env, key, place, shape)), picture);
    }
    assert.equal(await readFile(path.join(env.root, "Archive/Heat.en.srt"), "utf8"), "original subtitle");
  });
});

test("a case-only rename writes the requested spelling and keeps the item identity", async () => {
  await withEnv(async (env) => {
    await bootFresh(env);
    await seedState(env);
    const before = await captureTransferIdentity(path.join(env.root, SOURCE));
    const response = await api(env, "/api/library/rename", {
      method: "POST",
      cookie: env.adminCookie,
      body: { path: sourceKey(env), name: "heat" },
    });
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    assert.deepEqual(await (await response.json() as { path: string }), { path: libraryKey(env, `${PARENT}/heat.mkv`) });
    const names = await (await import("node:fs/promises")).readdir(path.join(env.root, PARENT));
    assert.ok(names.includes("heat.mkv"), "the directory entry keeps the requested spelling");
    assert.ok(!names.includes("Heat.mkv"), "the old spelling is gone");
    assert.equal(await captureTransferIdentity(path.join(env.root, PARENT, "heat.mkv")), before);
  });
});
