import { expect, test, type Page } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { appUrl } from "../../playwright.config";

const libraryId = `rlib_${"1".repeat(32)}`;
const capabilities = { rename: false, move: false, delete: false, identify: false, writeArtwork: false, downloadToLibrary: false, downloadToDevice: false };
const folder = (id: string, name: string) => ({ id, name, type: "folder", providerIds: {} });

type BrowseItem = { id: string; name: string; type: string } & Record<string, unknown>;

/** Placeholder files make the folder rows browsable; these tests never play them. */
const localRoot = path.resolve("e2e/.tmp/remote-library-local");
const localOtherRoot = path.resolve("e2e/.tmp/remote-library-local-b");
const LOCAL_FOLDERS = 60;
const localLibraryIds: string[] = [];

async function remoteLibraries(page: Page, options: { folders?: number; items?: (url: URL) => BrowseItem[] | null; sources?: unknown[] } = {}) {
  const requests: URL[] = [];
  let sources = 0;
  await page.route("**/remote-test-art/*.svg", async (route) => {
    const colors = ["#5b718c", "#9b615c", "#597c68", "#85739b"];
    const index = Number(new URL(route.request().url()).pathname.split("/").pop()?.split(".")[0]) || 0;
    await route.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="360"><rect width="240" height="360" fill="${colors[index % colors.length]}"/></svg>` });
  });
  await page.route("**/api/remote-libraries**", async (route) => {
    const url = new URL(route.request().url());
    let body: unknown;
    if (url.pathname === "/api/remote-libraries") {
      body = { libraries: Array.from({ length: 8 }, (_, i) => ({
        id: i ? `rlib_${(i + 1).toString(16).padStart(32, "0")}` : libraryId,
        connectionId: "connection", remoteId: `root-${i}`, name: i ? `Remote library ${i + 1}` : "Remote clips",
        type: "mixed", enabled: true, order: i, showOnHome: true, showInContinueWatching: true,
        showInFavorites: true, browseMode: "folders", mosaic: true, provider: "emby", capabilities,
      })) };
    } else if (url.pathname.endsWith("/preview")) {
      body = { posters: [0, 1, 2, 3].map(i => `/remote-test-art/${i}.svg`) };
    } else if (url.pathname.endsWith("/browse")) {
      requests.push(url);
      const parent = url.searchParams.get("parentId");
      const custom = options.items?.(url) ?? null;
      const items: BrowseItem[] = custom ?? (options.folders
        ? Array.from({ length: options.folders }, (_, i) => folder(`folder-${i}`, `Category ${i + 1}`))
        : parent === "folder-a" ? [folder("nested-a", "Collection One")]
        : parent === "nested-a" ? [{ id: "clip-a", name: "Clip One", type: "movie", providerIds: {} }]
        : url.searchParams.has("cursor") ? [folder("folder-c", "Category Charlie")]
        : [folder("folder-a", "Category Alpha"), folder("folder-b", "Category Bravo")]);
      // The plain root stub is the only paged one; a cursor page and the explicit pages end there.
      const paged = !custom && !options.folders && !parent;
      body = { items, total: paged ? 3 : items.length, capabilities, asOf: "2026-01-01T00:00:00Z", stale: false,
        ...(paged && !url.searchParams.has("cursor") ? { cursor: "next-root" } : {}) };
    } else if (url.pathname.endsWith("/sources")) {
      sources++;
      body = { streams: options.sources ?? [] };
    } else if (/\/items\/[^/]+$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
      const episodeQuery = new URL(url);
      episodeQuery.searchParams.set("type", "episode");
      const candidates = [...(options.items?.(url) ?? []), ...(options.items?.(episodeQuery) ?? [])];
      body = { item: candidates.find((item) => item.id === id) ?? { id, name: id, type: "movie", providerIds: {} }, capabilities };
    } else {
      body = { items: [], total: 0 };
    }
    await route.fulfill({ json: body });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  return { requests, sources: () => sources };
}

test.beforeAll(async ({ playwright }) => {
  await mkdir(localRoot, { recursive: true });
  await mkdir(localOtherRoot, { recursive: true });
  await Promise.all(Array.from({ length: LOCAL_FOLDERS }, async (_, i) => {
    const folder = path.join(localRoot, `Folder ${String(i + 1).padStart(2, "0")}`);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "placeholder.mp4"), new Uint8Array([0]));
  }));
  const request = await playwright.request.newContext({ baseURL: appUrl, storageState: "e2e/.tmp/session.json" });
  for (const [name, root] of [["Local roots", localRoot], ["Local roots B", localOtherRoot]] as const) {
    expect((await request.post("/api/libraries/grants", { data: { path: root } })).status()).toBe(201);
    const created = await request.post("/api/libraries", { data: { name, type: "movie", root, autoScanMetadata: false, writeArtwork: false } });
    expect(created.status(), await created.text()).toBe(201);
    localLibraryIds.push((await created.json()).id as string);
  }
  await request.dispose();
});

test.afterAll(async ({ playwright }) => {
  const request = await playwright.request.newContext({ baseURL: appUrl, storageState: "e2e/.tmp/session.json" });
  for (const id of localLibraryIds) await request.delete(`/api/libraries/${id}?forget=1`);
  for (const root of [localRoot, localOtherRoot]) await request.delete(`/api/libraries/grants?path=${encodeURIComponent(root)}`);
  await request.dispose();
  await rm(localRoot, { recursive: true, force: true });
  await rm(localOtherRoot, { recursive: true, force: true });
});

test("remote folders keep their hierarchy and the next page appends without a click", async ({ page }) => {
  const remote = await remoteLibraries(page);
  await page.locator(".remote-libraries .browse-item.library").filter({ hasText: "Remote clips" }).getByRole("button").click();
  const panel = page.locator(".remote-browse-panel");
  await expect(panel.locator(".browse-item.folder").filter({ hasText: "Category Alpha" })).toBeVisible();
  expect(remote.requests[0].searchParams.get("mode")).toBe("folders");
  // The provider's second page arrives on its own as the listing nears its end: no Load-more click.
  await panel.locator(".browse-scroll").evaluate((node) => { node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event("scroll")); });
  await expect(panel.locator(".browse-item.folder")).toHaveCount(3);
  await expect(panel.locator(".browse-item.folder").filter({ hasText: "Category Charlie" })).toBeVisible();
  expect(remote.requests.filter((url) => url.searchParams.get("cursor") === "next-root"), "the cursor page is asked for once").toHaveLength(1);
  await expect(panel.locator(".load-more")).toHaveCount(0);
  await panel.locator(".browse-item.folder").filter({ hasText: "Category Alpha" }).getByRole("button").click();
  await expect(panel.locator(".browse-item.folder")).toHaveCount(1);
  await expect(panel.locator(".browse-item.folder")).toContainText("Collection One");
  expect(remote.requests.at(-1)!.searchParams.get("parentId")).toBe("folder-a");
  expect(remote.sources()).toBe(0);
  await panel.locator(".library-back").click();
  await expect(panel.locator(".browse-item.folder")).toHaveCount(3);
  await expect(panel.locator(".browse-item.folder").filter({ hasText: "Category Alpha" }).getByRole("button")).toBeFocused();
});

test("item and series breadcrumbs walk the remote hierarchy", async ({ page }) => {
  await remoteLibraries(page, { items: (url) => url.searchParams.get("type") === "episode"
    ? [{ id: "ep1", name: "Pilot", type: "episode", season: 1, episode: 1, providerIds: {} }]
    : [{ id: "ser1", name: "Show", type: "series", providerIds: {} }] });
  await page.locator(".remote-libraries .browse-item.library").filter({ hasText: "Remote clips" }).getByRole("button").click();
  const panel = page.locator(".remote-browse-panel");
  const crumbs = panel.locator(".crumbs button");
  await panel.locator(".browse-item").filter({ hasText: "Show" }).locator(".library-open").click();
  await expect(crumbs).toHaveText(["", "Remote clips", "Show"]);
  await panel.locator(".browse-item").filter({ hasText: "Pilot" }).locator(".library-open").click();
  await expect(crumbs).toHaveText(["", "Remote clips", "Show", "S1 E1 · Pilot"]);
  await expect(panel.locator('.crumbs button[aria-current="page"]')).toBeDisabled();
  // The series crumb goes back to the series and returns focus to the episode it came from.
  await panel.locator(".crumbs button").filter({ hasText: "Show" }).click();
  await expect(crumbs).toHaveText(["", "Remote clips", "Show"]);
  await expect(panel.locator(".browse-item").filter({ hasText: "Pilot" }).locator(".library-open")).toBeFocused();
});

test("the remote toolbar folds on a deliberate scroll and the expand button restores it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await remoteLibraries(page, { folders: 40 });
  await page.locator(".remote-libraries .browse-item.library").filter({ hasText: "Remote clips" }).getByRole("button").click();
  const panel = page.locator(".remote-browse-panel");
  await expect(panel.locator(".browse-item.folder")).toHaveCount(40);
  const scroll = () => panel.locator(".browse-scroll").evaluate((node) => { node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event("scroll")); });
  await expect.poll(async () => { await scroll(); return (await panel.locator(".fold.browse-fold").getAttribute("class")) ?? ""; }).toContain("closed");
  await panel.locator(".header-expand").click();
  await expect(panel.locator(".fold.browse-fold")).not.toHaveClass(/closed/);
});

test("a local folder with remote roots owns the pane and its own scroll", async ({ page }) => {
  await remoteLibraries(page);
  await expect(page.locator(".library-page")).toHaveClass(/library-remote-roots/);
  // A local folder owns the page: the remote roots leave and the local listing scrolls itself.
  await page.locator(".browse-panel .browse-item.library").filter({ has: page.locator(".library-copy strong", { hasText: /^Local roots$/ }) }).locator(".library-open").click();
  await expect(page.locator(".browse-panel .browse-item.folder")).toHaveCount(LOCAL_FOLDERS);
  await expect(page.locator(".remote-libraries")).toHaveCount(0);
  await expect(page.locator(".library-page")).not.toHaveClass(/library-remote-roots/);
  await expect(page.locator(".browse-panel > .browse-scroll")).toHaveCSS("overflow-y", "auto");
  // The local toolbar folds and restores on the same deliberate scroll the remote one uses.
  await page.setViewportSize({ width: 390, height: 844 });
  const scroll = () => page.locator(".browse-panel > .browse-scroll").evaluate((node) => { node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event("scroll")); });
  await expect.poll(async () => { await scroll(); return (await page.locator(".library-page .fold.browse-fold").getAttribute("class")) ?? ""; }).toContain("closed");
  await page.locator(".library-page .header-expand").click();
  await expect(page.locator(".library-page .fold.browse-fold")).not.toHaveClass(/closed/);
  // Back at the local root both blocks return.
  await page.locator(".browse-panel .crumbs button").filter({ hasText: "Knihovna" }).click();
  await expect(page.locator(".remote-libraries")).toBeVisible();
  await expect(page.locator(".library-page")).toHaveClass(/library-remote-roots/);
});

test("remote and local library blocks share tile markup and every root stays reachable on phones", async ({ page }) => {
  await remoteLibraries(page);
  const roots = page.locator(".remote-libraries .browse-item.library");
  await expect(roots).toHaveCount(8);
  await expect(roots.first().locator(".library-preview-collage")).toBeVisible();
  for (const viewport of [{ width: 1440, height: 900 }, { width: 820, height: 1180 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await roots.last().scrollIntoViewIfNeeded();
    const last = await roots.last().boundingBox();
    expect(last).not.toBeNull();
    expect(last!.y).toBeGreaterThanOrEqual(0);
    expect(last!.y + last!.height).toBeLessThanOrEqual(viewport.height + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator(".library-page").evaluate(node => { node.scrollTop = 0; });
  }
});


test("a missing backdrop falls back to its poster through repeated tile style changes", async ({ page }) => {
  await remoteLibraries(page);
  let backdropRequests = 0;
  await page.route("**/remote-test-art/missing-backdrop.jpg", async route => {
    backdropRequests++;
    await route.fulfill({ status: 404, body: "Missing" });
  });
  await page.route("**/api/remote-libraries/*/browse*", async route => route.fulfill({ json: {
    items: [{ id: "movie", name: "Movie with a poster", type: "movie", providerIds: {}, poster: "/remote-test-art/0.svg", wide: "/remote-test-art/missing-backdrop.jpg", overview: "A metadata description", year: 2024 }],
    total: 1, capabilities, asOf: "2026-01-01T00:00:00Z", stale: false,
  } }));
  await page.locator(".remote-libraries .browse-item.library").filter({ hasText: "Remote clips" }).getByRole("button").click();
  const panel = page.locator(".remote-browse-panel");
  const image = panel.locator(".browse-art img:not(.tile-blur)");
  for (let i = 0; i < 6; i++) {
    await panel.locator(".shape-toggle").click();
    await expect(image).toHaveAttribute("src", "/remote-test-art/0.svg");
    await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true);
    await expect(panel.locator(".browse-art .broken")).toHaveCount(0);
  }
  expect(backdropRequests).toBe(1);
  await expect(panel.locator(".library-desc")).toHaveText("A metadata description");
  await expect(panel.locator(".browse-menu")).toBeVisible();
});

test("a remote film's versions open a picker that defaults to the largest", async ({ page }) => {
  await remoteLibraries(page, {
    items: () => [{ id: "m1", name: "Film One", type: "movie", providerIds: {} }],
    sources: [
      { sourceId: "s1", kind: "remote", playable: true, name: "720p", provider: "emby", behaviorHints: { videoSize: 1_000_000_000 } },
      { sourceId: "s2", kind: "remote", playable: true, name: "1080p", provider: "emby", behaviorHints: { videoSize: 4_000_000_000 } },
    ],
  });
  await page.locator(".remote-libraries .browse-item.library").filter({ hasText: "Remote clips" }).getByRole("button").click();
  const panel = page.locator(".remote-browse-panel");
  await panel.locator(".browse-item").filter({ hasText: "Film One" }).locator(".library-open").click();
  const detail = panel.locator(".library-title-detail");
  // The versions live behind the arrow now, with the largest as the default; the picker is the
  // only place a version is named.
  await expect(detail.locator(".remote-streams")).toHaveCount(0);
  await detail.getByRole("button", { name: "Vybrat zdroj" }).click();
  const dialog = page.getByRole("dialog", { name: "Vybrat zdroj" });
  const rows = dialog.locator(".remote-streams button");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveAttribute("aria-pressed", "true");
  await expect(rows.first()).toContainText("1080p");
});
