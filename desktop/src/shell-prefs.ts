import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { renameWithRetry } from "./fs-retry.js";

export const SHELL_PREFS_FILE = "shell-prefs.json";

export const SHELL_LOCALES = ["en", "cs", "sk", "de", "es", "fr", "it", "pl", "pt-BR", "ru"] as const;
export type ShellLocale = (typeof SHELL_LOCALES)[number];

export interface ShellPrefs {
  locale: ShellLocale | null;
  /** Look for a newer release on GitHub at launch and once a day. */
  checkUpdates: boolean;
  /** Whether the close-to-tray balloon has been shown on this install; once is enough. */
  trayNoticeShown: boolean;
}

const isLocale = (value: unknown): value is ShellLocale => SHELL_LOCALES.includes(value as ShellLocale);

/** A missing or malformed value means the default: the check is on. */
const readCheckUpdates = (body: Record<string, unknown>): boolean => body.checkUpdates !== false;

/** Anything but a plain `true` means the balloon has not been shown yet. */
const readTrayNoticeShown = (body: Record<string, unknown>): boolean => body.trayNoticeShown === true;

const defaults = (): ShellPrefs => ({ locale: null, checkUpdates: true, trayNoticeShown: false });

/** The file is read leniently: a missing, unreadable or malformed file, and a value of the wrong
 *  shape, all mean the default -- follow the system for the language, and check for updates. */
export async function readShellPrefs(dir: string): Promise<ShellPrefs> {
  let text: string;
  try {
    text = await readFile(path.join(dir, SHELL_PREFS_FILE), "utf8");
  } catch {
    return defaults();
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return defaults();
  }
  if (typeof body !== "object" || body === null) return defaults();
  const record = body as Record<string, unknown>;
  const locale = record.locale;
  return { locale: isLocale(locale) ? locale : null, checkUpdates: readCheckUpdates(record), trayNoticeShown: readTrayNoticeShown(record) };
}

/** The same read before `whenReady`, where the language switch cannot wait for the async one. */
export function readShellPrefsSync(dir: string): ShellPrefs {
  let text: string;
  try {
    text = readFileSync(path.join(dir, SHELL_PREFS_FILE), "utf8");
  } catch {
    return defaults();
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return defaults();
  }
  if (typeof body !== "object" || body === null) return defaults();
  const record = body as Record<string, unknown>;
  const locale = record.locale;
  return { locale: isLocale(locale) ? locale : null, checkUpdates: readCheckUpdates(record), trayNoticeShown: readTrayNoticeShown(record) };
}

export async function writeShellPrefs(dir: string, prefs: ShellPrefs): Promise<void> {
  await mkdir(dir, { recursive: true });
  const temporary = path.join(dir, `${SHELL_PREFS_FILE}.${randomUUID()}`);
  try {
    await writeFile(temporary,
      JSON.stringify({ locale: prefs.locale, checkUpdates: prefs.checkUpdates, trayNoticeShown: prefs.trayNoticeShown }) + "\n",
      { encoding: "utf8", flag: "wx" });
    await renameWithRetry(temporary, path.join(dir, SHELL_PREFS_FILE));
  } catch (error) {
    await rm(temporary).catch(() => {});
    throw error;
  }
}

/** The explicit choice, else the closest supported system language, else English. */
export function effectiveLocale(choice: ShellLocale | null, systemLocale: string): ShellLocale {
  if (choice !== null) return choice;
  const tag = systemLocale.trim().toLowerCase().replaceAll("_", "-");
  return SHELL_LOCALES.find((locale) => locale.toLowerCase() === tag)
    ?? SHELL_LOCALES.find((locale) => locale.toLowerCase().split("-")[0] === tag.split("-")[0])
    ?? "en";
}
