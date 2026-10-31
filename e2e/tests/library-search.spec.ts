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

test("the library field finds videos anywhere beneath the folder and starts no search", async ({ page }) => {
  let searched = false;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/search/everywhere")) searched = true;
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  await scanLibrary(page);

  await openFolder(page, "Hledacka");
  await expect(page.locator(".browse-tools").getByRole("button", { name: "Hledat", exact: true })).toHaveCount(0);
  const box = page.getByLabel(filter);
  const filtered = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/library/browse" && url.searchParams.get("query") === "hluboky";
  });
  await box.fill("hluboky");
  await filtered;
  // Both videos sit two and one folders down; the filter reaches them without opening a folder.
  await expect(page.locator(".browse-item").filter({ hasText: "Hluboky soubor" })).toBeVisible();
  await expect(page.locator(".browse-item").filter({ hasText: "Hluboky jinde" })).toBeVisible();
  await expect(page.locator("main.view-library")).toBeVisible();
  expect(searched).toBe(false);

  await box.fill("");
  await expect(page.locator(".browse-item").filter({ hasText: "Jina" })).toBeVisible();
});
