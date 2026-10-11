import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CLIENT_LOG_KEEP, ClientLogStore } from "./client-logs.js";

const oneLine = (message: string) => [{ t: "2026-01-01T00:00:00.000Z", level: "INFO", message }];

test("the store keeps the newest fifty bundles and drops the rest", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "client-logs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  const store = new ClientLogStore(dir, () => (clock += 1000));

  let oldest = "";
  let newest = "";
  for (let index = 0; index < CLIENT_LOG_KEEP + 3; index += 1) {
    const saved = await store.save({ user: "ada", client: "web", app: "1.2.3", device: "browser", lines: oneLine(`line ${index}`) });
    if (index === 0) oldest = saved.id;
    newest = saved.id;
  }

  const list = await store.list();
  assert.equal(list.length, CLIENT_LOG_KEEP);
  assert.equal(list[0]!.id, newest, "newest first");
  assert.equal(list.some((bundle) => bundle.id === oldest), false, "the oldest bundle was dropped");
  assert.equal(newest.startsWith(oldest), false);
});

test("a bundle id that could name another file is refused", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "client-logs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ClientLogStore(dir);
  assert.equal(await store.get("../../state"), undefined);
  assert.equal(await store.remove("../../state"), false);
});

test("a file in the bundle directory that is not a bundle is skipped", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "client-logs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ClientLogStore(dir);
  const saved = await store.save({ user: "ada", client: "web", app: "1.2.3", device: "browser", lines: oneLine("hello") });
  // A foreign file lands next to the bundles: a stray JSON object, one that carries the
  // wrong shape, and one that is not JSON at all. None of them may break the list.
  await writeFile(path.join(dir, "client-logs", "stray.json"), JSON.stringify({ note: "not a bundle" }));
  await writeFile(path.join(dir, "client-logs", "half.json"), JSON.stringify({ ...saved, lines: "no" }));
  await writeFile(path.join(dir, "client-logs", "broken.json"), "{ not json");

  const list = await store.list();
  assert.deepEqual(list.map((bundle) => bundle.id), [saved.id]);
});
