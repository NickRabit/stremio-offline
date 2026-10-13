import { expect, test, type Page } from "@playwright/test";

const libraryId = `rlib_${"1".repeat(32)}`;
const capabilities = { rename: false, move: false, delete: false, identify: false, writeArtwork: false, downloadToLibrary: false, downloadToDevice: false };
const folder = (id: string, name: string) => ({ id, name, type: "folder", providerIds: {} });

async function remoteLibraries(page: Page) {
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
      const items = parent === "folder-a" ? [folder("nested-a", "Collection One")]
        : parent === "nested-a" ? [{ id: "clip-a", name: "Clip One", type: "movie", providerIds: {} }]
        : url.searchParams.has("cursor") ? [folder("folder-c", "Category Charlie")]
        : [folder("folder-a", "Category Alpha"), folder("folder-b", "Category Bravo")];
      body = { items, total: parent ? items.length : 3, capabilities, asOf: "2026-01-01T00:00:00Z", stale: false,
        ...(!parent && !url.searchParams.has("cursor") ? { cursor: "next-root" } : {}) };
    } else if (url.pathname.endsWith("/sources")) {
      sources++;
      body = { streams: [] };
    } else {
      body = { items: [], total: 0 };
    }
    await route.fulfill({ json: body });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  return { requests, sources: () => sources };
}

test("remote folders keep their hierarchy and only fetch an explicitly opened page", async ({ page }) => {
  const remote = await remoteLibraries(page);
  await page.locator(".remote-libraries .browse-item.library").filter({ hasText: "Remote clips" }).getByRole("button").click();
  const panel = page.locator(".remote-browse-panel");
  await expect(panel.locator(".browse-item.folder")).toHaveCount(2);
  expect(remote.requests).toHaveLength(1);
  expect(remote.requests[0].searchParams.get("mode")).toBe("folders");
  await panel.locator(".browse-item.folder").filter({ hasText: "Category Alpha" }).getByRole("button").click();
  await expect(panel.locator(".browse-item.folder")).toHaveCount(1);
  await expect(panel.locator(".browse-item.folder")).toContainText("Collection One");
  expect(remote.requests).toHaveLength(2);
  expect(remote.requests[1].searchParams.get("parentId")).toBe("folder-a");
  expect(remote.sources()).toBe(0);
  await panel.locator(".library-back").click();
  await expect(panel.locator(".browse-item.folder")).toHaveCount(2);
  await expect(panel.locator(".browse-item.folder").filter({ hasText: "Category Alpha" }).getByRole("button")).toBeFocused();
  await panel.locator(".load-more button").click();
  await expect(panel.locator(".browse-item.folder")).toHaveCount(3);
  expect(remote.requests.at(-1)?.searchParams.get("cursor")).toBe("next-root");
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
