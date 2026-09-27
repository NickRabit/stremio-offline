import { rename } from "node:fs/promises";

/** Windows refuses a rename over a file another process holds open: an antivirus, an indexer or
 *  a backup keeps the target busy for a moment. POSIX replaces it either way. */
const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

export interface RenameWithRetryOptions {
  attempts?: number;
  delayMs?: number;
  platform?: NodeJS.Platform;
  renameImpl?: (from: string, to: string) => Promise<void>;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Renames `from` to `to`, waiting out a Windows lock with a delay that grows per attempt. */
export async function renameWithRetry(from: string, to: string, options: RenameWithRetryOptions = {}): Promise<void> {
  const { attempts = 5, delayMs = 50, platform = process.platform, renameImpl = rename } = options;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await renameImpl(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (platform !== "win32" || code === undefined || !RETRY_CODES.has(code) || attempt >= attempts) throw error;
      await wait(delayMs * attempt);
    }
  }
}
