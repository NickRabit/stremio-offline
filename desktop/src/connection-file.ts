import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { httpAllowed, parseServerOrigin } from "./origin.js";

const FILE = "connection.json";
const TMP_FILE = "connection.json.tmp";
const LEGACY_NAME = "Server";

export const MAX_PROFILE_NAME = 80;

export interface ServerProfile {
  id: string;
  name: string;
  origin: string;
}

export interface ProfileStore {
  profiles: ServerProfile[];
  selectedProfileId: string | null;
}

export interface ProfileInput {
  name: string;
  origin: string;
}

const emptyStore = (): ProfileStore => ({ profiles: [], selectedProfileId: null });

export function normalizeProfileName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const name = input.trim();
  return name.length > 0 && name.length <= MAX_PROFILE_NAME ? name : null;
}

export function normalizeProfileOrigin(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const server = parseServerOrigin(input);
  if (!server || !httpAllowed(server)) return null;
  return server.origin;
}

export function findProfile(store: ProfileStore, id: string | null): ServerProfile | null {
  if (id === null) return null;
  return store.profiles.find((profile) => profile.id === id) ?? null;
}

export function addProfile(store: ProfileStore, id: string, input: ProfileInput): ProfileStore | null {
  const name = normalizeProfileName(input.name);
  const origin = normalizeProfileOrigin(input.origin);
  if (name === null || origin === null) return null;
  if (id.length === 0 || findProfile(store, id)) return null;
  return { profiles: [...store.profiles, { id, name, origin }], selectedProfileId: id };
}

export function updateProfile(store: ProfileStore, id: string, input: ProfileInput): ProfileStore | null {
  if (!findProfile(store, id)) return null;
  const name = normalizeProfileName(input.name);
  const origin = normalizeProfileOrigin(input.origin);
  if (name === null || origin === null) return null;
  return { ...store, profiles: store.profiles.map((profile) => profile.id === id ? { id, name, origin } : profile) };
}

export function removeProfile(store: ProfileStore, id: string): ProfileStore {
  return {
    profiles: store.profiles.filter((profile) => profile.id !== id),
    selectedProfileId: store.selectedProfileId === id ? null : store.selectedProfileId,
  };
}

export function selectProfile(store: ProfileStore, id: string | null): ProfileStore | null {
  if (id === null) return { ...store, selectedProfileId: null };
  if (!findProfile(store, id)) return null;
  return { ...store, selectedProfileId: id };
}

const readStoredProfile = (value: unknown): ServerProfile | null => {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" && record.id.length > 0 ? record.id : null;
  const name = normalizeProfileName(record.name);
  const origin = normalizeProfileOrigin(record.origin);
  if (id === null || name === null || origin === null) return null;
  return { id, name, origin };
};

const migrateLegacyOrigin = (origin: unknown): ProfileStore => {
  const normalized = normalizeProfileOrigin(origin);
  if (normalized === null) return emptyStore();
  const id = randomUUID();
  return { profiles: [{ id, name: LEGACY_NAME, origin: normalized }], selectedProfileId: id };
};

const readStore = (body: unknown): ProfileStore => {
  if (typeof body !== "object" || body === null) return emptyStore();
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.profiles)) return migrateLegacyOrigin(record.origin);
  const profiles: ServerProfile[] = [];
  for (const entry of record.profiles) {
    const profile = readStoredProfile(entry);
    if (!profile || profiles.some((existing) => existing.id === profile.id)) continue;
    profiles.push(profile);
  }
  const selected = typeof record.selectedProfileId === "string" ? record.selectedProfileId : null;
  const selectedProfileId = profiles.some((profile) => profile.id === selected) ? selected : null;
  return { profiles, selectedProfileId };
};

export async function readProfiles(dir: string): Promise<ProfileStore> {
  let text: string;
  try {
    text = await readFile(path.join(dir, FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw error;
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return emptyStore();
  }
  return readStore(body);
}

export async function writeProfiles(dir: string, store: ProfileStore): Promise<void> {
  if (!Array.isArray(store.profiles)) throw new Error("Invalid profile list");
  const profiles = store.profiles.map((profile) => {
    const normalized = readStoredProfile(profile);
    if (!normalized) throw new Error("Invalid server profile");
    return normalized;
  });
  if (new Set(profiles.map(({ id }) => id)).size !== profiles.length) throw new Error("Duplicate profile id");
  if (store.selectedProfileId !== null && !profiles.some(({ id }) => id === store.selectedProfileId)) {
    throw new Error("Invalid selected profile");
  }
  await mkdir(dir, { recursive: true });
  // Only the three profile fields leave the process: the file never carries a credential.
  const body = JSON.stringify({ profiles, selectedProfileId: store.selectedProfileId }) + "\n";
  const temporary = path.join(dir, `${TMP_FILE}.${randomUUID()}`);
  try {
    await writeFile(temporary, body, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path.join(dir, FILE));
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
