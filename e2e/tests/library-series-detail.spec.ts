import { expect, test } from "@playwright/test";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fixtureLibraryTitles } from "./fixture-library";
import { goToView } from "./nav";

const series = fixtureLibraryTitles.find((title) => title.type === "series")!;
const sample = path.resolve("e2e/fixtures/media/sample.mp4");
const directory = path.resolve("e2e/.tmp/downloads", series.folder);

test.beforeAll(async () => {
  await mkdir(directory, { recursive: true });
  for (const file of series.files) await copyFile(sample, path.join(directory, file));
});

test.beforeEach(async ({ request }) => {
  await expect.poll(async () => {
    const listing = await (await request.get("/api/library/browse")).json() as { items: Array<{ path: string }> };
    return listing.items.some((item) => item.path === series.folder);
  }, { timeout: 30_000 }).toBe(true);
  const matched = await request.post("/api/library/match", {
    data: { path: series.folder, id: series.id, type: series.type },
  });
  expect(matched.ok(), await matched.text()).toBe(true);
});

test("a matched local series opens like its catalogue detail and Back leaves the show", async ({ page }) => {
  await page.goto("/");
  await goToView(page, "Knihovna");

  const tile = page.locator(`[data-path="${series.folder}"]`);
  await expect(tile).toBeVisible();
  await tile.locator(".library-open").click();

  const detail = page.locator(".library-local-detail");
  await expect(detail).toBeVisible();
  await expect(detail.locator(".library-detail-hero h2")).toHaveText(series.folder);
  const episodeBlock = detail.locator(".catalogue-episodes");
  await expect(episodeBlock.locator(".episode-current")).toBeVisible();
  await expect(detail.locator(".library-detail-play .split-button")).toBeVisible();
  await expect(detail.locator("dl.detail-tech")).toBeVisible();

  const codeFor = (file: string) => {
    const match = /S(\d{2})E(\d{2})/.exec(file)!;
    return `${match[1]}×${match[2]}`;
  };
  const fileFor = (code: string) => series.files.find((file) => codeFor(file) === code)!;
  const fileRow = () => detail.locator(".detail-tech dt").filter({ hasText: "Soubor" })
    .locator("xpath=following-sibling::dd[1]");

  const firstCode = (await episodeBlock.locator(".episode-current b").textContent())!.trim();
  const otherCode = series.files.map(codeFor).find((code) => code !== firstCode)!;
  await expect(fileRow()).toHaveText(fileFor(firstCode));

  await episodeBlock.locator(".episode-current button").click();
  await expect(episodeBlock.locator(".episode-list")).toBeVisible();
  await episodeBlock.locator(".episode-list button", { hasText: otherCode }).click();
  await expect(episodeBlock.locator(".episode-current")).toContainText(otherCode);
  await expect(fileRow()).toHaveText(fileFor(otherCode));
  await expect(detail.locator(".library-detail-play .split-button")).toBeVisible();

  await page.locator(".library-back").click();
  await expect(detail).toHaveCount(0);
  await expect(tile).toBeVisible();
});
