import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_PROFILE_NAME,
  addProfile,
  normalizeProfileName,
  normalizeProfileOrigin,
  readProfiles,
  removeProfile,
  selectProfile,
  updateProfile,
  writeProfiles,
  type ProfileStore,
} from "./connection-file.js";

const withDir = async (body: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stremio-desktop-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const storeOf = (...profiles: ProfileStore["profiles"]) =>
  ({ profiles, selectedProfileId: profiles.at(-1)?.id ?? null }) satisfies ProfileStore;

const fileOf = (dir: string) => path.join(dir, "connection.json");

test("a profile store that was written is read back", async () => {
  await withDir(async (dir) => {
    const store = storeOf({ id: "a", name: "Living room", origin: "http://192.168.1.20:8090" });
    await writeProfiles(dir, store);
    assert.deepEqual(await readProfiles(dir), store);
    assert.deepEqual(await readdir(dir), ["connection.json"]);
  });
});

test("a missing file has no profiles", async () => {
  await withDir(async (dir) => {
    assert.deepEqual(await readProfiles(dir), { profiles: [], selectedProfileId: null });
  });
});

test("a legacy single origin migrates to one named profile", async () => {
  await withDir(async (dir) => {
    await writeFile(fileOf(dir), JSON.stringify({ origin: "HTTP://192.168.1.20:8090/" }), "utf8");
    const store = await readProfiles(dir);
    assert.equal(store.profiles.length, 1);
    assert.equal(store.profiles[0].name, "Server");
    assert.equal(store.profiles[0].origin, "http://192.168.1.20:8090");
    assert.equal(store.selectedProfileId, store.profiles[0].id);
  });
});

test("the selected profile survives a restart on its own", async () => {
  await withDir(async (dir) => {
    const store: ProfileStore = {
      profiles: [
        { id: "a", name: "Attic", origin: "https://attic.example" },
        { id: "b", name: "Basement", origin: "https://basement.example" },
      ],
      selectedProfileId: "b",
    };
    await writeProfiles(dir, store);
    assert.deepEqual(await readProfiles(dir), store);
    const switched = selectProfile(store, "a");
    assert.ok(switched);
    await writeProfiles(dir, switched);
    assert.equal((await readProfiles(dir)).selectedProfileId, "a");
  });
});

test("an edit keeps the profile id and a create selects the new profile", async () => {
  await withDir(async (dir) => {
    const created = addProfile({ profiles: [], selectedProfileId: null }, "a", { name: "Old", origin: "http://192.168.1.20:8090" });
    assert.ok(created);
    assert.equal(created.selectedProfileId, "a");

    const edited = updateProfile(created, "a", { name: "New", origin: "https://nas.example" });
    assert.ok(edited);
    assert.deepEqual(edited.profiles, [{ id: "a", name: "New", origin: "https://nas.example" }]);
    assert.equal(edited.selectedProfileId, "a");
    await writeProfiles(dir, edited);
    assert.deepEqual(await readProfiles(dir), edited);
  });
});

test("deleting the selected profile clears the selection", () => {
  const store: ProfileStore = {
    profiles: [
      { id: "a", name: "Attic", origin: "https://attic.example" },
      { id: "b", name: "Basement", origin: "https://basement.example" },
    ],
    selectedProfileId: "a",
  };
  assert.deepEqual(removeProfile(store, "a"), { profiles: [store.profiles[1]], selectedProfileId: null });
  assert.deepEqual(removeProfile(store, "b"), { profiles: [store.profiles[0]], selectedProfileId: "a" });
  assert.deepEqual(removeProfile(store, "missing"), store);
});

test("an invalid name or origin is refused", () => {
  assert.equal(normalizeProfileName("  Living room  "), "Living room");
  assert.equal(normalizeProfileName(""), null);
  assert.equal(normalizeProfileName("   "), null);
  assert.equal(normalizeProfileName("x".repeat(MAX_PROFILE_NAME + 1)), null);
  assert.equal(normalizeProfileName("x".repeat(MAX_PROFILE_NAME)), "x".repeat(MAX_PROFILE_NAME));
  assert.equal(normalizeProfileName(42), null);

  assert.equal(normalizeProfileOrigin("http://192.168.1.20:8090/"), "http://192.168.1.20:8090");
  assert.equal(normalizeProfileOrigin("https://nas.example"), "https://nas.example");
  const rejected = ["", "not a url", "ftp://192.168.1.20", "http://user:pass@192.168.1.20:8090", "http://192.168.1.20:8090/library", "http://192.168.1.20:8090?x=1", "http://8.8.8.8", "http://nas.example", 17];
  for (const value of rejected) assert.equal(normalizeProfileOrigin(value), null, JSON.stringify(value));

  const store: ProfileStore = { profiles: [{ id: "a", name: "Attic", origin: "https://attic.example" }], selectedProfileId: "a" };
  assert.equal(addProfile(store, "b", { name: "", origin: "https://attic.example" }), null);
  assert.equal(addProfile(store, "b", { name: "Basement", origin: "http://8.8.8.8" }), null);
  assert.equal(addProfile(store, "a", { name: "Basement", origin: "https://basement.example" }), null);
  assert.equal(updateProfile(store, "a", { name: "Attic", origin: "http://user:pass@nas.example" }), null);
  assert.equal(updateProfile(store, "missing", { name: "Attic", origin: "https://attic.example" }), null);
  assert.deepEqual(store.profiles, [{ id: "a", name: "Attic", origin: "https://attic.example" }]);
});

test("selecting an unknown profile changes nothing", () => {
  const store: ProfileStore = { profiles: [{ id: "a", name: "Attic", origin: "https://attic.example" }], selectedProfileId: "a" };
  assert.equal(selectProfile(store, "missing"), null);
  assert.deepEqual(selectProfile(store, "a"), store);
  assert.deepEqual(selectProfile(store, null), { profiles: store.profiles, selectedProfileId: null });
});

test("a corrupt or unsupported file recovers to an empty list", async () => {
  await withDir(async (dir) => {
    const bodies = [
      "not json",
      JSON.stringify({ origin: 5 }),
      JSON.stringify({ profiles: "x" }),
      JSON.stringify({ profiles: [{ id: 1, name: "x", origin: "https://a.example" }] }),
      JSON.stringify([1, 2]),
      JSON.stringify(null),
      JSON.stringify("text"),
      "",
    ];
    for (const body of bodies) {
      await writeFile(fileOf(dir), body, "utf8");
      assert.deepEqual(await readProfiles(dir), { profiles: [], selectedProfileId: null }, body);
    }
  });
});

test("entries that do not validate are dropped and a dangling selection clears", async () => {
  await withDir(async (dir) => {
    const body = {
      profiles: [
        { id: "keep", name: " Keep ", origin: "https://nas.example/" },
        { id: "dup", name: "First", origin: "https://first.example" },
        { id: "dup", name: "Second", origin: "https://second.example" },
        { id: "bad-origin", name: "Bad", origin: "http://user:pass@nas.example" },
        { id: "", name: "No id", origin: "https://nas.example" },
        { id: "bad-name", name: "  ", origin: "https://nas.example" },
      ],
      selectedProfileId: "drop-origin",
      token: "secret",
      password: "secret",
    };
    await writeFile(fileOf(dir), JSON.stringify(body), "utf8");
    const store = await readProfiles(dir);
    assert.deepEqual(store.profiles, [
      { id: "keep", name: "Keep", origin: "https://nas.example" },
      { id: "dup", name: "First", origin: "https://first.example" },
    ]);
    assert.equal(store.selectedProfileId, null);
  });
});

test("the written file carries only the profile fields", async () => {
  await withDir(async (dir) => {
    await writeProfiles(dir, storeOf({ id: "a", name: "Attic", origin: "https://attic.example" }));
    const raw = await readFile(fileOf(dir), "utf8");
    for (const field of ["password", "token", "cookie"]) assert.equal(raw.includes(field), false, field);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed), ["profiles", "selectedProfileId"]);
    assert.deepEqual(Object.keys((parsed.profiles as object[])[0]), ["id", "name", "origin"]);
  });
});

test("writes reject invalid profiles and dangling selections", async () => {
  await withDir(async (dir) => {
    const file = fileOf(dir);
    const valid = storeOf({ id: "a", name: "Attic", origin: "https://attic.example" });
    await writeProfiles(dir, valid);
    const before = await readFile(file, "utf8");
    await assert.rejects(writeProfiles(dir, { profiles: [{ id: "a", name: " ", origin: "https://attic.example" }], selectedProfileId: null }));
    await assert.rejects(writeProfiles(dir, { ...valid, selectedProfileId: "missing" }));
    assert.equal(await readFile(file, "utf8"), before);
  });
});

test("a read error other than a missing file is surfaced", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "not-a-directory");
    await writeFile(file, "", "utf8");
    await assert.rejects(readProfiles(file), { code: "ENOTDIR" });
  });
});
