import { expect, test, type Page } from "@playwright/test";

/** The catalogue opened the way a person opens it: the view, then the listing to browse. */
const openCatalogue = async (page: Page, label: RegExp) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Katalog", exact: true }).click();
  const select = page.getByRole("combobox", { name: "Procházet katalog" });
  const labels = await select.locator("option").allTextContents();
  await select.selectOption({ label: labels.find((text) => label.test(text))! });
};

/** The one way into the full detail, whichever of its two homes is on screen. */
const info = (page: Page) => page.locator(".detail-panel .detail-info:visible");

test("a show played from the full detail carries its own episode and plays the next one", async ({ page }) => {
  await openCatalogue(page, /Seriály/);
  await page.getByRole("button", { name: /Zkušební seriál/ }).click();
  await page.locator(".detail-panel").getByRole("button", { name: /První díl/ }).click();
  await expect(page.locator(".detail-panel .stream-list button").first()).toBeVisible();
  // The addon's own row: a library copy plays as a file, with the library's next file rather than
  // the show's next episode.
  await page.locator(".detail-panel .stream-list").getByRole("button", { name: /E2E 1080p/ }).click();
  await info(page).click();
  const main = page.locator("main.view-title-detail");
  await expect(main).toBeVisible();

  await main.getByRole("button", { name: "Přehrát", exact: true }).click();
  const player = page.locator(".player-overlay");
  await expect(player).toBeVisible();
  // The episode on screen travels with the title, and the next one comes from the detail's own
  // show, never from whatever the browse panel happens to have selected behind it.
  await expect(player.locator(".player-head strong")).toHaveText("Zkušební seriál · 01×01");
  await expect(player.locator(".next-episode")).toHaveAttribute("title", /Druhý díl/);

  await player.locator(".next-episode").click();
  await expect(player.locator(".player-head strong")).toHaveText("Zkušební seriál · 01×02");
});

test("the full detail settles in one step while its extras and sources are still on their way", async ({ page }) => {
  const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
  await page.route("**/api/meta/movie/*/extras*", async (route) => {
    await wait(900);
    await route.fulfill({ json: {
      source: "tmdb", originalTitle: "Test Film Original", originalLanguage: "en", ageRating: "15",
      ratings: { imdb: "7.1", tmdb: 6.9, tmdbVotes: 1200 },
      people: [
        { name: "Ada Director", role: "director" },
        ...Array.from({ length: 8 }, (_, index) => ({ name: `Actor ${index}`, role: "cast", character: `Role ${index}` })),
      ],
      videos: Array.from({ length: 3 }, (_, index) => ({ key: `video-${index}`, name: `Trailer ${index}`, kind: "trailer", thumbnail: "" })),
      related: Array.from({ length: 8 }, (_, index) => ({ type: "movie", id: `tt-related-${index}`, name: `Related ${index}`, year: "2020" })),
    } });
  });
  await page.route("**/api/streams/**", async (route) => { await wait(1800); await route.fallback(); });
  await openCatalogue(page, /Filmy/);
  await page.getByRole("button", { name: /Zkušební film/ }).click();
  await expect(info(page)).toBeVisible();
  await page.evaluate(() => {
    const store = window as unknown as { __shift: number };
    store.__shift = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>) {
        if (!entry.hadRecentInput) store.__shift += entry.value;
      }
    }).observe({ type: "layout-shift" });
  });
  await info(page).click();
  const main = page.locator("main.view-title-detail");
  await expect(main.locator(".detail-tech")).toBeVisible({ timeout: 10_000 });
  await expect(main.locator(".title-extras .person").first()).toBeVisible();
  await page.waitForTimeout(400);
  const shift = await page.evaluate(() => (window as unknown as { __shift: number }).__shift);
  // Skeletons stand where the content lands, so the page barely moves while it fills in.
  expect(shift).toBeLessThan(0.03);
});
