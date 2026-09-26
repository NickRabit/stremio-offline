import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const SETTINGS_FILE = "local-settings.json";

export interface LocalSettings {
  allowPrivateAddons: boolean;
}

export const defaultLocalSettings = (): LocalSettings => ({ allowPrivateAddons: false });

/** The file is read leniently: unknown fields are dropped and a bad value means the default. */
const settingsFromStored = (body: unknown): LocalSettings => {
  if (typeof body !== "object" || body === null) return defaultLocalSettings();
  const value = (body as Record<string, unknown>).allowPrivateAddons;
  return { allowPrivateAddons: typeof value === "boolean" ? value : false };
};

export async function readLocalSettings(dir: string): Promise<LocalSettings> {
  let text: string;
  try {
    text = await readFile(path.join(dir, SETTINGS_FILE), "utf8");
  } catch {
    return defaultLocalSettings();
  }
  try {
    return settingsFromStored(JSON.parse(text));
  } catch {
    return defaultLocalSettings();
  }
}

export async function writeLocalSettings(dir: string, settings: LocalSettings): Promise<void> {
  await mkdir(dir, { recursive: true });
  const temporary = path.join(dir, `${SETTINGS_FILE}.${randomUUID()}`);
  try {
    await writeFile(temporary, JSON.stringify({ allowPrivateAddons: settings.allowPrivateAddons }) + "\n", { encoding: "utf8", flag: "wx" });
    await rename(temporary, path.join(dir, SETTINGS_FILE));
  } catch (error) {
    await rm(temporary).catch(() => {});
    throw error;
  }
}

/** The page is the only caller, and this is the whole shape it may send over IPC. */
export function parseLocalSettings(input: unknown): LocalSettings | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "allowPrivateAddons") return null;
  return typeof record.allowPrivateAddons === "boolean" ? { allowPrivateAddons: record.allowPrivateAddons } : null;
}
