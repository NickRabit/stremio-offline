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

test.beforeEach(async ({ request, page }) => {
  await resetViews(request);
  await page.route("**/api/stream-sources/**", route => route.fulfill({ json: [] }));
  await page.route("**/api/remote-libraries/*/streams/**", route => route.fulfill({ json: { streams: [] } }));
});

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
  const rows = dialog.locator(".stream-list button");
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toHaveAttribute("aria-pressed", "true");
  await expect(rows.first()).toContainText(largerCopy);
  await rows.nth(1).click();
  await expect(dialog).toHaveCount(0);
  // Escape closes the picker and hands focus back to the arrow.
  await arrow.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.stream-list button[aria-pressed="true"]')).toContainText(otherCopy);
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

test("local detail clears only the chosen version's saved position", async ({ page }) => {
  const forgotten: string[] = [];
  const cleared = new Set<string>();
  await page.route("**/api/progress/*", async (route) => {
    const key = decodeURIComponent(new URL(route.request().url()).pathname.slice("/api/progress/".length));
    if (route.request().method() === "DELETE") {
      forgotten.push(key); cleared.add(key);
      await route.fulfill({ status: 204 });
    } else await route.fulfill({ json: cleared.has(key) ? null : { key, position: 120, duration: 3600 } });
  });
  await openDetail(page);
  const detail = page.locator(".library-title-detail");
  await expect(detail.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "3");
  await detail.getByRole("button", { name: "Zapomenout postup" }).click();
  await expect(detail.getByRole("progressbar")).toHaveCount(0);
  expect(forgotten).toEqual([`file:Other/${largerCopy}`]);
  await expect(detail.getByRole("button", { name: "Přidat do oblíbených" })).toHaveAttribute("aria-pressed", "false");
});

test("local detail starts its selected version at zero without forgetting progress", async ({ page }) => {
  let reads = 0;
  let deletes = 0;
  let started: { sourceId: string; time: number } | undefined;
  await page.route("**/api/progress/*", async (route) => {
    if (route.request().method() === "DELETE") { deletes++; await route.fulfill({ status: 204 }); return; }
    reads++;
    const key = decodeURIComponent(new URL(route.request().url()).pathname.slice("/api/progress/".length));
    await route.fulfill({ json: { key, position: 120, duration: 3600 } });
  });
  await page.route("**/api/playback", async (route) => {
    started = route.request().postDataJSON();
    await route.fulfill({ status: 503, json: { error: "Synthetic playback unavailable" } });
  });
  await openDetail(page);
  const detail = page.locator(".library-title-detail");
  await expect(detail.getByRole("progressbar")).toBeVisible();
  const before = reads;
  await detail.getByRole("button", { name: "Přehrát od začátku" }).click();
  await expect.poll(() => started).toEqual(expect.objectContaining({ sourceId: `exact:Other/${largerCopy}`, time: 0 }));
  expect(reads).toBe(before);
  expect(deletes).toBe(0);
});

test("saved-position controls remain usable across desktop and mobile viewports", async ({ page }) => {
  await page.route("**/api/progress/*", async (route) => {
    const key = decodeURIComponent(new URL(route.request().url()).pathname.slice("/api/progress/".length));
    await route.fulfill({ json: { key, position: 3723, duration: 7200 } });
  });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 820, height: 1180 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 851, height: 393 }]) {
    await page.setViewportSize(viewport);
    await openDetail(page);
    const detail = page.locator(".library-title-detail");
    await expect(detail.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "52");
    for (const name of ["Přehrát", "Přehrát od začátku", "Zapomenout postup", "Vybrat zdroj"]) {
      const button = detail.getByRole("button", { name, exact: true });
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  }
});

for (const [width, height] of [[1440, 900], [390, 844], [844, 390]]) {
  test(`local movie offers local remote and addon rows in the shared chooser at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openDetail(page);
    let discovery = 0;
    const called: string[] = [];
    const downloads: Array<Record<string, unknown>> = [];
    await page.route("**/api/stream-sources/movie/tt-detail", route => {
      discovery++;
      return route.fulfill({ json: [{ key: "fixture", name: "Fixture addon" }] });
    });
    await page.route("**/api/streams/movie/tt-detail**", route => {
      called.push(new URL(route.request().url()).searchParams.get("addon") ?? "unfiltered");
      return route.fulfill({ json: [{ sourceId: "local-detail-addon", kind: "remote", playable: true,
        name: "Addon FullHD", title: "CZ 25 GB", addonKey: "fixture", addonName: "Fixture addon" }] });
    });
    await page.route("**/api/remote-libraries", route => route.fulfill({ json: { libraries: [{
      id: "rlib_fixture", connectionId: "fixture", remoteId: "root", name: "Remote fixture", type: "movie", provider: "jellyfin", enabled: true,
    }] } }));
    await page.route("**/api/remote-libraries/rlib_fixture/streams/movie/tt-detail**", route => route.fulfill({ json: { streams: [{
      sourceId: "local-detail-remote", kind: "remote", playable: true, name: "Remote FullHD", provider: "jellyfin",
      libraryId: "rlib_fixture", libraryName: "Remote fixture", capabilities: { downloadToLibrary: true }, behaviorHints: { videoSize: 50_000_000_000 },
      remoteItem: { libraryId: "rlib_fixture", itemId: "film", mediaSourceId: "v1", progressKey: "remote:fixture" },
    }] } }));
    await page.route("**/api/downloads", route => {
      if (route.request().method() !== "POST") return route.continue();
      downloads.push(route.request().postDataJSON());
      return route.fulfill({ status: 201, json: { id: "fixture-job", status: "queued" } });
    });
    const detail = page.locator(".library-local-detail");
    expect(discovery).toBe(0);
    await detail.getByRole("button", { name: "Vybrat zdroj" }).click();
    const dialog = page.getByRole("dialog", { name: "Vybrat zdroj" });
    const rows = dialog.locator(".stream-list button");
    await expect(rows.filter({ hasText: "Addon FullHD" })).toBeVisible();
    await expect(rows.filter({ hasText: "Remote FullHD" })).toBeVisible();
    await expect(rows.first()).toContainText(largerCopy);
    await expect(rows.first()).toHaveAttribute("aria-pressed", "true");
    expect(discovery).toBe(1);
    expect(called).toEqual(["fixture"]);
    await expect(dialog.getByRole("combobox", { name: "Doplněk" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Zdroje z doplňků" })).toHaveCount(0);
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: `e2e/.tmp/local-unified-picker-${width}.png` });
    await rows.filter({ hasText: "Addon FullHD" }).click();
    await detail.getByRole("button", { name: "Do knihovny", exact: true }).click();
    const save = page.getByRole("dialog");
    await save.getByRole("button", { name: "Do knihovny", exact: true }).click();
    await expect(save).toHaveCount(0);
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toMatchObject({ sourceId: "local-detail-addon", media: { id: "tt-detail", kind: "movie" } });
    await detail.getByRole("button", { name: "Vybrat zdroj" }).click();
    await expect(dialog.locator('.stream-list button[aria-pressed="true"]')).toContainText("Addon FullHD");
    expect(discovery).toBe(1);
    expect(called).toEqual(["fixture"]);
    await dialog.locator(".stream-list button").filter({ hasText: "Remote FullHD" }).click();
    await detail.getByRole("button", { name: "Do knihovny", exact: true }).click();
    const remoteSave = page.getByRole("dialog");
    await remoteSave.getByRole("radio", { name: "Jinam", exact: true }).check();
    await remoteSave.getByRole("button", { name: "Do knihovny", exact: true }).click();
    await expect(remoteSave).toHaveCount(0);
    expect(downloads).toHaveLength(2);
    expect(downloads[1]).toMatchObject({ sourceId: "local-detail-remote", media: { id: "tt-detail", kind: "movie" } });
  });
}
