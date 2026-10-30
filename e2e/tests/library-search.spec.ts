import { expect, test, type Page } from "@playwright/test";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { scanLibrary } from "./library-tools";

const downloads = path.resolve("e2e/.tmp/downloads");
const sample = path.resolve("e2e/fixtures/media/sample.mp4");
const deepFolder = path.join(downloads, "Hledacka", "Hloubka", "Treti");
const siblingFolder = path.join(downloads, "Hledacka", "Jina");
const placeholder = "Hledat v katalozích a knihovnách…";

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

const hledat = (page: Page) => page.locator(".browse-panel:not(.remote-libraries) .browse-tools").getByRole("button", { name: "Hledat", exact: true });

const searchHere = async (page: Page, query: string, pathIncludes: string) => {
  const request = page.waitForRequest((candidate) => {
    if (candidate.method() !== "POST" || !candidate.url().endsWith("/api/search/everywhere")) return false;
    const body = candidate.postDataJSON() as { sources?: string[]; library?: { path?: string } } | null;
    return body?.sources?.length === 1 && body.sources[0] === "local" && (body.library?.path ?? "").includes(pathIncludes);
  });
  const box = page.getByRole("combobox", { name: placeholder });
  await box.fill(query);
  await box.press("Enter");
  await request;
};

test("the library opens Search for the folder and a deeper folder stays inside it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  await scanLibrary(page);

  await openFolder(page, "Hledacka");
  await hledat(page).click();
  await expect(page.locator("main.view-search")).toBeVisible();
  await expect(page.locator(".search-filters").getByRole("button", { name: "Knihovny", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Hledat ve všech knihovnách" })).toContainText("Hledacka");
  await searchHere(page, "hluboky", "Hledacka");
  await expect(page.locator("[data-search-card]").filter({ hasText: "Hluboky soubor" })).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Zpět do knihovny" }).click();
  await expect(page.locator("main.view-library")).toBeVisible();
  await expect(page.locator(".crumbs").getByRole("button", { name: "Hledacka" })).toBeVisible();

  await openFolder(page, "Hloubka");
  await hledat(page).click();
  await expect(page.getByRole("button", { name: "Hledat ve všech knihovnách" })).toContainText("Hloubka");
  await searchHere(page, "hluboky", "Hloubka");
  await expect(page.locator("[data-search-card]").filter({ hasText: "Hluboky soubor" })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-search-card]").filter({ hasText: "Hluboky jinde" })).toHaveCount(0);
});
