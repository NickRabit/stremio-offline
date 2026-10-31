import { expect, type Locator, type Page } from "@playwright/test";

export async function checkDetailActions(page: Page, detail: Locator) {
  const actions = detail.locator(".library-detail-actions");
  const boxesOf = (selector: string) => actions.locator(selector).evaluateAll(nodes => nodes.map(node => {
    const box = node.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }));
  // The two split buttons are one toolbar and share a height; the labelled round actions beside
  // them are taller by their caption and only need a full touch target.
  const splits = await boxesOf(".split-button > button, .library-detail-play > button");
  const all = await boxesOf("button");
  expect(splits.length).toBeGreaterThan(0);
  expect(all.length).toBeGreaterThan(2);
  for (const box of splits) expect(Math.abs(box.height - splits[0].height)).toBeLessThanOrEqual(1);
  for (const box of all) {
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  }
  const progress = detail.locator(".library-detail-progress");
  if (await progress.count()) {
    const reset = await progress.getByRole("button").boundingBox();
    const bar = await progress.getByRole("progressbar").boundingBox();
    expect(Math.abs(reset!.y + reset!.height / 2 - bar!.y - bar!.height / 2)).toBeLessThanOrEqual(1);
  }
  // The favourite is one of the labelled actions beside the splits, once, below the title.
  const favorite = detail.getByRole("button", { name: "Přidat do oblíbených", exact: true });
  await expect(favorite).toHaveCount(1);
  await expect(actions.locator(".detail-secondary").getByRole("button", { name: "Přidat do oblíbených", exact: true })).toHaveCount(1);
  const position = await favorite.boundingBox();
  const title = await detail.getByRole("heading").first().boundingBox();
  expect(position!.y).toBeGreaterThanOrEqual(title!.y + title!.height - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}


export async function detailArtwork(page: Page) {
  await page.route("**/detail-layout-art/*", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><defs><linearGradient id="g"><stop stop-color="#194766"/><stop offset="1" stop-color="#98643c"/></linearGradient></defs><rect width="1280" height="720" fill="url(#g)"/></svg>' }));
  await page.route("**/api/meta/**", route => route.fulfill({ json: { id: "tt123", type: "movie", name: "Detail film", poster: "/detail-layout-art/poster.svg", background: "/detail-layout-art/background.svg", description: "A family sets out on a journey through an unfamiliar world. Along the way they meet new friends, overcome unexpected obstacles and discover what matters most. This description stays visible in the shared detail while the artwork, title links and actions keep their own space." } }));
  for (const pattern of ["**/api/library/links?*", "**/api/links/**"]) await page.route(pattern, route => route.fulfill({ json: { links: [
    { site: "csfd", url: "https://www.csfd.cz/film/123/" }, { site: "tmdb", url: "https://www.themoviedb.org/movie/123" }, { site: "imdb", url: "https://www.imdb.com/title/tt123/" },
  ] } }));
  for (const pattern of ["**/api/library/trailer?*", "**/api/trailer/**"]) await page.route(pattern, route => route.fulfill({ json: { trailer: { youtubeId: "fixture", provider: "cinemeta" } } }));
}
