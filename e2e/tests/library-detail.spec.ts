import { expect, test, type Page, type Route } from "@playwright/test";
import { goToView } from "./nav";
import { resetViews } from "./library-tools";

/** The one local film the detail journeys work on: a file bound to a title that exists in two
 *  copies, so the source picker has something to choose between. */
const movieFile = "Detail film.mkv";
const otherCopy = "Detail film 1080p.mkv";
const largerCopy = "Detail film REMUX.mkv";

type BrowseItem = { kind: string; path: string; [key: string]: unknown };

const source = (filename: string) => ({ sourceId: `exact:${filename}`, kind: "library", playable: true, behaviorHints: { filename } });
const copy = (path: string, filename: string, size: number) =>
  ({ sourceId: `lib:${path}`, kind: "library", playable: true, localPath: path, libraryName: "Filmy", behaviorHints: { filename, videoSize: size } });

async function openDetail(page: Page, manyFiles = false) {
  await page.route("**/api/library/browse?*", async (route: Route) => {
    const path = new URL(route.request().url()).searchParams.get("path") || "";
    const file = { kind: "file", path: movieFile, label: movieFile, size: 2_000_000_000, season: null, episode: null, modified: "2026-09-01", match: "matched", favorite: false };
    const files = manyFiles ? Array.from({ length: 80 }, (_, index) => index === 40 ? file : { ...file, path: `Extra ${index}.mkv`, label: `Extra film ${index}` }) : [file];
    const items: BrowseItem[] = path ? [] : files;
    await route.fulfill({ json: { path, items, total: items.length, pending: false } });
  });
  await page.route("**/api/library/source", async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { path?: string };
    await route.fulfill({ json: source(body.path ?? movieFile) });
  });
  await page.route("**/api/library/identity?*", async (route: Route) =>
    route.fulfill({ json: {
      path: movieFile, key: movieFile, kind: "movie", file: true, label: movieFile,
      parsed: { title: "Detail film", query: "Detail film" }, match: "matched", bound: { type: "movie", id: "tt-detail", name: "Detail film" },
    } }));
  await page.route("**/api/local-streams/**", async (route: Route) =>
    route.fulfill({ json: [
      copy(movieFile, movieFile, 2_000_000_000),
      copy(`Other/${otherCopy}`, otherCopy, 4_000_000_000),
      copy(`Other/${largerCopy}`, largerCopy, 8_000_000_000),
    ] }));
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  const target = page.locator(`[data-path="${movieFile}"] .library-open`);
  await target.scrollIntoViewIfNeeded();
  const offset = await page.evaluate(() => {
    const page = document.querySelector<HTMLElement>(".library-page")!;
    const scroller = page.classList.contains("library-remote-roots") ? page : page.querySelector<HTMLElement>(".browse-panel > .browse-scroll")!;
    return scroller.scrollTop;
  });
  await target.click();
  return offset;
}

test.beforeEach(async ({ request }) => { await resetViews(request); });

test("a local file opens its own detail instead of playing, and Back returns to the listing", async ({ page }) => {
  await openDetail(page);
  const detail = page.locator(".library-title-detail");
  await expect(detail).toBeVisible();
  await expect(page.locator(".player-overlay"), "nothing plays on opening").toHaveCount(0);
  await expect(detail.locator(".hero.library-detail-hero")).toBeVisible();
  await expect(page.locator(".crumbs")).toContainText("Detail film");
  await expect(page.locator(".library-back")).toHaveAttribute("aria-label", "Zpět");
  await page.locator(".library-back").click();
  await expect(detail).toHaveCount(0);
  await expect(page.locator(".browse-item", { hasText: "Detail film" })).toBeVisible();
});

test("the largest copy is the default and the arrow opens the picker", async ({ page }) => {
  await openDetail(page);
  const detail = page.locator(".library-title-detail");
  const arrow = detail.getByRole("button", { name: "Vybrat zdroj" });
  // The picker is the one place a version is named, so the default is read by reopening it.
  await arrow.click();
  const dialog = page.getByRole("dialog", { name: "Vybrat zdroj" });
  const rows = dialog.locator(".remote-streams button");
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toHaveAttribute("aria-pressed", "true");
  await expect(rows.first()).toContainText(largerCopy);
  await rows.nth(1).click();
  await expect(dialog).toHaveCount(0);
  // Escape closes the picker and hands focus back to the arrow.
  await arrow.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.remote-streams button[aria-pressed="true"]')).toContainText(otherCopy);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(arrow).toBeFocused();
});


test("the sidebar's Library entry returns the section to its root", async ({ page }) => {
  await page.route("**/api/remote-libraries", route => route.fulfill({ json: { libraries: [{
    id: `rlib_${"2".repeat(32)}`, connectionId: "connection", remoteId: "root", name: "Remote roots", type: "movie",
    enabled: true, order: 0, showOnHome: true, showInContinueWatching: true, mosaic: false, provider: "emby",
  }] } }));
  const offset = await openDetail(page, true);
  expect(offset).toBeGreaterThan(0);
  await goToView(page, "Katalog");
  await goToView(page, "Knihovna");
  // A fresh start: the detail is gone, the root is at the top and nothing is focused back.
  await expect(page.locator(".library-title-detail")).toHaveCount(0);
  await expect(page.locator(".library-page")).toHaveClass(/library-remote-roots/);
  await expect.poll(async () => await page.locator(".library-page").evaluate(node => node.scrollTop)).toBe(0);
  await expect(page.locator(`[data-path="${movieFile}"] .library-open`)).not.toBeFocused();
});

test("re-entering a nested folder's parent leaves the root at the top, not where the folder sat", async ({ page }) => {
  await page.route("**/api/remote-libraries", route => route.fulfill({ json: { libraries: [{
    id: `rlib_${"3".repeat(32)}`, connectionId: "connection", remoteId: "root", name: "Remote roots", type: "movie",
    enabled: true, order: 0, showOnHome: true, showInContinueWatching: true, mosaic: false, provider: "emby",
  }] } }));
  // A root long enough to scroll, with one folder that holds another.
  await page.route("**/api/library/browse?*", (route) => {
    const path = new URL(route.request().url()).searchParams.get("path") || "";
    const filler = Array.from({ length: 60 }, (_, index) => ({ kind: "file", path: `Root ${index}.mkv`, label: `Root ${index}`, size: 1e9, season: null, episode: null, modified: "2026-09-01", match: "unmatched" }));
    const items = path === "Collection" ? [{ kind: "folder", path: "Collection/Inner", name: "Inner", fileCount: 5, size: 1e9, match: "unmatched" }]
      : path ? filler
      : [{ kind: "folder", path: "Collection", name: "Collection", fileCount: 5, size: 1e9, match: "unmatched" }, ...filler];
    return route.fulfill({ json: { path, items, total: items.length, pending: false } });
  });
  await page.goto("/");
  await goToView(page, "Knihovna");
  // Into a folder, then into the folder inside it, so the root is behind two levels of reflow.
  await page.locator('[data-path="Collection"] .library-open').click();
  await page.locator('[data-path="Collection/Inner"] .library-open').click();
  await expect(page.locator(".library-title-detail")).toHaveCount(0);
  // Re-read the Library: the nested folder is gone and the remote block returns under the roots.
  await goToView(page, "Knihovna");
  await expect(page.locator(".library-page")).toHaveClass(/library-remote-roots/);
  await expect(page.locator('[data-path="Collection"] .library-open')).toBeVisible();
  await expect.poll(async () => await page.locator(".library-page").evaluate(node => node.scrollTop)).toBe(0);
});

test("a local detail opens the shared gallery and loads alternative artwork once", async ({ page }) => {
  let galleryRequests = 0;
  await page.route("**/detail-art/*", (route) => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#334455"/></svg>' }));
  await page.route("**/api/meta/**", (route) => {
    const gallery = new URL(route.request().url()).searchParams.get("gallery") === "1";
    if (gallery) galleryRequests += 1;
    return route.fulfill({ json: {
      id: "tt-detail", type: "movie", name: "Detail film",
      poster: "/detail-art/poster.svg", background: "/detail-art/background.svg",
      ...(gallery ? { images: [{ url: "/detail-art/alternate.svg", shape: "wide", kind: "background" }] } : {}),
    } });
  });
  await openDetail(page);
  const trigger = page.locator(".library-title-detail .gallery-open");
  await expect(trigger).toBeVisible();
  expect(galleryRequests).toBe(0);
  await trigger.click();
  const gallery = page.getByRole("dialog", { name: "Galerie obrázků" });
  await expect(gallery.locator(".gallery-thumbnails button")).toHaveCount(3);
  await page.getByRole("button", { name: "Další obrázek", exact: true }).click();
  await expect(gallery.locator("figure img")).toHaveAttribute("src", "/detail-art/background.svg");
  await page.keyboard.press("ArrowRight");
  await expect(gallery.locator("figure img")).toHaveAttribute("src", "/detail-art/alternate.svg");
  await page.keyboard.press("Escape");
  await expect(gallery).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(gallery).toBeVisible();
  expect(galleryRequests).toBe(1);
});
