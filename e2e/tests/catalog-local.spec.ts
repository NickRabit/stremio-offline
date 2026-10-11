import { expect, test, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { appUrl } from "../../playwright.config";

// A folder name of its own: the binding is what this journey is about, and a folder another
// spec also uses would let its match stand in for this one's.
const movieFolder = "Lokální film (2024)";
const movieFile = "Lokální film.webm";
const seriesFolder = "Lokální seriál";
const downloads = path.resolve("e2e/.tmp/downloads");
const session = "e2e/.tmp/session.json";

/** The same write the Identify dialog makes, so the rows under test are the client's. */
const bind = async (request: import("@playwright/test").APIRequestContext, folder: string, id: string, type: string) => {
  const response = await request.post("/api/library/match", { data: { path: folder, id, type, scope: "unit" } });
  expect(response.ok(), `${folder}: ${response.status()} ${await response.text()}`).toBe(true);
};

test.beforeAll(async ({ playwright }) => {
  await mkdir(path.join(downloads, movieFolder), { recursive: true });
  await mkdir(path.join(downloads, seriesFolder), { recursive: true });
  // The fixture clip is two seconds long, and a play that short saves no position. Loop it into
  // a browser-playable copy, so the library really has progress to show afterwards.
  const movie = path.join(downloads, movieFolder, movieFile);
  await promisify(execFile)("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-stream_loop", "59", "-i", path.resolve("e2e/fixtures/media/sample.mp4"),
    "-c:v", "libvpx-vp9", "-c:a", "libopus", "-y", movie,
  ]);
  await copyFile(movie, path.join(downloads, seriesFolder, "Lokální seriál S01E01.webm"));
  await copyFile(movie, path.join(downloads, seriesFolder, "Lokální seriál S01E02.webm"));

  const request = await playwright.request.newContext({ baseURL: appUrl, storageState: session });
  try {
    await bind(request, movieFolder, "tt-e2e-movie", "movie");
    await bind(request, seriesFolder, "tt-e2e-series", "series");
  } finally { await request.dispose(); }
});

test.afterAll(async ({ playwright }) => {
  // The layout baselines are taken against the state the journeys leave behind, so the binding
  // and the files go away again.
  const request = await playwright.request.newContext({ baseURL: appUrl, storageState: session });
  try {
    for (const folder of [movieFolder, seriesFolder]) {
      try { await request.post("/api/library/match", { data: { path: folder, id: "", type: "movie" } }); }
      catch { /* the folder may already be gone */ }
    }
  } finally { await request.dispose(); }
  await rm(path.join(downloads, movieFolder), { recursive: true, force: true });
  await rm(path.join(downloads, seriesFolder), { recursive: true, force: true });
});

const openCatalog = async (page: Page, label: RegExp) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Katalog", exact: true }).click();
  const select = page.getByRole("combobox", { name: "Procházet katalog" });
  const labels = await select.locator("option").allTextContents();
  await select.selectOption({ label: labels.find((text) => label.test(text))! });
};

test("a movie already in the library leads its sources and plays the library file", async ({ page, request }) => {
  await openCatalog(page, /Filmy/);
  await page.getByRole("button", { name: /Zkušební film/ }).click();

  const detail = page.locator(".detail-panel");
  const rows = detail.locator(".stream-list button");
  await expect(rows.first().locator("i.local")).toContainText("Lokální");
  await expect(rows.first()).toContainText(movieFile);
  await expect(rows.first()).toHaveClass(/selected/);

  await detail.getByRole("button", { name: "Přehrát", exact: true }).click();
  const overlay = page.locator(".player-overlay");
  const video = overlay.locator("video");
  // The clip is two minutes long; past five seconds the player has a position worth saving.
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => !element.paused && element.currentTime > 6), { timeout: 30_000 }).toBe(true);
  await page.getByRole("button", { name: "Zavřít přehrávač", exact: true }).click();
  await expect(overlay).toHaveCount(0);

  // The play wrote the file's own progress, which is what the Library view reads.
  await expect.poll(async () => {
    const result = await (await request.get("/api/library/resume?limit=8")).json();
    return (result.items ?? []).some((item: { path?: string }) => (item.path ?? "").includes("Lokální film"));
  }).toBe(true);
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  const card = page.locator('.library-shelf .browse-item[data-path*="Lokální film"]');
  await expect(card).toBeVisible();
  await expect(card.locator(".resume-bar")).toHaveCount(1);
});

test("the addon filter never hides the local copy", async ({ page }) => {
  await openCatalog(page, /Filmy/);
  await page.getByRole("button", { name: /Zkušební film/ }).click();

  const detail = page.locator(".detail-panel");
  const rows = detail.locator(".stream-list button");
  await detail.getByRole("combobox", { name: "Doplněk" }).selectOption("E2E doplněk");

  await expect(rows).toHaveCount(3);
  await expect(rows.first().locator("i.local")).toContainText("Lokální");
  await expect(rows.nth(1)).toContainText("E2E 1080p");
});

test("an episode leads with its own local copy and a later one has none", async ({ page }) => {
  await openCatalog(page, /Seriály/);
  await page.getByRole("button", { name: /Zkušební seriál/ }).click();

  const detail = page.locator(".detail-panel");
  await expect(detail.getByRole("heading", { name: "Epizody" })).toBeVisible();
  await detail.getByRole("combobox", { name: "Série" }).selectOption("1");
  await detail.getByRole("button", { name: /První díl/ }).click();

  const rows = detail.locator(".stream-list button");
  await expect(rows.first().locator("i.local")).toContainText("Lokální");
  await expect(rows.first()).toContainText("Lokální seriál S01E01.webm");
  await expect(rows.first()).toHaveClass(/selected/);

  // S02E01 has no file, so the addon sources lead exactly as they did before.
  await detail.getByRole("button", { name: "Změnit" }).click();
  await detail.getByRole("combobox", { name: "Série" }).selectOption("2");
  await detail.getByRole("button", { name: /Nová série/ }).click();

  await expect(detail.locator(".stream-list button i.local")).toHaveCount(0);
  await expect(rows.first()).toContainText("E2E 1080p");
});
