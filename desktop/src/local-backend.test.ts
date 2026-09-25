import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  INSTANCE_DIRECTORY,
  LOCAL_HOST,
  LOCAL_PARTITION,
  LocalBackend,
  readReadyMessage,
  readRememberedPort,
  writeRememberedPort,
  type LocalBackendChild,
  type LocalBackendForkOptions,
  type LocalBackendOptions,
} from "./local-backend.js";
import { partitionForOrigin } from "./origin.js";

class FakeChild implements LocalBackendChild {
  pid: number | undefined = 4321;
  kills = 0;
  ignoreKill = false;
  private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();

  on(event: string, listener: (...args: any[]) => void): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  once(event: string, listener: (...args: any[]) => void): this {
    const wrapped = (...args: any[]) => {
      this.removeListener(event, wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }

  removeListener(event: string, listener: (...args: any[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, ...args: any[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  kill(): boolean {
    this.kills += 1;
    if (!this.ignoreKill) setImmediate(() => this.emit("exit", 0));
    return true;
  }
}

const READY = { type: "ready", port: 51234, address: LOCAL_HOST };

interface Forked {
  entry: string;
  options: LocalBackendForkOptions;
  child: FakeChild;
}

const makeBackend = (userDataDir: string, overrides: Partial<LocalBackendOptions> = {}) => {
  const forks: Forked[] = [];
  const probed: string[] = [];
  const waiting: (() => void)[] = [];
  const backend = new LocalBackend({
    entry: "/app/runtime/server/dist/index.js",
    userDataDir,
    fork: (entry, options) => {
      const child = new FakeChild();
      forks.push({ entry, options, child });
      for (const notify of waiting.splice(0)) notify();
      return child;
    },
    probeStatus: async (origin) => {
      probed.push(origin);
      return { ok: true, version: "0.4.73", restricted: false, secure: true };
    },
    ...overrides,
  });
  /** The child is forked after the start reads the remembered port, so tests wait for it. */
  const nextChild = async (): Promise<Forked> => {
    const index = forks.length;
    while (forks.length <= index) await new Promise<void>((resolve) => waiting.push(resolve));
    return forks[index]!;
  };
  return { backend, forks, probed, nextChild };
};

/** Nothing awaits the failure right away, and an unhandled rejection would fail the suite. */
const start = (harness: { backend: LocalBackend }) => {
  const promise = harness.backend.start();
  void promise.catch(() => {});
  return promise;
};

const tempDir = async (t: TestContext) => {
  const dir = await mkdtemp(path.join(tmpdir(), "local-backend-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

test("the child runs with the per-user directories and the port it reports is the one used", async (t) => {
  const dir = await tempDir(t);
  const harness = makeBackend(dir);
  const started = start(harness);
  const fork = await harness.nextChild();
  assert.equal(fork.entry, "/app/runtime/server/dist/index.js");
  assert.equal(fork.options.env.HOST, LOCAL_HOST);
  assert.equal(fork.options.env.PORT, "0");
  assert.equal(fork.options.env.DATA_DIR, path.join(dir, INSTANCE_DIRECTORY));
  assert.equal(fork.options.env.DOWNLOAD_DIR, path.join(dir, "downloads"));
  assert.equal(fork.options.cwd, dir);
  fork.child.emit("message", READY);
  const connection = await started;
  assert.equal(connection.server.origin, "http://127.0.0.1:51234");
  assert.deepEqual(harness.probed, ["http://127.0.0.1:51234"]);
  assert.deepEqual(connection.status, { version: "0.4.73", restricted: false, secure: true });
  assert.deepEqual(await readRememberedPort(dir), 51234);
  await harness.backend.stop();
  assert.equal(fork.child.kills, 1);
});

test("the remembered port is a request the child may answer with another port", async (t) => {
  const dir = await tempDir(t);
  await writeRememberedPort(dir, 51234);
  const harness = makeBackend(dir);
  const started = start(harness);
  const fork = await harness.nextChild();
  assert.equal(fork.options.env.PORT, "51234");
  fork.child.emit("message", { type: "ready", port: 51235, address: LOCAL_HOST });
  assert.equal((await started).server.origin, "http://127.0.0.1:51235");
  assert.deepEqual(await readRememberedPort(dir), 51235);
  await harness.backend.stop();
});

test("an occupied remembered port falls back to port 0", async (t) => {
  const dir = await tempDir(t);
  await writeRememberedPort(dir, 51234);
  const harness = makeBackend(dir);
  const started = start(harness);
  const first = await harness.nextChild();
  assert.equal(first.options.env.PORT, "51234");
  first.child.emit("message", { type: "error", code: "EADDRINUSE", message: "listen EADDRINUSE" });
  const second = await harness.nextChild();
  assert.equal(second.options.env.PORT, "0");
  second.child.emit("message", { type: "ready", port: 51235, address: LOCAL_HOST });
  assert.equal((await started).server.origin, "http://127.0.0.1:51235");
  await harness.backend.stop();
});

test("a child that exits before readiness rejects and is not left behind", async (t) => {
  const dir = await tempDir(t);
  const harness = makeBackend(dir);
  const started = start(harness);
  const fork = await harness.nextChild();
  fork.child.emit("exit", 1);
  await assert.rejects(started, /exited before it was ready/);
  assert.equal(harness.backend.current(), null);
  assert.equal(fork.child.kills, 0);
});

test("a readiness timeout stops the child", async (t) => {
  const dir = await tempDir(t);
  const harness = makeBackend(dir, { readyTimeoutMs: 20 });
  const started = start(harness);
  const fork = await harness.nextChild();
  await assert.rejects(started, /did not report its address in time/);
  assert.equal(fork.child.kills, 1);
  assert.equal(harness.backend.current(), null);
});

test("stop is idempotent and stops the child once", async (t) => {
  const dir = await tempDir(t);
  const harness = makeBackend(dir);
  await harness.backend.stop();
  const started = start(harness);
  const fork = await harness.nextChild();
  fork.child.emit("message", READY);
  await started;
  assert.notEqual(harness.backend.current(), null);
  await harness.backend.stop();
  await harness.backend.stop();
  assert.equal(fork.child.kills, 1);
  assert.equal(harness.backend.current(), null);
});

test("a child that ignores the graceful signal is force-killed by its own pid", async (t) => {
  const dir = await tempDir(t);
  const killed: number[] = [];
  let child: FakeChild | null = null;
  const harness = makeBackend(dir, {
    stopTimeoutMs: 10,
    forceKill: (pid) => {
      killed.push(pid);
      child?.emit("exit", 9);
    },
  });
  const started = start(harness);
  const fork = await harness.nextChild();
  child = fork.child;
  fork.child.ignoreKill = true;
  fork.child.emit("message", READY);
  await started;
  await harness.backend.stop();
  assert.deepEqual(killed, [4321]);
  assert.equal(harness.backend.current(), null);
});

test("a pid that appears after spawn is used for force kill", async (t) => {
  const dir = await tempDir(t);
  const killed: number[] = [];
  let child: FakeChild | null = null;
  const harness = makeBackend(dir, {
    stopTimeoutMs: 10,
    forceKill: (pid) => {
      killed.push(pid);
      child?.emit("exit", 9);
    },
  });
  const started = start(harness);
  const fork = await harness.nextChild();
  child = fork.child;
  fork.child.pid = undefined;
  fork.child.emit("message", READY);
  await started;
  fork.child.ignoreKill = true;
  const stopping = harness.backend.stop();
  fork.child.pid = 9876;
  await stopping;
  assert.deepEqual(killed, [9876]);
});

test("overlapping stop calls both wait for the process to exit", async (t) => {
  const dir = await tempDir(t);
  let child: FakeChild | null = null;
  const harness = makeBackend(dir, { forceKill: () => child?.emit("exit", 9) });
  const started = start(harness);
  const fork = await harness.nextChild();
  child = fork.child;
  fork.child.ignoreKill = true;
  fork.child.emit("message", READY);
  await started;
  const first = harness.backend.stop();
  const second = harness.backend.stop();
  let settled = false;
  void second.then(() => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  fork.child.emit("exit", 0);
  await Promise.all([first, second]);
  assert.equal(settled, true);
});

test("overlapping starts share one child", async (t) => {
  const dir = await tempDir(t);
  const harness = makeBackend(dir);
  const first = start(harness);
  const second = start(harness);
  assert.equal(await harness.nextChild().then(() => harness.forks.length), 1);
  harness.forks[0]!.child.emit("message", READY);
  assert.strictEqual(await first, await second);
  await harness.backend.stop();
});

test("an exit after readiness is reported and permits another start", async (t) => {
  const dir = await tempDir(t);
  let exits = 0;
  const harness = makeBackend(dir, { onUnexpectedExit: () => { exits += 1; } });
  const started = start(harness);
  const first = await harness.nextChild();
  first.child.emit("message", READY);
  await started;
  first.child.emit("exit", 12);
  assert.equal(exits, 1);
  assert.equal(harness.backend.current(), null);
  const again = start(harness);
  const second = await harness.nextChild();
  second.child.emit("message", { type: "ready", port: 51236, address: LOCAL_HOST });
  assert.equal((await again).server.origin, "http://127.0.0.1:51236");
  await harness.backend.stop();
});

test("a local server that fails the status check is stopped and remembered by nothing", async (t) => {
  const dir = await tempDir(t);
  const harness = makeBackend(dir, { probeStatus: async () => ({ ok: false, reason: "unreachable" }) });
  const started = start(harness);
  const fork = await harness.nextChild();
  fork.child.emit("message", READY);
  await assert.rejects(started, /status check/);
  assert.equal(fork.child.kills, 1);
  assert.equal(await readRememberedPort(dir), null);
});

test("a message that is not a ready report is not an address", () => {
  const rejected: unknown[] = [
    null,
    "ready",
    {},
    { type: "ready" },
    { type: "ready", port: 0, address: LOCAL_HOST },
    { type: "ready", port: 51234 },
    { type: "ready", port: 70000, address: LOCAL_HOST },
    { type: "ready", port: 51234, address: "" },
  ];
  for (const message of rejected) assert.equal(readReadyMessage(message), null, JSON.stringify(message));
  assert.deepEqual(readReadyMessage(READY), { port: 51234, address: LOCAL_HOST });
});

test("the local partition shares nothing with a remote origin's partition", () => {
  const remoteOrigins = [
    "http://192.168.1.20:8090",
    "https://nas.local",
    "http://localhost:8090",
    "http://127.0.0.1:8080",
    "http://127.0.0.1:51234",
  ];
  assert.equal(LOCAL_PARTITION.startsWith("persist:"), true);
  for (const origin of remoteOrigins) assert.notEqual(LOCAL_PARTITION, partitionForOrigin(origin), origin);
});
