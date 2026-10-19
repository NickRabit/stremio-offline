import { expect, test, type Page } from "@playwright/test";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { scanLibrary } from "./library-tools";

const placeholder = "Hledat v katalozích a knihovnách…";

// Twelve library folders no catalog knows: each is a card of its own that opens in the Library,
// and together they are long enough to scroll on a phone.
const folders = Array.from({ length: 12 }, (_, index) => `Pozicovka ${String(index + 1).padStart(2, "0")}`);
test.beforeAll(async () => {
  const sample = path.resolve("e2e/fixtures/media/sample.mp4");
  for (const folder of folders) {
    const directory = path.resolve("e2e/.tmp/downloads", folder);
    await mkdir(directory, { recursive: true });
    for (const file of ["a.mp4", "b.mp4"]) await copyFile(sample, path.join(directory, file));
  }
});

const scrollY = (page: Page) => page.evaluate(() => Math.round(window.scrollY));
const searchFolders = async (page: Page) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  await scanLibrary(page);
  await page.locator(".topbar-search").click();
  const box = page.getByRole("searchbox", { name: placeholder });
  await expect(box).toBeFocused();
  await box.fill("Pozicovka");
  await box.press("Enter");
  await expect(page.locator("[data-search-card]")).toHaveCount(folders.length, { timeout: 15_000 });
};

test("Safari: Back to search from a library folder returns to the same place in the results", async ({ page }) => {
  await searchFolders(page);
  const target = page.locator("[data-search-card][title=\"Pozicovka 09\"]");
  await page.evaluate(() => {
    const card = document.querySelector<HTMLElement>("[data-search-card][title=\"Pozicovka 09\"]")!;
    window.scrollTo(0, card.getBoundingClientRect().top + window.scrollY - 60);
  });
  const before = await scrollY(page);
  expect(before).toBeGreaterThan(300);

  await target.click();
  await expect(page.locator("main.view-library")).toBeVisible();
  await page.locator(".search-return").click();
  await expect(page.locator("main.view-search")).toBeVisible();
  await expect.poll(async () => Math.abs(await scrollY(page) - before)).toBeLessThanOrEqual(2);
  await expect(target).toBeFocused();
});

test("Safari: the top bar's Search goes back to the top with the query ready to replace", async ({ page }) => {
  await searchFolders(page);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  expect(await scrollY(page)).toBeGreaterThan(300);

  await page.locator(".topbar-search").click();
  await expect.poll(() => scrollY(page)).toBe(0);
  const box = page.getByRole("searchbox", { name: placeholder });
  await expect(box).toBeFocused();
  expect(await box.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([0, "Pozicovka".length]);
});
