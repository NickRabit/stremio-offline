import type { Server } from "node:http";

/** A narrow view of `process.parentPort`, the channel Electron adds to a utility process. */
export interface UtilityParentPort {
  postMessage(message: unknown): void;
}

/** What the helper needs from an express application, so a test can pass a bare listener. */
export interface Listenable {
  listen(port: number, host: string, onListening: (...args: unknown[]) => void): Server;
}

export interface BoundAddress {
  port: number;
  address: string;
}

export interface BoundServer extends BoundAddress {
  server: Server;
}

export interface StartServerOptions {
  app: Listenable;
  port: number;
  host: string;
  /** The utility parent, when the desktop shell started this process. */
  parentPort?: UtilityParentPort | null;
  env?: NodeJS.ProcessEnv;
}

/** Outside the desktop shell the server keeps listening on every interface, port 8080. */
export function resolveListenTarget(env: NodeJS.ProcessEnv = process.env): { port: number; host: string } {
  return { port: Number(env.PORT ?? 8080), host: env.HOST ?? "0.0.0.0" };
}

export function utilityParentPort(): UtilityParentPort | null {
  const parent = (process as unknown as { parentPort?: unknown }).parentPort;
  if (typeof parent !== "object" || parent === null) return null;
  return typeof (parent as { postMessage?: unknown }).postMessage === "function" ? parent as UtilityParentPort : null;
}

/**
 * Binds the listener and answers with the address the OS handed out. The parent is told only
 * after the bind succeeded, and the actual port is written back to `process.env.PORT` first:
 * internal playback links are built from that variable, so a request for port 0 has to leave
 * it holding the port the socket really took.
 */
export function startServer(options: StartServerOptions): Promise<BoundServer> {
  const env = options.env ?? process.env;
  const parentPort = options.parentPort === undefined ? utilityParentPort() : options.parentPort;
  return new Promise<BoundServer>((resolve, reject) => {
    const fail = (error: NodeJS.ErrnoException) => {
      parentPort?.postMessage({
        type: "error",
        code: typeof error.code === "string" ? error.code : null,
        message: error.message,
      });
      reject(error);
    };
    const server = options.app.listen(options.port, options.host, (...args: unknown[]) => {
      // Express hands this callback to a `listen` failure as well (it registers it once for the
      // error event), so a bind that did not happen can arrive here with an argument. The
      // `error` listener below is the one that reports it, with the code the parent needs.
      if (args.length > 0) return;
      server.removeListener("error", fail);
      const bound = server.address();
      if (bound === null || typeof bound === "string") {
        server.close();
        fail(new Error("The server did not report a bound address."));
        return;
      }
      env.PORT = String(bound.port);
      parentPort?.postMessage({ type: "ready", port: bound.port, address: bound.address });
      resolve({ server, port: bound.port, address: bound.address });
    });
    server.once("error", fail);
  });
}
