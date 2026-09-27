import { rename } from "node:fs/promises";

/** The refusals Windows answers with while another process still holds the file: an antivirus
 *  scan, the search indexer, a backup tool, or a player reading the copy about to be replaced. */
const LOCKED = new Set(["EPERM", "EBUSY", "EACCES"]);

export interface RenameRetryOptions {
  attempts?: number;
  delayMs?: number;
  platform?: string;
  renameImpl?: typeof rename;
}

/** `rename`, with a few short waits on win32 only: a locked destination there is usually
 *  somebody else's read that ends in a moment. On every other platform, and for every other
 *  failure, the first refusal is the answer -- that behaviour is unchanged. */
export async function renameWithRetry(from: string, to: string, {
  attempts = 5,
  delayMs = 50,
  platform = process.platform,
  renameImpl = rename,
}: RenameRetryOptions = {}): Promise<void> {
  let wait = delayMs;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await renameImpl(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (platform !== "win32" || !LOCKED.has(code ?? "") || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait *= 2;
    }
  }
}
