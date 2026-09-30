import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { launchShell, openedLinks, sandbox, stateOf, until } from "./helpers/shell";
import { cleanup, track } from "./helpers/lifecycle";

test.afterEach(cleanup);

test("the update notice follows the stand-in feed and goes away when the check is off", async () => {
  const box = await sandbox();
  const release = {
    tag_name: "v9.9.9",
    html_url: "https://github.com/NickRabit/stremio-offline/releases/tag/v9.9.9",
    draft: false,
    prerelease: false,
  };
  let hits = 0;
  const feed = createServer((_req, res) => {
    hits += 1;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(release));
  });
  await new Promise<void>((resolve) => feed.listen(0, "127.0.0.1", resolve));
  const port = (feed.address() as AddressInfo).port;

  try {
    const shell = await launchShell({ box, env: { STREMIO_OFFLINE_UPDATE_FEED: `http://127.0.0.1:${port}/latest` } });
    track(shell.app, box.root);

    const announced = await until(() => stateOf(shell.page), (state) => state.app.update !== null, "the update notice");
    expect(announced.app.update).toEqual({ version: "9.9.9", url: release.html_url });
    expect(announced.toast?.kind).toBe("update");
    expect(announced.app.prefs.checkUpdates).toBe(true);
    expect(hits).toBeGreaterThan(0);

    await shell.page.evaluate(() => window.stremioShell.openUpdate());
    await expect.poll(() => openedLinks(box).then((links) => links.length)).toBeGreaterThan(0);
    expect((await openedLinks(box))[0]).toBe(release.html_url);

    // A development run cannot register the Electron binary as a login item.
    const refused = await shell.page.evaluate(() => window.stremioShell.setAppPrefs({ openAtLogin: true, checkUpdates: true }));
    expect(refused.ok).toBe(false);

    await shell.page.evaluate(() => window.stremioShell.setAppPrefs({ openAtLogin: false, checkUpdates: false }));
    const off = await until(() => stateOf(shell.page), (state) => state.app.update === null, "the notice to clear");
    expect(off.app.prefs.checkUpdates).toBe(false);
  } finally {
    await new Promise<void>((resolve) => feed.close(() => resolve()));
  }
});
