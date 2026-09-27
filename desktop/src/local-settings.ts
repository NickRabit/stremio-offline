import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const SETTINGS_FILE = "local-settings.json";

export interface LocalSettings {
  allowPrivateAddons: boolean;
  publish: boolean;
  publishPort: number;
  /** The folder the local backend downloads to; null means `<userData>/downloads`. */
  downloadDir: string | null;
}

const DEFAULT_PUBLISH_PORT = 8091;
const MAX_DOWNLOAD_DIR = 1024;

export const defaultLocalSettings = (): LocalSettings =>
  ({ allowPrivateAddons: false, publish: false, publishPort: DEFAULT_PUBLISH_PORT, downloadDir: null });

const validPort = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535;

const validDownloadDir = (value: unknown): value is string =>
  typeof value === "string" && path.isAbsolute(value) && value.length <= MAX_DOWNLOAD_DIR && !value.includes("\0");

/** The file is read leniently: unknown fields are dropped and a bad value means the default. */
const settingsFromStored = (body: unknown): LocalSettings => {
  if (typeof body !== "object" || body === null) return defaultLocalSettings();
  const record = body as Record<string, unknown>;
  return {
    allowPrivateAddons: typeof record.allowPrivateAddons === "boolean" ? record.allowPrivateAddons : false,
    publish: typeof record.publish === "boolean" ? record.publish : false,
    publishPort: validPort(record.publishPort) ? record.publishPort : DEFAULT_PUBLISH_PORT,
    downloadDir: validDownloadDir(record.downloadDir) ? record.downloadDir : null,
  };
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
    await writeFile(temporary, JSON.stringify({
      allowPrivateAddons: settings.allowPrivateAddons,
      publish: settings.publish,
      publishPort: settings.publishPort,
      downloadDir: settings.downloadDir,
    }) + "\n", { encoding: "utf8", flag: "wx" });
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
  const keys = Object.keys(record).sort();
  if (keys.length !== 4 || keys[0] !== "allowPrivateAddons" || keys[1] !== "downloadDir" || keys[2] !== "publish" || keys[3] !== "publishPort") return null;
  if (typeof record.allowPrivateAddons !== "boolean" || typeof record.publish !== "boolean" || !validPort(record.publishPort)) return null;
  const downloadDir = record.downloadDir;
  if (downloadDir !== null && !validDownloadDir(downloadDir)) return null;
  return {
    allowPrivateAddons: record.allowPrivateAddons,
    publish: record.publish,
    publishPort: record.publishPort,
    downloadDir: downloadDir === null ? null : downloadDir,
  };
}
