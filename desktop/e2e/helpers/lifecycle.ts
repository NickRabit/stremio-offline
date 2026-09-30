import type { ElectronApplication } from "@playwright/test";
import { rm } from "node:fs/promises";
import { delay } from "./shell";

const apps: ElectronApplication[] = [];
const roots: string[] = [];

/** Every app a test starts and every scratch directory it made, closed and removed afterwards. */
export function track(app: ElectronApplication, root: string): void {
  apps.push(app);
  roots.push(root);
}

export async function cleanup(): Promise<void> {
  for (const app of apps.splice(0)) {
    // The handle is useless once the app is closed, so it is taken while it still answers.
    const child = childProcessOf(app);
    // An app that still reports work in progress refuses to quit, and a test may have left it
    // that way on purpose.
    await Promise.race([app.close().catch(() => {}), delay(5_000)]);
    child?.kill("SIGKILL");
  }
  // A killed app may still be flushing its cache into the directory.
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

const childProcessOf = (app: ElectronApplication) => {
  try {
    return app.process();
  } catch {
    return undefined;
  }
};
