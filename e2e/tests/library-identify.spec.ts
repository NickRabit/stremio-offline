import { expect, test, type Page } from "@playwright/test";
import { libraryTool } from "./library-tools";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

const sample = path.resolve("e2e/fixtures/media/sample.mp4");
const folderName = "Zkušební film (2024)";
const folder = path.resolve("e2e/.tmp/downloads", folderName);
const seriesName = "Zkušební seriál";
const seriesFolder = path.resolve("e2e/.tmp/downloads", seriesName);

test.beforeAll(async () => {
  await mkdir(folder, { recursive: true });
  await copyFile(sample, path.join(folder, "Zkušební film.mkv"));
  await mkdir(seriesFolder, { recursive: true });
  await copyFile(sample, path.join(seriesFolder, "Zkušební seriál S01E01.mkv"));
  await copyFile(sample, path.join(seriesFolder, "Zkušební seriál S01E02.mkv"));
});

const fixtureTile = (page: Page) => page.locator(".browse-item", { hasText: folderName });

test("scan library matches the unique fixture folder", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  await expect(fixtureTile(page)).toBeVisible();
  (await libraryTool(page, "Prohledat knihovnu")).click();
  await expect(page.getByText(/spárováno,/)).toBeVisible({ timeout: 20_000 });
  await expect(fixtureTile(page).locator(".library-desc")).toContainText("Film, který existuje jen pro testy.");
});

test("identify binds a library folder to the catalog title", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  await expect(fixtureTile(page)).toBeVisible();
  await page.getByRole("button", { name: `Možnosti: ${folderName}` }).click();
  const identify = page.getByRole("button", { name: "Přiřadit…" });
  const fix = page.getByRole("button", { name: "Opravit přiřazení…" });
  if (await identify.isVisible()) await identify.click();
  else await fix.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Zkušební film/ })).toBeVisible();
  await dialog.getByRole("button", { name: "Použít tento titul" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(fixtureTile(page).locator(".library-desc")).toContainText("Film, který existuje jen pro testy.");
  await expect(fixtureTile(page)).toContainText("2024");
});

test("unmatch clears the description and Identify stays available", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  await page.getByRole("button", { name: `Možnosti: ${folderName}` }).click();
  await page.getByRole("button", { name: "Zrušit přiřazení" }).click();
  await expect(page.getByText("Nepřiřazeno.")).toBeVisible();
  await expect(fixtureTile(page).locator(".library-desc")).toHaveCount(0);
  await page.getByRole("button", { name: `Možnosti: ${folderName}` }).click();
  await expect(page.getByRole("button", { name: "Přiřadit…" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Vyloučit z přiřazování" })).toBeVisible();
});

test("unmatch lets a later scan match again", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  await page.getByRole("button", { name: `Možnosti: ${folderName}` }).click();
  if (await page.getByRole("button", { name: "Zrušit přiřazení" }).isVisible()) {
    await page.getByRole("button", { name: "Zrušit přiřazení" }).click();
  } else {
    await page.keyboard.press("Escape");
  }
  (await libraryTool(page, "Prohledat knihovnu")).click();
  await expect(page.getByText(/spárováno,/)).toBeVisible({ timeout: 20_000 });
  await expect(fixtureTile(page).locator(".library-desc")).toContainText("Film, který existuje jen pro testy.");
});

test("skip catalog lookup keeps the title unmatched through a scan", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  await page.getByRole("button", { name: `Možnosti: ${folderName}` }).click();
  if (await page.getByRole("button", { name: "Zrušit přiřazení" }).isVisible()) {
    await page.getByRole("button", { name: "Zrušit přiřazení" }).click();
    await page.getByRole("button", { name: `Možnosti: ${folderName}` }).click();
  }
  await page.getByRole("button", { name: "Vyloučit z přiřazování" }).click();
  await expect(page.getByText("Vyloučeno z přiřazování.")).toBeVisible();
  (await libraryTool(page, "Prohledat knihovnu")).click();
  await expect(page.getByText(/spárováno,/)).toBeVisible({ timeout: 20_000 });
  await expect(fixtureTile(page).locator(".library-desc")).toHaveCount(0);
  await page.getByRole("button", { name: `Možnosti: ${folderName}` }).click();
  await page.getByRole("button", { name: "Zahrnout do přiřazování" }).click();
  await expect(page.getByText("Zahrnuto do přiřazování.")).toBeVisible();
});

test("each episode of a matched series shows its own plot", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  const seriesTile = page.locator(".browse-item", { hasText: seriesName });
  await expect(seriesTile).toBeVisible();
  await page.getByRole("button", { name: `Možnosti: ${seriesName}` }).click();
  const identify = page.getByRole("button", { name: "Přiřadit…" });
  if (await identify.isVisible()) await identify.click();
  else await page.getByRole("button", { name: "Opravit přiřazení…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /Zkušební seriál/ }).first().click();
  await dialog.getByRole("button", { name: "Použít tento titul" }).click();
  await expect(dialog).toHaveCount(0);

  await seriesTile.getByRole("button", { name: /Otevřít složku/ }).click();
  const first = page.locator(".browse-item", { hasText: "S01E01" });
  const second = page.locator(".browse-item", { hasText: "S01E02" });
  await expect(first.locator(".library-desc")).toContainText("V prvním dílu");
  await expect(second.locator(".library-desc")).toContainText("Ve druhém dílu");
});

test("find metadata on one item matches just that item", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  await expect(fixtureTile(page)).toBeVisible();
  await page.getByRole("button", { name: `Možnosti: ${folderName}` }).click();
  if (await page.getByRole("button", { name: "Zrušit přiřazení" }).isVisible()) {
    await page.getByRole("button", { name: "Zrušit přiřazení" }).click();
    await page.getByRole("button", { name: `Možnosti: ${folderName}` }).click();
  }
  await page.getByRole("button", { name: "Najít metadata" }).click();
  await expect(page.getByText("Hledám metadata…")).toBeVisible();
  await expect(fixtureTile(page).locator(".library-desc")).toContainText("Film, který existuje jen pro testy.", { timeout: 20_000 });
});
