import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isAvatarPreset } from "./avatar-presets.js";
import { USER_ID, type UserRecord } from "./users.js";

/** What an account shows instead of its initial. Absent means the initial. */
export type StoredAvatar =
  | { preset: string }
  /** Each upload has its own file. Numeric versions point to the original per-account file. */
  | { custom: string | number; type: AvatarImageType };

export type AvatarImageType = "image/png" | "image/jpeg" | "image/webp";

/** As the clients read it. A preset is drawn from the client's own copy of the set. */
export type PublicAvatar = { kind: "preset"; id: string } | { kind: "custom"; url: string };

/** The clients scale the picture down before sending it, so this is a ceiling against a client
 *  that does not, not a size anybody is expected to reach. */
export const AVATAR_MAX_BYTES = 200 * 1024;

export function publicAvatar(record: Pick<UserRecord, "id" | "avatar">): PublicAvatar | undefined {
  const avatar = record.avatar;
  if (!avatar) return undefined;
  if ("preset" in avatar) return isAvatarPreset(avatar.preset) ? { kind: "preset", id: avatar.preset } : undefined;
  return { kind: "custom", url: `/api/avatar/${record.id}?v=${avatar.custom}` };
}

/** Reads the type from the bytes: the declared content type is the sender's word. */
export function sniffImage(bytes: Uint8Array): AvatarImageType | undefined {
  const at = (index: number) => bytes[index];
  if (bytes.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47
    && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) return "image/png";
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46
    && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return "image/webp";
  return undefined;
}

/** One small file per account that uploaded a picture, under the data directory. */
export class AvatarStore {
  private readonly dir: string;
  constructor(dataDir: string) { this.dir = path.join(dataDir, "avatars"); }

  private file(userId: string, version: string | number): string {
    if (!USER_ID.test(userId)) throw new Error("Not an account id.");
    if (typeof version === "number") return path.join(this.dir, userId);
    if (!/^[0-9a-f-]{36}$/.test(version)) throw new Error("Not an avatar version.");
    return path.join(this.dir, `${userId}.${version}`);
  }

  async write(userId: string, bytes: Uint8Array): Promise<string> {
    const version = randomUUID();
    const file = this.file(userId, version);
    await mkdir(this.dir, { recursive: true });
    await writeFile(file, bytes, { flag: "wx" });
    return version;
  }

  async read(userId: string, version: string | number): Promise<Buffer | undefined> {
    try {
      return await readFile(this.file(userId, version));
    } catch {
      return undefined;
    }
  }

  async remove(userId: string, version: string | number): Promise<void> {
    await rm(this.file(userId, version), { force: true });
  }
}
