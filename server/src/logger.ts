import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
const ORDER: Record<LogLevel, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const LEVELS = Object.keys(ORDER) as LogLevel[];

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 7;
const MAINTENANCE_MS = 6 * 60 * 60 * 1000;

let chain = Promise.resolve();
let filename = path.join(process.env.DATA_DIR ?? "/data", "app.log");
let written = 0;
let threshold = ORDER.INFO;
let maxBytes = DEFAULT_MAX_BYTES;
let mirror = true;
let retentionDays = DEFAULT_RETENTION_DAYS;

export function parseLevel(value: unknown): LogLevel | undefined {
  const name = String(value ?? "").trim().toUpperCase();
  return LEVELS.includes(name as LogLevel) ? name as LogLevel : undefined;
}
export const currentLevel = (): LogLevel => LEVELS.find((level) => ORDER[level] === threshold) ?? "INFO";

/** What the server writes down, which is not the same as what the interface shows: a line that
 *  was never recorded cannot be filtered back into view. Set from the settings, so asking for
 *  detail does not mean editing the container. */
export function setLevel(level: LogLevel) { threshold = ORDER[level]; }

export async function initLogger(dataDir = process.env.DATA_DIR ?? "/data") {
  filename = path.join(dataDir, "app.log");
  threshold = ORDER[parseLevel(process.env.LOG_LEVEL) ?? "INFO"];
  maxBytes = Math.max(64 * 1024, Number(process.env.LOG_MAX_BYTES) || DEFAULT_MAX_BYTES);
  mirror = process.env.LOG_STDOUT !== "0";
  // Zero switches the cleanup off, otherwise older entries are dropped. Without it the log
  // only grows and stops being of any use: nobody finds last week's error among a million lines.
  retentionDays = Math.max(0, Number(process.env.LOG_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS) || 0);
  await mkdir(dataDir, { recursive: true });
  written = await stat(filename).then((info) => info.size, () => 0);
}

// Anything that looks like an address is reduced to scheme and host. Stream URLs carry
// access tokens in the query string, and the log is something users hand out when asking
// for help -- so the redaction has to happen here, not at every call site.
const SENSITIVE_KEY = /token|password|secret|authorization|cookie|api[-_]?key|airplay/i;
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/gi;
const MAX_STRING = 600;

const shortenUrl = (value: string) => {
  try { const url = new URL(value); return `${url.protocol}//${url.host}${url.pathname.length > 1 ? "/…" : ""}`; }
  catch { return "<url>"; }
};
const redactText = (value: string) => {
  const clean = value.replace(URL_PATTERN, shortenUrl).replace(/([?&]airplay=)[A-Za-z0-9_-]+/gi, "$1***");
  return clean.length > MAX_STRING ? `${clean.slice(0, MAX_STRING)}…` : clean;
};
/** A log line is one line: a newline in a message must not split it into a second record
 *  that reads as though the server wrote it. */
const singleLine = (value: string) => value.replace(/[\r\n]+/g, " ");

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (value === undefined) return undefined;
  if (depth >= 4) return "…";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactValue(item, depth + 1));
  if (value instanceof Error) return redactText(value.stack ?? value.message);
  if (typeof value === "object") return redactContext(value as Record<string, unknown>, depth + 1);
  return redactText(String(value));
}

function redactContext(context: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined) continue;
    result[key] = SENSITIVE_KEY.test(key) ? "***" : redactValue(value, depth);
  }
  return result;
}

/** Rotation keeps a single previous generation. Two bounded files beat one that grows
 * until the volume is full and nobody notices. */
async function write(line: string) {
  const size = Buffer.byteLength(line);
  if (written + size > maxBytes && written > 0) {
    await rename(filename, `${filename}.1`).catch(() => undefined);
    written = 0;
  }
  await appendFile(filename, line, { mode: 0o600 });
  written += size;
}

export function log(level: LogLevel, message: string, context?: Record<string, unknown>) {
  if (ORDER[level] < threshold) return;
  const payload = context ? redactContext(context) : undefined;
  const details = payload && Object.keys(payload).length ? ` ${JSON.stringify(payload)}` : "";
  // The message is redacted exactly like a context value: it may carry a stream address with
  // a token just as easily, and the log is what a user hands out when asking for help.
  const line = `${new Date().toISOString()} ${level} ${singleLine(redactText(message))}${details}\n`;
  if (mirror) (level === "ERROR" ? process.stderr : process.stdout).write(line);
  chain = chain.then(() => write(line)).catch(() => undefined);
}

/** Writing is fire-and-forget; tests and shutdown paths need a way to wait for the queue. */
export const flushLog = () => chain;

const levelOf = (line: string): LogLevel | undefined => parseLevel(line.split(" ")[1]);
const timeOf = (line: string) => { const value = Date.parse(line.slice(0, 24)); return Number.isNaN(value) ? undefined : value; };

/** Deletes the whole log, the rotated generation included. */
export async function clearLog() {
  chain = chain.then(async () => {
    await writeFile(filename, "", { mode: 0o600 });
    await rm(`${filename}.1`, { force: true });
    written = 0;
  }).catch(() => undefined);
  await chain;
}

/** Drops entries older than the retention period. A line with no recognised timestamp is kept,
 * so an unknown format does not lose something that matters. */
export async function pruneLog(days = retentionDays) {
  if (!days) return 0;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  chain = chain.then(async () => {
    await rm(`${filename}.1`, { force: true }).catch(() => undefined);
    const text = await readFile(filename, "utf8").catch(() => "");
    if (!text) return;
    const lines = text.split("\n").filter(Boolean);
    const kept = lines.filter((line) => { const at = timeOf(line); return at === undefined || at >= cutoff; });
    removed = lines.length - kept.length;
    if (!removed) return;
    const next = kept.length ? `${kept.join("\n")}\n` : "";
    await writeFile(filename, next, { mode: 0o600 });
    written = Buffer.byteLength(next);
  }).catch(() => undefined);
  await chain;
  if (removed) log("INFO", "Old log entries removed", { removed, keptDays: days });
  return removed;
}

/** The cleanup runs at start-up and then every six hours; more often it would have nothing to do. */
export function startLogMaintenance() {
  if (!retentionDays) return;
  void pruneLog();
  setInterval(() => void pruneLog(), MAINTENANCE_MS).unref();
}

export async function readLog(options: { tail?: number; level?: LogLevel; hours?: number; search?: string } = {}) {
  const previous = await readFile(`${filename}.1`, "utf8").catch(() => "");
  const current = await readFile(filename, "utf8").catch(() => "");
  let lines = `${previous}${current}`.split("\n").filter(Boolean);
  if (options.level) {
    const minimum = ORDER[options.level];
    // A line without a recognised level is kept: better an extra line than a lost one.
    lines = lines.filter((line) => { const level = levelOf(line); return !level || ORDER[level] >= minimum; });
  }
  if (options.hours) {
    const from = Date.now() - options.hours * 60 * 60 * 1000;
    lines = lines.filter((line) => { const at = timeOf(line); return at === undefined || at >= from; });
  }
  if (options.search) {
    const needle = options.search.toLowerCase();
    lines = lines.filter((line) => line.toLowerCase().includes(needle));
  }
  if (options.tail && lines.length > options.tail) lines = lines.slice(-options.tail);
  if (lines.length) return `${lines.join("\n")}\n`;
  // An empty filter result is not the same as an empty log; a message would look like
  // just another entry in the interface.
  const filtered = Boolean(options.level || options.hours || options.search);
  return filtered ? "" : "The log has no entries yet.\n";
}
