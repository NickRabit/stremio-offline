import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  connectThisMac,
  homeDir,
  launchShell,
  sandbox,
  shellStrings,
  stateOf,
  until,
  waitForBoxes,
} from "./helpers/shell";
import { cleanup, track } from "./helpers/lifecycle";

test.afterEach(cleanup);

test("a folder the app may not take and one it never prepared are refused", async () => {
  const box = await sandbox();
  const shell = await launchShell({ box });
  track(shell.app, box.root);

  const before = await stateOf(shell.page);
  const home = await homeDir(shell.app);
  const reservedHome = await shell.page.evaluate((dir) => window.stremioShell.prepareDownloadDir(dir), home);
  expect(reservedHome).toEqual({ ok: false, reason: "reserved" });
  const reservedData = await shell.page.evaluate((dir) => window.stremioShell.prepareDownloadDir(dir), `${box.userData}/instance`);
  expect(reservedData).toEqual({ ok: false, reason: "reserved" });

  const unprepared = await shell.page.evaluate(
    (settings) => window.stremioShell.setLocalSettings(settings),
    { ...before.local.settings, downloadDir: path.join(box.root, "Unprepared") },
  );
  expect(unprepared.ok).toBe(false);
  const after = await stateOf(shell.page);
  expect(after.local.settings.downloadDir).toBeNull();
});

test("a folder the app owns goes to the Trash with the instance", async () => {
  test.skip(process.platform === "win32", "Windows never moves a download folder to the Recycle Bin.");
  const box = await sandbox();
  const shell = await launchShell({ box, openDialogPath: box.downloads, messageBoxResponse: 0 });
  track(shell.app, box.root);

  const live = await connectThisMac(shell);
  expect(live.local.downloadDir).toBe(box.downloads);
  await until(() => stateOf(shell.page), (state) => state.local.downloadDirOwned, "the folder to be owned");
  expect(existsSync(`${box.userData}/instance`)).toBe(true);

  const result = await shell.page.evaluate(() => window.stremioShell.resetLocal({ deleteDownloads: true, forgetServers: false }));
  expect(result).toEqual({ ok: true, cancelled: false, downloadsKept: false });
  await expect(shell.page.locator(".shell-welcome")).toBeVisible();

  expect(existsSync(box.downloads)).toBe(false);
  expect(existsSync(`${box.userData}/instance`)).toBe(false);
  const trashed = await readdir(box.trash);
  expect(trashed.some((name) => name.startsWith("Filmy-"))).toBe(true);
  expect(trashed.some((name) => name.startsWith("instance-"))).toBe(true);

  // One dialog only: the reset was confirmed, so no folder was kept to explain.
  const asked = await waitForBoxes(box, 1);
  expect(asked).toHaveLength(1);
  expect(asked[0].message).toBe(shellStrings(live)["reset.title"]);
});

test("a folder holding the user's own file is kept, and the dialog says so", async () => {
  const box = await sandbox();
  const foreign = path.join(box.root, "Foreign");
  await mkdir(foreign, { recursive: true });
  await writeFile(path.join(foreign, "my-own-film.txt"), "mine\n");

  const shell = await launchShell({ box, messageBoxResponse: 0 });
  track(shell.app, box.root);

  const prepared = await shell.page.evaluate((dir) => window.stremioShell.prepareDownloadDir(dir), foreign);
  expect(prepared).toEqual({ ok: true, dir: foreign });
  const before = await stateOf(shell.page);
  const stored = await shell.page.evaluate(
    (settings) => window.stremioShell.setLocalSettings(settings),
    { ...before.local.settings, downloadDir: foreign },
  );
  expect(stored.ok).toBe(true);

  await shell.page.evaluate(() => window.stremioShell.connect({ kind: "local" }));
  const live = await until(() => stateOf(shell.page), (state) => state.screen.kind === "connected", "the local server");
  expect(live.local.downloadDirOwned).toBe(false);

  const result = await shell.page.evaluate(() => window.stremioShell.resetLocal({ deleteDownloads: true, forgetServers: true }));
  expect(result.ok).toBe(true);
  expect(result.downloadsKept).toBe(true);
  await expect(shell.page.locator(".shell-welcome")).toBeVisible();

  expect(existsSync(path.join(foreign, "my-own-film.txt"))).toBe(true);
  expect(existsSync(`${box.userData}/download-folder.json`)).toBe(false);
  const trashed = await readdir(box.trash);
  expect(trashed.some((name) => name.startsWith("Foreign-"))).toBe(false);

  const asked = await waitForBoxes(box, 2);
  expect(asked[0].message).toBe(shellStrings(live)["reset.title"]);
  expect(asked[1].type).toBe("info");
  expect(asked[1].message).toBe(shellStrings(live)["reset.downloadsKept"].replace("{dir}", foreign));

  const after = await stateOf(shell.page);
  expect(after.profiles).toHaveLength(0);
});
