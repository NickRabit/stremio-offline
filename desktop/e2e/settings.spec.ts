import { expect, test } from "@playwright/test";
import {
  closeSettingsWindow,
  connectThisMac,
  openSettings,
  openSettingsFromMenu,
  sandbox,
  settingsPage,
  stateOf,
  until,
  launchShell,
} from "./helpers/shell";
import { cleanup, track } from "./helpers/lifecycle";

test.afterEach(cleanup);

test("the restart notice survives closing and reopening the settings window", async () => {
  const box = await sandbox();
  const shell = await launchShell({ box, openDialogPath: box.downloads });
  track(shell.app, box.root);

  const live = await connectThisMac(shell);
  const stored = await shell.page.evaluate(
    (settings) => window.stremioShell.setLocalSettings(settings),
    { ...live.local.settings, publishPort: 8999 },
  );
  expect(stored.ok).toBe(true);
  expect(stored.restartNeeded).toBe(true);
  await until(() => stateOf(shell.page), (state) => state.local.restartNeeded, "the settings to want a restart");

  const settings = await openSettings(shell);
  await expect(settings.locator(".shell-notice")).toBeVisible();

  await closeSettingsWindow(shell.app);
  await expect.poll(() => settings.isClosed()).toBe(true);

  await openSettingsFromMenu(shell.app);
  const reopened = await settingsPage(shell.app);
  await expect(reopened.locator(".shell-notice")).toBeVisible();
  expect((await stateOf(shell.page)).local.restartNeeded).toBe(true);

  // The notice is what restarts the backend, and it disappears once the settings apply.
  await reopened.click(".shell-notice .primary");
  await until(() => stateOf(shell.page), (state) => !state.local.restartNeeded, "the restart to finish");
  await expect.poll(() => reopened.locator(".shell-notice").count()).toBe(0);
  expect((await stateOf(shell.page)).local.running).toBe(true);
});
