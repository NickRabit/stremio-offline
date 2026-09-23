import { expect, test } from "@playwright/test";
import { resetViews } from "../library-tools";

test.beforeEach(async ({ request }) => { await resetViews(request); });

const film = (name: string, match = "matched") => ({
  kind: "folder", path: name, name, fileCount: 1, size: 2e9, favorite: false, match,
  ...(match === "suggested" ? { suggestion: { type: "movie", id: "tt1", name: `Návrh ${name}`, score: 61 } } : {}),
});

const listing = (items: unknown[]) => ({ path: "", items, total: items.length, pending: false });

const running = {
  jobs: [{
    id: "job_running", op: "move", status: "running", total: 3, done: 1, failed: 0,
    bytes: 6e8, bytesTotal: 2e9, current: "Film A", startedAt: "2026-01-01T00:00:00.000Z", results: [],
  }],
};

/** The strip lives between the library header and the scrolling listing, outside the padding
 *  both of those carry. Without an inset of its own it ran from one panel edge to the other
 *  and its accent border sat flush against the toolbar, so the two read as one control. */
test("the operation strip keeps the listing's inset and clears the toolbar", async ({ page }) => {
  await page.route("**/api/library/ops", (route) => route.fulfill({ json: running }));
  await page.route("**/api/library/browse?*", (route) => route.fulfill({ json: listing([film("Film A"), film("Film B")]) }));
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();

  const strip = page.locator(".library-op-status");
  await expect(strip).toBeVisible();
  const box = (await strip.boundingBox())!;
  const head = (await page.locator(".browse-head").boundingBox())!;
  // The bar, not `.browse-tools`: a landscape phone turns that row into `display: contents`,
  // which leaves it without a box of its own -- and the controls it holds sit in the bar anyway.
  const tools = (await page.locator(".browse-bar").boundingBox())!;
  const grid = (await page.locator(".browse-grid, .browse-rows").first().boundingBox())!;

  // It lines up with the listing below it rather than running to the panel's own edges.
  expect(Math.abs(box.x - grid.x), "the strip and the listing start in different places").toBeLessThanOrEqual(1);
  expect(Math.abs((box.x + box.width) - (grid.x + grid.width)), "they end in different places").toBeLessThanOrEqual(1);
  expect(box.x).toBeGreaterThan(head.x);
  // Room between it and the toolbar, so the accent border of one does not touch the other.
  expect(box.y - (tools.y + tools.height), "the strip is pressed against the toolbar").toBeGreaterThanOrEqual(8);
  // And it stays in the header block it belongs to, above the scrolling listing.
  expect(box.y + box.height).toBeLessThanOrEqual(head.y + head.height + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(grid.y);
});

/** Past four libraries the row used to put the rest beyond its right edge, with the scrollbar
 *  hidden and nothing else to say they were there. */
test("every library the move dialog offers is drawn inside the row", async ({ page }) => {
  const libraries = ["downloads", "Filmy", "Filmy - Eliška", "XXX", "Eliška - Filmy (video)", "Archiv 2019-2024", "Záloha"]
    .map((name, index) => ({
      id: `lib_0000000${index}`, name, type: "mixed", enabled: true, order: index,
      unreachable: false, readOnly: false, titles: 1, files: 1, bytes: 1e9,
    }));
  await page.route("**/api/libraries", (route) => route.fulfill({ json: libraries }));
  // More than one library configured means the root lists them; inside one it is an ordinary tree.
  await page.route("**/api/library/browse?*", (route) => {
    const path = new URL(route.request().url()).searchParams.get("path") ?? "";
    return route.fulfill({ json: path
      ? listing([film("Film A")])
      : listing(libraries.map((entry) => ({ kind: "library", libraryId: entry.id, path: entry.id, name: entry.name, label: entry.name, type: entry.type, enabled: true, fileCount: 1, titles: 1, size: 1e9, unreachable: false, readOnly: false, posters: [] }))) });
  });
  await page.route("**/api/library/folders?*", (route) => route.fulfill({ json: { path: "", folders: [] } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  await page.locator(".browse-item.library").filter({ hasText: "downloads" }).getByRole("button").first().click();

  await page.getByRole("button", { name: "Možnosti: Film A", exact: true }).click();
  await page.getByRole("button", { name: "Přesunout", exact: true }).click();
  const row = page.locator(".move-libraries");
  await expect(row).toBeVisible();

  const chips = await row.locator("button").evaluateAll((buttons) => buttons.map((button) => {
    const box = button.getBoundingClientRect();
    return { right: box.right, bottom: box.bottom, width: box.width };
  }));
  const box = (await row.boundingBox())!;
  expect(chips.length).toBe(libraries.length);
  for (const chip of chips) {
    expect(chip.width, "a chip collapsed to nothing").toBeGreaterThan(20);
    expect(chip.right, "a chip is cut off at the right edge").toBeLessThanOrEqual(box.x + box.width + 1);
    expect(chip.bottom, "a chip is below the cap with no way to reach it").toBeLessThanOrEqual(box.y + box.height + 1);
  }
  // The cap is what keeps the row from eating the body it sits above.
  expect(box.height).toBeLessThanOrEqual(90);
});

/** The button is the way into the confirmation queue, and it has no business being there when
 *  that queue is empty: the filter would list nothing and say nothing about why. */
test("the filter for unconfirmed titles appears only while something is waiting", async ({ page }) => {
  let waiting = 0;
  await page.route("**/api/library/suggestions", (route) => route.fulfill({
    json: { items: [], total: waiting },
  }));
  const asked: string[] = [];
  await page.route("**/api/library/browse?*", (route) => {
    asked.push(route.request().url());
    const only = new URL(route.request().url()).searchParams.get("unconfirmed") === "1";
    return route.fulfill({ json: listing(only ? [film("Film B", "suggested")] : [film("Film A"), film("Film B", "suggested")]) });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();

  const button = page.getByRole("button", { name: "Jen čekající na potvrzení", exact: true });
  await expect(button).toHaveCount(0);

  waiting = 1;
  // The count is read again whenever the library view is entered.
  await page.getByRole("button", { name: "Katalog", exact: true }).click();
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute("aria-pressed", "false");

  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => asked.some((url) => url.includes("unconfirmed=1"))).toBe(true);
  await expect(page.locator(".browse-item")).toHaveCount(1);
});
