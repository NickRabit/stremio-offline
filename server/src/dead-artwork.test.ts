import assert from "node:assert/strict";
import test from "node:test";
import { DeadArtwork } from "./dead-artwork.js";

const meta = {
  id: "tt1",
  poster: "https://live.metahub.space/poster/small/tt1/img",
  background: "https://images.metahub.space/background/medium/tt1/img",
  logo: "https://live.metahub.space/logo/medium/tt1/img",
};

test("a metahub picture that answers 404 is dropped and the others stay", async () => {
  const dead = new DeadArtwork(async (url) => (url.includes("/poster/") ? 404 : 200));
  const pruned = await dead.prune(meta);
  assert.equal("poster" in pruned, false);
  assert.equal(pruned.background, meta.background);
  assert.equal(pruned.logo, meta.logo);
});

test("a timeout or a server error never strips artwork", async () => {
  assert.deepEqual(await new DeadArtwork(async () => undefined).prune(meta), meta);
  assert.deepEqual(await new DeadArtwork(async () => 503).prune(meta), meta);
});

test("another host is never probed and a verdict is remembered", async () => {
  let calls = 0;
  const dead = new DeadArtwork(async () => { calls += 1; return 404; });
  const other = { id: "tt2", poster: "https://m.media-amazon.com/x.jpg" };
  assert.deepEqual(await dead.prune(other), other);
  assert.equal(calls, 0);
  await dead.prune(meta);
  const after = calls;
  await dead.prune(meta);
  assert.equal(calls, after);
});
