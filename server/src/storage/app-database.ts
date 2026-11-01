import { chmodSync, closeSync, mkdirSync, openSync, statSync } from "node:fs";
import path, { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { MIGRATIONS, type Migration } from "./migrations.js";

export type StorageErrorCode = "closed" | "busy" | "broken" | "newer-schema" | "sql";

export class StorageError extends Error {
  constructor(readonly code: StorageErrorCode, message: string = code) {
    super(message);
    this.name = "StorageError";
  }
}

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface Statement {
  sql: string;
  params?: SqlValue[];
}

export interface AppDatabaseInfo {
  file: string;
  sqliteVersion: string;
  journalMode: "wal" | "delete";
  schemaVersion: number;
}

export interface AppDatabase {
  readonly info: AppDatabaseInfo;
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number; lastInsertRowid: number | bigint }>;
  get<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): Promise<T | undefined>;
  all<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): Promise<T[]>;
  batch(statements: Statement[]): Promise<number[]>;
  close(): Promise<void>;
  readonly state: "open" | "closing" | "closed" | "broken";
}

export interface OpenAppDatabaseOptions {
  dataDir: string;
  fileName?: string;
  migrations?: readonly Migration[];
  maxPending?: number;
  onWorker?: (worker: Worker) => void;
}

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: StorageError): void;
}

interface WorkerReply {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
}

interface ReadyMessage {
  type: "ready";
  info: AppDatabaseInfo;
}

interface OpenErrorMessage {
  type: "open-error";
  error?: { code?: string; message?: string };
}

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

function prepareFile(file: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  closeSync(openSync(file, "a", 0o600));
  if (process.platform !== "win32" && (statSync(file).mode & 0o177) !== 0) chmodSync(file, 0o600);
}

function storageCode(code: unknown): StorageErrorCode {
  return code === "newer-schema" ? "newer-schema" : "sql";
}

const workerExtension = extname(fileURLToPath(import.meta.url));
const workerUrl = new URL(`./sqlite-worker${workerExtension}`, import.meta.url);

export async function openAppDatabase(options: OpenAppDatabaseOptions): Promise<AppDatabase> {
  const file = path.join(options.dataDir, options.fileName ?? "application.sqlite");
  const migrations = options.migrations ?? MIGRATIONS;
  const maxPending = options.maxPending ?? 1000;
  if (!Number.isInteger(maxPending) || maxPending < 1) throw new TypeError("maxPending must be a positive integer.");

  try {
    prepareFile(file);
  } catch (error) {
    throw new StorageError("sql", messageOf(error));
  }

  return new Promise<AppDatabase>((resolveOpen, rejectOpen) => {
    let worker: Worker;
    try {
      worker = new Worker(workerUrl, { workerData: { file, migrations } });
    } catch (error) {
      rejectOpen(new StorageError("sql", messageOf(error)));
      return;
    }

    let state: AppDatabase["state"] = "open";
    let persistedInfo: AppDatabaseInfo | undefined;
    let nextId = 1;
    let openSettled = false;
    let closeRequested = false;
    let resolveClose: (() => void) | undefined;
    let rejectClose: ((error: StorageError) => void) | undefined;
    let closePromise: Promise<void> | undefined;
    const pending = new Map<number, PendingCall>();

    const broken = (detail?: string) => {
      if (state === "broken" || state === "closed") return;
      state = "broken";
      const error = new StorageError("broken", detail);
      void worker.terminate();
      for (const call of pending.values()) call.reject(error);
      pending.clear();
      if (!openSettled) {
        openSettled = true;
        rejectOpen(error);
      }
      rejectClose?.(error);
    };

    const sendCloseIfDrained = () => {
      if (state !== "closing" || closeRequested || pending.size > 0) return;
      closeRequested = true;
      try {
        worker.postMessage({ id: 0, op: "close" });
      } catch (error) {
        broken(messageOf(error));
      }
    };

    const closedWithError = (message: string) => new StorageError("closed", message);

    const enqueue = <T>(request: Record<string, unknown>): Promise<T> => {
      if (state === "broken") return Promise.reject(new StorageError("broken"));
      if (state !== "open") return Promise.reject(closedWithError("The database is closed."));
      if (pending.size >= maxPending) return Promise.reject(new StorageError("busy"));
      const id = nextId++;
      const promise = new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      });
      try {
        worker.postMessage({ id, ...request });
      } catch (error) {
        pending.delete(id);
        return Promise.reject(new StorageError("sql", messageOf(error)));
      }
      return promise;
    };

    worker.on("message", (message: ReadyMessage | OpenErrorMessage | WorkerReply) => {
      if ("type" in message) {
        if (message.type === "ready") {
          if (openSettled) {
            broken("The database worker reported readiness more than once.");
            return;
          }
          persistedInfo = message.info;
          try {
            options.onWorker?.(worker);
          } catch (error) {
            broken(messageOf(error));
            return;
          }
          openSettled = true;
          resolveOpen(database);
          return;
        }
        if (openSettled) return;
        openSettled = true;
        state = "broken";
        rejectOpen(new StorageError(storageCode(message.error?.code), message.error?.message));
        return;
      }

      if (message.id === 0) {
        if (!message.ok) broken(message.error?.message ?? "The database worker could not close.");
        return;
      }
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      if (message.ok) call.resolve(message.result);
      else call.reject(new StorageError("sql", message.error?.message));
      sendCloseIfDrained();
    });

    worker.on("error", (error) => broken(messageOf(error)));
    worker.on("messageerror", (error) => broken(messageOf(error)));
    worker.on("exit", (code) => {
      if (state === "closing" && closeRequested && code === 0) {
        state = "closed";
        resolveClose?.();
        return;
      }
      broken(`The database worker exited unexpectedly with code ${code}.`);
      rejectClose?.(new StorageError("broken", `The database worker exited unexpectedly with code ${code}.`));
    });

    const database: AppDatabase = {
      get info() {
        if (!persistedInfo) throw new Error("The database is not ready.");
        return persistedInfo;
      },
      get state() {
        return state;
      },
      run: (sql, params) => enqueue({ op: "run", sql, params }),
      get: (sql, params) => enqueue({ op: "get", sql, params }),
      all: (sql, params) => enqueue({ op: "all", sql, params }),
      batch: (statements) => enqueue({ op: "batch", statements }),
      close() {
        if (state === "closed") return Promise.resolve();
        if (state === "broken") return Promise.reject(new StorageError("broken"));
        if (state === "closing") return closePromise!;
        state = "closing";
        closePromise = new Promise<void>((resolve, reject) => {
          resolveClose = resolve;
          rejectClose = reject;
          sendCloseIfDrained();
        });
        return closePromise;
      },
    };
  });
}
