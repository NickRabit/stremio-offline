import { expect, test } from "@playwright/test";

test("Safari landscape keeps document scrolling available and restores its position", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Nastavení", exact: true }).click();
  const main = page.locator(".app-shell > main");
  await expect(main).toHaveCSS("overflow-y", "visible");
  await expect(page.locator("body")).not.toHaveCSS("overflow-y", "hidden");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeGreaterThan(350);
  // Wait for the section's asynchronous scroll restoration to finish.
  await page.waitForTimeout(1600);
  await page.evaluate(() => window.scrollTo(0, 350));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(350);
  await page.evaluate(() => window.scrollBy(0, -100));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(250);
  await page.getByRole("button", { name: "Katalog", exact: true }).click();
  await page.getByRole("button", { name: "Nastavení", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(250);
  await page.getByRole("button", { name: "Nastavení", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test("Safari landscape sidebar accepts touch navigation from every page", async ({ page }) => {
  await page.goto("/");
  for (const name of ["Nastavení", "Knihovna", "Stahování", "Doplňky", "Statistiky", "Katalog"]) {
    const button = page.locator(".sidebar").getByRole("button", { name, exact: true });
    await expect(button).toBeInViewport();
    await button.tap();
    await expect(button).toHaveClass(/active/);
    await expect(page.locator(".app-shell > main")).toBeVisible();
    await expect(page.locator("body")).not.toHaveCSS("overflow-y", "hidden");
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  }
});

test("Safari retries overlay fullscreen when the first rotation request is rejected", async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as typeof window & { fullscreenAttempts?: number };
    state.fullscreenAttempts = 0;
    const request = () => {
      state.fullscreenAttempts = (state.fullscreenAttempts ?? 0) + 1;
      return state.fullscreenAttempts === 1 ? Promise.reject(new Error("not ready")) : Promise.resolve();
    };
    Object.defineProperty(Document.prototype, "fullscreenEnabled", { configurable: true, get: () => true });
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value: request });
    Object.defineProperty(HTMLElement.prototype, "webkitRequestFullscreen", { configurable: true, value: request });
  });
  await page.setViewportSize({ width: 390, height: 664 });
  await page.goto("/");
  const catalog = page.getByRole("combobox", { name: "Procházet katalog" });
  const movieCatalog = await catalog.locator("option").filter({ hasText: "Filmy" }).first().getAttribute("value");
  await catalog.selectOption(movieCatalog!);
  await page.getByRole("button", { name: /Zkušební film/ }).click();
  await page.getByRole("button", { name: "Přehrát", exact: true }).click();
  await expect(page.locator(".player-overlay")).toBeVisible();

  await page.setViewportSize({ width: 844, height: 390 });
  await expect.poll(() => page.evaluate(() => (window as typeof window & { fullscreenAttempts?: number }).fullscreenAttempts ?? 0)).toBeGreaterThanOrEqual(2);
});
