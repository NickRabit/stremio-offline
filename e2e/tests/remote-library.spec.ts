import { expect, test, type Page } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { appUrl } from "../../playwright.config";
import { checkDetailActions, detailArtwork } from "./detail-layout";

const libraryId = `rlib_${"1".repeat(32)}`;
const capabilities = { rename: false, move: false, delete: false, identify: false, writeArtwork: false, downloadToLibrary: false, downloadToDevice: false };
const folder = (id: string, name: string) => ({ id, name, type: "folder", providerIds: {} });

type BrowseItem = { id: string; name: string; type: string } & Record<string, unknown>;

/** Placeholder files make the folder rows browsable; these tests never play them. */
const localRoot = path.resolve("e2e/.tmp/remote-library-local");
const localOtherRoot = path.resolve("e2e/.tmp/remote-library-local-b");
const LOCAL_FOLDERS = 60;
const localLibraryIds: string[] = [];

async function remoteLibraries(page: Page, options: { folders?: number; items?: (url: URL) => BrowseItem[] | null; sources?: unknown[]; browse?: (url: URL) => unknown | Promise<unknown> } = {}) {
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
    } else if (url.pathname.endsWith("/mosaic")) {
      // The composed fan is a picture of its own: this fixture answers one like any artwork.
      await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="720"><rect width="480" height="720" fill="#2b3440"/></svg>' });
      return;
    } else if (url.pathname.endsWith("/preview")) {
      const posters = [0, 1, 2, 3].map(i => `/remote-test-art/${i}.svg`);
      body = { posters, mosaic: "/api/remote-libraries/" + url.pathname.split("/").at(-2) + "/mosaic?v=e2e" };
    } else if (url.pathname.endsWith("/browse")) {
      requests.push(url);
      if (options.browse) { await route.fulfill({ json: await options.browse(url) }); return; }
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
  // The section's own entry in the sidebar, not the crumb the trail now starts with.
  await page.locator(".sidebar").getByRole("button", { name: "Knihovna", exact: true }).click();
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

test("a large listing resumes its canceled page after a detail return without refetching loaded rows", async ({ page }) => {
  const total = 6000;
  const rows = (start: number) => Array.from({ length: 60 }, (_, i) => ({
    id: `large-${start + i}`, name: `Synthetic title ${String(start + i).padStart(4, "0")}`, type: "movie", providerIds: {},
  }));
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let secondAttempts = 0;
  const remote = await remoteLibraries(page, {
    items: () => rows(0),
    browse: async (url) => {
      const start = Number(url.searchParams.get("cursor") ?? 0);
      if (start === 60 && ++secondAttempts === 1) await held;
      return { items: rows(start), total, cursor: String(start + 60), capabilities, asOf: "2026-01-01T00:00:00Z", stale: false };
    },
  });
  await page.locator(".remote-libraries .browse-item.library").filter({ hasText: "Remote clips" }).getByRole("button").click();
  const panel = page.locator(".remote-browse-panel");
  const tiles = panel.locator(".browse-item");
  await expect(tiles).toHaveCount(60);
  const nudge = () => panel.locator(".browse-scroll").evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    for (let i = 0; i < 10; i++) node.dispatchEvent(new Event("scroll"));
  });
  await nudge();
  await expect.poll(() => secondAttempts).toBe(1);
  expect(remote.requests).toHaveLength(2);
  await tiles.first().locator(".library-open").click();
  await expect(panel.locator(".crumbs button[aria-current=page]")).toContainText("Synthetic title");
  await panel.locator(".library-back").click();
  await expect(tiles).toHaveCount(60);
  // The page canceled on the way into the detail left the action disabled once, and the listing
  // then refused every later page: what makes the resume below possible is a canceled load that
  // is over as far as the listing is concerned.
  await expect(panel.locator(".load-more button")).toBeEnabled();
  await nudge();
  await expect(tiles).toHaveCount(120);
  expect(secondAttempts).toBe(2);
  release();
  await nudge();
  await expect(tiles).toHaveCount(180);
  const loaded = await tiles.locator(".library-copy strong").allTextContents();
  expect(new Set(loaded).size).toBe(180);
  expect(remote.requests.filter((url) => !url.searchParams.has("cursor"))).toHaveLength(1);
  expect(remote.requests.every((url) => url.searchParams.get("limit") === "60")).toBe(true);
  await tiles.first().locator(".library-open").click();
  await panel.locator(".library-back").click();
  await expect(tiles).toHaveCount(180);
  expect(await tiles.locator(".library-copy strong").allTextContents()).toEqual(loaded);
  expect(remote.requests.filter((url) => !url.searchParams.has("cursor"))).toHaveLength(1);
});

test("item and series breadcrumbs walk the remote hierarchy", async ({ page }) => {
  await remoteLibraries(page, { items: (url) => url.searchParams.get("type") === "episode"
    ? [{ id: "ep1", name: "Pilot", type: "episode", season: 1, episode: 1, providerIds: {} }]
    : [{ id: "ser1", name: "Show", type: "series", providerIds: {} }] });
  await page.locator(".remote-libraries .browse-item.library").filter({ hasText: "Remote clips" }).getByRole("button").click();
  const panel = page.locator(".remote-browse-panel");
  const crumbs = panel.locator(".crumbs button");
  await panel.locator(".browse-item").filter({ hasText: "Show" }).locator(".library-open").click();
  // The trail starts with the section it is in, the way the library's own listing does.
  await expect(crumbs).toHaveText(["", "Knihovna", "Remote clips", "Show"]);
  await panel.locator(".browse-item").filter({ hasText: "Pilot" }).locator(".library-open").click();
  await expect(crumbs).toHaveText(["", "Knihovna", "Remote clips", "Show", "S1 E1 · Pilot"]);
  await expect(panel.locator('.crumbs button[aria-current="page"]')).toBeDisabled();
  // The series crumb goes back to the series and returns focus to the episode it came from.
  await panel.locator(".crumbs button").filter({ hasText: "Show" }).click();
  await expect(crumbs).toHaveText(["", "Knihovna", "Remote clips", "Show"]);
  await expect(panel.locator(".browse-item").filter({ hasText: "Pilot" }).locator(".library-open")).toBeFocused();
});

/** The section's own crumb leaves the media server entirely, from a title as from a listing: no
 *  detail or remote panel may stay behind over the libraries it returns to. */
test("the Library crumb of a remote title's detail returns to the libraries", async ({ page }) => {
  await remoteLibraries(page, { items: () => [{ id: "m1", name: "Film One", type: "movie", providerIds: {} }] });
  await page.locator(".remote-libraries .browse-item.library").filter({ hasText: "Remote clips" }).getByRole("button").click();
  const panel = page.locator(".remote-browse-panel");
  await panel.locator(".browse-item").filter({ hasText: "Film One" }).locator(".library-open").click();
  await expect(panel.locator(".library-title-detail")).toBeVisible();
  await panel.locator(".crumbs").getByRole("button", { name: "Knihovna", exact: true }).click();
  await expect(page.locator(".remote-browse-panel")).toHaveCount(0);
  await expect(page.locator(".library-title-detail")).toHaveCount(0);
  await expect(page.locator(".remote-libraries .browse-item.library").filter({ hasText: "Remote clips" })).toBeVisible();
  // Opening the library again starts at its listing, not at the title that was left.
  await page.locator(".remote-libraries .browse-item.library").filter({ hasText: "Remote clips" }).getByRole("button").click();
  await expect(page.locator(".remote-browse-panel .browse-item").filter({ hasText: "Film One" })).toBeVisible();
  await expect(page.locator(".library-title-detail")).toHaveCount(0);
});

for (const nested of [false, true]) {
  test(`current remote breadcrumb restores a paginated ${nested ? "folder" : "root"} listing`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const items = Array.from({ length: 80 }, (_, i) => ({ id: `movie-${i}`, name: `Movie ${i}`, type: "movie", providerIds: {} }));
    const remote = await remoteLibraries(page, { items: () => items });
    await page.route("**/api/remote-libraries/*/browse*", async route => {
      const url = new URL(route.request().url());
      remote.requests.push(url);
      const root = nested && !url.searchParams.has("parentId");
      await route.fulfill({ json: { items: root ? [folder("folder-a", "Category Alpha")]
        : url.searchParams.has("cursor") ? items.slice(60) : items.slice(0, 60),
        total: root ? 1 : 80, capabilities, asOf: "2026-01-01T00:00:00Z", stale: false,
        ...(!root && !url.searchParams.has("cursor") ? { cursor: "next" } : {}) } });
    });
    await page.locator(".remote-libraries .browse-item.library").filter({ hasText: "Remote clips" }).getByRole("button").click();
    const panel = page.locator(".remote-browse-panel");
    if (nested) await panel.locator('.library-open').click();
    await panel.locator('.browse-item[data-remote-id="movie-59"]').scrollIntoViewIfNeeded();
    await expect(panel.locator('.browse-item[data-remote-id="movie-79"]')).toBeVisible();
    const target = panel.locator('.browse-item[data-remote-id="movie-70"] .library-open');
    await target.scrollIntoViewIfNeeded();
    const offset = await panel.locator(".browse-scroll").evaluate(node => node.scrollTop);
    expect(offset).toBeGreaterThan(100);
    const reads = remote.requests.length;
    await target.click();
    await expect(panel.locator(".library-title-detail")).toBeVisible();
    await panel.locator(".crumbs").getByRole("button", { name: nested ? "Category Alpha" : "Remote clips", exact: true }).click();
    await expect(panel.locator(".library-title-detail")).toHaveCount(0);
    await expect(panel.locator('.browse-item[data-remote-id]')).toHaveCount(80);
    await expect.poll(() => panel.locator(".browse-scroll").evaluate((node, expected) => Math.abs(node.scrollTop - expected), offset)).toBeLessThan(2);
    await expect(target).toBeFocused();
    expect(remote.requests).toHaveLength(reads);
  });
}

test("an ancestor breadcrumb restores a scrolled remote listing without a new page", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const items = Array.from({ length: 80 }, (_, i) => (i === 70
    ? folder("folder-70", "Category 71")
    : { id: `movie-${i}`, name: `Movie ${i}`, type: "movie", providerIds: {} }));
  const remote = await remoteLibraries(page);
  await page.route("**/api/remote-libraries/*/browse*", async route => {
    const url = new URL(route.request().url());
    remote.requests.push(url);
    if (url.searchParams.get("parentId") === "folder-70") {
      await route.fulfill({ json: { items: [{ id: "clip-70", name: "Clip Seventy", type: "movie", providerIds: {} }],
        total: 1, capabilities, asOf: "2026-01-01T00:00:00Z", stale: false } });
      return;
    }
    await route.fulfill({ json: { items: url.searchParams.has("cursor") ? items.slice(60) : items.slice(0, 60),
      total: 80, capabilities, asOf: "2026-01-01T00:00:00Z", stale: false,
      ...(url.searchParams.has("cursor") ? {} : { cursor: "next" }) } });
  });
  await page.locator(".remote-libraries .browse-item.library").filter({ hasText: "Remote clips" }).getByRole("button").click();
  const panel = page.locator(".remote-browse-panel");
  await panel.locator('.browse-item[data-remote-id="movie-59"]').scrollIntoViewIfNeeded();
  const target = panel.locator('.browse-item[data-remote-id="folder-70"]');
  await expect(target).toBeVisible();
  await target.locator(".library-open").scrollIntoViewIfNeeded();
  const offset = await panel.locator(".browse-scroll").evaluate(node => node.scrollTop);
  expect(offset).toBeGreaterThan(100);
  await target.locator(".library-open").click();
  await expect(panel.locator('.browse-item[data-remote-id="clip-70"]')).toBeVisible();
  const reads = remote.requests.length;
  await panel.locator('.browse-item[data-remote-id="clip-70"] .library-open').click();
  await expect(panel.locator(".library-title-detail")).toBeVisible();
  await panel.locator(".crumbs").getByRole("button", { name: "Remote clips", exact: true }).click();
  await expect(panel.locator(".library-title-detail")).toHaveCount(0);
  await expect(panel.locator(".browse-item[data-remote-id]")).toHaveCount(80);
  await expect(panel.locator('.browse-item[data-remote-id="movie-79"]')).toBeVisible();
  await expect.poll(() => panel.locator(".browse-scroll").evaluate((node, expected) => Math.abs(node.scrollTop - expected), offset)).toBeLessThan(2);
  await expect(target.locator(".library-open")).toBeFocused();
  expect(remote.requests).toHaveLength(reads);
});

test("remote ancestor breadcrumb and Back restore the same intermediate listing", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const remote = await remoteLibraries(page, { items: (url) => {
    const parent = url.searchParams.get("parentId");
    if (parent === "folder-a") return [folder("nested-a", "Collection One")];
    if (parent === "nested-a") return [folder("nested-b", "Collection Two")];
    if (parent === "nested-b") return [{ id: "clip-a", name: "Clip One", type: "movie", providerIds: {} }];
    return [folder("folder-a", "Category Alpha")];
  } });
  await page.locator(".remote-libraries .browse-item.library").filter({ hasText: "Remote clips" }).getByRole("button").click();
  const panel = page.locator(".remote-browse-panel");
  const nested = () => panel.locator('.browse-item[data-remote-id="nested-a"]');
  await panel.locator('.browse-item[data-remote-id="folder-a"] .library-open').click();
  await nested().locator(".library-open").click();
  const reads = remote.requests.length;
  // The intermediate breadcrumb returns to Collection One from the listing it left behind.
  await panel.locator(".crumbs").getByRole("button", { name: "Category Alpha", exact: true }).click();
  await expect(nested()).toBeVisible();
  await expect(nested().locator(".library-open")).toBeFocused();
  expect(remote.requests).toHaveLength(reads);
  // Back from the same child lands on that same cached listing.
  await nested().locator(".library-open").click();
  expect(remote.requests).toHaveLength(reads + 1);
  await panel.locator(".library-back").click();
  await expect(nested()).toBeVisible();
  await expect(nested().locator(".library-open")).toBeFocused();
  expect(remote.requests).toHaveLength(reads + 1);
});

test("the sidebar returns to the libraries and the next remote open starts fresh at the top", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const clips = Array.from({ length: 80 }, (_, i) => ({ id: `clip-${i}`, name: `Clip ${i}`, type: "movie", providerIds: {} }));
  const remote = await remoteLibraries(page);
  await page.route("**/api/remote-libraries/*/browse*", async route => {
    const url = new URL(route.request().url());
    remote.requests.push(url);
    if (url.searchParams.get("parentId") !== "folder-a") {
      await route.fulfill({ json: { items: [folder("folder-a", "Category Alpha")], total: 1,
        capabilities, asOf: "2026-01-01T00:00:00Z", stale: false } });
      return;
    }
    await route.fulfill({ json: { items: url.searchParams.has("cursor") ? clips.slice(60) : clips.slice(0, 60),
      total: 80, capabilities, asOf: "2026-01-01T00:00:00Z", stale: false,
      ...(url.searchParams.has("cursor") ? {} : { cursor: "next" }) } });
  });
  const openLibrary = () => page.locator(".remote-libraries .browse-item.library").filter({ hasText: "Remote clips" }).getByRole("button").click();
  await openLibrary();
  const panel = page.locator(".remote-browse-panel");
  await panel.locator('.browse-item[data-remote-id="folder-a"] .library-open').click();
  await panel.locator('.browse-item[data-remote-id="clip-59"]').scrollIntoViewIfNeeded();
  await expect(panel.locator('.browse-item[data-remote-id="clip-79"]')).toBeVisible();
  expect(await panel.locator(".browse-scroll").evaluate(node => node.scrollTop)).toBeGreaterThan(100);
  const reads = remote.requests.length;
  // The section's own entry in the sidebar, not the crumb the trail now starts with.
  await page.locator(".sidebar").getByRole("button", { name: "Knihovna", exact: true }).click();
  await expect(page.locator(".remote-libraries .browse-item.library")).toHaveCount(8);
  await expect(panel).toHaveCount(0);
  await openLibrary();
  await expect(panel.locator('.browse-item[data-remote-id="folder-a"]')).toBeVisible();
  expect(remote.requests).toHaveLength(reads + 1);
  await panel.locator('.browse-item[data-remote-id="folder-a"] .library-open').click();
  await expect(panel.locator(".browse-item[data-remote-id]")).toHaveCount(60);
  expect(await panel.locator(".browse-scroll").evaluate(node => node.scrollTop)).toBe(0);
  expect(remote.requests).toHaveLength(reads + 2);
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
  // The fan is composed when the library's preview answers, which is a round trip after the row
  // is drawn: the row starts on its fallback, and this is the wait for the picture that replaces
  // it rather than a check that it was already there.
  await expect(roots.first().locator(".browse-art img")).toHaveAttribute("src", /\/mosaic\?v=e2e&shape=poster$/, { timeout: 20_000 });
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
  // The broken backdrop is asked for while the wide shape draws it; one render may put the same
  // address on the wire more than once, so what the page must not do is ask again for every style
  // change that follows a failure it has already seen.
  await panel.locator(".shape-toggle").click();
  await expect(image).toHaveAttribute("src", "/remote-test-art/0.svg");
  await expect.poll(() => backdropRequests, { message: "the wide shape never drew the backdrop" }).toBeGreaterThan(0);
  const asked = backdropRequests;
  for (let i = 0; i < 5; i++) {
    await panel.locator(".shape-toggle").click();
    await expect(image).toHaveAttribute("src", "/remote-test-art/0.svg");
    await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true);
    await expect(panel.locator(".browse-art .broken")).toHaveCount(0);
  }
  expect(backdropRequests, "the failure is remembered, so no later style change asks for it again").toBe(asked);
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

test("an unmatched remote clip uses its native preview as a full-resolution detail backdrop", async ({ page }) => {
  const poster = `/api/remote-libraries/${libraryId}/items/preview-only/artwork/Primary?tag=preview-1`;
  await remoteLibraries(page, { items: () => [{ id: "preview-only", name: "Preview only", type: "movie", providerIds: {}, poster }] });
  const sizes: Array<string | null> = [];
  const metadata: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/meta/")) metadata.push(request.url()); });
  await page.route("**/items/preview-only/artwork/Primary?*", async (route) => {
    const size = new URL(route.request().url()).searchParams.get("size");
    sizes.push(size);
    const [width, height] = size === "detail" ? [1920, 1080] : [640, 360];
    await route.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#48617b"/></svg>` });
  });
  await page.locator(".remote-libraries .browse-item.library").filter({ hasText: "Remote clips" }).getByRole("button").click();
  const panel = page.locator(".remote-browse-panel");
  const preview = panel.locator(".browse-art img:not(.tile-blur)").first();
  await expect(preview).toHaveAttribute("src", poster);
  await expect.poll(() => preview.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(640);
  expect(sizes.every((size) => size === null), "listing previews keep the tile variant").toBe(true);
  await panel.locator(".browse-item").filter({ hasText: "Preview only" }).locator(".library-open").click();
  const detail = panel.locator(".library-title-detail");
  await expect(detail).toHaveCSS("background-image", /size=detail/);
  await expect.poll(() => detail.locator(".gallery-open img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1920);
  expect(sizes).toContain("detail");
  expect(metadata, "a clip without provider IDs never guesses catalogue metadata").toEqual([]);
});

for (const width of [1440, 390]) {
  test(`native copy menu selects an exact version and local destination at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const remote = await remoteLibraries(page, {
      items: () => [{ id: "copy-film", name: "Copy fixture", type: "movie", providerIds: {} }],
      sources: [
        { sourceId: "copy-small", kind: "remote", playable: true, name: "720p", provider: "emby",
          remoteItem: { libraryId, itemId: "copy-film", mediaSourceId: "v1" },
          capabilities: { ...capabilities, downloadToLibrary: true }, behaviorHints: { videoSize: 1_000_000_000 } },
        { sourceId: "copy-large", kind: "remote", playable: true, name: "1080p", provider: "emby",
          remoteItem: { libraryId, itemId: "copy-film", mediaSourceId: "v2" },
          capabilities: { ...capabilities, downloadToLibrary: true }, behaviorHints: { videoSize: 4_000_000_000 } },
      ],
    });
    const copies: Array<{ sourceId: string; target: { libraryId: string } }> = [];
    await page.route("**/api/downloads", async route => {
      if (route.request().method() !== "POST") { await route.continue(); return; }
      copies.push(route.request().postDataJSON());
      await route.fulfill({ status: 201, json: { id: "copy-job", status: "queued" } });
    });
    await page.locator(".remote-libraries .browse-item.library").filter({ hasText: "Remote clips" }).getByRole("button").click();
    const tile = page.locator('.remote-browse-panel .browse-item[data-remote-id="copy-film"]');
    expect(remote.sources(), "drawing a tile does not read its versions").toBe(0);
    await tile.locator(".browse-menu").click();
    await tile.getByRole("button", { name: "Do knihovny", exact: true }).click();
    const dialog = page.getByRole("dialog").filter({ has: page.locator(".save-target-card") });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".native-source-choice select")).toBeVisible();
    expect(remote.sources()).toBe(1);
    const small = await dialog.locator(".native-source-choice option").filter({ hasText: "720p" }).getAttribute("value");
    await dialog.locator(".native-source-choice select").selectOption(small!);
    await dialog.locator(".bulk-strategy").first().locator("label").nth(1).click();
    await dialog.getByRole("button", { name: "Local roots B", exact: true }).click();
    await dialog.getByRole("button", { name: "Do knihovny", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(copies).toHaveLength(1);
    expect(copies[0]!.sourceId).toBe("copy-small");
    expect(copies[0]!.target.libraryId).toBe(localLibraryIds[1]);
    expect(remote.sources()).toBe(1);
    await expect(page.locator(".remote-browse-panel .crumbs")).toContainText("Remote clips");
  });
}

test("a native copy keeps the projected destination as its automatic default", async ({ page }) => {
  const remote = await remoteLibraries(page, {
    items: () => [{ id: "copy-film", name: "Copy fixture", type: "movie", providerIds: {} }],
    sources: [
      { sourceId: "copy-small", kind: "remote", playable: true, name: "720p", provider: "emby",
        remoteItem: { libraryId, itemId: "copy-film", mediaSourceId: "v1" },
        capabilities: { ...capabilities, downloadToLibrary: true }, behaviorHints: { videoSize: 1_000_000_000 } },
      { sourceId: "copy-large", kind: "remote", playable: true, name: "1080p", provider: "emby",
        remoteItem: { libraryId, itemId: "copy-film", mediaSourceId: "v2" },
        capabilities: { ...capabilities, downloadToLibrary: true }, behaviorHints: { videoSize: 4_000_000_000 },
        downloadLibraryId: localLibraryIds[1] },
    ],
  });
  const copies: Array<Record<string, unknown>> = [];
  await page.route("**/api/downloads", async route => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    copies.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, json: { id: "copy-job", status: "queued" } });
  });
  await page.locator(".remote-libraries .browse-item.library").filter({ hasText: "Remote clips" }).getByRole("button").click();
  const tile = page.locator('.remote-browse-panel .browse-item[data-remote-id="copy-film"]');
  await tile.locator(".browse-menu").click();
  await tile.getByRole("button", { name: "Do knihovny", exact: true }).click();
  const dialog = page.getByRole("dialog").filter({ has: page.locator(".save-target-card") });
  await expect(dialog).toBeVisible();
  // The automatic option names the destination the server projected, and the exact version the
  // server would pick is the largest one.
  await expect(dialog.locator(".bulk-strategy").first().locator("label").first()).toContainText("Local roots B");
  await dialog.getByRole("button", { name: "Do knihovny", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(copies).toHaveLength(1);
  expect(copies[0]!.sourceId).toBe("copy-large");
  expect("target" in copies[0]!).toBe(false);
});

for (const [width, height] of [[1440, 900], [390, 844], [844, 390]]) {
  test(`native detail automatically unifies sources and copies the exact source at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const requests: string[] = [];
    const matches: string[] = [];
    const copies: Array<{ sourceId: string; target?: unknown; media: { id: string; kind: string } }> = [];
    await page.route("**/api/meta/movie/tt1234567**", route => route.fulfill({ json: { id: "tt1234567", type: "movie", name: "On demand film" } }));
    await page.route("**/api/links/movie/tt1234567**", route => route.fulfill({ json: { links: [] } }));
    await page.route("**/api/trailer/movie/tt1234567**", route => route.fulfill({ json: { trailer: null } }));
    await page.route("**/api/stream-sources/movie/tt1234567", async route => {
      requests.push("discovery");
      await route.fulfill({ json: [{ key: "provider-one", name: "Provider one" }, { key: "provider-two", name: "Provider two" }] });
    });
    await page.route("**/api/streams/movie/tt1234567**", async route => {
      const provider = new URL(route.request().url()).searchParams.get("addon");
      requests.push(provider ?? "unfiltered");
      await route.fulfill({ json: provider === "provider-one" ? [{ sourceId: "addon-copy-exact", kind: "remote", playable: true,
        name: "Addon 20 GB", title: "CZ 20 GB", addonKey: provider, addonName: "Provider one" }] : [] });
    });
    await page.route("**/api/downloads", async route => {
      if (route.request().method() !== "POST") return route.continue();
      copies.push(route.request().postDataJSON());
      await route.fulfill({ status: 201, json: { id: "addon-copy-job", status: "queued" } });
    });
    await remoteLibraries(page, {
      items: () => [{ id: "addon-film", name: "On demand film", type: "movie", providerIds: { imdb: "tt1234567" } }],
      sources: [{ sourceId: "native-small", kind: "remote", playable: true, name: "Native 1080p", provider: "emby", libraryId,
        remoteItem: { libraryId, itemId: "addon-film", mediaSourceId: "v1", progressKey: "remote:native" },
        behaviorHints: { videoSize: 1_000_000_000 } }],
    });
    await page.route("**/api/local-streams/movie/tt1234567", route => route.fulfill({ json: [{
      sourceId: "local-copy", kind: "library", playable: true, localPath: "Other/copy.mkv", libraryName: "Local roots",
      behaviorHints: { filename: "Local 40 GB.mkv", videoSize: 40_000_000_000 },
    }] }));
    await page.route("**/api/remote-libraries/*/streams/movie/tt1234567**", route => {
      const id = new URL(route.request().url()).pathname.split("/")[3]!;
      matches.push(id);
      return route.fulfill({ json: { streams: id.endsWith("2") ? [{ sourceId: "foreign-copy", kind: "remote", playable: true,
        name: "Other server 30 GB", provider: "jellyfin", libraryId: id, libraryName: "Other server",
        capabilities: { ...capabilities, downloadToLibrary: true }, downloadLibraryId: localLibraryIds[1],
        behaviorHints: { videoSize: 30_000_000_000 },
        remoteItem: { libraryId: id, itemId: "foreign-film", mediaSourceId: "v1", progressKey: "remote:foreign" },
      }] : [] } });
    });
    await page.locator(".remote-libraries .browse-item.library").filter({ hasText: "Remote clips" }).getByRole("button").click();
    const detail = page.locator(".remote-browse-panel .library-title-detail");
    await page.locator(".remote-browse-panel .browse-item").filter({ hasText: "On demand film" }).locator(".library-open").click();
    await expect(detail.getByRole("button", { name: "Přehrát", exact: true })).toBeEnabled();
    expect(requests).toEqual([]);
    await detail.getByRole("button", { name: "Vybrat zdroj" }).click();
    const dialog = page.getByRole("dialog", { name: "Vybrat zdroj" });
    await expect(dialog).toBeVisible();
    const native = dialog.locator(".stream-list button").filter({ hasText: "Native 1080p" });
    const addon = dialog.locator(".stream-list button").filter({ hasText: "Addon 20 GB" });
    await expect(addon).toBeVisible();
    await expect(dialog.locator(".stream-list button").filter({ hasText: "Local 40 GB" })).toBeVisible();
    await expect(dialog.locator(".stream-list button").filter({ hasText: "Other server 30 GB" })).toBeVisible();
    await expect.poll(() => [...requests].sort()).toEqual(["discovery", "provider-one", "provider-two"]);
    await expect.poll(() => matches.length).toBe(7);
    expect(matches).not.toContain(libraryId);
    await expect(dialog.getByRole("button", { name: "Načíst zdroje" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Zdroje z doplňků" })).toHaveCount(0);
    await expect(native).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.locator(".stream-list button").first()).toContainText("Native 1080p");
    await expect(dialog.getByRole("combobox", { name: "Doplněk" })).toBeVisible();
    await expect(dialog.getByRole("combobox", { name: "Jazyk" })).toBeVisible();
    await expect(dialog.getByRole("combobox", { name: "Řazení" })).toBeVisible();
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
    const overflowing = await dialog.evaluate(node => node.scrollWidth > node.clientWidth + 1);
    expect(overflowing).toBe(false);
    await page.screenshot({ path: `e2e/.tmp/native-addon-picker-${width}.png` });
    await addon.click();
    // The button queues the row through the destination its own source projects; the arrow beside
    // it is the one that asks, which is the dialog this journey is about.
    await detail.locator(".library-detail-save .split-button-toggle").click();
    const save = page.getByRole("dialog");
    await expect(save).toBeVisible();
    await save.getByRole("button", { name: "Do knihovny", exact: true }).click();
    await expect(save).toHaveCount(0);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ sourceId: "addon-copy-exact", media: { id: "tt1234567", kind: "movie" } });
    expect(copies[0]).not.toHaveProperty("target");
    await detail.getByRole("button", { name: "Vybrat zdroj" }).click();
    await expect(dialog.locator(".stream-list button").filter({ hasText: "Addon 20 GB" })).toHaveAttribute("aria-pressed", "true");
    expect([...requests].sort()).toEqual(["discovery", "provider-one", "provider-two"]);
    expect(matches).toHaveLength(7);
    await dialog.locator(".stream-list button").filter({ hasText: "Other server 30 GB" }).click();
    await detail.getByRole("button", { name: "Vybrat zdroj" }).click();
    await expect(dialog.locator('.stream-list button[aria-pressed="true"]')).toContainText("Other server 30 GB");
    await page.keyboard.press("Escape");
    await detail.locator(".library-detail-save .split-button-toggle").click();
    const foreignSave = page.getByRole("dialog");
    await foreignSave.getByRole("button", { name: "Do knihovny", exact: true }).click();
    await expect(foreignSave).toHaveCount(0);
    expect(copies).toHaveLength(2);
    expect(copies[1]).toMatchObject({ sourceId: "foreign-copy", media: { id: "tt1234567", kind: "movie" } });
    if (width === 1440) {
      const starts: Array<{ sourceId: string }> = [];
      const devicePaths: string[] = [];
      await page.route("**/unified-player.mp4", route => route.fulfill({ path: path.resolve("e2e/fixtures/media/sample.mp4"), contentType: "video/mp4" }));
      await page.route("**/api/playback", route => {
        starts.push(route.request().postDataJSON());
        return route.fulfill({ json: { id: "unified-source-player", mode: "direct", url: "/unified-player.mp4", offset: 0, duration: 600,
          hardware: false, acceleration: false, audioTracks: [], subtitleTracks: [], audioTrack: 0, subtitleTrack: null, quality: null } });
      });
      await page.route("**/api/playback/unified-source-player", route => route.fulfill({ status: 204 }));
      // The fixture file may be refused by this browser's codecs; the player then asks once for a
      // conversion of the same session, which is not another start.
      await page.route("**/api/playback/unified-source-player/escalate", route => route.fulfill({ json: { id: "unified-source-player", mode: "direct",
        url: "/unified-player.mp4", offset: 0, duration: 600, hardware: false, acceleration: false, audioTracks: [], subtitleTracks: [],
        audioTrack: 0, subtitleTrack: null, quality: null } }));
      await page.route("**/api/library/source", route => {
        const body = route.request().postDataJSON() as { path: string };
        devicePaths.push(body.path);
        return route.fulfill({ json: { sourceId: "exact-local-device-copy", kind: "library", playable: true } });
      });
      await page.route("**/api/device-download", route => route.fulfill({ json: { url: "/unified-device-file", filename: "copy.mkv" } }));
      await page.route("**/unified-device-file", route => route.fulfill({ body: "fixture", headers: { "Content-Disposition": 'attachment; filename="copy.mkv"' } }));
      await detail.getByRole("button", { name: "Přehrát", exact: true }).click();
      const player = page.locator(".player-overlay");
      await expect(player).toBeVisible();
      await player.dispatchEvent("pointermove");
      await player.locator(".player-settings-toggle").click();
      await expect(player.getByRole("button", { name: "Uložit do knihovny na serveru", exact: true })).toBeVisible();
      await expect(player.getByRole("button", { name: "Uložit do tohoto zařízení", exact: true })).toHaveCount(0);
      await player.getByRole("button", { name: "Uložit do knihovny na serveru", exact: true }).click();
      // The player has one save button and it saves: the row on screen goes through the destination
      // its own source projects, with no dialog in the way.
      await expect(page.locator('.identify-overlay[role="dialog"]').filter({ has: page.locator(".save-target-card") })).toHaveCount(0);
      expect(copies).toHaveLength(3);
      expect(copies[2]).toMatchObject({ sourceId: "foreign-copy", media: { id: "tt1234567", kind: "movie" } });
      await player.dispatchEvent("pointermove");
      await player.getByRole("button", { name: "Zavřít přehrávač", exact: true }).click();
      await expect(player).toHaveCount(0);
      await detail.getByRole("button", { name: "Vybrat zdroj" }).click();
      await dialog.locator(".stream-list button").filter({ hasText: "Local 40 GB" }).click();
      await detail.getByRole("button", { name: "Přehrát", exact: true }).click();
      await expect(player).toBeVisible();
      await player.dispatchEvent("pointermove");
      await player.locator(".player-settings-toggle").click();
      await expect(player.getByRole("button", { name: "Uložit do knihovny na serveru", exact: true })).toHaveCount(0);
      await player.getByRole("button", { name: "Uložit do tohoto zařízení", exact: true }).click();
      await expect.poll(() => devicePaths).toContain("Other/copy.mkv");
      expect(starts.map(item => item.sourceId)).toEqual(["foreign-copy", "local-copy"]);
      await player.dispatchEvent("pointermove");
      await player.getByRole("button", { name: "Zavřít přehrávač", exact: true }).click();
    }
  });
}


test("remote detail actions align across phone tablet and desktop", async ({ page }) => {
  await detailArtwork(page);
  for (const viewport of [{ width: 1440, height: 900 }, { width: 820, height: 1180 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await remoteLibraries(page, {
      items: () => [{ id: "layout-film", name: "Film One", type: "movie", providerIds: { imdb: "tt123" }, poster: "/detail-layout-art/poster.svg", wide: "/detail-layout-art/background.svg", overview: "A family sets out on a journey through an unfamiliar world. Along the way they meet new friends, overcome unexpected obstacles and discover what matters most. The complete description stays visible while title links, artwork and the action toolbar keep their own space." }],
      sources: [{ sourceId: "layout-source", kind: "remote", playable: true, provider: "emby", remoteItem: { libraryId, itemId: "layout-film", mediaSourceId: "layout-source" } }],
    });
    await page.route("**/api/remote-libraries/*/items/layout-film/state", route => route.fulfill({ json: { position: 3723, duration: 7200, mediaSourceId: "layout-source", favorite: false, watched: false } }));
    await page.locator(".remote-libraries .browse-item.library").filter({ hasText: "Remote clips" }).getByRole("button").click();
    await page.locator(".remote-browse-panel .browse-item").filter({ hasText: "Film One" }).locator(".library-open").click();
    const detail = page.locator(".remote-browse-panel .library-title-detail");
    await expect(detail.getByRole("button", { name: "Přehrát od začátku", exact: true })).toBeVisible();
    await expect(detail.locator(".gallery-open")).toBeVisible();
    await expect(detail.locator(".title-links a")).toHaveCount(3);
    await checkDetailActions(page, detail);
    await detail.locator(".library-detail-actions").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `e2e/.tmp/remote-detail-actions-${viewport.width}.png` });
  }
});

/** One position per title: a media-server film the catalogue can name shows the position the title
 *  holds, not the state of the version that happens to be listed first. */
test("a media-server film shows the title's own position", async ({ page, request }) => {
  const key = "movie:tt9900001";
  const film: BrowseItem = { id: "identified-film", name: "Identified film", type: "movie", providerIds: { imdb: "tt9900001" } };
  expect((await request.post("/api/progress", { data: { key, title: "Identified film", position: 600, duration: 2400 } })).ok()).toBe(true);
  try {
    await remoteLibraries(page, {
      items: () => [film],
      sources: [{ sourceId: "native-1", kind: "remote", playable: true, name: "Native 1080p", provider: "emby", libraryId,
        remoteItem: { libraryId, itemId: "identified-film", mediaSourceId: "v1", progressKey: "remote:native" },
        behaviorHints: { videoSize: 1_000_000_000 } }],
    });
    await page.locator(".remote-libraries .browse-item.library").filter({ hasText: "Remote clips" }).getByRole("button").click();
    await page.locator(".remote-browse-panel .browse-item").filter({ hasText: "Identified film" }).locator(".library-open").click();
    const detail = page.locator(".remote-browse-panel .library-title-detail");
    await expect(detail.locator(".library-detail-progress span")).toContainText("10:00", { timeout: 15_000 });
  } finally {
    await request.delete(`/api/progress/${encodeURIComponent(key)}`);
  }
});

/** One star per title, media server included: starring a film from its own detail stars
 *  `movie:<id>`, and clearing that from the catalogue clears the detail's star again.
 *
 *  Skipped: `remoteLibraries` answers every `/api/remote-libraries**` request itself, so the star
 *  PATCH never reaches the server's own state and `/api/watchlist` cannot be read back here. The
 *  rule is covered by `server/src/media-server-personal.test.ts`. */
test.skip("a media-server film's star is its title's star", async ({ page, request }) => {
  const imdb = "tt9900002";
  await remoteLibraries(page, {
    items: () => [{ id: "starred-film", name: "Starred film", type: "movie", providerIds: { imdb } }],
    sources: [{ sourceId: "native-1", kind: "remote", playable: true, name: "Native 1080p", provider: "emby", libraryId,
      remoteItem: { libraryId, itemId: "starred-film", mediaSourceId: "v1", progressKey: "remote:native" } }],
  });
  await page.locator(".remote-libraries .browse-item.library").filter({ hasText: "Remote clips" }).getByRole("button").click();
  await page.locator(".remote-browse-panel .browse-item").filter({ hasText: "Starred film" }).locator(".library-open").click();
  const detail = page.locator(".remote-browse-panel .library-title-detail");

  await detail.getByRole("button", { name: "Přidat do oblíbených", exact: true }).click();
  await expect.poll(async () => ((await (await request.get("/api/watchlist")).json()) as Array<{ key: string }>).map((entry) => entry.key))
    .toContain(`movie:${imdb}`);

  await request.post("/api/watchlist", { data: { type: "movie", id: imdb, favorite: false } });
  await page.reload();
  await expect(detail.getByRole("button", { name: "Přidat do oblíbených", exact: true })).toHaveAttribute("aria-pressed", "false");
});
