import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_SIZE,
  Debounced,
  MIN_SIZE,
  restoreBounds,
  readWindowState,
  writeWindowState,
  type Rect,
  type WindowState,
} from "./window-state.js";

const withDir = async (body: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stremio-desktop-window-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const fileOf = (dir: string) => path.join(dir, "window-state.json");

const stateOf = (x: number, y: number, width: number, height: number, maximized = false): WindowState =>
  ({ bounds: { x, y, width, height }, maximized });

const primary: Rect = { x: 0, y: 0, width: 1920, height: 1080 };

test("a window state survives a round trip", async () => {
  await withDir(async (dir) => {
    const state = stateOf(120, 80, 1280, 800, true);
    await writeWindowState(dir, "main", state);
    assert.deepEqual(await readWindowState(dir, "main"), state);
    assert.equal(await readWindowState(dir, "settings"), null);
    assert.deepEqual(await readdir(dir), ["window-state.json"]);
  });
});

test("writing one name keeps the other", async () => {
  await withDir(async (dir) => {
    const main = stateOf(10, 20, 1000, 700);
    const settings = stateOf(400, 300, 900, 600, true);
    await writeWindowState(dir, "main", main);
    await writeWindowState(dir, "settings", settings);
    await writeWindowState(dir, "main", stateOf(30, 40, 1100, 700));
    assert.deepEqual(await readWindowState(dir, "settings"), settings);
    assert.deepEqual(await readWindowState(dir, "main"), stateOf(30, 40, 1100, 700));
  });
});

test("two concurrent writes of different names both survive", async () => {
  await withDir(async (dir) => {
    const main = stateOf(10, 20, 1000, 700);
    const settings = stateOf(400, 300, 900, 600);
    await Promise.all([writeWindowState(dir, "main", main), writeWindowState(dir, "settings", settings)]);
    assert.deepEqual(await readWindowState(dir, "main"), main);
    assert.deepEqual(await readWindowState(dir, "settings"), settings);
  });
});

test("a malformed file has no state", async () => {
  await withDir(async (dir) => {
    for (const text of ["", "not json", "null", "[]", JSON.stringify({ main: 7 }), JSON.stringify({ main: {} })]) {
      await writeFile(fileOf(dir), text, "utf8");
      assert.equal(await readWindowState(dir, "main"), null, text);
    }
  });
});

test("a missing file has no state", async () => {
  await withDir(async (dir) => {
    assert.equal(await readWindowState(dir, "main"), null);
    assert.equal(await readWindowState(dir, "settings"), null);
  });
});

test("a rectangle that is too small or not integral has no state", async () => {
  await withDir(async (dir) => {
    const rejected: WindowState[] = [
      stateOf(0, 0, MIN_SIZE.width - 1, 800),
      stateOf(0, 0, 1280, MIN_SIZE.height - 1),
      stateOf(10.5, 0, 1280, 800),
      stateOf(0, 0, Number.NaN, 800),
    ];
    for (const state of rejected) {
      await writeFile(fileOf(dir), JSON.stringify({ main: state }), "utf8");
      assert.equal(await readWindowState(dir, "main"), null, JSON.stringify(state));
    }
  });
});

test("a rectangle that fits the primary display is kept as it was", () => {
  const saved = stateOf(200, 120, 1280, 800);
  assert.deepEqual(restoreBounds(saved, [primary], primary, DEFAULT_SIZE), saved);
});

test("a partly off-screen rectangle is clamped onto the display", () => {
  const kept = restoreBounds(stateOf(-200, 300, 1280, 800), [primary], primary, DEFAULT_SIZE);
  assert.deepEqual(kept, stateOf(0, 300, 1280, 800));
  const right = restoreBounds(stateOf(1700, 300, 1280, 800), [primary], primary, DEFAULT_SIZE);
  assert.deepEqual(right, stateOf(640, 300, 1280, 800));
  const high = restoreBounds(stateOf(200, -50, 1280, 800), [primary], primary, DEFAULT_SIZE);
  assert.deepEqual(high, stateOf(200, 0, 1280, 800));
});

test("a rectangle larger than the display shrinks to the work area", () => {
  assert.deepEqual(restoreBounds(stateOf(0, 0, 2560, 1440), [primary], primary, DEFAULT_SIZE),
    stateOf(0, 0, 1920, 1080));
});

test("a rectangle on a disconnected monitor is centred on the primary display", () => {
  const restored = restoreBounds(stateOf(3000, 400, 1280, 800, true), [primary], primary, DEFAULT_SIZE);
  assert.deepEqual(restored.bounds, stateOf(Math.round((1920 - DEFAULT_SIZE.width) / 2), Math.round((1080 - DEFAULT_SIZE.height) / 2), 1280, 800).bounds);
  assert.equal(restored.maximized, false);
});

test("a rectangle that pokes less than 100 px onto the display is dropped", () => {
  const barely = stateOf(primary.width - 90, 200, 1280, 800);
  assert.equal(restoreBounds(barely, [primary], primary, DEFAULT_SIZE).bounds.x, 320);
});

test("a rectangle on a secondary display is kept on that display", () => {
  const secondary: Rect = { x: 1920, y: 0, width: 1920, height: 1080 };
  const saved = stateOf(2100, 200, 1280, 800);
  assert.deepEqual(restoreBounds(saved, [primary, secondary], primary, DEFAULT_SIZE), saved);
});

test("with no saved state the window opens centred on the primary display", () => {
  assert.deepEqual(restoreBounds(null, [primary], primary, DEFAULT_SIZE),
    stateOf(320, 140, 1280, 800));
});

test("the default is centred inside an offset primary work area", () => {
  const offset: Rect = { x: 1920, y: 0, width: 1920, height: 1080 };
  assert.deepEqual(restoreBounds(null, [offset], offset, DEFAULT_SIZE), stateOf(2240, 140, 1280, 800));
});

test("a default larger than the primary work area is clamped", () => {
  const small: Rect = { x: 0, y: 0, width: 1280, height: 800 };
  assert.deepEqual(restoreBounds(null, [small], small, { width: 1600, height: 1000 }),
    stateOf(0, 0, 1280, 800));
});

test("a maximized flag is kept only with a kept rectangle", () => {
  assert.equal(restoreBounds(stateOf(200, 120, 1280, 800, true), [primary], primary, DEFAULT_SIZE).maximized, true);
  assert.equal(restoreBounds(stateOf(4000, 0, 1280, 800, true), [primary], primary, DEFAULT_SIZE).maximized, false);
});

const fakeTimers = () => {
  let next = 0;
  const pending = new Map<number, () => void>();
  return {
    pending,
    set: ((callback: () => void, _delayMs?: number) => {
      const id = ++next;
      pending.set(id, callback);
      return id;
    }) as unknown as typeof setTimeout,
    clear: ((id: number) => { pending.delete(id); }) as unknown as typeof clearTimeout,
    run(): void {
      for (const [id, callback] of [...pending]) {
        pending.delete(id);
        callback();
      }
    },
  };
};

test("a burst of schedules writes once after the last one", () => {
  const timers = fakeTimers();
  let writes = 0;
  const debounced = new Debounced(() => { writes += 1; }, 500, timers);
  debounced.schedule();
  debounced.schedule();
  debounced.schedule();
  assert.equal(writes, 0);
  assert.equal(timers.pending.size, 1);
  timers.run();
  assert.equal(writes, 1);
  assert.equal(timers.pending.size, 0);
});

test("flush writes a pending state at once", () => {
  const timers = fakeTimers();
  let writes = 0;
  const debounced = new Debounced(() => { writes += 1; }, 500, timers);
  debounced.schedule();
  debounced.flush();
  assert.equal(writes, 1);
  timers.run();
  assert.equal(writes, 1);
});

test("flush without pending work does nothing", () => {
  const timers = fakeTimers();
  let writes = 0;
  const debounced = new Debounced(() => { writes += 1; }, 500, timers);
  debounced.flush();
  assert.equal(writes, 0);
  debounced.schedule();
  timers.run();
  debounced.flush();
  assert.equal(writes, 1);
});
