import assert from "node:assert/strict";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, mkdtemp, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { captureTransferIdentity, reconcileTransfer, setIdentityFsForTests } from "./library-recovery.js";

const VIRTIOFS = 0x6a656a63;
const EXT4 = 0xef53;

// Docker Desktop's virtiofs hands out a fresh inode number once the kernel forgets an
// entry; everything else about the object stays as it was.
function renumberingVolume(type: number, platform = "linux") {
  let shift = 0n;
  const restore = setIdentityFsForTests({
    platform,
    statfs: (async () => ({ type })) as never,
    lstat: (async (target: string) => {
      const info = await lstat(target, { bigint: true });
      return Object.assign(Object.create(Object.getPrototypeOf(info) as object) as BigIntStats, info, { ino: info.ino + shift });
    }) as never,
  });
  return { renumber: () => { shift += 1000n; }, restore };
}

async function withFilm(run: (root: string, folder: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "recovery-identity-"));
  try {
    const folder = path.join(root, "Old", "Heat");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "heat.mkv"), "film");
    await run(root, folder);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function renamedAfterRenumbering(type: number, platform?: string): Promise<"retry" | "finish"> {
  let decision: "retry" | "finish" | undefined;
  await withFilm(async (root, folder) => {
    const volume = renumberingVolume(type, platform);
    try {
      const sourceIdentity = await captureTransferIdentity(folder);
      const target = path.join(root, "Old", "Heat (1995)");
      await rename(folder, target);
      volume.renumber();
      decision = await reconcileTransfer({ phase: "published", sourceIdentity, publishedIdentity: sourceIdentity },
        folder, target, root, root);
    } finally {
      volume.restore();
    }
  });
  return decision!;
}

test("a renamed folder is recognised on a volume that renumbers its inodes", async () => {
  assert.equal(await renamedAfterRenumbering(VIRTIOFS), "finish");
});

test("a renumbered inode is still a different object on a volume that keeps inode numbers", async () => {
  await assert.rejects(renamedAfterRenumbering(EXT4), { messageKey: "err.libraryRecoveryConflict" });
});

test("the filesystem magic only counts on Linux", async () => {
  await assert.rejects(renamedAfterRenumbering(VIRTIOFS, "darwin"), { messageKey: "err.libraryRecoveryConflict" });
});

test("a replaced file is not mistaken for the original on a volume that renumbers inodes", async () => {
  await withFilm(async (root, folder) => {
    const volume = renumberingVolume(VIRTIOFS);
    try {
      const film = path.join(folder, "heat.mkv");
      // Later than either birth time: macOS pulls the birth time back to an earlier mtime.
      const when = new Date(Date.now() + 86_400_000);
      await utimes(film, when, when);
      await utimes(folder, when, when);
      const sourceIdentity = await captureTransferIdentity(folder);
      const target = path.join(root, "Old", "Heat (1995)");
      await rename(folder, target);
      const moved = path.join(target, "heat.mkv");
      await rm(moved);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await writeFile(moved, "film");
      await utimes(moved, when, when);
      await utimes(target, when, when);
      volume.renumber();
      await assert.rejects(reconcileTransfer({ phase: "published", sourceIdentity, publishedIdentity: sourceIdentity },
        folder, target, root, root), { messageKey: "err.libraryRecoveryConflict" });
    } finally {
      volume.restore();
    }
  });
});
