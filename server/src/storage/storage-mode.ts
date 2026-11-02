import { access, rm } from "node:fs/promises";
import path from "node:path";

/** An existing database that cannot be opened stops the start: its stores may already have moved
 *  their JSON aside. Only a first run may fall back to JSON, and it removes the file the failed
 *  open created, so the next start is a first run again rather than a refusal. */
export async function chooseStorageMode<T>(dataDir: string, open: (dataDir: string) => Promise<T>): Promise<T | undefined> {
  const file = path.join(dataDir, "application.sqlite");
  const exists = await access(file).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  try {
    return await open(dataDir);
  } catch (error) {
    if (exists) throw error;
    await Promise.all([file, `${file}-wal`, `${file}-shm`].map((name) => rm(name, { force: true })));
    return undefined;
  }
}
