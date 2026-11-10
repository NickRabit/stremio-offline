import { expect, test } from "@playwright/test";

const addonUrl = `http://127.0.0.1:${process.env.LEADCAP_ADDON_PORT ?? "8198"}`;

test.beforeEach(async ({ request }) => {
  await request.get(`${addonUrl}/proxy-control?mode=leadcap`);
});

test.afterEach(async ({ request }) => {
  await request.get(`${addonUrl}/proxy-control?mode=video`);
});

test("a paused conversion resumes and a near-edge seek wakes it", async ({ page }) => {
  await page.goto("/");
  const form = page.locator("form.login-card");
  await form.getByLabel("Username").fill("leadcap-admin");
  await form.getByLabel("Password", { exact: true }).fill("leadcap-password");
  await form.getByRole("button", { name: "Sign in" }).click();

  await page.getByRole("button", { name: "Catalog", exact: true }).click();
  const catalog = page.getByRole("combobox", { name: "Browse catalog" });
  const movies = (await catalog.locator("option").allTextContents()).find((text) => /Filmy/.test(text));
  expect(movies).toBeTruthy();
  await catalog.selectOption({ label: movies! });
  await page.getByRole("button", { name: /Zkušební film/ }).click();

  const detail = page.locator(".detail-panel");
  await detail.getByRole("button", { name: /E2E lead cap/ }).click();
  const master = page.waitForResponse((response) => /\/api\/playback\/[^/]+\/\d+\/master\.m3u8$/.test(new URL(response.url()).pathname));
  await detail.getByRole("button", { name: "Play", exact: true }).click();
  await master;

  const overlay = page.locator(".player-overlay");
  const video = overlay.locator("video");
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => !element.paused && element.currentTime > 0)).toBe(true);

  await overlay.dispatchEvent("pointermove");
  await overlay.getByRole("button", { name: "Pause", exact: true }).click();
  await page.waitForTimeout(6_000);
  await overlay.dispatchEvent("pointermove");
  await overlay.getByRole("button", { name: "Play", exact: true }).click();
  const resumedAt = await video.evaluate((element: HTMLVideoElement) => element.currentTime);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(resumedAt + 0.3);

  const playlistEnd = await video.evaluate((element: HTMLVideoElement) =>
    element.seekable.length ? element.seekable.end(element.seekable.length - 1) : 0);
  const timeline = overlay.getByRole("slider", { name: "Position", exact: true });
  const max = Number(await timeline.getAttribute("aria-valuemax"));
  const target = Math.min(playlistEnd + 5, max - 1);
  expect(target).toBeGreaterThan(playlistEnd + 0.5);
  const box = await timeline.boundingBox();
  expect(box).not.toBeNull();

  const wakingPing = page.waitForRequest((request) => {
    if (!request.url().endsWith("/ping")) return false;
    const body = request.postDataJSON() as { waitingFor?: unknown } | null;
    return typeof body?.waitingFor === "number";
  });
  await timeline.click({ position: { x: box!.width * target / max, y: 5 }, force: true });
  const ping = await wakingPing;
  expect((ping.postDataJSON() as { waitingFor: number }).waitingFor).toBeCloseTo(target, 0);

  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(target - 2);
  await expect(overlay.locator(".player-error")).toHaveCount(0);
});
