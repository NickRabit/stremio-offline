import type { RemoteLibrary } from "./types";

const STORAGE_PREFIX = "remote-roots:";
const remembered = new Map<string, RemoteLibrary[]>();

const readStoredCount = (account: string): number => {
  try {
    const value = Number(localStorage.getItem(`${STORAGE_PREFIX}${account}`));
    return Number.isInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
};

/** The roots last listed for this account in this page session, or null. */
export function rememberedRoots(account: string): RemoteLibrary[] | null {
  if (!account) return null;
  return remembered.get(account) ?? null;
}

/** How many roots the account had last time: the in-memory list's length, else
 *  the number stored in localStorage under `remote-roots:<account>`, else 0. */
export function rememberedRootCount(account: string): number {
  if (!account) return 0;
  const roots = remembered.get(account);
  return roots ? roots.length : readStoredCount(account);
}

/** Keeps the list in memory and its length in localStorage. Writes storage only
 *  when the stored number differs. Storage failures are ignored. */
export function rememberRoots(account: string, roots: RemoteLibrary[]): void {
  if (!account) return;
  remembered.set(account, [...roots]);
  try {
    const key = `${STORAGE_PREFIX}${account}`;
    const count = String(roots.length);
    if (localStorage.getItem(key) !== count) localStorage.setItem(key, count);
  } catch {
    /* Storage may be unavailable. */
  }
}

export function resetRememberedRoots(): void {
  remembered.clear();
}
