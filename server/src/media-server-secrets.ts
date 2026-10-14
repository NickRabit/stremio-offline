import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, opendir, rmdir, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { renameWithRetry } from "./fs-retry.js";
import {
  MediaServerError,
  MEDIA_CONNECTION_ID,
  MEDIA_SERVER_KINDS,
  MEDIA_SECRET_REF,
  newSecretRef,
  validateMediaServerToken,
  type MediaServerKind,
} from "./media-server-types.js";

export interface MediaServerSecretBinding {
  connectionId: string;
  provider: MediaServerKind;
  serverId: string;
  accountId: string;
}

const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0;
const ENVELOPE_MAX = 32 * 1024;
const REFERENCES_MAX = 4096;
const VERSION = 1;
const isPosix = process.platform !== "win32";

const keyUnavailable = (message: string): MediaServerError => new MediaServerError("secret-key-unavailable", message);
const secretUnavailable = (message: string): MediaServerError => new MediaServerError("secret-unavailable", message);
const invalid = (message: string): MediaServerError => new MediaServerError("invalid-input", message);

const aadFor = (binding: MediaServerSecretBinding, ref: string): Buffer =>
  Buffer.from(
    JSON.stringify(["media-server-secret", VERSION, binding.connectionId, binding.provider, binding.serverId, binding.accountId, ref]),
    "utf8",
  );

function checkBinding(binding: MediaServerSecretBinding): void {
  if (typeof binding !== "object" || binding === null) throw invalid("The secret binding is malformed.");
  if (typeof binding.connectionId !== "string" || !MEDIA_CONNECTION_ID.test(binding.connectionId)) throw invalid("The secret binding connection id is malformed.");
  if (!MEDIA_SERVER_KINDS.includes(binding.provider)) throw invalid("The secret binding provider is malformed.");
  for (const value of [binding.serverId, binding.accountId]) {
    if (typeof value !== "string" || value.length === 0 || value.length > 512) throw invalid("The secret binding identity is malformed.");
  }
}

const checkRef = (ref: unknown): string => {
  if (typeof ref !== "string" || !MEDIA_SECRET_REF.test(ref)) throw invalid("The secret reference is malformed.");
  return ref;
};

/** The encrypted token store. One file per secret, bound to the connection and remote identity
 *  by AES-256-GCM additional data, so a swapped file or binding fails to decrypt. The key is
 *  read on every operation, never cached, so a changed or removed key fails closed. */
export class MediaServerSecrets {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly directory: string,
    private readonly keyFile: string | undefined,
    private readonly seams: { rename?: (from: string, to: string) => Promise<void> } = {},
  ) {}

  /** Whether a key file path was supplied at all. It says nothing about readability: the
   *  bytes are read on every real operation, so a missing or unreadable file still fails
   *  closed there. Exposed to the interface only as a boolean, never as a path. */
  keyConfigured(): boolean {
    return Boolean(this.keyFile);
  }

  /** The references the vault actually holds, for startup reconciliation. Needs no key: a
   *  removal does not decrypt. A missing directory is empty, an unsafe directory fails
   *  closed, and the listing is bounded, so a large or hostile vault can never make the
   *  caller delete anything by halves. Own `.ref.hex.tmp` files do not match the handle
   *  shape and are ignored. */
  references(): Promise<string[]> {
    return this.serialize(async () => {
      if (!(await this.directoryUsable())) return [];
      let handle;
      try { handle = await opendir(this.directory); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw secretUnavailable("The secret vault directory could not be listed.");
      }
      const found: string[] = [];
      let seen = 0;
      for await (const entry of handle) {
        seen += 1;
        if (seen > REFERENCES_MAX) throw secretUnavailable("The secret vault holds too many entries.");
        if (!MEDIA_SECRET_REF.test(entry.name)) continue;
        if (!entry.isFile()) continue;
        found.push(entry.name);
      }
      return found.sort();
    });
  }

  put(binding: MediaServerSecretBinding, token: string): Promise<string> {
    return this.serialize(async () => {
      const key = await this.readKey();
      checkBinding(binding);
      const value = validateMediaServerToken(token);
      const ref = newSecretRef();
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(aadFor(binding, ref));
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      const envelope = Buffer.from(JSON.stringify({
        v: VERSION,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ct: ciphertext.toString("base64"),
      }), "utf8");
      await this.writeEnvelope(ref, envelope);
      return ref;
    });
  }

  get(binding: MediaServerSecretBinding, ref: string): Promise<string> {
    return this.serialize(async () => {
      const validRef = checkRef(ref);
      checkBinding(binding);
      const key = await this.readKey();
      const envelope = await this.readEnvelope(validRef);
      return validateMediaServerToken(this.decrypt(key, binding, validRef, envelope));
    });
  }

  remove(ref: string): Promise<void> {
    return this.serialize(async () => {
      const validRef = checkRef(ref);
      if (!(await this.directoryUsable())) return;
      const target = path.join(this.directory, validRef);
      let info;
      try { info = await lstat(target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw secretUnavailable("The stored secret could not be removed.");
      }
      if (info.isSymbolicLink() || !info.isFile()) throw secretUnavailable("The stored secret could not be removed.");
      await unlink(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw secretUnavailable("The stored secret could not be removed.");
      });
    });
  }

  /** Operations run one after another so two writes never fight over the temp file and a
   *  failure cannot leave the queue stuck behind a rejected promise. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** lstat first so a symlink or FIFO is refused before `open`, which could otherwise block on
   *  a FIFO; then open with `O_NOFOLLOW | O_NONBLOCK` and confirm the descriptor is the same
   *  regular inode. Returns undefined only when the path does not exist. */
  private async openRegular(target: string, label: string, fail: (message: string) => MediaServerError): Promise<{ handle: FileHandle; info: Stats } | undefined> {
    let pre;
    try { pre = await lstat(target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw fail(`${label} is not available.`);
    }
    if (pre.isSymbolicLink()) throw fail(`${label} must not be a symlink.`);
    if (!pre.isFile()) throw fail(`${label} must be a regular file.`);
    let handle: FileHandle;
    try { handle = await open(target, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ELOOP") throw fail(`${label} must not be a symlink.`);
      if (code === "ENOENT") return undefined;
      throw fail(`${label} is not available.`);
    }
    let info: Stats;
    try { info = await handle.stat(); }
    catch { await handle.close().catch(() => undefined); throw fail(`${label} is not available.`); }
    if (info.isSymbolicLink() || !info.isFile() || info.dev !== pre.dev || info.ino !== pre.ino) {
      await handle.close().catch(() => undefined);
      throw fail(`${label} must be a regular file.`);
    }
    return { handle, info };
  }

  private async readKey(): Promise<Buffer> {
    if (!this.keyFile) throw keyUnavailable("No secret vault key is configured.");
    const opened = await this.openRegular(this.keyFile, "The secret vault key", keyUnavailable);
    if (!opened) throw keyUnavailable("The secret vault key is not available.");
    const { handle, info } = opened;
    try {
      if (isPosix) {
        if ((info.mode & 0o077) !== 0) throw keyUnavailable("The secret vault key is readable by others.");
        if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
          throw keyUnavailable("The secret vault key is not owned by the process user.");
        }
      }
      if (info.size !== 32) throw keyUnavailable("The secret vault key must be exactly 32 bytes.");
      const key = Buffer.alloc(32);
      let read = 0;
      try {
        while (read < 32) {
          const { bytesRead } = await handle.read(key, read, 32 - read, read);
          if (bytesRead === 0) break;
          read += bytesRead;
        }
      } catch { throw keyUnavailable("The secret vault key could not be read."); }
      if (read !== 32) throw keyUnavailable("The secret vault key could not be read.");
      return key;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /** Owner, mode and type are checked on the directory itself. A symlinked or owner-insecure
   *  vault is refused even for an idempotent removal; a missing directory is not an error. */
  private async directoryUsable(): Promise<boolean> {
    let info;
    try { info = await lstat(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw secretUnavailable("The secret vault directory is not usable.");
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw secretUnavailable("The secret vault directory is not usable.");
    if (isPosix) {
      if ((info.mode & 0o077) !== 0) throw secretUnavailable("The secret vault directory is readable by others.");
      if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
        throw secretUnavailable("The secret vault directory is not owned by the process user.");
      }
    }
    return true;
  }

  private async ensureDirectory(): Promise<void> {
    if (await this.directoryUsable()) return;
    await mkdir(this.directory, { mode: 0o700 }).catch(() => { throw secretUnavailable("The secret vault directory could not be created."); });
    // Same shared-folder inheritance as the key: a new directory can come back world-readable.
    // An empty directory that stays that way is removed, so a later attempt can try again.
    // A directory that already existed is refused above and is never removed here.
    if (isPosix) {
      try {
        await chmod(this.directory, 0o700);
      } catch {
        await rmdir(this.directory).catch(() => undefined);
        throw secretUnavailable("The secret vault directory could not be created.");
      }
    }
    try {
      if (!(await this.directoryUsable())) throw secretUnavailable("The secret vault directory could not be created.");
    } catch (error) {
      await rmdir(this.directory).catch(() => undefined);
      throw error;
    }
  }

  private async readEnvelope(ref: string): Promise<Buffer> {
    await this.ensureDirectory();
    const opened = await this.openRegular(path.join(this.directory, ref), "The stored secret", secretUnavailable);
    if (!opened) throw secretUnavailable("The stored secret is not available.");
    const { handle, info } = opened;
    try {
      if (isPosix) {
        if ((info.mode & 0o077) !== 0) throw secretUnavailable("The stored secret is readable by others.");
        if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
          throw secretUnavailable("The stored secret is not owned by the process user.");
        }
      }
      if (info.size <= 0 || info.size > ENVELOPE_MAX) throw secretUnavailable("The stored secret envelope has an invalid size.");
      return await this.readEnvelopeBytes(handle);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /** Read in bounded steps rather than trusting the stat size, so a file that grows between
   *  the check and the read still cannot exceed the envelope cap. */
  private async readEnvelopeBytes(handle: FileHandle): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const size = Math.min(8192, ENVELOPE_MAX + 1 - total);
        if (size <= 0) break;
        const chunk = Buffer.allocUnsafe(size);
        const { bytesRead } = await handle.read(chunk, 0, size, total);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > ENVELOPE_MAX) throw secretUnavailable("The stored secret envelope has an invalid size.");
        chunks.push(chunk.subarray(0, bytesRead));
      }
    } catch (error) {
      if (error instanceof MediaServerError) throw error;
      throw secretUnavailable("The stored secret is not available.");
    }
    if (total <= 0) throw secretUnavailable("The stored secret envelope has an invalid size.");
    return Buffer.concat(chunks);
  }

  private decrypt(key: Buffer, binding: MediaServerSecretBinding, ref: string, envelope: Buffer): string {
    let parsed: { v?: unknown; iv?: unknown; tag?: unknown; ct?: unknown };
    try { parsed = JSON.parse(envelope.toString("utf8")); }
    catch { throw secretUnavailable("The stored secret envelope is corrupt."); }
    if (!parsed || parsed.v !== VERSION || typeof parsed.iv !== "string" || typeof parsed.tag !== "string" || typeof parsed.ct !== "string") {
      throw secretUnavailable("The stored secret envelope is corrupt.");
    }
    const iv = Buffer.from(parsed.iv, "base64");
    const tag = Buffer.from(parsed.tag, "base64");
    const ciphertext = Buffer.from(parsed.ct, "base64");
    if (iv.length !== 12 || tag.length !== 16) throw secretUnavailable("The stored secret envelope is corrupt.");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aadFor(binding, ref));
    decipher.setAuthTag(tag);
    try { return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"); }
    catch { throw secretUnavailable("The stored secret could not be decrypted."); }
  }

  private async writeEnvelope(ref: string, envelope: Buffer): Promise<void> {
    await this.ensureDirectory();
    if (envelope.length > ENVELOPE_MAX) throw secretUnavailable("The secret envelope is too large.");
    const target = path.join(this.directory, checkRef(ref));
    const temp = path.join(this.directory, `.${ref}.${randomBytes(8).toString("hex")}.tmp`);
    let handle: FileHandle | undefined;
    try {
      handle = await open(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW, 0o600);
      await handle.writeFile(envelope);
      if (isPosix) await handle.chmod(0o600);
      await handle.sync();
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temp).catch(() => undefined);
      throw error instanceof MediaServerError ? error : secretUnavailable("The secret could not be stored.");
    }
    try {
      await handle.close();
      await (this.seams.rename ?? renameWithRetry)(temp, target);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error instanceof MediaServerError ? error : secretUnavailable("The secret could not be stored.");
    }
  }
}
