import { realpath } from "node:fs/promises";
import path from "node:path";
import { log } from "./logger.js";
import { isInside, realAncestor, toPosix, type RootGrant } from "./libraries.js";

/** `LIBRARY_ROOTS` is a comma-separated list of absolute paths, and an empty value
 *  keeps the download directory the install has always had. Relative entries are
 *  dropped rather than resolved: their meaning would depend on the working directory. */
export function parseRootList(value: string | undefined, fallback: string): string[] {
  const parts = (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  const roots = parts.length ? parts : [fallback];
  const absolute = roots.filter((root) => path.isAbsolute(root));
  for (const root of roots.filter((root) => !path.isAbsolute(root))) {
    log("WARN", "Ignoring a relative LIBRARY_ROOTS entry", { root });
  }
  return [...new Set(absolute.map((root) => path.resolve(root)))];
}

/** The operator's grants. Rebuilt on every boot, so they are not persisted. */
export function envGrants(value: string | undefined, downloadDir: string, at = new Date().toISOString()): RootGrant[] {
  return parseRootList(value, downloadDir).map((root) => ({ path: root, source: "env" as const, grantedAt: at }));
}

/** Operator grants win over a user grant on the same path; both are deduplicated by path. */
export function mergeGrants(env: RootGrant[], user: RootGrant[]): RootGrant[] {
  const merged = new Map<string, RootGrant>();
  // Inserted user first so an operator grant on the same path overwrites it.
  for (const grant of [...user, ...env]) merged.set(path.resolve(grant.path), grant);
  return [...merged.values()];
}

/** The grant containing `candidate`, when there is one. Symlinks are resolved on both
 *  sides, so a link pointing out of a grant grants nothing. */
export async function grantingRoot(grants: RootGrant[], candidate: string): Promise<RootGrant | undefined> {
  const absolute = path.resolve(candidate);
  const real = await realAncestor(absolute);
  if (!real) return undefined;
  for (const grant of grants) {
    // The grant itself must exist. Resolving it to its nearest existing ancestor
    // would widen a grant on a missing mount to the directory above it.
    const root = await realpath(path.resolve(grant.path)).catch(() => undefined);
    if (root && isInside(real, root)) return grant;
  }
  return undefined;
}

export const insideGrant = async (grants: RootGrant[], candidate: string) => Boolean(await grantingRoot(grants, candidate));

export const grantView = (grant: RootGrant) => ({ path: toPosix(grant.path), source: grant.source, grantedAt: grant.grantedAt });
