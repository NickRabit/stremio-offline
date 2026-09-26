import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ServerProfile } from "./connection-file.js";
import type { ProbeFailure } from "./status.js";
import {
  MAX_TARGET_ID,
  LatestRequest,
  fallbackApplies,
  launchPlan,
  readStartupChoice,
  sameTarget,
  writeStartupChoice,
  type Target,
} from "./startup.js";

const withDir = async (body: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stremio-desktop-startup-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const fileOf = (dir: string) => path.join(dir, "startup.json");

const profileOf = (id: string): ServerProfile => ({ id, name: `Server ${id}`, origin: "http://192.168.1.20:8090" });

const store = async (dir: string, body: unknown) => {
  await writeFile(fileOf(dir), JSON.stringify(body), "utf8");
};

test("a chosen target survives a round trip", async () => {
  await withDir(async (dir) => {
    const targets: (Target | null)[] = [{ kind: "local" }, { kind: "profile", id: "p1" }, null];
    for (const target of targets) {
      await writeStartupChoice(dir, target);
      assert.deepEqual(await readStartupChoice(dir), target);
    }
    assert.deepEqual(await readdir(dir), ["startup.json"]);
  });
});

test("a missing file has no choice", async () => {
  await withDir(async (dir) => {
    assert.equal(await readStartupChoice(dir), null);
  });
});

test("a malformed or wrongly shaped file has no choice", async () => {
  await withDir(async (dir) => {
    const rejected: string[] = [
      "",
      "not json",
      "null",
      "[]",
      JSON.stringify({}),
      JSON.stringify({ target: "local" }),
      JSON.stringify({ target: { kind: "remote", id: "p1" } }),
      JSON.stringify({ target: { kind: "Local" } }),
      JSON.stringify({ target: { kind: "profile" } }),
      JSON.stringify({ target: { kind: "profile", id: "" } }),
      JSON.stringify({ target: { kind: "profile", id: 7 } }),
      JSON.stringify({ target: { kind: "profile", id: "x".repeat(MAX_TARGET_ID + 1) } }),
    ];
    for (const text of rejected) {
      await writeFile(fileOf(dir), text, "utf8");
      assert.equal(await readStartupChoice(dir), null, text);
    }
  });
});

test("a profile id at the length limit is kept", async () => {
  await withDir(async (dir) => {
    const id = "x".repeat(MAX_TARGET_ID);
    await store(dir, { target: { kind: "profile", id } });
    assert.deepEqual(await readStartupChoice(dir), { kind: "profile", id });
  });
});

test("the choice is written as a single newline-terminated line", async () => {
  await withDir(async (dir) => {
    await writeStartupChoice(dir, null);
    assert.equal(await readFile(fileOf(dir), "utf8"), '{"target":null}\n');
  });
});

test("launch opens the welcome screen when there is no choice", () => {
  assert.deepEqual(launchPlan(null, [profileOf("p1")]), { screen: "welcome" });
});

test("launch connects to the local backend", () => {
  assert.deepEqual(launchPlan({ kind: "local" }, []), { screen: "connect", target: { kind: "local" } });
});

test("launch connects to a profile that still exists", () => {
  const profiles = [profileOf("p1"), profileOf("p2")];
  assert.deepEqual(launchPlan({ kind: "profile", id: "p2" }, profiles), {
    screen: "connect",
    target: { kind: "profile", id: "p2" },
  });
});

test("launch of a deleted profile shows the welcome screen", () => {
  assert.deepEqual(launchPlan({ kind: "profile", id: "gone" }, [profileOf("p1")]), { screen: "welcome" });
  assert.deepEqual(launchPlan({ kind: "profile", id: "p1" }, []), { screen: "welcome" });
});

const failures: ProbeFailure[] = ["invalid", "insecure-transport", "unreachable", "not-status"];

test("a failed profile connection falls back only when nothing answered", () => {
  for (const reason of failures) {
    assert.equal(fallbackApplies({ kind: "profile", id: "p1" }, reason), reason === "unreachable", reason);
  }
});

test("a failed local connection never falls back", () => {
  for (const reason of failures) assert.equal(fallbackApplies({ kind: "local" }, reason), false, reason);
});

test("two targets are the same when kind and id match", () => {
  assert.equal(sameTarget(null, null), true);
  assert.equal(sameTarget({ kind: "local" }, { kind: "local" }), true);
  assert.equal(sameTarget({ kind: "profile", id: "p1" }, { kind: "profile", id: "p1" }), true);
  assert.equal(sameTarget({ kind: "profile", id: "p1" }, { kind: "profile", id: "p2" }), false);
  assert.equal(sameTarget({ kind: "local" }, { kind: "profile", id: "p1" }), false);
  assert.equal(sameTarget({ kind: "profile", id: "p1" }, { kind: "local" }), false);
  assert.equal(sameTarget(null, { kind: "local" }), false);
  assert.equal(sameTarget({ kind: "profile", id: "p1" }, null), false);
});

test("only the newest ticket is current", () => {
  const requests = new LatestRequest();
  const first = requests.next();
  assert.equal(requests.isCurrent(first), true);
  const second = requests.next();
  assert.equal(requests.isCurrent(first), false);
  assert.equal(requests.isCurrent(second), true);
  assert.equal(requests.isCurrent(9), false);
});
