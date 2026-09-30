import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import {
  APP_OWNS_FOLDER,
  chooseThisMacFromMenu,
  connected,
  launchShell,
  sandbox,
  settingsPage,
  stateOf,
  until,
} from "./helpers/shell";
import { cleanup, track } from "./helpers/lifecycle";

test.afterEach(cleanup);

test("the folder step suggests a folder and Back returns to the welcome screen", async () => {
  const box = await sandbox();
  const shell = await launchShell({ box });
  track(shell.app, box.root);

  await expect(shell.page.locator(".shell-welcome")).toBeVisible();
  await shell.page.click(".shell-choice >> nth=0");
  await expect(shell.page.locator(".shell-folder-step")).toBeVisible();

  const state = await stateOf(shell.page);
  await expect(shell.page.locator(".shell-folder-step .shell-folder code")).toHaveText(state.local.suggestedDownloadDir);

  await shell.page.click(".shell-folder-step .shell-actions button >> nth=0");
  await expect(shell.page.locator(".shell-welcome")).toBeVisible();
  await expect(shell.page.locator(".shell-folder-step")).toBeHidden();
});

test("choosing another folder starts the local server on it", async () => {
  const box = await sandbox();
  const shell = await launchShell({ box, openDialogPath: box.downloads });
  track(shell.app, box.root);

  await shell.page.click(".shell-choice >> nth=0");
  await shell.page.click(".shell-folder-step .shell-folder button");
  await expect(shell.page.locator(".shell-folder-step .shell-folder code")).toHaveText(box.downloads);
  await shell.page.click(".shell-folder-step .primary");

  const state = await until(
    () => stateOf(shell.page),
    (live) => connected(live) && (!APP_OWNS_FOLDER || live.local.downloadDirOwned),
    "the local server and its folder",
  );
  expect(state.local.downloadDir).toBe(box.downloads);
  expect(state.local.downloadDirOwned).toBe(APP_OWNS_FOLDER);
  expect(state.local.initialized).toBe(true);
  expect(state.connection?.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(existsSync(box.downloads)).toBe(true);
});

test("This Mac asks for the folder from the welcome screen, the settings window and the menu", async () => {
  const box = await sandbox();
  const shell = await launchShell({ box });
  track(shell.app, box.root);

  await shell.page.click(".shell-choice >> nth=0");
  await expect(shell.page.locator(".shell-folder-step")).toBeVisible();
  await shell.page.click(".shell-folder-step .shell-actions button >> nth=0");
  await expect(shell.page.locator(".shell-welcome")).toBeVisible();

  await shell.page.evaluate(() => window.stremioShell.openSettings());
  const settings = await settingsPage(shell.app);
  await settings.click(".shell-server-main >> nth=0");
  await expect(shell.page.locator(".shell-folder-step")).toBeVisible();
  await shell.page.click(".shell-folder-step .shell-actions button >> nth=0");
  await expect(shell.page.locator(".shell-welcome")).toBeVisible();

  await chooseThisMacFromMenu(shell.app);
  await expect(shell.page.locator(".shell-folder-step")).toBeVisible();
  await shell.page.click(".shell-folder-step .shell-actions button >> nth=0");
  await expect(shell.page.locator(".shell-welcome")).toBeVisible();

  // The folder step never reached the backend, so the instance is still missing.
  expect(existsSync(`${box.userData}/instance`)).toBe(false);
});
