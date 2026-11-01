import { expect, test, type Page } from "@playwright/test";

/** The catalogue opened the way a person opens it: the view, then the listing to browse. */
const openCatalogue = async (page: Page, label: RegExp) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Katalog", exact: true }).click();
  const select = page.getByRole("combobox", { name: "Procházet katalog" });
  const labels = await select.locator("option").allTextContents();
  await select.selectOption({ label: labels.find((text) => label.test(text))! });
};

/** The one way into the full detail: the end of the hero's chip row, and the same control in the
 *  panel's head for the states that fold the whole hero away (a phone, a landscape window).
 *  Exactly one of the two is ever on screen. */
const info = (page: Page) => page.locator(".detail-panel .detail-info:visible");
const heroInfo = (page: Page) => page.locator(".detail-panel .hero .title-chips .detail-info");

/** Scrolling the source list is what folds the hero away on a phone; a pull back would restore
 *  it, so the list is left where the gesture put it. */
const scrollSources = async (page: Page) => {
  const list = page.locator(".detail-panel .stream-list");
  if (!(await list.count())) return;
  await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await page.waitForTimeout(150);
};

test("the way into the full detail ends the hero's chip row and never leaves the panel", async ({ page }) => {
  await openCatalogue(page, /Filmy/);
  await page.getByRole("button", { name: /Zkušební film/ }).click();
  const panel = page.locator(".detail-panel");
  await expect(panel.locator(".hero")).toBeVisible();

  await expect(info(page)).toHaveCount(1);
  const button = heroInfo(page);
  await expect(button).toHaveCount(1);
  // Where the row has room the control ends it; a phone or a tablet has none, and the panel's head
  // carries the same control there, in the corner its own spacer used to hold.
  const narrow = (page.viewportSize()?.width ?? 0) <= 980;
  const headControl = page.locator(".detail-panel .catalog-detail-head .detail-info-head");
  if (narrow) {
    await expect(headControl).toBeVisible();
    await expect(button).toBeHidden();
  } else {
    await expect(button).toBeVisible();
    await expect(headControl).toBeHidden();
  }
  // The chips keep a row of their own across the whole band, and the corner art starts below it:
  // the row the art used to share is the one it narrowed, which wrapped the chips on a phone.
  const geometry = await panel.locator(".hero").evaluate((hero) => {
    const box = (node: Element | null) => node ? node.getBoundingClientRect() : null;
    const row = box(hero.querySelector(".detail-chips"))!;
    const heroBox = box(hero)!;
    const style = getComputedStyle(hero);
    return {
      row: { left: row.left, right: row.right, bottom: row.bottom },
      band: { left: heroBox.left + parseFloat(style.paddingLeft), right: heroBox.right - parseFloat(style.paddingRight) },
      control: box(hero.querySelector(".detail-info")),
      art: box(hero.querySelector(".gallery-open")),
    };
  });
  expect(geometry.row.left).toBeGreaterThanOrEqual(geometry.band.left - 1);
  expect(geometry.row.right).toBeLessThanOrEqual(geometry.band.right + 1);
  expect(geometry.row.right).toBeGreaterThan(geometry.band.right - 2);
  if (geometry.art) expect(geometry.art.top).toBeGreaterThanOrEqual(geometry.row.bottom - 1);
  if (!narrow) {
    expect(geometry.control).not.toBeNull();
    expect(geometry.control!.right).toBeLessThanOrEqual(geometry.row.right + 1);
    expect(geometry.control!.right).toBeGreaterThan(geometry.row.right - 40);
    expect(geometry.control!.height).toBeGreaterThanOrEqual(24);
  }

  await panel.locator(".catalog-description summary").click();
  await expect(panel.locator(".catalog-description details[open] p")).toBeVisible();
  await expect(info(page)).toBeInViewport();

  // Folded away -- the band on a desktop, the whole hero on a phone -- the control stays where it
  // can be reached, which is the one promise the placement has to keep.
  await scrollSources(page);
  await expect(info(page)).toHaveCount(1);
  await expect(info(page)).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test("a film opens the full detail over the catalogue and comes back to it", async ({ page }) => {
  await openCatalogue(page, /Filmy/);
  await page.getByRole("button", { name: /Zkušební film/ }).click();
  const panel = page.locator(".detail-panel");
  // A row the viewer picks on purpose, not the one that happened to be first: the detail has to
  // open on exactly this version, and to say so before any button is pressed.
  await panel.locator(".stream-list").getByRole("button", { name: /E2E 720p/ }).click();
  // The row the catalogue picked is the row the shared detail has to open on.
  const selected = panel.locator(".stream-list button.selected");
  await expect(selected).toHaveCount(1);
  const pickedRow = (await selected.locator("strong").textContent())!.trim();

  await info(page).click();
  const main = page.locator("main.view-title-detail");
  await expect(main).toBeVisible();
  const detail = main.locator(".library-title-detail");
  await expect(detail).toBeVisible();
  await expect(detail.getByRole("heading").first()).toBeVisible();
  await expect(detail.locator(".library-detail-actions").getByRole("button", { name: "Přehrát", exact: true })).toBeVisible();
  // The row the buttons act on is named above them, so Play, To library and To device visibly act
  // on the version the catalogue had chosen.
  await expect(detail.locator(".detail-tech")).toContainText(pickedRow);
  await expect(detail.locator(".detail-tech")).toContainText("900.0 MB");

  // The way back is outside the scroller, so it is reachable from wherever the reader has got to.
  const back = main.locator(".browse-head .library-back");
  await expect(back).toBeInViewport();
  const pane = (await main.locator(".browse-panel").boundingBox())!;
  expect(pane.height).toBeGreaterThan(200);
  expect(pane.width).toBeGreaterThan(200);
  const scroll = main.locator(".browse-scroll");
  expect(await scroll.evaluate((element) => element.clientHeight)).toBeGreaterThan(120);
  if (await scroll.evaluate((element) => element.scrollHeight > element.clientHeight + 1)) {
    await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(back).toBeInViewport();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

  // The row the catalogue selected travelled with the title.
  await detail.locator(".library-detail-play .split-button-toggle").click();
  const chosen = page.locator(".library-source-card .remote-streams button[aria-pressed=true]");
  await expect(chosen).toHaveCount(1);
  await expect(chosen.locator("strong")).toHaveText(pickedRow);
  await page.keyboard.press("Escape");
  await expect(page.locator(".library-source-card")).toHaveCount(0);

  await back.click();
  await expect(main).toHaveCount(0);
  await expect(page.locator(".poster-grid .poster-card.selected")).toHaveCount(1);
});

test("the full detail draws the title's own chips, watch star and follow", async ({ page }) => {
  await openCatalogue(page, /Seriály/);
  await page.getByRole("button", { name: /Zkušební seriál/ }).click();
  await page.locator(".detail-panel").getByRole("button", { name: /První díl/ }).click();
  await expect(page.locator(".detail-panel .stream-list button").first()).toBeVisible();

  await info(page).click();
  const main = page.locator("main.view-title-detail");
  await expect(main).toBeVisible();
  const chips = main.locator(".library-detail-chips");
  await expect(chips).toBeVisible();
  // What the panel offered to add the title to the list with travels into the full detail: the star
  // writes the same watchlist entry (among the labelled actions), and the show can be followed from
  // either place.
  await expect(main.locator(".detail-secondary").getByRole("button", { name: "Přidat do seznamu" })).toBeVisible();
  const follow = chips.getByRole("button", { name: /Sledovat/ });
  await expect(follow).toBeVisible();
  await follow.click();
  const dialog = page.locator(".identify-overlay");
  await expect(dialog).toBeVisible();
  await dialog.locator(".dialog-foot").getByRole("button", { name: "Zrušit" }).click();
  await expect(dialog).toHaveCount(0);

  // The row is the hero's own: the title block stands under it, not beside it.
  const stacked = await main.locator(".library-title-detail").evaluate((surface) => {
    const row = surface.querySelector(".detail-chips")!.getBoundingClientRect();
    const heading = surface.querySelector("h2")!.getBoundingClientRect();
    const art = surface.querySelector(".gallery-open")?.getBoundingClientRect();
    return { rowBottom: row.bottom, headingTop: heading.top, artTop: art?.top ?? null };
  });
  expect(stacked.headingTop).toBeGreaterThanOrEqual(stacked.rowBottom - 1);
  if (stacked.artTop !== null) expect(stacked.artTop).toBeGreaterThanOrEqual(stacked.rowBottom - 1);
});

test("the full detail shows the saved position it holds and can start over", async ({ page, request }) => {
  const key = "series:tt-e2e-series:1:1";
  const saved = { key, position: 300, duration: 1800, title: "Zkušební seriál" };
  await request.post("/api/progress", { data: saved });
  try {
    await openCatalogue(page, /Seriály/);
    await page.getByRole("button", { name: /Zkušební seriál/ }).click();
    await page.locator(".detail-panel").getByRole("button", { name: /První díl/ }).click();
    await expect(page.locator(".detail-panel .stream-list button").first()).toBeVisible();
    await info(page).click();
    const row = page.locator("main.view-title-detail .library-detail-progress");
    await expect(row).toBeVisible();
    await expect(row).toContainText("5:00");
    // The pair stands together: the position the store holds, and the way to say the episode is
    // seen -- which is that position going away.
    const watched = page.locator("main.view-title-detail").getByRole("button", { name: "Označit jako zhlédnuté" });
    await expect(watched).toBeVisible();

    // Marking it seen clears it, and the row goes with it: there is nothing left to resume.
    await watched.click();
    await expect(row).toHaveCount(0);
    const list = await (await request.get("/api/progress")).json() as Array<{ key: string }>;
    expect(list.some((entry) => entry.key === key)).toBe(false);
  } finally {
    await request.delete(`/api/progress/${encodeURIComponent(key)}`);
  }
});

test("the menu is a way out of the full detail as well as the breadcrumb", async ({ page }) => {
  await openCatalogue(page, /Filmy/);
  await page.getByRole("button", { name: /Zkušební film/ }).click();
  const main = page.locator("main.view-title-detail");
  const menu = (name: string) => page.locator(".sidebar").getByRole("button", { name, exact: true });

  await info(page).click();
  await expect(main).toBeVisible();
  // The entry naming the section the detail was drawn over only puts that section back, with the
  // title it was opened on still selected: asking for what is already there does not reset it.
  await menu("Katalog").click();
  await expect(main).toHaveCount(0);
  await expect(page.locator(".poster-grid .poster-card.selected")).toHaveCount(1);
  await expect(page.locator(".detail-panel .stream-list button").first()).toBeVisible();

  // Another section is a real journey, and the detail is not left standing over it.
  await info(page).click();
  await expect(main).toBeVisible();
  await menu("Knihovna").click();
  await expect(main).toHaveCount(0);
  await expect(page.locator("main")).toHaveClass(/view-library/);
});

test("the section under the full detail keeps the position it was left at", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Domů", exact: true }).click();
  const card = page.locator('.home-card[data-kind="discovery"]').first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  const room = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
  test.skip(room < 60, "this viewport has nothing to scroll on Home");
  const wanted = Math.min(150, room);
  await page.evaluate((top) => window.scrollTo(0, top), wanted);
  await page.waitForTimeout(300);
  // Where a slow row still settles, the offset the browser accepts is the one under test.
  const before = await page.evaluate(() => Math.round(window.scrollY));
  expect(before).toBeGreaterThan(0);

  await card.click();
  await expect(page.locator("main.view-title-detail")).toBeVisible();
  await page.locator("main.view-title-detail .library-back").click();
  await expect(page.locator("main.view-title-detail")).toHaveCount(0);
  // The detail is drawn over that section, so the section is read again on the way back: the
  // position is given back once its rows are there, not merely asked for once. Rows that settle
  // as they come back can move the page a few pixels -- what must not happen is the top of it.
  await expect.poll(async () => Math.abs((await page.evaluate(() => window.scrollY)) - before)).toBeLessThan(40);
});

test("a series opens the full detail on the episode the catalogue had and lets another be chosen", async ({ page }) => {
  await openCatalogue(page, /Seriály/);
  await page.getByRole("button", { name: /Zkušební seriál/ }).click();
  const panel = page.locator(".detail-panel");
  await expect(panel.getByRole("heading", { name: "Epizody" })).toBeVisible();
  await panel.getByRole("button", { name: /První díl/ }).click();
  await expect(panel.locator(".stream-list button").first()).toBeVisible();
  // The episode's own row travels the same way: the detail opens on the version the panel picked.
  const pickedRow = (await panel.locator(".stream-list button.selected strong").textContent())!.trim();

  // The way in is on screen beside the episodes and the sources: in the hero's chip row, or in
  // the head while the band is folded away.
  await expect(info(page)).toHaveCount(1);
  await expect(info(page)).toBeInViewport();
  // Short screens drop the chips and the description to spend the height on the sources; where
  // they are there, opening the copy must not take the way in away.
  const summary = panel.locator(".catalog-description summary");
  if (await summary.isVisible()) {
    await summary.click();
    await expect(info(page)).toBeInViewport();
  }

  await info(page).click();
  const main = page.locator("main.view-title-detail");
  await expect(main).toBeVisible();
  const episodes = main.locator(".catalogue-episodes");
  await expect(episodes.locator(".episode-current")).toContainText("První díl");
  await expect(main.locator(".detail-tech")).toContainText(pickedRow);
  await expect(main.locator(".library-detail-actions").getByRole("button", { name: "Přehrát", exact: true })).toBeVisible();
  const back = main.locator(".browse-head .library-back");
  await expect(back).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

  // Another episode is picked inside the detail, which asks for that episode's own sources.
  await episodes.locator(".episode-current button").click();
  const episodeRows = episodes.locator(".episode-list button");
  await expect(episodeRows).toHaveCount(2);
  await episodeRows.nth(1).click();
  await expect(episodes.locator(".episode-current")).not.toContainText("První díl");
  await expect(main.locator(".library-detail-actions").getByRole("button", { name: "Přehrát", exact: true })).toBeVisible();

  // The labelled season menu reaches the other season's own episodes.
  await episodes.locator(".episode-current button").click();
  await episodes.getByRole("combobox", { name: "Série" }).selectOption("2");
  await expect(episodeRows).toHaveCount(1);
  await expect(episodeRows.first()).toContainText("Nová série");

  await back.click();
  await expect(main).toHaveCount(0);
  await expect(page.locator(".poster-grid .poster-card.selected")).toHaveCount(1);
});
