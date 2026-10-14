import { randomBytes, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { link, lstat, mkdir, open, opendir, readFile, rm } from "node:fs/promises";
import path from "node:path";

/** A deployment override always wins and is never created, read or repaired here. */
export const MEDIA_SERVER_KEY_FILE_ENV = "MEDIA_SERVER_KEY_FILE";
/** Default file name inside the data directory. A full copy of that directory is the backup. */
export const MEDIA_SERVER_KEY_NAME = "media-server.key";
/** The vault the server keeps beside `state.json`. */
export const MEDIA_SERVER_SECRETS_DIRECTORY = "media-server-secrets";
const KEY_BYTES = 32;
const OWNER_ONLY = 0o600;

/** What happened while preparing the key, for a caller that wants one generic log line.
 *  `exposed` was already explained by the call that refused to publish the file. */
export type MediaKeyOutcome = "existing" | "created" | "declined" | "exposed" | "failed";

export type MediaKeyLog = (level: "INFO" | "WARN", line: string) => void;

/** The default key path for a data directory, with no filesystem access. */
export function mediaServerKeyPath(dataDir: string): string {
  return path.join(dataDir, MEDIA_SERVER_KEY_NAME);
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
async function hasCredentialEvidence(dataDir: string): Promise<boolean> {
  if (await stateBindsSecret(path.join(dataDir, "state.json"))) return true;
  return vaultHasEntries(path.join(dataDir, MEDIA_SERVER_SECRETS_DIRECTORY));
}

/** The data directory must be, or become, a real directory. A symlink is never followed. */
async function ensureRealDirectory(dataDir: string): Promise<boolean> {
  const before = await lstatOrNull(dataDir);
  if (before !== null) return before.isDirectory();
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const after = await lstatOrNull(dataDir);
  return after !== null && after.isDirectory();
}

/** Writes 32 random bytes to a unique temp file, fsyncs and closes it, then publishes it as the
 *  key with a hard link. A concurrently created key wins: `EEXIST` leaves the winner's bytes in
 *  place. The temp file is removed either way, and no rename ever replaces an existing key.
 *
 *  The mode passed to `open` is not what a shared folder keeps. Synology's `docker` share grants
 *  Everyone read on every new file, so the inode comes back group- or world-readable and would be
 *  discarded. Tighten the descriptor just written, then judge that inode, not a path that could
 *  have been swapped since. */
async function publishKey(dataDir: string, intended: string, log?: MediaKeyLog): Promise<MediaKeyOutcome> {
  const temp = path.join(dataDir, `${MEDIA_SERVER_KEY_NAME}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temp, "wx", OWNER_ONLY);
    const info = await (async () => {
      try {
        await handle.writeFile(randomBytes(KEY_BYTES));
        if (process.platform !== "win32") await handle.chmod(OWNER_ONLY);
        await handle.sync();
        return await handle.stat();
      } finally {
        await handle.close().catch(() => {});
      }
    })();
    if (!info.isFile()) return "failed";
    if (process.platform !== "win32") {
      const mode = info.mode & 0o777;
      const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
      const foreignOwner = uid !== undefined && info.uid !== uid;
      if ((mode & 0o077) !== 0 || foreignOwner) {
        const why = foreignOwner
          ? "the new file is not owned by the server user"
          : "the data directory left the new file readable by other accounts";
        log?.("WARN", `The media-server key was not created because ${why} (mode ${mode.toString(8)}).`);
        return "exposed";
      }
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

/** Locates or, only for a genuine first run, creates the data-directory key. Returns what
 *  happened. An existing file, a symlink, a malformed state or an unreadable vault all leave
 *  the intended path untouched so the vault fails closed on its own. */
export async function establishContainerMediaKey(dataDir: string, intended: string, log?: MediaKeyLog): Promise<MediaKeyOutcome> {
  try {
    if ((await lstatOrNull(intended)) !== null) return "existing";
    if (!(await ensureRealDirectory(dataDir))) return "declined";
    if (await hasCredentialEvidence(dataDir)) return "declined";
    return await publishKey(dataDir, intended, log);
  } catch {
    return "failed";
  }
}

/** The path the server should read its key from. A non-blank `MEDIA_SERVER_KEY_FILE` is a
 *  deployment override and is returned exactly as it is. Otherwise a new 32-byte random key is
 *  created at `<dataDir>/media-server.key` only when no encrypted credential already exists.
 *  A missing or corrupt key is never silently replaced. */
export async function prepareContainerMediaKey(
  dataDir: string,
  env: NodeJS.ProcessEnv,
  log?: MediaKeyLog,
): Promise<string> {
  const override = env[MEDIA_SERVER_KEY_FILE_ENV];
  if (typeof override === "string" && override.trim().length > 0) return override;
  const intended = mediaServerKeyPath(dataDir);
  const outcome = await establishContainerMediaKey(dataDir, intended, log);
  if (outcome === "created") {
    log?.("INFO", "Created a new media-server key in the data directory.");
  } else if (outcome === "declined") {
    log?.("WARN", "The media-server key was not created because this install may already hold encrypted credentials.");
  } else if (outcome === "failed") {
    log?.("WARN", "The media-server key could not be prepared; remote-server credentials cannot be stored.");
  }
  return intended;
}
