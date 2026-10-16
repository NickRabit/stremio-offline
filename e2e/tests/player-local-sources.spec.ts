import { expect, test, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { addonManifest, appUrl } from "../../playwright.config";
import { pickAddonStream } from "./catalog-sources";

// A folder of its own: the binding is what these journeys switch sources under, and the layout
// baselines are taken against the library the other specs leave behind.
const filmFolder = "Kontrola zdrojů (2024)";
const filmFile = "Kontrola zdrojů.webm";
// A file nothing binds: it plays as itself and has no other source to offer.
const looseFile = "Nespárovaný film.webm";
const downloads = path.resolve("e2e/.tmp/downloads");
const session = "e2e/.tmp/session.json";

const bind = async (request: import("@playwright/test").APIRequestContext, folder: string, id: string, type: string) => {
  const response = await request.post("/api/library/match", { data: { path: folder, id, type, scope: "unit" } });
  expect(response.ok(), `${folder}: ${response.status()} ${await response.text()}`).toBe(true);
};

test.beforeAll(async ({ playwright }) => {
  await mkdir(path.join(downloads, filmFolder), { recursive: true });
  // The fixture clip is two seconds long, and a play that short never saves a position: loop it,
  // so the film really runs while the sources are switched underneath it.
  const film = path.join(downloads, filmFolder, filmFile);
  await promisify(execFile)("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-stream_loop", "59", "-i", path.resolve("e2e/fixtures/media/sample.mp4"),
    "-c:v", "libvpx-vp9", "-c:a", "libopus", "-y", film,
  ]);
  await copyFile(film, path.join(downloads, looseFile));
  const request = await playwright.request.newContext({ baseURL: appUrl, storageState: session });
  try { await bind(request, filmFolder, "tt-e2e-movie", "movie"); }
  finally { await request.dispose(); }
});

test.afterAll(async ({ playwright }) => {
  const request = await playwright.request.newContext({ baseURL: appUrl, storageState: session });
  try { await request.post("/api/library/match", { data: { path: filmFolder, id: "", type: "movie" } }); }
  finally { await request.dispose(); }
  await rm(path.join(downloads, filmFolder), { recursive: true, force: true });
  await rm(path.join(downloads, looseFile), { force: true });
});

test.describe("the player's sources for a library file", () => {
  // Chromium in the test image has no H.264, so the addon hands out its VP9 copy and a switch
  // really plays; the mode is shared with the other specs in the run.
  test.beforeEach(async ({ request }) => {
    await request.get(new URL("/proxy-control?mode=browser", addonManifest).href);
  });
  test.afterEach(async ({ request }) => {
    await request.get(new URL("/proxy-control?mode=video", addonManifest).href);
  });

  /** Opens one row of the library the way a viewer does: the tile, then its own detail. A journey
   *  that cares what the page had behind the player walks there instead of reloading the app. */
  const openLibraryRow = async (page: Page, name: string, reload = true) => {
    if (reload) await page.goto("/");
    await page.getByRole("button", { name: "Knihovna", exact: true }).click();
    const tile = page.locator(".browse-item").filter({ hasText: name }).first();
    await expect(tile).toBeVisible();
    await tile.locator(".library-open").click();
    await expect(page.locator(".library-title-detail")).toBeVisible();
  };

  const play = async (page: Page) => {
    await page.locator(".library-title-detail").getByRole("button", { name: "Přehrát", exact: true }).click();
    await expect(page.locator(".player-overlay")).toBeVisible();
  };

  const playerTitle = (page: Page) => page.locator(".player-head strong");
  const sources = (page: Page) => page.locator("#player-sources .track-picker button");
  /** The list is read once per source, so opening it again shows the rows the session now has. */
  const openSources = async (page: Page) => {
    const panel = page.locator("#player-sources");
    if (!(await panel.isVisible().catch(() => false))) await page.getByRole("button", { name: "Zdroje", exact: true }).click();
    await expect(panel).toBeVisible();
    await expect.poll(async () => sources(page).count()).toBeGreaterThan(1);
    await expect(panel.locator(".identify-hint")).toHaveCount(0);
  };

  test("a matched file offers the title's sources, and the title stays put across a switch", async ({ page }) => {
    await openLibraryRow(page, filmFolder);
    await play(page);
    const title = await playerTitle(page).textContent();
    expect(title).toBe(filmFolder);

    // The viewer's own copy stands first, named by its file, and is the row that plays.
    await openSources(page);
    await expect(sources(page).first()).toContainText(filmFile);
    await expect(sources(page).first()).toHaveAttribute("aria-pressed", "true");
    await expect(sources(page).filter({ hasText: "E2E" })).toHaveCount(1);

    // Away to the addon's stream and back to the file: the header never changes its mind.
    await sources(page).filter({ hasText: "E2E" }).click();
    await expect(playerTitle(page)).toHaveText(title!);
    await openSources(page);
    await expect(sources(page).filter({ hasText: "E2E" })).toHaveAttribute("aria-pressed", "true");
    await sources(page).filter({ hasText: filmFile }).click();
    await expect(playerTitle(page)).toHaveText(title!);
    await openSources(page);
    await expect(sources(page).filter({ hasText: filmFile })).toHaveAttribute("aria-pressed", "true");
  });

  test("a file nothing binds plays as itself, with no sources control", async ({ page }) => {
    await openLibraryRow(page, looseFile.replace(/\.webm$/, ""));
    await play(page);
    await expect(playerTitle(page)).toHaveText("Nespárovaný film");
    await expect(page.getByRole("button", { name: "Zdroje", exact: true })).toHaveCount(0);
  });

  test("a catalogue play keeps switching both ways", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Katalog", exact: true }).click();
    const catalog = page.getByRole("combobox", { name: "Procházet katalog" });
    const labels = await catalog.locator("option").allTextContents();
    await catalog.selectOption({ label: labels.find((text) => /Filmy/.test(text))! });
    await page.getByRole("button", { name: /Zkušební film/ }).click();
    await pickAddonStream(page);
    await page.locator(".detail-panel").getByRole("button", { name: "Přehrát", exact: true }).click();
    await expect(page.locator(".player-overlay")).toBeVisible();
    await expect(playerTitle(page)).toHaveText("Zkušební film");

    // The catalogue play reaches the viewer's own copy, and back to the addon row it started on.
    await openSources(page);
    await expect(sources(page).first()).toContainText(filmFile);
    await sources(page).filter({ hasText: filmFile }).click();
    await expect(playerTitle(page)).toHaveText("Zkušební film");
    await openSources(page);
    await expect(sources(page).filter({ hasText: filmFile })).toHaveAttribute("aria-pressed", "true");
    await sources(page).filter({ hasText: "E2E" }).click();
    await expect(playerTitle(page)).toHaveText("Zkušební film");
    await openSources(page);
    await expect(sources(page).filter({ hasText: "E2E" })).toHaveAttribute("aria-pressed", "true");
  });

  test("a library play never borrows a title another detail has open", async ({ page }) => {
    // The catalogue leaves a detail behind, and its title is not the file about to play.
    await page.goto("/");
    await page.getByRole("button", { name: "Katalog", exact: true }).click();
    const catalog = page.getByRole("combobox", { name: "Procházet katalog" });
    const labels = await catalog.locator("option").allTextContents();
    await catalog.selectOption({ label: labels.find((text) => /Seriál/.test(text))! });
    await page.getByRole("button", { name: /Zkušební seriál/ }).first().click();
    await expect(page.locator(".detail-panel")).toContainText("Zkušební seriál");

    const progressKeys: string[] = [];
    // No reload: the detail the viewer left open is exactly the state under test.
    await openLibraryRow(page, filmFolder, false);
    await play(page);
    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("/api/progress/")) progressKeys.push(decodeURIComponent(url));
    });
    await openSources(page);
    await sources(page).filter({ hasText: "E2E" }).click();
    await expect(playerTitle(page)).toHaveText(filmFolder, { timeout: 5_000 });
    // The film the file is bound to names the play, never the show the panel happens to hold.
    expect(progressKeys.filter((url) => url.includes("tt-e2e-series"))).toEqual([]);
  });

  test("a Continue card of a matched file offers the title's sources too", async ({ page, request }) => {
    // Nothing hands this play an identity: it can only come from the matcher's own answer.
    const key = `file:${filmFolder}/${filmFile}`;
    expect((await request.post("/api/progress", { data: { key, path: `${filmFolder}/${filmFile}`, title: filmFolder, position: 60, duration: 180 } })).ok()).toBe(true);
    try {
      await page.goto("/");
      await page.getByRole("button", { name: "Pokračovat ve sledování", exact: true }).click();
      const card = page.locator(".browse-item", { hasText: filmFolder }).first();
      await expect(card).toBeVisible();
      await card.locator(".browse-open").click();
      await expect(page.locator(".player-overlay")).toBeVisible();
      await expect(playerTitle(page)).toHaveText(filmFolder);
      await openSources(page);
      await expect(sources(page)).toHaveCount(2);
      await expect(sources(page).first()).toContainText(filmFile);
    } finally {
      await request.delete(`/api/progress/${encodeURIComponent(key)}`);
    }
  });
});
