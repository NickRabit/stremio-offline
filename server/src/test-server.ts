import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LISTENING = /INFO Stremio Offline is listening (\{.*\})/;

export interface SpawnedServer {
  child: ChildProcess;
  base: string;
  /** Everything the server wrote to stderr, for assertion messages. */
  log(): string;
  stop(): Promise<void>;
}

/** Boots `index.ts` the way the container runs it, for tests that have no unit seam.
 *  The server binds port 0 itself and the port is read back from its own log line. Probing
 *  for a free port and handing it over is a race: test files run in parallel, and a stub in
 *  another file could take the port first and answer our requests with 200. */
export async function spawnServer(env: Record<string, string>, timeout = 30_000): Promise<SpawnedServer> {
  const child = spawn(process.execPath, ["--import", "tsx", path.join(serverDir, "src", "index.ts")], {
    cwd: serverDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env, PORT: "0", HOST: "127.0.0.1", LOG_LEVEL: "INFO", LOG_STDOUT: "1" },
  });
  let log = "";
  child.stderr?.on("data", (chunk) => { log += String(chunk); });

  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  };

  const port = await new Promise<number>((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for the server to listen\n${log}`)), timeout);
    const onExit = (code: number | null) => finish(new Error(`the server exited with ${code}\n${log}`));
    const onData = (chunk: Buffer) => {
      stdout += String(chunk);
      const match = LISTENING.exec(stdout);
      if (match) finish(undefined, (JSON.parse(match[1]!) as { port: number }).port);
    };
    function finish(error?: Error, value?: number) {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.stdout?.off("data", onData);
      // Keep draining, so a chatty server never blocks on a full pipe.
      child.stdout?.resume();
      if (error) reject(error); else resolve(value!);
    }
    child.once("exit", onExit);
    child.stdout?.on("data", onData);
  }).catch(async (error) => { await stop(); throw error; });

  return { child, base: `http://127.0.0.1:${port}`, log: () => log, stop };
}
