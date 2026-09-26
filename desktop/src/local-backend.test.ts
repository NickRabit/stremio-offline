import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, type NetworkInterfaceInfo } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  INSTANCE_DIRECTORY,
  MACOS_TOOL_DIRECTORIES,
  LOCAL_HOST,
  LOCAL_PARTITION,
  PUBLISHED_HOST,
  LocalBackend,
  LocalPortBusyError,
  lanAddresses,
  localBackendEnv,
  localHostNames,
  readActivityMessage,
  readReadyMessage,
  readRememberedPort,
  writeRememberedPort,
  type LocalBackendChild,
  type LocalBackendForkOptions,
  type LocalBackendOptions,
} from "./local-backend.js";
import { writeLocalSettings } from "./local-settings.js";
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
  assert.equal(fork.options.env.HOST_CHECK, "loopback");
  assert.equal(fork.options.env.DESKTOP_LOCAL_BACKEND, "1");
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

test("on macOS the tool directories are appended after the inherited PATH entries", () => {
  assert.deepEqual([...MACOS_TOOL_DIRECTORIES], ["/opt/homebrew/bin", "/usr/local/bin"]);
  const env = localBackendEnv({ PATH: "/usr/bin:/bin" }, "/data", 8090, "darwin", () => true);
  assert.equal(env.PATH, "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin");
});

test("a tool directory already on PATH is not added a second time", () => {
  const plain = localBackendEnv({ PATH: "/opt/homebrew/bin:/usr/bin" }, "/data", 8090, "darwin", () => true);
  assert.equal(plain.PATH, "/opt/homebrew/bin:/usr/bin:/usr/local/bin");
  const slashed = localBackendEnv({ PATH: "/opt/homebrew/bin/:/usr/bin" }, "/data", 8090, "darwin", () => true);
  assert.equal(slashed.PATH, "/opt/homebrew/bin/:/usr/bin:/usr/local/bin");
});

test("a tool directory that is not there is skipped", () => {
  const env = localBackendEnv({ PATH: "/usr/bin:/bin" }, "/data", 8090, "darwin", (dir) => dir === "/usr/local/bin");
  assert.equal(env.PATH, "/usr/bin:/bin:/usr/local/bin");
});

test("other platforms keep the PATH they were given", () => {
  for (const platform of ["linux", "win32"] as const) {
    const env = localBackendEnv({ PATH: "/usr/bin:/bin" }, "/data", 8090, platform, () => true);
    assert.equal(env.PATH, "/usr/bin:/bin");
    assert.equal("PATH" in localBackendEnv({}, "/data", 8090, platform, () => true), false);
  }
});

test("macOS without an inherited PATH starts from the system directories", () => {
  assert.equal(localBackendEnv({}, "/data", 8090, "darwin", () => false).PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
  assert.equal(localBackendEnv({}, "/data", 8090, "darwin", () => true).PATH,
    "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin");
});

test("the PATH logic leaves the backend variables as they were", () => {
  const env = localBackendEnv(
    { PATH: "/usr/bin", HOST: "elsewhere", PORT: "1", DATA_DIR: "/x", DOWNLOAD_DIR: "/y" },
    "/data", 8090, "darwin", () => true,
  );
  assert.equal(env.HOST, LOCAL_HOST);
  assert.equal(env.PORT, "8090");
  assert.equal(env.DATA_DIR, path.join("/data", INSTANCE_DIRECTORY));
  assert.equal(env.DOWNLOAD_DIR, path.join("/data", "downloads"));
});

test("the switch on lets the child reach the local network", () => {
  const env = localBackendEnv({ PATH: "/usr/bin" }, "/data", 8090, "linux", () => true, { allowPrivateAddons: true, publish: false, publishPort: 8091 });
  assert.equal(env.ALLOW_PRIVATE_ADDONS, "1");
});

test("the switch off leaves an inherited permission alone and adds none", () => {
  const inherited = localBackendEnv({ ALLOW_PRIVATE_ADDONS: "1" }, "/data", 8090, "linux", () => true, { allowPrivateAddons: false, publish: false, publishPort: 8091 });
  assert.equal(inherited.ALLOW_PRIVATE_ADDONS, "1");
  const absent = localBackendEnv({}, "/data", 8090, "linux", () => true, { allowPrivateAddons: false, publish: false, publishPort: 8091 });
  assert.equal("ALLOW_PRIVATE_ADDONS" in absent, false);
  assert.equal("ALLOW_PRIVATE_ADDONS" in localBackendEnv({}, "/data", 8090, "linux", () => true), false);
});

test("a start reads the settings and passes the switch to the child", async (t) => {
  const dir = await tempDir(t);
  const reads: string[] = [];
  const harness = makeBackend(dir, {
    readSettings: async (requested) => {
      reads.push(requested);
      return { allowPrivateAddons: true, publish: false, publishPort: 8091 };
    },
  });
  const started = start(harness);
  const fork = await harness.nextChild();
  assert.equal(fork.options.env.ALLOW_PRIVATE_ADDONS, "1");
  fork.child.emit("message", READY);
  await started;
  await harness.backend.stop();
  assert.deepEqual(reads, [dir]);
});

test("the settings are read again on the next start", async (t) => {
  const dir = await tempDir(t);
  let allowPrivateAddons = false;
  let reads = 0;
  const harness = makeBackend(dir, {
    readSettings: async () => {
      reads += 1;
      return { allowPrivateAddons, publish: false, publishPort: 8091 };
    },
  });
  const first = start(harness);
  const firstFork = await harness.nextChild();
  assert.equal("ALLOW_PRIVATE_ADDONS" in firstFork.options.env, false);
  firstFork.child.emit("message", READY);
  await first;
  await harness.backend.stop();
  allowPrivateAddons = true;
  const second = start(harness);
  const secondFork = await harness.nextChild();
  assert.equal(secondFork.options.env.ALLOW_PRIVATE_ADDONS, "1");
  secondFork.child.emit("message", READY);
  await second;
  await harness.backend.stop();
  assert.equal(reads, 2);
});

test("without a settings reader the stored file decides the child environment", async (t) => {
  const dir = await tempDir(t);
  await writeLocalSettings(dir, { allowPrivateAddons: true, publish: false, publishPort: 8091 });
  const harness = makeBackend(dir);
  const started = start(harness);
  const fork = await harness.nextChild();
  assert.equal(fork.options.env.ALLOW_PRIVATE_ADDONS, "1");
  fork.child.emit("message", READY);
  await started;
  await harness.backend.stop();
});

test("a running backend is reused while the stored settings match what it was started with", async (t) => {
  const dir = await tempDir(t);
  const harness = makeBackend(dir, { readSettings: async () => ({ allowPrivateAddons: true, publish: false, publishPort: 8091 }) });
  const first = start(harness);
  const fork = await harness.nextChild();
  fork.child.emit("message", READY);
  const connection = await first;
  assert.equal(await harness.backend.start(), connection);
  assert.equal(harness.forks.length, 1);
  assert.equal(fork.child.kills, 0);
  await harness.backend.stop();
});

test("a running backend started with other settings is replaced on the next start", async (t) => {
  const dir = await tempDir(t);
  let allowPrivateAddons = true;
  let unexpected = 0;
  const harness = makeBackend(dir, {
    readSettings: async () => ({ allowPrivateAddons, publish: false, publishPort: 8091 }),
    onUnexpectedExit: () => { unexpected += 1; },
  });
  const first = start(harness);
  const firstFork = await harness.nextChild();
  firstFork.child.emit("message", READY);
  await first;
  // Switched off while the form was back but the child lived on: it must not keep the network open.
  allowPrivateAddons = false;
  const second = start(harness);
  const secondFork = await harness.nextChild();
  assert.equal(firstFork.child.kills, 1);
  assert.equal("ALLOW_PRIVATE_ADDONS" in secondFork.options.env, false);
  secondFork.child.emit("message", READY);
  await second;
  assert.equal(unexpected, 0, "a replacement is not an unexpected exit");
  await harness.backend.stop();
});

test("publishing points the child at every interface and the published host check", () => {
  const env = localBackendEnv({}, "/data", 8091, "linux", () => true, { allowPrivateAddons: false, publish: true, publishPort: 8091 });
  assert.equal(env.HOST, PUBLISHED_HOST);
  assert.equal(env.HOST_CHECK, "published");
  assert.equal(env.PORT, "8091");
  assert.equal(env.HOST_NAMES, localHostNames().join(","));
});

test("not publishing keeps the loopback check and names no host", () => {
  const env = localBackendEnv({}, "/data", 8091, "linux", () => true, { allowPrivateAddons: false, publish: false, publishPort: 8091 });
  assert.equal(env.HOST, LOCAL_HOST);
  assert.equal(env.HOST_CHECK, "loopback");
  assert.equal("HOST_NAMES" in env, false);
});

test("the .local names are lower-cased and given the suffix once", () => {
  assert.deepEqual(localHostNames("Mac", null), ["mac.local"]);
  assert.deepEqual(localHostNames("Mac.local", null), ["mac.local"]);
  assert.deepEqual(localHostNames("MAC.LOCAL", null), ["mac.local"]);
  assert.deepEqual(localHostNames("", null), []);
  // A HostName set by DHCP is not what Bonjour announces; the announced name comes first.
  assert.deepEqual(localHostNames("192-168-1-41.isp.example", "Ondrej-Mac"), ["ondrej-mac.local", "192-168-1-41.isp.example.local"]);
  assert.deepEqual(localHostNames("Ondrej-Mac.local", "Ondrej-Mac"), ["ondrej-mac.local"]);
});

const face = (address: string, family: "IPv4" | "IPv6", internal: boolean): NetworkInterfaceInfo =>
  ({ address, family, internal, netmask: "", mac: "", cidr: null, scopeid: 0 }) as NetworkInterfaceInfo;

test("the lan addresses are the IPv4 ones in order, then the names, without duplicates", () => {
  const interfaces = {
    lo0: [face("127.0.0.1", "IPv4", true), face("::1", "IPv6", true)],
    en0: [face("192.168.1.41", "IPv4", false), face("fe80::1", "IPv6", false)],
    en1: [face("192.168.1.41", "IPv4", false)],
  } as unknown as NodeJS.Dict<NetworkInterfaceInfo[]>;
  assert.deepEqual(lanAddresses(interfaces, 8091, ["mac.local", "mac.local"]), [
    "http://192.168.1.41:8091",
    "http://mac.local:8091",
  ]);
});

test("a published start asks for its configured port only", async (t) => {
  const dir = await tempDir(t);
  await writeRememberedPort(dir, 51234);
  const harness = makeBackend(dir, { readSettings: async () => ({ allowPrivateAddons: false, publish: true, publishPort: 8095 }) });
  const started = start(harness);
  const fork = await harness.nextChild();
  assert.equal(fork.options.env.PORT, "8095");
  assert.equal(fork.options.env.HOST, PUBLISHED_HOST);
  fork.child.emit("message", { type: "error", code: "EADDRINUSE", message: "listen EADDRINUSE" });
  await assert.rejects(started, (error: unknown) => error instanceof LocalPortBusyError && error.port === 8095);
  assert.equal(harness.forks.length, 1, "a busy published port is not retried on port 0");
  assert.equal(await readRememberedPort(dir), 51234, "publishing leaves the remembered port alone");
  await harness.backend.stop();
});

test("a published ready on every interface is accepted and fills the addresses", async (t) => {
  const dir = await tempDir(t);
  const harness = makeBackend(dir, { readSettings: async () => ({ allowPrivateAddons: false, publish: true, publishPort: 8091 }) });
  const started = start(harness);
  const fork = await harness.nextChild();
  fork.child.emit("message", { type: "ready", port: 8091, address: PUBLISHED_HOST });
  const connection = await started;
  assert.equal(connection.server.origin, "http://127.0.0.1:8091");
  assert.equal(connection.published, true);
  assert.deepEqual(connection.addresses, lanAddresses(undefined, 8091, localHostNames()));
  assert.equal(await readRememberedPort(dir), null, "a published port is not remembered");
  await harness.backend.stop();
});

test("an unpublished ready on every interface is refused", async (t) => {
  const dir = await tempDir(t);
  const harness = makeBackend(dir);
  const started = start(harness);
  const fork = await harness.nextChild();
  fork.child.emit("message", { type: "ready", port: 51234, address: PUBLISHED_HOST });
  await assert.rejects(started, /expected address/);
  assert.equal(fork.child.kills, 1);
  assert.equal(harness.backend.current(), null);
  await harness.backend.stop();
});

test("a running backend is replaced when publishing is switched on", async (t) => {
  const dir = await tempDir(t);
  let publish = false;
  const harness = makeBackend(dir, { readSettings: async () => ({ allowPrivateAddons: false, publish, publishPort: 8091 }) });
  const first = start(harness);
  const firstFork = await harness.nextChild();
  firstFork.child.emit("message", READY);
  await first;
  publish = true;
  const second = start(harness);
  const secondFork = await harness.nextChild();
  assert.equal(firstFork.child.kills, 1);
  assert.equal(secondFork.options.env.HOST_CHECK, "published");
  secondFork.child.emit("message", { type: "ready", port: 8091, address: PUBLISHED_HOST });
  await second;
  await harness.backend.stop();
});

test("only a boolean streaming flag is an activity report", () => {
  assert.equal(readActivityMessage({ type: "activity", streaming: true }), true);
  assert.equal(readActivityMessage({ type: "activity", streaming: false }), false);
  const rejected: unknown[] = [null, "activity", {}, { type: "activity" }, { type: "activity", streaming: "yes" }, { type: "ready", port: 8091, address: LOCAL_HOST }];
  for (const message of rejected) assert.equal(readActivityMessage(message), null, JSON.stringify(message));
});

test("activity reports are forwarded and malformed ones are ignored", async (t) => {
  const dir = await tempDir(t);
  const seen: boolean[] = [];
  const harness = makeBackend(dir, {
    readSettings: async () => ({ allowPrivateAddons: false, publish: true, publishPort: 8091 }),
    onActivity: (streaming) => seen.push(streaming),
  });
  const started = start(harness);
  const fork = await harness.nextChild();
  fork.child.emit("message", { type: "ready", port: 8091, address: PUBLISHED_HOST });
  await started;
  fork.child.emit("message", { type: "activity", streaming: true });
  fork.child.emit("message", { type: "activity" });
  fork.child.emit("message", { type: "activity", streaming: "yes" });
  fork.child.emit("message", { type: "ready", port: 8091, address: PUBLISHED_HOST });
  fork.child.emit("message", { type: "activity", streaming: false });
  assert.deepEqual(seen, [true, false]);
  await harness.backend.stop();
});
