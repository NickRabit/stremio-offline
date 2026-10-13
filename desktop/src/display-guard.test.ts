import assert from "node:assert/strict";
import test from "node:test";
import { attachDisplayGuard, DisplayGuard, type DisplayBlocker, type MediaEvents } from "./display-guard.js";

const fakeBlocker = () => {
  const running = new Set<number>();
  let next = 1;
  const calls: string[] = [];
  const blocker: DisplayBlocker = {
    start(type) { calls.push(`start ${type}`); running.add(next); return next++; },
    stop(id) { calls.push(`stop ${id}`); running.delete(id); },
  };
  return { blocker, running, calls };
};

type MediaEvent = "media-started-playing" | "media-paused" | "destroyed";

const fakeMedia = () => {
  const listeners = new Map<MediaEvent, Set<() => void>>();
  const source: MediaEvents = {
    on(event, listener) {
      const set = listeners.get(event) ?? new Set<() => void>();
      listeners.set(event, set);
      set.add(listener);
    },
    removeListener(event, listener) { listeners.get(event)?.delete(listener); },
  };
  const emit = (event: MediaEvent) => { for (const listener of [...(listeners.get(event) ?? [])]) listener(); };
  return { source, emit };
};

test("the first playing element starts one blocker and the second adds nothing", () => {
  const { blocker, running, calls } = fakeBlocker();
  const guard = new DisplayGuard(blocker);
  guard.started();
  assert.equal(running.size, 1);
  assert.deepEqual(calls, ["start prevent-display-sleep"]);
  guard.started();
  assert.equal(running.size, 1);
  assert.deepEqual(calls, ["start prevent-display-sleep"]);
  assert.equal(guard.held, true);
});

test("the blocker goes when the last element stops, and only then", () => {
  const { blocker, calls } = fakeBlocker();
  const guard = new DisplayGuard(blocker);
  guard.started();
  guard.started();
  guard.paused();
  assert.equal(guard.held, true);
  guard.paused();
  assert.equal(guard.held, false);
  guard.paused();
  assert.deepEqual(calls, ["start prevent-display-sleep", "stop 1"]);
});

test("reset drops the blocker, ignores a stray pause and starts again for the next film", () => {
  const { blocker, calls } = fakeBlocker();
  const guard = new DisplayGuard(blocker);
  guard.started();
  guard.started();
  guard.reset();
  assert.equal(guard.held, false);
  guard.paused();
  assert.deepEqual(calls, ["start prevent-display-sleep", "stop 1"]);
  guard.started();
  assert.equal(guard.held, true);
  assert.deepEqual(calls, ["start prevent-display-sleep", "stop 1", "start prevent-display-sleep"]);
});

test("release drops the OS assertion but leaves the count to the events", () => {
  const { blocker, calls } = fakeBlocker();
  const guard = new DisplayGuard(blocker);
  guard.started();
  guard.release();
  guard.paused();
  guard.started();
  assert.deepEqual(calls, ["start prevent-display-sleep", "stop 1", "start prevent-display-sleep"]);
  assert.equal(guard.held, true);
});

test("the guard follows media events on the page", () => {
  const { blocker, calls } = fakeBlocker();
  const guard = new DisplayGuard(blocker);
  const media = fakeMedia();
  attachDisplayGuard(media.source, guard);
  media.emit("media-started-playing");
  assert.equal(guard.held, true);
  media.emit("media-paused");
  assert.equal(guard.held, false);
  media.emit("media-paused");
  assert.deepEqual(calls, ["start prevent-display-sleep", "stop 1"]);
});

test("a destroyed page drops the guard and stops following the events", () => {
  const { blocker, calls } = fakeBlocker();
  const guard = new DisplayGuard(blocker);
  const media = fakeMedia();
  attachDisplayGuard(media.source, guard);
  media.emit("media-started-playing");
  media.emit("destroyed");
  assert.equal(guard.held, false);
  media.emit("media-started-playing");
  assert.equal(guard.held, false);
  assert.deepEqual(calls, ["start prevent-display-sleep", "stop 1"]);
});

test("detaching twice releases once and removes the listeners", () => {
  const { blocker, calls } = fakeBlocker();
  const guard = new DisplayGuard(blocker);
  const media = fakeMedia();
  const detach = attachDisplayGuard(media.source, guard);
  media.emit("media-started-playing");
  detach();
  detach();
  assert.deepEqual(calls, ["start prevent-display-sleep", "stop 1"]);
  media.emit("media-started-playing");
  assert.equal(guard.held, false);
  assert.deepEqual(calls, ["start prevent-display-sleep", "stop 1"]);
});
