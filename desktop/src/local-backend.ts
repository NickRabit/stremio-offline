import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultLocalSettings, readLocalSettings, type LocalSettings } from "./local-settings.js";
import { parseServerOrigin, type ServerOrigin } from "./origin.js";
import type { ProbeResult } from "./status.js";

/** One persistent partition for the local server, so its cookies survive a changed port. */
export const LOCAL_PARTITION = "persist:stremio-local";
/** The local backend is reachable from this machine only. */
export const LOCAL_HOST = "127.0.0.1";
/** The address the child reports when it is shared with the home network. */
export const PUBLISHED_HOST = "0.0.0.0";
export const INSTANCE_DIRECTORY = "instance";
export const DOWNLOADS_DIRECTORY = "downloads";
export const PORT_FILE = "local-backend.json";
export const READY_TIMEOUT_MS = 30_000;
export const STOP_TIMEOUT_MS = 5_000;
/** Where the tools a desktop install needs are installed on macOS. A Finder launch inherits
 *  `/usr/bin:/bin:/usr/sbin:/sbin`, so neither is on the child's `PATH` by itself. */
export const MACOS_TOOL_DIRECTORIES = ["/opt/homebrew/bin", "/usr/local/bin"] as const;
const MACOS_FALLBACK_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

const sameSettings = (a: LocalSettings, b: LocalSettings) =>
  a.allowPrivateAddons === b.allowPrivateAddons && a.publish === b.publish && a.publishPort === b.publishPort;

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
  published: boolean;
  addresses: string[];
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
  /** Read on every launch, so a switch thrown in the shell applies to the next start. */
  readSettings?: (dir: string) => Promise<LocalSettings>;
  /** Whether anything is streaming, so the shell can hold the machine awake while published. */
  onActivity?: (streaming: boolean) => void;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
  /** How a child that ignores the graceful signal is finished off. */
  forceKill?: (pid: number) => void;
  onUnexpectedExit?: () => void;
  log?: (line: string) => void;
}

class PortBusyError extends Error {}

/** A published start has a fixed port, so an occupied one is a failure the page can name. */
export class LocalPortBusyError extends Error {
  constructor(readonly port: number) {
    super(`Port ${port} is in use by another program.`);
    this.name = "LocalPortBusyError";
  }
}

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

/** The child reports whether anything is streaming, so the shell can hold the Mac awake. */
export function readActivityMessage(message: unknown): boolean | null {
  if (typeof message !== "object" || message === null) return null;
  const record = message as Record<string, unknown>;
  if (record.type !== "activity") return null;
  return typeof record.streaming === "boolean" ? record.streaming : null;
}

/** The name macOS announces over Bonjour. `os.hostname()` answers with HostName instead when one
 *  is set -- by DHCP or by hand -- and that name is not what another device can look up. */
const bonjourName = (): string | null => {
  if (process.platform !== "darwin") return null;
  try {
    return execFileSync("/usr/sbin/scutil", ["--get", "LocalHostName"], { encoding: "utf8", timeout: 2_000 }).trim() || null;
  } catch {
    return null;
  }
};

/** The machine's own `.local` names, which is how another device reaches it over Bonjour. */
export function localHostNames(hostname = os.hostname(), announced: string | null = bonjourName()): string[] {
  const names = new Set<string>();
  for (const candidate of [announced, hostname]) {
    const name = candidate?.trim().toLowerCase() ?? "";
    if (name.length === 0) continue;
    names.add(name.endsWith(".local") ? name : `${name}.local`);
  }
  return [...names];
}

/** The URLs to type on another device: every IPv4 the machine holds, then its `.local` names. */
export function lanAddresses(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
  port: number,
  names: string[],
): string[] {
  const addresses: string[] = [];
  const seen = new Set<string>();
  const add = (address: string) => {
    if (seen.has(address)) return;
    seen.add(address);
    addresses.push(address);
  };
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      add(`http://${entry.address}:${port}`);
    }
  }
  for (const name of names) add(`http://${name}:${port}`);
  return addresses;
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
  settings: LocalSettings = defaultLocalSettings(),
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parent)) if (value !== undefined) env[key] = value;
  env.HOST = settings.publish ? PUBLISHED_HOST : LOCAL_HOST;
  env.HOST_CHECK = settings.publish ? "published" : "loopback";
  if (settings.publish) env.HOST_NAMES = localHostNames().join(",");
  else delete env.HOST_NAMES;
  env.DESKTOP_LOCAL_BACKEND = "1";
  env.PORT = String(port);
  env.DATA_DIR = path.join(userDataDir, INSTANCE_DIRECTORY);
  env.DOWNLOAD_DIR = path.join(userDataDir, DOWNLOADS_DIRECTORY);
  // Off leaves an inherited value alone: a developer running from a terminal keeps their own.
  if (settings.allowPrivateAddons) env.ALLOW_PRIVATE_ADDONS = "1";
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
  private launchedWith: LocalSettings | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(options: LocalBackendOptions) {
    this.options = options;
  }

  current(): LocalBackendConnection | null {
    return this.connection;
  }

  start(): Promise<LocalBackendConnection> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.ensureStarted().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  /** A backend still running from before keeps its environment, so one started with other
   *  settings than those now stored is replaced: the connection form can come back after a failed
   *  page load while the child lives on, and a switch turned off there must not stay on. */
  private async ensureStarted(): Promise<LocalBackendConnection> {
    if (this.connection) {
      const wanted = await (this.options.readSettings ?? readLocalSettings)(this.options.userDataDir);
      if (this.launchedWith && sameSettings(wanted, this.launchedWith)) return this.connection;
      this.options.log?.("The local settings changed, restarting the local server.");
      await this.stopTracked();
    }
    return this.startBackend();
  }

  private async startBackend(): Promise<LocalBackendConnection> {
    const settings = await (this.options.readSettings ?? readLocalSettings)(this.options.userDataDir);
    // Publishing has one fixed port: no remembered port, no port-0 fallback.
    if (settings.publish) return this.launch(settings.publishPort, settings);
    const remembered = await (this.options.readPort ?? readRememberedPort)(this.options.userDataDir);
    const attempts = remembered === null ? [0] : [remembered, 0];
    let failure: unknown = null;
    for (const port of attempts) {
      try {
        return await this.launch(port, settings);
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

  private async launch(port: number, settings: LocalSettings): Promise<LocalBackendConnection> {
    const { options } = this;
    this.launchedWith = settings;
    const child = options.fork(options.entry, {
      env: localBackendEnv(process.env, options.userDataDir, port, process.platform, isDirectory, settings),
      cwd: options.userDataDir,
      stdio: "inherit",
      serviceName: SERVICE_NAME,
    });
    const tracked = track(child);
    this.tracked = tracked;
    child.on("exit", (code) => this.onExit(tracked, code));
    const expectedAddress = settings.publish ? PUBLISHED_HOST : LOCAL_HOST;
    let ready: BoundAddress;
    try {
      ready = await awaitReady(child, options.readyTimeoutMs ?? READY_TIMEOUT_MS);
      if (ready.address !== expectedAddress) throw new Error("The local server did not bind to the expected address.");
    } catch (error) {
      await this.stopTracked();
      if (settings.publish && error instanceof PortBusyError) throw new LocalPortBusyError(port);
      throw error;
    }
    const server = parseServerOrigin(`http://${LOCAL_HOST}:${ready.port}`);
    const probe = server ? await options.probeStatus(server.origin) : null;
    if (!server || !probe?.ok) {
      await this.stopTracked();
      throw new Error("The local server did not answer its own status check.");
    }
    const onActivity = options.onActivity;
    if (settings.publish && onActivity) {
      child.on("message", (message) => {
        const streaming = readActivityMessage(message);
        if (streaming !== null) onActivity(streaming);
      });
    }
    this.connection = {
      server,
      status: { version: probe.version, restricted: probe.restricted, secure: probe.secure },
      published: settings.publish,
      addresses: settings.publish ? lanAddresses(undefined, ready.port, localHostNames()) : [],
    };
    // A published port is fixed and configurable, so there is nothing to remember for next time.
    if (!settings.publish) await this.remember(ready.port);
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
