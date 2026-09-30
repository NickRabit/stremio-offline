import { expect, test } from "@playwright/test";
import {
  activate,
  appQuit,
  backendStatus,
  boxes,
  closeWindows,
  connectThisMac,
  delay,
  launchShell,
  openSettings,
  sandbox,
  shellStrings,
  stateOf,
  until,
  waitForBoxes,
  waitForExit,
  waitForPage,
  webContentsCount,
  windowCount,
} from "./helpers/shell";
import { cleanup, track } from "./helpers/lifecycle";
import { holdDeviceTransfer, signIn } from "./helpers/backend";

const LINUX = process.platform === "linux";
const KEEPS_RUNNING = process.platform === "darwin" || process.platform === "win32";

test.afterEach(cleanup);

test("closing the window keeps the backend running and activate brings it back", async () => {
  test.skip(!KEEPS_RUNNING, "This platform quits with its window.");
  const box = await sandbox();
  const shell = await launchShell({ box, openDialogPath: box.downloads, messageBoxResponse: 1 });
  track(shell.app, box.root);

  const live = await connectThisMac(shell);
  const origin = live.connection?.origin ?? "";

  await closeWindows(shell.app);
  await expect.poll(() => windowCount(shell.app)).toBe(0);
  expect(await backendStatus(shell.app, origin)).toBe(200);

  await activate(shell.app);
  const page = await waitForPage(shell.app, (url) => url.includes("view=main"));
  const back = await until(() => stateOf(page), (state) => state.screen.kind === "connected", "the window to come back");
  expect(back.connection?.origin).toBe(origin);
});

test("quitting while something runs asks first, and cancelling keeps the app", async () => {
  const box = await sandbox();
  const shell = await launchShell({ box, openDialogPath: box.downloads, messageBoxResponse: 1 });
  track(shell.app, box.root);

  const live = await connectThisMac(shell);
  const origin = live.connection?.origin ?? "";
  const cookie = await signIn(origin);
  const transfer = await holdDeviceTransfer(origin, cookie, box.downloads);
  try {
    await until(() => stateOf(shell.page), (state) => state.local.busy, "the app to report work in progress", 120_000);

    await appQuit(shell.app);
    const asked = await waitForBoxes(box, 1);
    expect(asked[0].message).toBe(shellStrings(await stateOf(shell.page))["quit.title"]);

    await delay(1_000);
    const state = await stateOf(shell.page);
    expect(state.screen.kind).toBe("connected");
    expect(await windowCount(shell.app)).toBe(1);
  } finally {
    transfer.stop();
  }
});

test("quitting with nothing running asks nothing and quits", async () => {
  const box = await sandbox();
  const shell = await launchShell({ box, messageBoxResponse: 0 });
  track(shell.app, box.root);

  await appQuit(shell.app);
  await waitForExit(shell.app);
  expect(await boxes(box)).toEqual([]);
});

test("on Linux closing the window quits when nothing runs", async () => {
  test.skip(!LINUX, "Closing only quits on Linux.");
  const box = await sandbox();
  const shell = await launchShell({ box, messageBoxResponse: 0 });
  track(shell.app, box.root);

  await closeWindows(shell.app);
  await waitForExit(shell.app);
  expect(await boxes(box)).toEqual([]);
});

test("on Linux closing the window asks while something runs", async () => {
  test.skip(!LINUX, "Closing only quits on Linux.");
  const box = await sandbox();
  const shell = await launchShell({ box, openDialogPath: box.downloads, messageBoxResponse: 1 });
  track(shell.app, box.root);

  const live = await connectThisMac(shell);
  const origin = live.connection?.origin ?? "";
  const cookie = await signIn(origin);
  const transfer = await holdDeviceTransfer(origin, cookie, box.downloads);
  try {
    await until(() => stateOf(shell.page), (state) => state.local.busy, "the app to report work in progress", 120_000);

    await closeWindows(shell.app);
    const asked = await waitForBoxes(box, 1);
    expect(asked[0].message).toBe(shellStrings(await stateOf(shell.page))["quit.title"]);

    await delay(1_000);
    expect(await windowCount(shell.app)).toBe(1);
  } finally {
    transfer.stop();
  }
});

test("no webContents outlive a closed window where the app keeps running", async () => {
  test.skip(!KEEPS_RUNNING, "The app is gone with its window here, so there is nothing left to inspect.");
  const box = await sandbox();
  const shell = await launchShell({ box, openDialogPath: box.downloads, messageBoxResponse: 1 });
  track(shell.app, box.root);

  await connectThisMac(shell);
  await openSettings(shell);
  await closeWindows(shell.app);

  await expect.poll(() => webContentsCount(shell.app), { timeout: 30_000 }).toBe(0);
});
