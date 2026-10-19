import { expect, test, type Page } from "@playwright/test";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { scanLibrary } from "./library-tools";

const downloads = path.resolve("e2e/.tmp/downloads");
const sample = path.resolve("e2e/fixtures/media/sample.mp4");
const deepFolder = path.join(downloads, "Hledacka", "Hloubka", "Treti");
const siblingFolder = path.join(downloads, "Hledacka", "Jina");
const filter = "Filtrovat knihovnu";

test.beforeAll(async () => {
  await mkdir(deepFolder, { recursive: true });
  await mkdir(siblingFolder, { recursive: true });
  await copyFile(sample, path.join(deepFolder, "Hluboky soubor.mp4"));
  await copyFile(sample, path.join(siblingFolder, "Hluboky jinde.mp4"));
});

test.afterAll(async () => {
  await rm(path.join(downloads, "Hledacka"), { recursive: true, force: true });
});

const openFolder = async (page: Page, name: string) => {
  const tile = page.locator(".browse-item").filter({ hasText: name });
  await expect(tile).toBeVisible();
  await tile.getByRole("button", { name: /Otevřít složku/ }).click();
};

test("the library box searches the whole opened library and the folder's subtree", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  await scanLibrary(page);

  await openFolder(page, "Hledacka");
  const box = page.getByLabel(filter);
  await box.fill("hluboky");
  await expect(page.locator("[data-search-card]").filter({ hasText: "Hluboky soubor" })).toBeVisible({ timeout: 15_000 });

  await box.fill("");
  await openFolder(page, "Hloubka");
  await box.fill("hluboky");
  await expect(page.locator("[data-search-card]").filter({ hasText: "Hluboky soubor" })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-search-card]").filter({ hasText: "Hluboky jinde" })).toHaveCount(0);
});
