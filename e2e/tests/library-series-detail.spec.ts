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

test("a matched local series opens its episodes and Back returns from an episode", async ({ page }) => {
  await page.goto("/");
  await goToView(page, "Knihovna");

  const tile = page.locator(`[data-path="${series.folder}"]`);
  await expect(tile).toBeVisible();
  await tile.locator(".library-open").click();

  const detail = page.locator(".local-series-detail");
  await expect(detail).toBeVisible();
  await expect(detail.locator(".library-detail-hero h2")).toHaveText(series.folder);
  await expect(detail.locator(".remote-season").first()).toHaveText("Série 1");

  await detail.locator(".remote-season-group .browse-item").first().locator(".library-open").click();
  await expect(detail).toHaveCount(0);
  await expect(page.locator(".library-title-detail:not(.local-series-detail)")).toBeVisible();

  await page.locator(".library-back").click();
  await expect(detail).toBeVisible();
});
