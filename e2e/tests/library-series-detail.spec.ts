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

test("the series detail keeps the chosen episode through its real folder listing", async ({ page }) => {
  await page.goto("/");
  await goToView(page, "Knihovna");
  await page.locator(`[data-path="${series.folder}"] .library-open`).click();

  const detail = page.locator(".library-local-detail");
  await expect(detail).toBeVisible();
  const episodeBlock = detail.locator(".catalogue-episodes");
  await episodeBlock.locator(".episode-current button").click();
  await episodeBlock.locator(".episode-list button", { hasText: "01×02" }).click();
  await expect(episodeBlock.locator(".episode-current")).toContainText("01×02");

  await detail.locator('.detail-secondary button[title="Otevřít složku"]').click();
  await expect(detail).toHaveCount(0);
  const first = page.locator(`[data-path="${series.folder}/${series.files[0]}"]`);
  const second = page.locator(`[data-path="${series.folder}/${series.files[1]}"]`);
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  await expect(page.getByRole("button", { name: "Vybrat položky", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Detail titulu", exact: true })).toBeVisible();

  await first.locator(".browse-menu").click();
  await expect(first.getByRole("button", { name: "Přejmenovat", exact: true })).toBeVisible();
  await expect(first.getByRole("button", { name: "Přesunout", exact: true })).toBeVisible();
  await expect(first.getByRole("button", { name: "Smazat", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Detail titulu", exact: true }).click();
  await expect(detail).toBeVisible();
  await expect(detail.locator(".episode-current")).toContainText("01×02");
});

test("leaving the series folder ends its folder view", async ({ page }) => {
  await page.goto("/");
  await goToView(page, "Knihovna");
  const tile = page.locator(`[data-path="${series.folder}"]`);
  await tile.locator(".library-open").click();
  await page.locator('.library-local-detail .detail-secondary button[title="Otevřít složku"]').click();
  await expect(page.getByRole("button", { name: "Detail titulu", exact: true })).toBeVisible();

  await page.locator(".crumbs").getByRole("button", { name: "Knihovna", exact: true }).click();
  await tile.locator(".library-open").click();

  await expect(page.locator(".library-local-detail")).toBeVisible();
  await expect(page.getByRole("button", { name: "Detail titulu", exact: true })).toHaveCount(0);
});

test("a Home episode card opens the local series on that episode", async ({ page, request }) => {
  const file = series.files.find((name) => name.includes("S01E02"))!;
  const relative = `${series.folder}/${file}`;
  const key = `file:${relative}`;
  await request.post("/api/progress", {
    data: { key, path: relative, title: series.folder, position: 120, duration: 2400 },
  });
  try {
    await page.goto("/");
    await goToView(page, "Domů");
    const card = page.locator('.home-row[data-row="resume"] .home-card', { hasText: series.folder });
    await expect(card).toBeVisible();
    await card.locator(".browse-open").click();

    const detail = page.locator(".library-local-detail");
    await expect(detail).toBeVisible();
    await expect(detail.locator(".episode-current")).toContainText("01×02");
    const current = page.locator('.crumbs button[aria-current="page"]');
    await expect(current).toHaveText(series.folder);
  } finally {
    await request.delete(`/api/progress/${encodeURIComponent(key)}`);
  }
});

test("a file detail's Folder action highlights that file in its parent", async ({ page }) => {
  await page.goto("/");
  await goToView(page, "Knihovna");
  await page.locator(`[data-path="${series.folder}"] .library-open`).click();
  await page.locator('.library-local-detail .detail-secondary button[title="Otevřít složku"]').click();

  const file = page.locator(`[data-path="${series.folder}/${series.files[0]}"]`);
  await file.locator(".library-open").click();
  const detail = page.locator(".library-local-detail");
  await expect(detail).toBeVisible();
  await detail.locator('.detail-secondary button[title="Otevřít složku"]').click();

  await expect(file.locator(".browse-focus-mark")).toBeVisible();
});
