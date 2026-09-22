import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { httpAllowed, parseServerOrigin } from "./origin.js";

const FILE = "connection.json";
const TMP_FILE = "connection.json.tmp";

export async function readSavedOrigin(dir: string): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(path.join(dir, FILE), "utf8");
  } catch {
    return null;
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const stored = (body as Record<string, unknown>).origin;
  if (typeof stored !== "string") return null;
  const server = parseServerOrigin(stored);
  if (!server || !httpAllowed(server)) return null;
  return server.origin;
}

export async function writeSavedOrigin(dir: string, origin: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const temporary = path.join(dir, TMP_FILE);
  await writeFile(temporary, JSON.stringify({ origin }) + "\n", "utf8");
  await rename(temporary, path.join(dir, FILE));
}
