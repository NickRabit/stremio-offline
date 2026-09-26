import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const SHELL_PREFS_FILE = "shell-prefs.json";

export type ShellLocale = "cs" | "en";

export interface ShellPrefs {
  locale: ShellLocale | null;
}

const isLocale = (value: unknown): value is ShellLocale => value === "cs" || value === "en";

/** The file is read leniently: a missing, unreadable or malformed file and a value of the wrong
 *  shape all mean "follow the system". */
export async function readShellPrefs(dir: string): Promise<ShellPrefs> {
  let text: string;
  try {
    text = await readFile(path.join(dir, SHELL_PREFS_FILE), "utf8");
  } catch {
    return { locale: null };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { locale: null };
  }
  if (typeof body !== "object" || body === null) return { locale: null };
  const locale = (body as Record<string, unknown>).locale;
  return { locale: isLocale(locale) ? locale : null };
}

export async function writeShellPrefs(dir: string, prefs: ShellPrefs): Promise<void> {
  await mkdir(dir, { recursive: true });
  const temporary = path.join(dir, `${SHELL_PREFS_FILE}.${randomUUID()}`);
  try {
    await writeFile(temporary, JSON.stringify({ locale: prefs.locale }) + "\n", { encoding: "utf8", flag: "wx" });
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
