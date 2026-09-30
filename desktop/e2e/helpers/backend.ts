import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { DESKTOP_DIR } from "./shell.js";

export interface StandInServer {
  origin: string;
  stop(): Promise<void>;
}

/**
 * A second backend for the scenarios that used to need a server on another machine. It is the
 * staged runtime the packaged app carries, so the test needs a build, not Docker.
 */
export async function startStandInServer(root: string): Promise<StandInServer> {
  const entry = path.join(DESKTOP_DIR, "runtime", "server", "dist", "index.js");
  await access(entry).catch(() => {
    throw new Error(`The staged backend is missing (${entry}). Run npm run stage:local-backend -w desktop first.`);
  });
  const dataDir = path.join(root, "stand-in", "data");
  const downloadDir = path.join(root, "stand-in", "downloads");
  await mkdir(dataDir, { recursive: true });
  await mkdir(downloadDir, { recursive: true });
  // Without this the first boot fetches Cinemeta and OpenSubtitles, which is slow and online.
  await writeFile(path.join(dataDir, "state.json"), `${JSON.stringify({ addons: [], defaultsInstalled: true })}\n`);

  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      DOWNLOAD_DIR: downloadDir,
      PORT: "0",
      HOST: "127.0.0.1",
      HOST_CHECK: "loopback",
      LOG_STDOUT: "1",
      LIBRARY_AUTO_SCAN: "0",
      ADDON_AUTO_REFRESH: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Drained so a chatty run cannot fill the pipe, and kept in the log when a scenario fails.
  child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[stand-in backend] ${chunk}`));
  child.stderr?.on("data", (chunk: Buffer) => process.stdout.write(`[stand-in backend] ${chunk}`));
  const origin = await waitForOrigin(child, path.join(dataDir, "app.log"));
  return { origin, stop: () => stopChild(child) };
}

function waitForOrigin(child: ChildProcess, logFile: string, timeoutMs = 60_000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let output = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error("The stand-in backend did not report a port in time.")), timeoutMs);
    const finish = (error: Error | null, origin?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      child.stdout?.off("data", onStdout);
      if (error) reject(error);
      else resolve(origin as string);
    };
    const onStdout = (chunk: Buffer) => {
      output += chunk.toString();
      const port = portFrom(output);
      if (port !== null) finish(null, `http://127.0.0.1:${port}`);
    };
    child.stdout?.on("data", onStdout);
    child.once("exit", (code) => finish(new Error(`The stand-in backend exited before it was ready (code ${code}).`)));

    // The log file is written as the line is printed; a run that loses the pipe still answers.
    const poll = setInterval(async () => {
      const text = await readFile(logFile, "utf8").catch(() => "");
      const port = portFrom(text);
      if (port !== null) finish(null, `http://127.0.0.1:${port}`);
    }, 250);
    poll.unref();
  });
}

const portFrom = (text: string): number | null => {
  const match = /is listening \{.*?"port":(\d+)/.exec(text);
  return match ? Number(match[1]) : null;
};

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const killed = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 5_000)),
  ]);
  if (killed) { child.kill("SIGKILL"); await exited; }
}

/** What the desktop app would have asked for if a person had signed in to the local backend. */
export async function signIn(origin: string): Promise<string> {
  const response = await fetch(`${origin}/api/auth/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "e2e-admin", password: "e2e-password" }),
  });
  if (!response.ok) throw new Error(`The local backend refused the account setup (HTTP ${response.status}).`);
  const cookie = response.headers.getSetCookie()[0];
  if (!cookie) throw new Error("The local backend answered without a session cookie.");
  return cookie.split(";")[0];
}

export interface HeldTransfer {
  stop(): void;
}

/**
 * Saves a file from the local library to this machine over a connection that is never read.
 * The server keeps the transfer open, so the app reports work in progress until it is stopped.
 */
export async function holdDeviceTransfer(origin: string, cookie: string, downloads: string): Promise<HeldTransfer> {
  const file = path.join(downloads, "hold.mp4");
  await writeFile(file, Buffer.alloc(8 * 1024 * 1024));

  const libraries = await api<Array<{ id: string }>>(origin, cookie, "/api/libraries");
  const library = libraries[0];
  if (!library) throw new Error("The local backend has no library to save from.");
  const source = await api<{ sourceId: string }>(origin, cookie, "/api/library/source", {
    path: `${library.id}/${path.basename(file)}`,
  });
  const ticket = await api<{ url: string }>(origin, cookie, "/api/device-download", {
    title: "Hold",
    sourceId: source.sourceId,
  });

  const url = new URL(ticket.url, origin);
  const request = http.get({ host: url.hostname, port: url.port, path: url.pathname, headers: { cookie } });
  request.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    request.once("response", () => resolve());
    request.once("error", reject);
  });
  return { stop: () => request.destroy() };
}

async function api<T>(origin: string, cookie: string, route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${origin}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${route} answered HTTP ${response.status} from the local backend.`);
  return await response.json() as T;
}
