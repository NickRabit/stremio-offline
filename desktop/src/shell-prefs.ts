import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const SHELL_PREFS_FILE = "shell-prefs.json";

export type ShellLocale = "cs" | "en";

export interface ShellPrefs {
  locale: ShellLocale | null;
  /** Look for a newer release on GitHub at launch and once a day. */
  checkUpdates: boolean;
}

const isLocale = (value: unknown): value is ShellLocale => value === "cs" || value === "en";

/** A missing or malformed value means the default: the check is on. */
const readCheckUpdates = (body: Record<string, unknown>): boolean => body.checkUpdates !== false;

/** The file is read leniently: a missing, unreadable or malformed file, and a value of the wrong
 *  shape, all mean the default -- follow the system for the language, and check for updates. */
export async function readShellPrefs(dir: string): Promise<ShellPrefs> {
  let text: string;
  try {
    text = await readFile(path.join(dir, SHELL_PREFS_FILE), "utf8");
  } catch {
    return { locale: null, checkUpdates: true };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { locale: null, checkUpdates: true };
  }
  if (typeof body !== "object" || body === null) return { locale: null, checkUpdates: true };
  const record = body as Record<string, unknown>;
  const locale = record.locale;
  return { locale: isLocale(locale) ? locale : null, checkUpdates: readCheckUpdates(record) };
}

/** The same read before `whenReady`, where the language switch cannot wait for the async one. */
export function readShellPrefsSync(dir: string): ShellPrefs {
  let text: string;
  try {
    text = readFileSync(path.join(dir, SHELL_PREFS_FILE), "utf8");
  } catch {
    return { locale: null, checkUpdates: true };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { locale: null, checkUpdates: true };
  }
  if (typeof body !== "object" || body === null) return { locale: null, checkUpdates: true };
  const record = body as Record<string, unknown>;
  const locale = record.locale;
  return { locale: isLocale(locale) ? locale : null, checkUpdates: readCheckUpdates(record) };
}

export async function writeShellPrefs(dir: string, prefs: ShellPrefs): Promise<void> {
  await mkdir(dir, { recursive: true });
  const temporary = path.join(dir, `${SHELL_PREFS_FILE}.${randomUUID()}`);
  try {
    await writeFile(temporary, JSON.stringify({ locale: prefs.locale, checkUpdates: prefs.checkUpdates }) + "\n", { encoding: "utf8", flag: "wx" });
    await rename(temporary, path.join(dir, SHELL_PREFS_FILE));
  } catch (error) {
    await rm(temporary).catch(() => {});
    throw error;
  }
}

/** The explicit choice, else Czech when the system speaks it, else English. */
export function effectiveLocale(choice: ShellLocale | null, systemLocale: string): ShellLocale {
  if (choice !== null) return choice;
  return systemLocale.trim().toLowerCase().startsWith("cs") ? "cs" : "en";
}
