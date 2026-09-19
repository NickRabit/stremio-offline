import { expect, test } from "@playwright/test";
import { addonManifest } from "../../../playwright.config";

test.afterEach(async ({ request }) => {
  await request.get(new URL("/proxy-control?mode=video", addonManifest).href);
});

test("player keeps its picture stable and its overlay controls reachable", async ({ page, request }) => {
  await request.get(new URL("/proxy-control?mode=browser", addonManifest).href);
  await page.goto("/");
  await page.getByRole("button", { name: "Katalog", exact: true }).click();
  const catalog = page.getByRole("combobox", { name: "Procházet katalog" });
  const option = await catalog.locator("option").filter({ hasText: "Filmy" }).first().getAttribute("value");
  await catalog.selectOption(option!);
  await page.getByRole("button", { name: /Zkušební film/ }).click();
  await page.getByRole("button", { name: "Přehrát", exact: true }).click();
  const overlay = page.locator(".player-overlay");
  const video = overlay.locator("video");
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 15_000 }).toBeGreaterThan(0);
  await video.evaluate((element: HTMLVideoElement) => {
    element.loop = true;
    const track = element.addTextTrack("subtitles", "Layout", "cs");
    track.addCue(new VTTCue(0, 3600, "First subtitle line\nSecond subtitle line"));
    track.mode = "showing";
  });
  await overlay.dispatchEvent("pointermove");
  const before = await video.boundingBox();
  const close = await overlay.getByRole("button", { name: "Zavřít přehrávač", exact: true }).boundingBox();
  expect(close!.y).toBeLessThan(50);
  const cues = overlay.locator(".player-subtitles");
  await expect(cues).toBeVisible();
  const bottom = await overlay.locator(".player-bottom").boundingBox();
  const raised = await cues.boundingBox();
  expect(raised!.y + raised!.height).toBeLessThan(bottom!.y + 1);
  await expect(overlay).toHaveClass(/controls-hidden/, { timeout: 8000 });
  expect(await video.boundingBox()).toEqual(before);
  await expect.poll(async () => (await cues.boundingBox())!.y).toBeGreaterThan(raised!.y);
  await overlay.dispatchEvent("pointermove");
  await overlay.getByRole("button", { name: "Nastavení přehrávání", exact: true }).click();
  await expect(overlay.locator(".player-settings")).toBeVisible();
  await page.waitForTimeout(3800);
  await expect(overlay).not.toHaveClass(/controls-hidden/);
  const overflow = await overlay.locator(".player-controls").evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(overflow).toBe(false);
  const settingsButton = await overlay.locator(".player-settings-toggle").boundingBox();
  const fullscreenButton = await overlay.locator(".fullscreen-action").count() ? await overlay.locator(".fullscreen-action").boundingBox() : null;
  if (fullscreenButton) expect(fullscreenButton.x - settingsButton!.x - settingsButton!.width).toBeLessThanOrEqual(8);

  for (const button of await overlay.locator(".player-controls button").all()) {
    const box = await button.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  }
  await overlay.getByRole("button", { name: "Zavřít nastavení přehrávání" }).click();
  await page.screenshot({ path: `test-results/player-${test.info().project.name}.png` });
  if (await overlay.locator(".fullscreen-action").count()) await overlay.locator(".fullscreen-action").click();
  await overlay.dispatchEvent("pointermove");
  const maximized = await video.boundingBox();
  await expect(overlay).toHaveClass(/controls-hidden/, { timeout: 8000 });
  expect(await video.boundingBox()).toEqual(maximized);
  await overlay.dispatchEvent("pointermove");
  await overlay.getByRole("button", { name: "Zavřít přehrávač", exact: true }).click();
  await expect(overlay).toHaveCount(0);
});

test("video clicks dismiss controls and settings; double-click toggles fullscreen", async ({ page, request }) => {
  await request.get(new URL("/proxy-control?mode=browser", addonManifest).href);
  await page.goto("/");
  await page.getByRole("button", { name: "Katalog", exact: true }).click();
  const catalog = page.getByRole("combobox", { name: "Procházet katalog" });
  await catalog.selectOption((await catalog.locator("option").filter({ hasText: "Filmy" }).first().getAttribute("value"))!);
  await page.getByRole("button", { name: /Zkušební film/ }).click();
  await page.getByRole("button", { name: "Přehrát", exact: true }).click();
  const overlay = page.locator(".player-overlay");
  const video = overlay.locator("video");
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 15_000 }).toBeGreaterThan(0);
  await video.evaluate((element: HTMLVideoElement) => { element.loop = true; });
  await video.dispatchEvent("click");
  await expect(overlay).toHaveClass(/controls-hidden/);
  await video.dispatchEvent("click");
  await expect(overlay).not.toHaveClass(/controls-hidden/);
  await overlay.getByRole("button", { name: "Nastavení přehrávání", exact: true }).click();
  await expect(overlay.locator(".player-settings")).toBeVisible();
  await video.dispatchEvent("click");
  await expect(overlay.locator(".player-settings")).toHaveCount(0);
  await expect(overlay).toHaveClass(/controls-hidden/);
  await video.dispatchEvent("click");
  const supportsFullscreen = await overlay.evaluate((element) => Boolean(
    (typeof element.requestFullscreen === "function" && document.fullscreenEnabled)
    || (element as HTMLElement & { webkitRequestFullscreen?: () => void }).webkitRequestFullscreen,
  ));
  const hasFinePointer = await page.evaluate(() => window.matchMedia("(pointer: fine)").matches);
  if (!hasFinePointer) {
    // Without a fine pointer the double click must not reach the fullscreen toggle. It cannot
    // be checked by asserting that nothing is fullscreen, though: a touch phone held sideways
    // is put into fullscreen by the player itself on the first gesture, which Chromium on
    // Android allows and iOS Safari does not, so the two coarse projects start this line in
    // different states. What has to hold in both is that the gesture changes nothing.
    const fullscreenBefore = await page.evaluate(() => document.fullscreenElement !== null);
    await video.dispatchEvent("dblclick");
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => document.fullscreenElement !== null),
      "a double click toggled fullscreen on a touch screen").toBe(fullscreenBefore);
    await expect(overlay.locator(".fullscreen-notice")).toHaveCount(0);
    return;
  }
  if (!supportsFullscreen) {
    await expect(overlay.locator(".fullscreen-action")).toHaveCount(0);
    await expect(video).toBeVisible();
    return;
  }
  await page.evaluate(async () => { if (document.fullscreenElement) await document.exitFullscreen(); });
  await overlay.dispatchEvent("pointermove", { pointerType: "mouse" });
  await video.dblclick();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains("player-overlay"))).toBe(true);
  await expect(overlay.locator(".fullscreen-action")).toHaveAttribute("aria-label", "Ukončit celou obrazovku");
  await video.dblclick();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await overlay.locator(".fullscreen-action").click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains("player-overlay"))).toBe(true);
  await page.clock.install();
  // Pause a second *ahead* of the browser's clock rather than "now": the timestamp is read in
  // Node and reaches the browser after a round trip, and on a busy runner that instant is
  // already in the past -- which the clock refuses ("Cannot fast-forward to the past"). The
  // jump lands before the pointermove below starts the countdown, so the 9999/1 pair still
  // measures exactly the idle timeout.
  await page.clock.pauseAt(new Date(Date.now() + 1_000));
  await overlay.dispatchEvent("pointermove", { pointerType: "mouse" });
  await page.clock.fastForward(9999);
  await expect(overlay).not.toHaveClass(/cursor-hidden/);
  await page.clock.fastForward(1);
  await expect(overlay).toHaveClass(/cursor-hidden/);
  await expect(video).toHaveCSS("cursor", "none");
  await overlay.dispatchEvent("pointermove", { pointerType: "mouse" });
  await expect(overlay).not.toHaveClass(/cursor-hidden/);
  await overlay.locator(".fullscreen-action").click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await page.clock.fastForward(10_000);
  await expect(overlay).not.toHaveClass(/cursor-hidden/);
});
