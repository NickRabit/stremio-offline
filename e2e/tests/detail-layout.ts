import { expect, type Locator, type Page } from "@playwright/test";

export async function checkDetailActions(page: Page, detail: Locator) {
  const actions = detail.locator(".library-detail-actions");
  const buttons = actions.getByRole("button");
  const boxes = await buttons.evaluateAll(nodes => nodes.map(node => {
    const box = node.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }));
  expect(boxes.length).toBeGreaterThan(2);
  for (const box of boxes) {
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(Math.abs(box.height - boxes[0].height)).toBeLessThanOrEqual(1);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  }
  const progress = detail.locator(".library-detail-progress");
  if (await progress.count()) {
    const reset = await progress.getByRole("button").boundingBox();
    const bar = await progress.getByRole("progressbar").boundingBox();
    expect(Math.abs(reset!.y + reset!.height / 2 - bar!.y - bar!.height / 2)).toBeLessThanOrEqual(1);
  }
  const favorite = detail.getByRole("button", { name: "Přidat do oblíbených", exact: true });
  await expect(favorite).toHaveCount(1);
  await expect(actions.getByRole("button", { name: "Přidat do oblíbených", exact: true })).toHaveCount(0);
  const position = await favorite.boundingBox();
  const title = await detail.getByRole("heading").first().boundingBox();
  expect(position!.y + position!.height).toBeLessThanOrEqual(title!.y + 1);
  // The star is one of the title's chips: the same height as its neighbours, on their line.
  const chip = await detail.locator(".library-detail-chips .pill").first().boundingBox();
  if (chip) {
    expect(Math.abs(position!.height - chip.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(position!.y + position!.height / 2 - chip.y - chip.height / 2)).toBeLessThanOrEqual(1);
  }
  expect(position!.width).toBeGreaterThanOrEqual(position!.height);
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
