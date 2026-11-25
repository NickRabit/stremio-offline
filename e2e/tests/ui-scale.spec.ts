import { expect, test, type Page } from "@playwright/test";
import { addonManifest } from "../../playwright.config";
import { chooseCatalog } from "./catalog-picker";
import { pickAddonStream } from "./catalog-sources";

const openSettingsHome = async (page: Page) => {
  await page.getByRole("button", { name: "Nastavení", exact: true }).click();
  await page.getByRole("tab", { name: "Domů", exact: true }).click();
};

const openFirstEpisode = async (page: Page) => {
  await page.getByRole("button", { name: "Katalog", exact: true }).click();
  await chooseCatalog(page, /Seriály/, "series");
  await page.getByRole("button", { name: /Zkušební seriál/ }).click();

  const detail = page.locator(".detail-panel");
  await detail.getByRole("combobox", { name: "Série" }).selectOption("1");
  await detail.getByRole("button", { name: /První díl/ }).click();
  await pickAddonStream(page);
  await detail.getByRole("button", { name: "Přehrát", exact: true }).click();
  const overlay = page.locator(".player-overlay");
  await expect(overlay).toBeVisible();
  return overlay;
};

test.describe("interface scale", () => {
  test.beforeEach(async ({ request }) => {
    await request.get(new URL("/proxy-control?mode=browser", addonManifest).href);
  });

  test.afterEach(async ({ request }) => {
    await request.get(new URL("/proxy-control?mode=video", addonManifest).href);
  });

  test("scales this device, survives reload and fits the player and account menu", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto("/");
    await openSettingsHome(page);

    const scale = page.locator(".ui-scale-setting select");
    await expect(scale).toHaveValue("1");
    await scale.scrollIntoViewIfNeeded();
    await scale.selectOption("1.5");
    await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe("1.5");
    // The row the viewer just changed stays on screen while the page grows around it.
    await expect(scale).toBeInViewport();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("ui-scale"))).toBe("1.5");

    await page.reload();
    await openSettingsHome(page);
    await expect(page.locator(".ui-scale-setting select")).toHaveValue("1.5");
    await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe("1.5");

    const trigger = page.locator(".account-trigger");
    await trigger.click();
    const menu = page.locator(".account-menu");
    await expect(menu).toBeVisible();
    const triggerBox = (await trigger.boundingBox())!;
    const menuBox = (await menu.boundingBox())!;
    const gap = menuBox.y - (triggerBox.y + triggerBox.height);
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(12);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    const overlay = await openFirstEpisode(page);
    const rect = await overlay.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: window.innerWidth, height: window.innerHeight };
    });
    expect(Math.abs(rect.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(rect.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(rect.right - rect.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(rect.bottom - rect.height)).toBeLessThanOrEqual(1);

    await overlay.getByRole("button", { name: "Zavřít přehrávač", exact: true }).click();
    await expect(overlay).toHaveCount(0);
    // 1920x1080 at 150 % holds the layout of a 1280x720 window, and the catalogue compacts the
    // way it does there: its heading gives the series detail the height for its episodes.
    await expect(page.locator("main.view-catalog .catalog-view > .heading")).toBeHidden();
    await openSettingsHome(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe("1.12");
    const limited = page.locator(".ui-scale-setting .setting-note");
    await expect(limited).toContainText("112");
    await expect(limited).toContainText("%");

    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe("");
    await expect(limited).toContainText("100");
  });
});
