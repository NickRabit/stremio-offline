import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ActivityLog, ACTIVITY_LIMIT } from "./activity.js";

test("activity retains bounded, separate user events, pages without duplicates and survives restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "activity-"));
  try {
    const log = new ActivityLog(dir);
    await log.load();
    for (let i = 0; i < ACTIVITY_LIMIT + 3; i++) log.record({ kind: "playback", title: "Same film", userId: i % 2 ? "ada" : "bob", username: i % 2 ? "Ada" : "Bob" });
    log.record({ kind: "device", title: "Saved.mkv", userId: "ada", username: "Ada", partial: true });
    const first = log.page(24);
    assert.equal(first.total, ACTIVITY_LIMIT);
    assert.equal(first.items.length, 50);
    log.record({ kind: "library", title: "New film", userId: "bob" });
    const second = log.page(24, "", "", first.next);
    assert.equal(second.items.length, 50);
    assert.ok(second.items.every((item) => item.id < first.next!));
    assert.equal(log.page(24, "device", "ada").items[0].partial, true);
    assert.equal(log.page(24, "device", "bob").total, 0);
    assert.deepEqual(new Set(first.users.map((user) => user.id)), new Set(["ada", "bob"]));
    await log.flush();
    const restored = new ActivityLog(dir);
    await restored.load();
    assert.deepEqual(restored.page(24), JSON.parse(JSON.stringify(log.page(24))));
    restored.record({ kind: "playback", title: "After restart" });
    assert.ok(restored.page(24).items[0].id > log.page(24).items[0].id);
    await restored.flush();
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test("the chosen period excludes older activity and keeps user options independent of kind", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "activity-period-"));
  try {
    await writeFile(path.join(dir, "activity.json"), JSON.stringify([
      { id: 1, at: new Date(Date.now() - 48 * 3600000).toISOString(), kind: "playback", title: "Old", userId: "old" },
      { id: 2, at: new Date().toISOString(), kind: "device", title: "New", userId: "ada", username: "Ada" },
    ]));
    const log = new ActivityLog(dir);
    await log.load();
    assert.equal(log.page(24).total, 1);
    assert.equal(log.page(168).total, 2);
    assert.equal(log.page(24, "playback").total, 0);
    assert.deepEqual(log.page(24, "playback").users, [{ id: "ada", username: "Ada" }]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
