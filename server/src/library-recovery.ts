import type { BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { lstat, readdir, stat, statfs } from "node:fs/promises";
import { AppError } from "./errors.js";

export const recoveryConflict = () => new AppError(
  "The interrupted library operation could not be verified. Check the source and destination before trying again.",
  "err.libraryRecoveryConflict", 409,
);

const validIdentity = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

// statfs(2) magic numbers of Linux filesystems whose daemon hands out inode numbers
// from its own table and may hand out a new one once the kernel forgets the old one
// (Docker Desktop's bind mounts are virtiofs; sshfs, rclone and mergerfs are FUSE).
const UNSTABLE_INODE_FILESYSTEMS = new Set([0x6a656a63, 0x65735546]);

const identityFs = { lstat, readdir, statfs, platform: process.platform as string };

/** Swaps the filesystem calls the identity is built from, so a test can renumber inodes. */
export function setIdentityFsForTests(fs: Partial<typeof identityFs>): () => void {
  const previous = { ...identityFs };
  Object.assign(identityFs, fs);
  return () => { Object.assign(identityFs, previous); };
}

async function stableInodes(target: string): Promise<boolean> {
  if (identityFs.platform !== "linux") return true;
  return !UNSTABLE_INODE_FILESYSTEMS.has(Number((await identityFs.statfs(target)).type));
}

// Relative names survive a rename. Replacing an episode inside a season leaves its
// grandparent's timestamps intact, so a directory proof includes each descendant.
// Where the volume renumbers inodes, the birth time is what tells a replacement apart.
async function objectIdentity(target: string, rootInfo: BigIntStats): Promise<string> {
  const hash = createHash("sha256");
  const stable = new Map<bigint, boolean>();
  async function visit(relative: string, info: BigIntStats): Promise<boolean> {
    if (info.dev <= 0n || info.ino <= 0n || info.birthtimeNs <= 0n || !(info.isDirectory() || info.isFile())) return false;
    let keepsInode = stable.get(info.dev);
    if (keepsInode === undefined) {
      keepsInode = await stableInodes(path.join(target, relative));
      stable.set(info.dev, keepsInode);
    }
    hash.update(JSON.stringify([relative, info.isDirectory(), String(info.dev), keepsInode ? String(info.ino) : "",
      String(info.birthtimeNs), String(info.mtimeNs), String(info.size)]));
    if (info.isDirectory()) {
      const directory = path.join(target, relative);
      for (const name of (await identityFs.readdir(directory)).sort()) {
        const child = await identityFs.lstat(path.join(directory, name), { bigint: true });
        if (!await visit(path.join(relative, name), child)) return false;
      }
    }
    return true;
  }
  // Volumes without stable identities can still serve live operations. Their journals
  // deliberately carry no usable proof for an automatic replay.
  return await visit("", rootInfo) ? hash.digest("hex") : "";
}

export async function captureTransferIdentity(target: string): Promise<string> {
  return objectIdentity(target, await identityFs.lstat(target, { bigint: true }));
}

async function probe(target: string): Promise<string | undefined> {
  const info = await identityFs.lstat(target, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw recoveryConflict();
  });
  if (!info) return undefined;
  // Disappearance of a child during inspection is not absence of the whole tree.
  return objectIdentity(target, info).catch(() => { throw recoveryConflict(); });
}

export interface RecoveryEvidence {
  phase: "moving" | "published";
  sourceIdentity: string;
  publishedIdentity: string | null;
}

export function hasEvidence<T extends Partial<RecoveryEvidence>>(step: T): step is T & RecoveryEvidence {
  return validIdentity(step.sourceIdentity) && (validIdentity(step.publishedIdentity)
    || (step.phase === "moving" && step.publishedIdentity === null));
}

export async function reconcileTransfer(
  step: RecoveryEvidence, source: string, target: string, sourceRoot: string, targetRoot: string, copy = false,
): Promise<"retry" | "finish"> {
  for (const root of [sourceRoot, targetRoot]) {
    if (!await stat(root).then((info) => info.isDirectory(), () => false)) throw recoveryConflict();
  }
  if (!hasEvidence(step)) throw recoveryConflict();
  const [original, destination] = await Promise.all([probe(source), probe(target)]);
  if (original !== undefined && original !== step.sourceIdentity) throw recoveryConflict();
  if (destination === undefined) {
    if (step.phase === "moving" && original) return "retry";
    throw recoveryConflict();
  }
  // Seeing the same object under both names could be a third-party hard link.
  if (copy && original === undefined) throw recoveryConflict();
  if (original !== undefined && (!step.publishedIdentity || step.publishedIdentity === original)) throw recoveryConflict();
  const expected = step.publishedIdentity ?? (copy ? null : step.sourceIdentity);
  if (destination !== expected) throw recoveryConflict();
  return "finish";
}
