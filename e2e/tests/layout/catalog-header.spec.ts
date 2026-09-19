import { expect, test } from "@playwright/test";

test("description survives source loading and remains expandable", async ({ page }, testInfo) => {
  const description = "A long description that must remain readable without displacing the source controls. ".repeat(25);
  await page.route("**/api/meta/**", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...await response.json(), description } });
  });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/stream-sources/**", async (route) => {
    const response = await route.fetch();
    await hold;
    await route.fulfill({ response });
  });
  await page.goto("/");
  const catalog = page.getByRole("combobox", { name: "Procházet katalog" });
  await expect(catalog).toBeVisible();
  const options = await catalog.locator("option").allTextContents();
  await catalog.selectOption({ label: options.find((text) => /Filmy/.test(text))! });
  await page.getByRole("button", { name: /Zkušební film/ }).click();
  const preview = page.locator(".description-preview");
  await expect(preview).toHaveText(description.trim());
  await expect(preview).toBeVisible();
  const before = await preview.boundingBox();
  release();
  await expect(page.locator(".stream-list button").first()).toBeVisible();
  await expect(preview).toBeVisible();
  const after = await preview.boundingBox();
  expect(Math.abs(after!.height - before!.height)).toBeLessThan(2);
  await page.locator(".catalog-description summary").click();
  await expect(page.locator(".catalog-description details")).toHaveAttribute("open", "");
  await expect(page.locator(".catalog-description details p")).toBeVisible();
  if (testInfo.project.name === "mobile") {
    const actions = await page.locator(".source-footer .actions").boundingBox();
    const navigation = await page.locator(".sidebar").boundingBox();
    for (const button of await page.locator(".source-footer .actions button").all()) {
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    expect(actions!.y + actions!.height).toBeLessThanOrEqual(navigation!.y);
  }
});

test("desktop episode and source lists use the available detail height", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("desktop"), "desktop detail layout");
  const seriesDescription = "A long series description that must stay inside its artwork panel even when the episode list is crowded. ".repeat(4);
  await page.route("**/api/meta/**", async (route) => {
    const response = await route.fetch();
    const meta = await response.json();
    if (!meta.videos?.length) return route.fulfill({ response });
    await route.fulfill({
      json: {
        ...meta,
        description: seriesDescription,
        videos: Array.from({ length: 23 }, (_, index) => ({
          ...meta.videos[index % meta.videos.length],
          id: `series-episode-${index}`,
          season: 1,
          episode: index + 1,
        })),
      },
    });
  });
  await page.goto("/");
  const catalog = page.getByRole("combobox", { name: "Procházet katalog" });
  await expect(catalog.locator("option").filter({ hasText: /Seriály/ })).toHaveCount(1);
  const options = await catalog.locator("option").allTextContents();
  await catalog.selectOption({ label: options.find((text) => /Seriály/.test(text))! });
  const series = page.getByRole("button", { name: /Zkušební seriál/ });
  await expect(series).toBeVisible();
  await series.click();

  const detail = page.locator(".detail-panel");
  const episodes = detail.locator(".episode-list");
  await expect(episodes.getByRole("button")).toHaveCount(23);
  const heroBox = await detail.locator(".hero").boundingBox();
  const descriptionBox = await detail.locator(".description-preview").boundingBox();
  expect(descriptionBox!.y + descriptionBox!.height).toBeLessThanOrEqual(heroBox!.y + heroBox!.height);
  const detailBox = await detail.boundingBox();
  const episodeBox = await episodes.boundingBox();
  expect(detailBox!.y + detailBox!.height - (episodeBox!.y + episodeBox!.height)).toBeLessThan(24);

  const movieCatalog = options.find((text) => /Filmy/.test(text))!;
  await catalog.selectOption({ label: movieCatalog });
  const movie = page.getByRole("button", { name: /Zkušební film/ });
  await expect(movie).toBeVisible();
  await movie.click();
  await expect(detail.getByRole("heading", { name: "Zdroje" })).toBeVisible();
  const sourcesBox = await detail.locator(".sources").boundingBox();
  for (const button of await detail.locator(".source-footer .actions button").all()) {
    const buttonBox = await button.boundingBox();
    expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(sourcesBox!.y + sourcesBox!.height);
  }
});

test("mobile source view returns to the episode picker", async ({ page }, testInfo) => {
  test.skip(!["mobile", "mobile-landscape"].includes(testInfo.project.name), "phone detail navigation");
  await page.goto("/");
  const catalog = page.getByRole("combobox", { name: "Procházet katalog" });
  await expect(catalog.locator("option").filter({ hasText: /Seriály/ })).toHaveCount(1);
  const options = await catalog.locator("option").allTextContents();
  await catalog.selectOption({ label: options.find((text) => /Seriály/.test(text))! });
  await page.getByRole("button", { name: /Zkušební seriál/ }).click();

  const detail = page.locator(".detail-panel");
  await detail.getByRole("button", { name: /První díl/ }).click();
  await expect(detail.getByRole("heading", { name: "Zdroje" })).toBeVisible();
  const episodesBack = detail.locator(".mobile-detail-head").getByRole("button", { name: "Epizody" });
  await expect(episodesBack).toBeVisible();
  await episodesBack.click();

  await expect(detail.getByRole("heading", { name: "Epizody" })).toBeVisible();
  await expect(detail.getByRole("heading", { name: "Zdroje" })).toHaveCount(0);
  await expect(detail.locator(".mobile-detail-head").getByRole("button", { name: "Výsledky" })).toBeVisible();
});

test("phone source scrolling hides metadata and restores it before reaching the top", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "phone portrait has a collapsible metadata header");
  await page.route("**/api/streams/**", async (route) => {
    const response = await route.fetch();
    const streams = await response.json();
    await route.fulfill({ json: Array.from({ length: 40 }, (_, i) => ({ ...streams[0], name: `Source ${i}` })) });
  });
  await page.goto("/");
  const catalog = page.getByRole("combobox", { name: "Procházet katalog" });
  await expect(catalog).toBeVisible();
  const options = await catalog.locator("option").allTextContents();
  await catalog.selectOption({ label: options.find((text) => /Filmy/.test(text))! });
  await page.getByRole("button", { name: /Zkušební film/ }).click();
  const list = page.locator(".stream-list");
  await expect(list.locator("button")).toHaveCount(40);
  await list.evaluate((element) => { element.scrollTop = 500; });
  await expect(page.locator(".detail-panel .hero")).toBeHidden();
  await page.waitForTimeout(300);
  await list.evaluate((element) => { element.scrollTop -= 80; });
  await expect(page.locator(".detail-panel .hero")).toBeVisible();
  expect(await list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});

test("phone catalog search waits to be asked back, by the button or by the top of the list", async ({ page }, testInfo) => {
  test.skip(!["mobile", "mobile-landscape"].includes(testInfo.project.name), "compact phone catalog");
  await page.route("**/api/catalog?**", async (route) => {
    const response = await route.fetch();
    const items = await response.json();
    await route.fulfill({ json: Array.from({ length: 60 }, (_, i) => ({ ...items[0], id: `catalog-${i}`, name: `Title ${i}` })) });
  });
  await page.goto("/");
  const catalog = page.getByRole("combobox", { name: "Procházet katalog" });
  await expect(catalog).toBeVisible();
  const options = await catalog.locator("option").allTextContents();
  await catalog.selectOption({ label: options.find((text) => /Filmy/.test(text))! });
  const list = page.locator(".poster-grid");
  await expect(list.locator(".poster-card")).toHaveCount(60);
  await list.evaluate((element) => { element.scrollTop = 500; });
  await expect(page.locator(".searchbar")).toBeHidden();

  // A pull is not a request: the header a reader folded away stays folded until asked.
  await page.waitForTimeout(300);
  await list.evaluate((element) => { element.scrollTop -= 80; });
  await page.waitForTimeout(300);
  await expect(page.locator(".searchbar")).toBeHidden();

  // The top of the list is one way back.
  await list.evaluate((element) => { element.scrollTop = 0; });
  await expect(page.locator(".searchbar")).toBeVisible();

  // The button is the other, and it leaves the list where the reader had it.
  await page.waitForTimeout(300);
  await list.evaluate((element) => { element.scrollTop = 500; });
  await expect(page.locator(".searchbar")).toBeHidden();
  await page.getByRole("button", { name: "Zobrazit hledání a filtry" }).click();
  await expect(page.locator(".searchbar")).toBeVisible();
  expect(await list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});

test("phone catalog keeps the selected title in place after rotating during playback", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "starts in phone portrait");
  await page.route("**/api/catalog?**", async (route) => {
    const response = await route.fetch();
    const items = await response.json();
    await route.fulfill({ json: Array.from({ length: 60 }, (_, index) => ({ ...items[0], id: `tt-e2e-${index}`, name: `Title ${index}` })) });
  });
  await page.route("**/api/meta/movie/tt-e2e-*", async (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop()!);
    const index = id.split("-").pop();
    await route.fulfill({ json: { id, type: "movie", name: `Title ${index}`, description: "Rotation test title" } });
  });
  await page.goto("/");
  const catalog = page.getByRole("combobox", { name: "Procházet katalog" });
  await expect(catalog).toBeVisible();
  const options = await catalog.locator("option").allTextContents();
  await catalog.selectOption({ label: options.find((text) => /Filmy/.test(text))! });

  const list = page.locator(".poster-grid");
  const title = list.getByRole("button", { name: /Title 35/ });
  await expect(list.locator(".poster-card")).toHaveCount(60);
  await list.evaluate((element) => { element.scrollTop = 500; });
  await expect(page.locator(".searchbar")).toBeHidden();
  await title.evaluate((element) => element.scrollIntoView({ block: "center" }));
  const before = await title.evaluate((element) => {
    const list = element.parentElement!;
    return (element.getBoundingClientRect().top - list.getBoundingClientRect().top) / list.clientHeight;
  });
  await title.evaluate((element: HTMLButtonElement) => element.click());
  const detail = page.locator(".detail-panel");
  await expect(detail).toBeVisible();
  await detail.getByRole("button", { name: "Přehrát", exact: true }).click();
  const player = page.locator(".player-overlay");
  await expect(player).toBeVisible();

  await page.setViewportSize({ width: 844, height: 390 });
  await player.getByRole("button", { name: "Zavřít přehrávač", exact: true }).click({ force: true });
  await expect(player).toHaveCount(0);
  await page.locator(".mobile-detail-head").getByRole("button", { name: "Výsledky" }).click();

  await expect(page.locator(".searchbar")).toBeHidden();
  await expect(title).toBeInViewport();
  await expect.poll(() => title.evaluate((element) => {
    const list = element.parentElement!;
    return (element.getBoundingClientRect().top - list.getBoundingClientRect().top) / list.clientHeight;
  }).then((after) => Math.abs(after - before))).toBeLessThan(0.15);
});
