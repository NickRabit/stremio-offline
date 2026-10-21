import { unlink } from "node:fs/promises";

/** Runs the steps of a reset that come after the data has gone: clearing sign-ins, deleting the
 *  app's own files, forgetting servers. Each one is tried even when an earlier one failed, and the
 *  reasons of those that failed come back, so a reset that left a sign-in or a saved server
 *  behind is not reported as a clean slate. */
export async function forgetLocalState(steps: ReadonlyArray<() => Promise<unknown>>): Promise<string[]> {
  const failures: string[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  return failures;
}

/** Deletes a file; one that is not there is already what a reset wants. */
export async function removeIfPresent(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
