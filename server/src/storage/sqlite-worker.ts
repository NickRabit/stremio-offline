import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import type { Migration } from "./migrations.js";
import { parseSqliteVersion, walSafe } from "./sqlite-runtime.js";

type SqlValue = string | number | bigint | null | Uint8Array;

interface Statement {
  sql: string;
  params?: SqlValue[];
}

interface Request {
  id: number;
  op: "run" | "get" | "all" | "batch" | "close";
  sql?: string;
  params?: SqlValue[];
  statements?: Statement[];
}

interface OpenData {
  file: string;
  migrations: readonly Migration[];
}

const PREPARED_CACHE_LIMIT = 200;
if (!parentPort) throw new Error("The SQLite worker requires a parent port.");
const port: NonNullable<typeof parentPort> = parentPort;

const data = workerData as OpenData;
let database: DatabaseSync | undefined;
let closed = false;
const prepared = new Map<string, StatementSync>();

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

function preparedStatement(sql: string): StatementSync {
  const cached = prepared.get(sql);
  if (cached) return cached;
  if (!database) throw new Error("The database is not open.");
  const statement = database.prepare(sql);
  if (prepared.size >= PREPARED_CACHE_LIMIT) {
    const oldest = prepared.keys().next().value;
    if (oldest !== undefined) prepared.delete(oldest);
  }
  prepared.set(sql, statement);
  return statement;
}

function run(sql: string, params: SqlValue[] = []) {
  const result = preparedStatement(sql).run(...params as SQLInputValue[]);
  return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
}

function get(sql: string, params: SqlValue[] = []) {
  return preparedStatement(sql).get(...params as SQLInputValue[]);
}

function all(sql: string, params: SqlValue[] = []) {
  return preparedStatement(sql).all(...params as SQLInputValue[]);
}

function batch(statements: Statement[]): number[] {
  if (!database) throw new Error("The database is not open.");
  database.exec("BEGIN IMMEDIATE");
  try {
    const changes = statements.map((statement) => run(statement.sql, statement.params).changes);
    database.exec("COMMIT");
    return changes;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Keep the original statement failure.
    }
    throw error;
  }
}

function applyMigrations(migrations: readonly Migration[], current: number): number {
  if (!database) throw new Error("The database is not open.");
  let version = current;
  for (const migration of [...migrations].sort((left, right) => left.version - right.version)) {
    if (migration.version <= version) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of migration.statements) database.exec(statement);
      database.exec(`PRAGMA user_version = ${migration.version}`);
      database.exec("COMMIT");
      version = migration.version;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Keep the original migration failure.
      }
      throw error;
    }
  }
  return version;
}

function initialize(): { sqliteVersion: string; journalMode: "wal" | "delete"; schemaVersion: number } {
  const newest = data.migrations.reduce((version, migration) => Math.max(version, migration.version), 0);
  const probe = new DatabaseSync(data.file, { readOnly: true });
  let version: number;
  try {
    const row = probe.prepare("PRAGMA user_version").get();
    version = Number(row?.user_version ?? 0);
  } finally {
    probe.close();
  }
  if (version > newest) {
    throw Object.assign(new Error(`Database schema version ${version} is newer than supported version ${newest}.`), {
      code: "newer-schema",
    });
  }

  database = new DatabaseSync(data.file);
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA synchronous = FULL");
  const sqliteVersion = String(database.prepare("SELECT sqlite_version() AS version").get()?.version ?? "");
  const parsed = parseSqliteVersion(sqliteVersion);
  const requestedJournal = parsed && walSafe(parsed) ? "WAL" : "DELETE";
  database.exec(`PRAGMA journal_mode = ${requestedJournal}`);
  version = applyMigrations(data.migrations, version);
  const journalRow = database.prepare("PRAGMA journal_mode").get();
  const journalMode = String(journalRow?.journal_mode ?? "").toLowerCase() === "wal" ? "wal" : "delete";
  return { sqliteVersion, journalMode, schemaVersion: version };
}

function replyError(id: number, error: unknown) {
  port.postMessage({ id, ok: false, error: { code: "sql", message: messageOf(error) } });
}

function handle(request: Request) {
  if (!database) throw new Error("The database is not open.");
  switch (request.op) {
    case "run": return run(request.sql ?? "", request.params);
    case "get": return get(request.sql ?? "", request.params);
    case "all": return all(request.sql ?? "", request.params);
    case "batch": return batch(request.statements ?? []);
    case "close": return undefined;
  }
}

try {
  const info = initialize();
  port.postMessage({ type: "ready", info: { file: data.file, ...info } });
  port.on("message", (request: Request) => {
    if (closed) return;
    if (request.op === "close") {
      try {
        database?.close();
        database = undefined;
        prepared.clear();
        closed = true;
        port.postMessage({ id: request.id, ok: true, result: undefined });
        port.close();
      } catch (error) {
        replyError(request.id, error);
      }
      return;
    }
    try {
      port.postMessage({ id: request.id, ok: true, result: handle(request) });
    } catch (error) {
      replyError(request.id, error);
    }
  });
} catch (error) {
  const code = (error as { code?: unknown }).code === "newer-schema" ? "newer-schema" : "sql";
  port.postMessage({ type: "open-error", error: { code, message: messageOf(error) } });
  try {
    database?.close();
  } finally {
    port.close();
  }
}
