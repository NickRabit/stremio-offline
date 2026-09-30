import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startStandInServer, type StandInServer } from "./helpers/backend";
import { APP_OWNS_FOLDER, launchShell, openSettings, sandbox, stateOf, until } from "./helpers/shell";
import { cleanup, track } from "./helpers/lifecycle";

let standIn: StandInServer;
let standInRoot: string;

test.beforeAll(async () => {
  standInRoot = await mkdtemp(path.join(tmpdir(), "stremio-desktop-stand-in-"));
  standIn = await startStandInServer(standInRoot);
});

test.afterAll(async () => {
  await standIn.stop();
  await rm(standInRoot, { recursive: true, force: true });
});

test.afterEach(cleanup);

test("This Mac asks for a folder from a server on the network, and Back returns to it", async () => {
  const box = await sandbox();
  const shell = await launchShell({ box, openDialogPath: box.downloads, messageBoxResponse: 1 });
  track(shell.app, box.root);

  const saved = await shell.page.evaluate(
    (origin) => window.stremioShell.saveProfile({ id: null, name: "NAS", origin }),
    standIn.origin,
  );
  if (!saved.ok) throw new Error("The profile was not saved.");
  await shell.page.evaluate((id) => window.stremioShell.connect({ kind: "profile", id }), saved.profile.id);
  const remote = await until(() => stateOf(shell.page), (state) => state.screen.kind === "connected", "the server on the network");
  expect(remote.connection?.origin).toBe(standIn.origin);

  const settings = await openSettings(shell);
  await settings.click(".shell-server-main >> nth=0");
  const setup = await until(() => stateOf(shell.page), (state) => state.screen.kind === "setup", "the folder step");
  expect(setup.local.running).toBe(false);
  expect(existsSync(`${box.userData}/instance`)).toBe(false);

  await shell.page.click(".shell-folder-step .shell-actions button >> nth=0");
  await until(
    () => stateOf(shell.page),
    (state) => state.screen.kind === "connected" && state.connection?.origin === standIn.origin,
    "the server on the network again",
  );

  await shell.page.evaluate(() => window.stremioShell.connect({ kind: "local" }));
  await until(() => stateOf(shell.page), (state) => state.screen.kind === "setup", "the folder step again");
  await shell.page.click(".shell-folder-step .shell-folder button");
  await shell.page.click(".shell-folder-step .primary");
  const local = await until(
    () => stateOf(shell.page),
    (state) => state.screen.kind === "connected" && state.connection?.target.kind === "local"
      && (!APP_OWNS_FOLDER || state.local.downloadDirOwned),
    "This Mac",
  );
  expect(local.local.downloadDir).toBe(box.downloads);
  expect(local.local.downloadDirOwned).toBe(APP_OWNS_FOLDER);
  expect(existsSync(box.downloads)).toBe(true);
});

test("a server that stopped answering does not silently start This Mac", async () => {
  const box = await sandbox();
  const first = await launchShell({ box, messageBoxResponse: 1 });
  track(first.app, box.root);
  const saved = await first.page.evaluate(() => window.stremioShell.saveProfile({ id: null, name: "Dead", origin: "http://127.0.0.1:9" }));
  if (!saved.ok) throw new Error("The profile was not saved.");
  await first.app.close();
  await writeFile(
    path.join(box.userData, "startup.json"),
    `${JSON.stringify({ target: { kind: "profile", id: saved.profile.id } })}\n`,
  );

  const shell = await launchShell({ box, messageBoxResponse: 1 });
  track(shell.app, box.root);

  const failed = await until(() => stateOf(shell.page), (state) => state.screen.kind === "error", "the failure screen");
  expect(failed.screen.kind === "error" && failed.screen.reason).toBe("unreachable");
  expect(existsSync(`${box.userData}/instance`)).toBe(false);

  await shell.page.click(".shell-failure .shell-actions button >> nth=1");
  await expect(shell.page.locator(".shell-folder-step")).toBeVisible();
  expect((await stateOf(shell.page)).local.initialized).toBe(false);

  await shell.page.click(".shell-folder-step .shell-actions button >> nth=0");
  await expect(shell.page.locator(".shell-failure")).toBeVisible();
});
