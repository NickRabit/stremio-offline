import { randomBytes, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { link, lstat, mkdir, open, opendir, readFile, rm } from "node:fs/promises";
import { INSTANCE_DIRECTORY } from "./local-backend.js";
import { pathFor } from "./platform.js";

/** A deployment override always wins and is never created, read or repaired here. */
export const MEDIA_SERVER_KEY_FILE_ENV = "MEDIA_SERVER_KEY_FILE";
/** The key lives beside the instance directory, so a metadata-only backup never carries it. */
export const MEDIA_SERVER_KEY_NAME = "media-server.key";
/** The vault the server keeps beside `state.json`, inside the instance directory. */
export const MEDIA_SERVER_SECRETS_DIRECTORY = "media-server-secrets";
const KEY_BYTES = 32;
const OWNER_ONLY = 0o600;

/** What happened while preparing the key, for a caller that wants one generic log line. */
export type MediaKeyOutcome = "existing" | "created" | "declined" | "failed";

/** Prepares the key path for a launch. Injected in tests; the production default really creates a
 *  first-run key, so an injected collaborator must not be a silent no-op. */
export type PrepareMediaServerKey = (
  userDataDir: string,
  parentEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
) => Promise<string>;

/** The default key path for a user-data directory, with no filesystem access. */
export function mediaServerKeyPath(userDataDir: string, platform: NodeJS.Platform = process.platform): string {
  return pathFor(platform).join(userDataDir, MEDIA_SERVER_KEY_NAME);
}

/** `lstat` that answers `null` only for a genuinely absent path; anything else is rethrown. */
async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** True when `state.json` already binds a stored credential, or is unreadable or malformed --
 *  all of which mean a missing key is not a first run. A state without the media fields, or with
 *  an empty connection list, proves nothing and is safe. */
async function stateBindsSecret(stateFile: string): Promise<boolean> {
  const info = await lstatOrNull(stateFile);
  if (info === null) return false;
  if (info.isSymbolicLink() || !info.isFile()) return true;
  let text: string;
  try {
    text = await readFile(stateFile, "utf8");
  } catch {
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return true;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return true;
  const connections = (parsed as Record<string, unknown>).mediaConnections;
  if (connections === undefined) return false;
  if (!Array.isArray(connections)) return true;
  return connections.some((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const ref = (entry as Record<string, unknown>).secretRef;
    return typeof ref === "string" && ref.length > 0;
  });
}

/** Any entry in the vault directory is credential evidence: a stored token, an interrupted write,
 *  anything at all. A missing directory is empty, an unreadable or unsafe one declines. */
async function vaultHasEntries(vaultDir: string): Promise<boolean> {
  const info = await lstatOrNull(vaultDir);
  if (info === null) return false;
  if (info.isSymbolicLink() || !info.isDirectory()) return true;
  let handle;
  try {
    handle = await opendir(vaultDir);
  } catch {
    return true;
  }
  for await (const _entry of handle) return true;
  return false;
}

/** Whether already-encrypted material proves the install is not in its first run. */
async function hasCredentialEvidence(userDataDir: string, platform: NodeJS.Platform): Promise<boolean> {
  const target = pathFor(platform);
  const instance = target.join(userDataDir, INSTANCE_DIRECTORY);
  const info = await lstatOrNull(instance);
  // An instance path that is a symlink, a file or anything but a directory is not something to
  // read evidence through; declining keeps the key from appearing beside an unknown layout.
  if (info !== null && (info.isSymbolicLink() || !info.isDirectory())) return true;
  if (await stateBindsSecret(target.join(instance, "state.json"))) return true;
  return vaultHasEntries(target.join(instance, MEDIA_SERVER_SECRETS_DIRECTORY));
}

/** The user-data directory must be, or become, a real directory. A symlink is never followed. */
async function ensureRealDirectory(userDataDir: string): Promise<boolean> {
  const before = await lstatOrNull(userDataDir);
  if (before !== null) return before.isDirectory();
  await mkdir(userDataDir, { recursive: true, mode: 0o700 });
  const after = await lstatOrNull(userDataDir);
  return after !== null && after.isDirectory();
}

/** Writes 32 random bytes to a unique temp file, fsyncs and closes it, then publishes it as the
 *  key with a hard link. A concurrently created key wins: `EEXIST` leaves the winner's bytes in
 *  place. The temp file is removed either way, and no rename ever replaces an existing key. */
async function publishKey(userDataDir: string, intended: string, platform: NodeJS.Platform): Promise<MediaKeyOutcome> {
  const temp = pathFor(platform).join(userDataDir, `${MEDIA_SERVER_KEY_NAME}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temp, "wx", OWNER_ONLY);
    try {
      await handle.writeFile(randomBytes(KEY_BYTES));
      await handle.sync();
    } finally {
      await handle.close().catch(() => {});
    }
    const info = await lstat(temp);
    if (!info.isFile()) return "declined";
    if (platform !== "win32") {
      // Windows inherits the user profile's ACL from the containing directory; the creation mode
      // is not a claim about that ACL, so only POSIX checks the owner and the mode bits.
      if ((info.mode & 0o077) !== 0) return "declined";
      const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
      if (uid !== undefined && info.uid !== uid) return "declined";
    }
    try {
      await link(temp, intended);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return "existing";
    }
    return "created";
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

/** Locates or, only for a genuine first run, creates the desktop media-server key. Returns the
 *  path the backend should be pointed at, whatever happened: an existing file, a symlink, a
 *  malformed state or unreadable vault all leave the intended path untouched so the backend
 *  fails closed on its own, and the application still starts. */
export async function establishDesktopMediaKey(
  userDataDir: string,
  intended: string,
  platform: NodeJS.Platform,
): Promise<MediaKeyOutcome> {
  try {
    if ((await lstatOrNull(intended)) !== null) return "existing";
    if (!(await ensureRealDirectory(userDataDir))) return "declined";
    if (await hasCredentialEvidence(userDataDir, platform)) return "declined";
    return await publishKey(userDataDir, intended, platform);
  } catch {
    return "failed";
  }
}

/** The path the desktop backend should read its key from. A non-blank `MEDIA_SERVER_KEY_FILE` in
 *  the parent environment is a deployment override and is returned exactly as it is. Otherwise a
 *  new 32-byte random key is created at the default path only when no encrypted credential
 *  already exists; a missing or corrupt key is never silently replaced. */
export async function prepareDesktopMediaKey(
  userDataDir: string,
  parentEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  log?: (line: string) => void,
): Promise<string> {
  const override = parentEnv[MEDIA_SERVER_KEY_FILE_ENV];
  if (typeof override === "string" && override.trim().length > 0) return override;
  const intended = mediaServerKeyPath(userDataDir, platform);
  const outcome = await establishDesktopMediaKey(userDataDir, intended, platform);
  if (outcome === "declined") {
    log?.("The desktop media-server key was not created because this install may already hold encrypted credentials.");
  } else if (outcome === "failed") {
    log?.("The desktop media-server key could not be prepared; remote-server credentials cannot be stored.");
  }
  return intended;
}
