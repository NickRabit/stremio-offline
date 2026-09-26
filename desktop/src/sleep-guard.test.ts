import assert from "node:assert/strict";
import test from "node:test";
import { SleepGuard, type SleepBlocker } from "./sleep-guard.js";

const fakeBlocker = () => {
  const running = new Set<number>();
  let next = 1;
  const calls: string[] = [];
  const blocker: SleepBlocker = {
    start(type) { calls.push(`start ${type}`); running.add(next); return next++; },
    stop(id) { calls.push(`stop ${id}`); running.delete(id); },
  };
  return { blocker, running, calls };
};

test("a shared backend that streams holds exactly one blocker", () => {
  const { blocker, running, calls } = fakeBlocker();
  const guard = new SleepGuard(blocker);
  guard.update({ published: true, streaming: true });
  guard.update({ published: true, streaming: true });
  assert.equal(running.size, 1);
  assert.deepEqual(calls, ["start prevent-app-suspension"]);
  assert.equal(guard.held, true);
});

test("the blocker goes when the stream ends, and comes back with the next one", () => {
  const { blocker, running } = fakeBlocker();
  const guard = new SleepGuard(blocker);
  guard.update({ published: true, streaming: true });
  guard.update({ published: true, streaming: false });
  assert.equal(running.size, 0);
  guard.update({ published: true, streaming: true });
  assert.equal(running.size, 1);
});

test("an unshared backend never keeps the Mac awake, even while it streams", () => {
  const { blocker, calls } = fakeBlocker();
  const guard = new SleepGuard(blocker);
  guard.update({ published: false, streaming: true });
  assert.deepEqual(calls, []);
  assert.equal(guard.held, false);
});

test("a stop, an exit or a quit releases it once, and a second release does nothing", () => {
  const { blocker, running, calls } = fakeBlocker();
  const guard = new SleepGuard(blocker);
  guard.update({ published: true, streaming: true });
  guard.release();
  guard.release();
  assert.equal(running.size, 0);
  assert.deepEqual(calls, ["start prevent-app-suspension", "stop 1"]);
});
