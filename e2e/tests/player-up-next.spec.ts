import { expect, test, type Page } from "@playwright/test";
import { addonManifest } from "../../playwright.config";

const openFirstEpisode = async (page: Page) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Katalog", exact: true }).click();
  const catalog = page.getByRole("combobox", { name: "Procházet katalog" });
  await catalog.selectOption((await catalog.locator("option").filter({ hasText: "Seriály" }).first().getAttribute("value"))!);
  await page.getByRole("button", { name: /Zkušební seriál/ }).click();

  const detail = page.locator(".detail-panel");
  await detail.getByRole("combobox", { name: "Série" }).selectOption("1");
  await detail.getByRole("button", { name: /První díl/ }).click();
  await detail.getByRole("button", { name: "Přehrát", exact: true }).click();

  const overlay = page.locator(".player-overlay");
  await expect(overlay.locator(".player-head strong")).toContainText("První díl");
  return { overlay, detail };
};

test.describe("up next", () => {
  // Chromium in the test image has no H.264, so the addon hands out its VP9 copy and the
  // clip really plays to its end; the mode is shared with the other specs in the run.
  test.beforeEach(async ({ request }) => {
    await request.get(new URL("/proxy-control?mode=browser", addonManifest).href);
  });
  test.afterEach(async ({ request }) => {
    await request.get(new URL("/proxy-control?mode=video", addonManifest).href);
  });

  test("an episode that ends offers the next one and plays it on demand", async ({ page }) => {
    const { overlay, detail } = await openFirstEpisode(page);
    const card = overlay.locator(".player-up-next");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText("NÁSLEDUJE");
    await expect(card.locator("strong")).toHaveText("Druhý díl");

    await card.getByRole("button", { name: "Přehrát hned" }).click();
    await expect(overlay.locator(".player-head strong")).toContainText("Druhý díl");
    await expect(detail.locator(".episode-current")).toContainText("Druhý díl");
    // That episode runs to its own end, which is when the season behind it is offered.
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.locator("strong")).toHaveText("Nová série");
  });

  test("the countdown moves on by itself", async ({ page }) => {
    const { overlay, detail } = await openFirstEpisode(page);
    const card = overlay.locator(".player-up-next");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText("Spustí se za");

    await expect(overlay.locator(".player-head strong")).toContainText("Druhý díl", { timeout: 30_000 });
    await expect(detail.locator(".episode-current")).toContainText("Druhý díl");
  });

  test("a countdown the viewer walked away from does not fire behind the closed player", async ({ page }) => {
    const { overlay, detail } = await openFirstEpisode(page);
    await expect(overlay.locator(".player-up-next")).toBeVisible({ timeout: 30_000 });
    await expect(overlay.locator(".player-up-next")).toContainText("Spustí se za");

    await overlay.getByRole("button", { name: "Zavřít přehrávač", exact: true }).click();
    await expect(overlay).toHaveCount(0);
    // Longer than the countdown: a timer left running swaps the detail view to the next
    // episode with nobody watching.
    await page.waitForTimeout(6_000);
    await expect(detail.locator(".episode-current")).toContainText("První díl");
  });
});
