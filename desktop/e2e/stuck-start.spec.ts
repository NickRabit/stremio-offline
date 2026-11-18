import { expect, test } from "@playwright/test";
import path from "node:path";
import { DESKTOP_DIR, launchShell, openSettings, sandbox, stateOf, until } from "./helpers/shell";
import { cleanup, track } from "./helpers/lifecycle";

test.afterEach(cleanup);

const SILENT_BACKEND = path.join(DESKTOP_DIR, "e2e", "fixtures", "silent-backend.mjs");

test("the settings stay usable while a local start never answers", async () => {
  const box = await sandbox();
  const shell = await launchShell({
    box,
    openDialogPath: box.downloads,
    env: { STREMIO_OFFLINE_LOCAL_BACKEND_ENTRY: SILENT_BACKEND },
  });
  track(shell.app, box.root);

  await shell.page.click(".shell-choice >> nth=0");
  await shell.page.click(".shell-folder-step .shell-folder button");
  await shell.page.click(".shell-folder-step .primary");
  await until(() => stateOf(shell.page), (state) => state.screen.kind === "connecting", "the local start");
  const settings = await openSettings(shell);

  // A language is no change to the start: it is stored at once and the start carries on.
  await settings.evaluate(() => window.stremioShell.setLocale("cs"));
  const after = await stateOf(shell.page);
  expect(after.localeChoice).toBe("cs");
  expect(after.screen.kind).toBe("connecting");

  // A change to the local server is: the stuck start gives way, and the window says it failed.
  const stored = await settings.evaluate(
    (current) => window.stremioShell.setLocalSettings({ ...current, allowPrivateAddons: !current.allowPrivateAddons }),
    after.local.settings,
  );
  expect(stored.ok).toBe(true);
  const failed = await until(() => stateOf(shell.page), (state) => state.screen.kind === "error", "the failure screen");
  expect(failed.screen).toMatchObject({ kind: "error", reason: "local-startup" });
});
