import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseServerOrigin, type ServerOrigin } from "./origin.js";
import type { ProbeResult } from "./status.js";

/** One persistent partition for the local server, so its cookies survive a changed port. */
export const LOCAL_PARTITION = "persist:stremio-local";
/** The local backend is reachable from this machine only. */
export const LOCAL_HOST = "127.0.0.1";
export const INSTANCE_DIRECTORY = "instance";
export const DOWNLOADS_DIRECTORY = "downloads";
export const PORT_FILE = "local-backend.json";
export const READY_TIMEOUT_MS = 30_000;
export const STOP_TIMEOUT_MS = 5_000;
/** Where the tools a desktop install needs are installed on macOS. A Finder launch inherits
 *  `/usr/bin:/bin:/usr/sbin:/sbin`, so neither is on the child's `PATH` by itself. */
export const MACOS_TOOL_DIRECTORIES = ["/opt/homebrew/bin", "/usr/local/bin"] as const;
const MACOS_FALLBACK_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

const SERVICE_NAME = "Stremio Offline backend";

export interface BoundAddress {
  port: number;
  address: string;
}

export interface LocalBackendStatus {
  version: string;
  restricted: boolean;
  secure: boolean;
}

export interface LocalBackendConnection {
  server: ServerOrigin;
  status: LocalBackendStatus;
}

/** The slice of Electron's `UtilityProcess` the lifecycle needs, so tests can stand one in. */
export interface LocalBackendChild {
  readonly pid: number | undefined;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  once(event: "exit", listener: (code: number) => void): unknown;
  removeListener(event: "message", listener: (message: unknown) => void): unknown;
  removeListener(event: "exit", listener: (code: number) => void): unknown;
  kill(): boolean;
}

export interface LocalBackendForkOptions {
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdio: "inherit";
  serviceName: string;
}

export type LocalBackendFork = (entry: string, options: LocalBackendForkOptions) => LocalBackendChild;

export interface LocalBackendOptions {
  /** The compiled server entry point. */
  entry: string;
  /** `<userData>/instance` and `<userData>/downloads` are derived from this. */
  userDataDir: string;
  fork: LocalBackendFork;
  /** The shell's own status probe, so the local server passes the same check as a remote one. */
  probeStatus: (origin: string) => Promise<ProbeResult>;
  readPort?: (dir: string) => Promise<number | null>;
  writePort?: (dir: string, port: number) => Promise<void>;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
  /** How a child that ignores the graceful signal is finished off. */
  forceKill?: (pid: number) => void;
  onUnexpectedExit?: () => void;
  log?: (line: string) => void;
}

class PortBusyError extends Error {}

const isUsablePort = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535;

/** The ready message the server posts once `app.listen` has bound successfully. */
export function readReadyMessage(message: unknown): BoundAddress | null {
  if (typeof message !== "object" || message === null) return null;
  const record = message as Record<string, unknown>;
  if (record.type !== "ready") return null;
  if (!isUsablePort(record.port)) return null;
  const address = record.address;
  if (typeof address !== "string" || address.length === 0 || address.length > 128) return null;
  return { port: record.port, address };
}

export function readErrorMessage(message: unknown): { code: string | null } | null {
  if (typeof message !== "object" || message === null) return null;
  const record = message as Record<string, unknown>;
  if (record.type !== "error") return null;
  return { code: typeof record.code === "string" && record.code.length > 0 ? record.code : null };
}

const isDirectory = (dir: string) => {
  try { return statSync(dir).isDirectory(); } catch { return false; }
};

/** An entry as it is compared, without the one trailing slash it may carry. */
const withoutTrailingSlash = (entry: string) => entry.length > 1 && entry.endsWith("/") ? entry.slice(0, -1) : entry;

/** macOS tools live outside the `PATH` a launch from the Finder inherits. The inherited
 *  entries stay first, so a Homebrew the user put on `PATH` themselves still wins. */
const macosPath = (inherited: string | undefined, directoryExists: (dir: string) => boolean) => {
  const base = inherited ? inherited : MACOS_FALLBACK_PATH;
  const present = new Set(base.split(":").map(withoutTrailingSlash));
  const added = MACOS_TOOL_DIRECTORIES.filter((dir) => directoryExists(dir) && !present.has(withoutTrailingSlash(dir)));
  return added.length ? `${base}:${added.join(":")}` : base;
};

/** The child's environment, on top of the parent's so `PATH` still finds ffmpeg. */
export function localBackendEnv(
  parent: NodeJS.ProcessEnv,
  userDataDir: string,
  port: number,
  platform: NodeJS.Platform = process.platform,
  directoryExists: (dir: string) => boolean = isDirectory,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parent)) if (value !== undefined) env[key] = value;
  env.HOST = LOCAL_HOST;
  env.HOST_CHECK = "loopback";
  env.PORT = String(port);
  env.DATA_DIR = path.join(userDataDir, INSTANCE_DIRECTORY);
  env.DOWNLOAD_DIR = path.join(userDataDir, DOWNLOADS_DIRECTORY);
  if (platform === "darwin") env.PATH = macosPath(env.PATH, directoryExists);
  return env;
}

/** The port of the last successful local start. It is not a saved remote profile. */
export async function readRememberedPort(dir: string): Promise<number | null> {
  let text: string;
  try {
    text = await readFile(path.join(dir, PORT_FILE), "utf8");
  } catch {
    return null;
  }
  try {
    const port = (JSON.parse(text) as { port?: unknown }).port;
    return isUsablePort(port) ? port : null;
  } catch {
    return null;
  }
}

export async function writeRememberedPort(dir: string, port: number): Promise<void> {
  await mkdir(dir, { recursive: true });
  const temporary = path.join(dir, `${PORT_FILE}.${randomUUID()}`);
  try {
    await writeFile(temporary, JSON.stringify({ port }) + "\n", { encoding: "utf8", flag: "wx" });
    await rename(temporary, path.join(dir, PORT_FILE));
  } catch (error) {
    await rm(temporary).catch(() => {});
    throw error;
  }
}

interface TrackedChild {
  child: LocalBackendChild;
  exited: boolean;
  waitExit: Promise<void>;
}

const track = (child: LocalBackendChild): TrackedChild => {
  let resolveExit!: () => void;
  const tracked: TrackedChild = { child, exited: false, waitExit: new Promise<void>((resolve) => { resolveExit = resolve; }) };
  child.once("exit", () => { tracked.exited = true; resolveExit(); });
  return tracked;
};

const timedOut = (promise: Promise<void>, ms: number): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(true), ms);
    void promise.then(() => { clearTimeout(timer); resolve(false); });
  });

const forceKillProcess = (pid: number) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The child is gone already, which is what the kill was for.
  }
};

const awaitReady = (child: LocalBackendChild, timeoutMs: number): Promise<BoundAddress> =>
  new Promise<BoundAddress>((resolve, reject) => {
    const finish = (error: Error | null, address?: BoundAddress) => {
      clearTimeout(timer);
      child.removeListener("message", onMessage);
      child.removeListener("exit", onExit);
      if (error) reject(error);
      else resolve(address as BoundAddress);
    };
    const timer = setTimeout(() => finish(new Error("The local server did not report its address in time.")), timeoutMs);
    const onMessage = (message: unknown) => {
      const address = readReadyMessage(message);
      if (address) return finish(null, address);
      const failure = readErrorMessage(message);
      if (!failure) return;
      finish(failure.code === "EADDRINUSE"
        ? new PortBusyError("The remembered port is in use.")
        : new Error("The local server could not start."));
    };
    const onExit = (code: number) => finish(new Error(`The local server exited before it was ready (code ${code}).`));
    child.on("message", onMessage);
    child.once("exit", onExit);
  });

/**
 * Runs the compiled server as a managed utility process. The port the child reports is the
 * only port this class ever uses: port 0 is a request, and the answer arrives over IPC.
 */
export class LocalBackend {
  private readonly options: LocalBackendOptions;
  private tracked: TrackedChild | null = null;
  private connection: LocalBackendConnection | null = null;
  private startPromise: Promise<LocalBackendConnection> | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(options: LocalBackendOptions) {
    this.options = options;
  }

  current(): LocalBackendConnection | null {
    return this.connection;
  }

  start(): Promise<LocalBackendConnection> {
    if (this.connection) return Promise.resolve(this.connection);
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startBackend().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  private async startBackend(): Promise<LocalBackendConnection> {
    const remembered = await (this.options.readPort ?? readRememberedPort)(this.options.userDataDir);
    const attempts = remembered === null ? [0] : [remembered, 0];
    let failure: unknown = null;
    for (const port of attempts) {
      try {
        return await this.launch(port);
      } catch (error) {
        failure = error;
        // Only an occupied remembered port is worth a second try, and only with port 0.
        if (port === 0 || !(error instanceof PortBusyError)) break;
      }
    }
    throw failure instanceof Error ? failure : new Error("The local server did not start.");
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const starting = this.startPromise;
    this.stopPromise = (starting ? starting.catch(() => {}).then(() => this.stopTracked()) : this.stopTracked())
      .finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }

  private stopTracked(): Promise<void> {
    if (this.stopPromise && this.tracked === null) return this.stopPromise;
    const tracked = this.tracked;
    this.tracked = null;
    this.connection = null;
    if (!tracked || tracked.exited) return Promise.resolve();
    return (async () => {
      tracked.child.kill();
      if (await timedOut(tracked.waitExit, this.options.stopTimeoutMs ?? STOP_TIMEOUT_MS)) {
        const pid = tracked.child.pid;
        if (typeof pid === "number") (this.options.forceKill ?? forceKillProcess)(pid);
        await tracked.waitExit;
      }
    })();
  }

  private async launch(port: number): Promise<LocalBackendConnection> {
    const { options } = this;
    const child = options.fork(options.entry, {
      env: localBackendEnv(process.env, options.userDataDir, port),
      cwd: options.userDataDir,
      stdio: "inherit",
      serviceName: SERVICE_NAME,
    });
    const tracked = track(child);
    this.tracked = tracked;
    child.on("exit", (code) => this.onExit(tracked, code));
    let ready: BoundAddress;
    try {
      ready = await awaitReady(child, options.readyTimeoutMs ?? READY_TIMEOUT_MS);
      if (ready.address !== LOCAL_HOST) throw new Error("The local server did not bind to the loopback address.");
    } catch (error) {
      await this.stopTracked();
      throw error;
    }
    const server = parseServerOrigin(`http://${LOCAL_HOST}:${ready.port}`);
    const probe = server ? await options.probeStatus(server.origin) : null;
    if (!server || !probe?.ok) {
      await this.stopTracked();
      throw new Error("The local server did not answer its own status check.");
    }
    this.connection = { server, status: { version: probe.version, restricted: probe.restricted, secure: probe.secure } };
    await this.remember(ready.port);
    return this.connection;
  }

  private onExit(tracked: TrackedChild, code: number): void {
    if (this.tracked !== tracked) return;
    const wasConnected = this.connection !== null;
    this.tracked = null;
    this.connection = null;
    if (!wasConnected) return;
    this.options.log?.(`The local server exited (code ${code}).`);
    this.options.onUnexpectedExit?.();
  }

  private async remember(port: number): Promise<void> {
    try {
      await (this.options.writePort ?? writeRememberedPort)(this.options.userDataDir, port);
    } catch (error) {
      this.options.log?.(`The local port could not be remembered: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
