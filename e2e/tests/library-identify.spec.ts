import { expect, test, type Page } from "@playwright/test";
import { scanLibrary } from "./library-tools";
import { addonManifest, appUrl } from "../../playwright.config";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

const sample = path.resolve("e2e/fixtures/media/sample.mp4");
const folderName = "Zkušební film (2024)";
const folder = path.resolve("e2e/.tmp/downloads", folderName);
const seriesName = "Zkušební seriál";
const seriesFolder = path.resolve("e2e/.tmp/downloads", seriesName);

test.beforeAll(async () => {
  await mkdir(folder, { recursive: true });
  await copyFile(sample, path.join(folder, "Zkušební film.mkv"));
  await mkdir(seriesFolder, { recursive: true });
  await copyFile(sample, path.join(seriesFolder, "Zkušební seriál S01E01.mkv"));
  await copyFile(sample, path.join(seriesFolder, "Zkušební seriál S01E02.mkv"));
});

const fixtureTile = (page: Page) => page.locator(".browse-item", { hasText: folderName });

test("scan library matches the unique fixture folder", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  await expect(fixtureTile(page)).toBeVisible();
  await scanLibrary(page);
  await expect(fixtureTile(page).locator(".library-desc")).toContainText("Film, který existuje jen pro testy.");
});

test("identify binds a library folder to the catalog title", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  await expect(fixtureTile(page)).toBeVisible();
  await page.getByRole("button", { name: `Možnosti: ${folderName}` }).click();
  const identify = page.getByRole("button", { name: "Přiřadit…" });
  const fix = page.getByRole("button", { name: "Opravit přiřazení…" });
  if (await identify.isVisible()) await identify.click();
  else await fix.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Zkušební film/ })).toBeVisible();
  await dialog.getByRole("button", { name: "Použít tento titul" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(fixtureTile(page).locator(".library-desc")).toContainText("Film, který existuje jen pro testy.");
  await expect(fixtureTile(page)).toContainText("2024");
});

test("unmatch clears the description and Identify stays available", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  await page.getByRole("button", { name: `Možnosti: ${folderName}` }).click();
  await page.getByRole("button", { name: "Zrušit přiřazení" }).click();
  await expect(page.getByText("Nepřiřazeno.")).toBeVisible();
  await expect(fixtureTile(page).locator(".library-desc")).toHaveCount(0);
  await page.getByRole("button", { name: `Možnosti: ${folderName}` }).click();
  await expect(page.getByRole("button", { name: "Přiřadit…" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Vyloučit z přiřazování" })).toBeVisible();
});

test("unmatch lets a later scan match again", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  await page.getByRole("button", { name: `Možnosti: ${folderName}` }).click();
  if (await page.getByRole("button", { name: "Zrušit přiřazení" }).isVisible()) {
    await page.getByRole("button", { name: "Zrušit přiřazení" }).click();
  } else {
    await page.keyboard.press("Escape");
  }
  await scanLibrary(page);
  await expect(fixtureTile(page).locator(".library-desc")).toContainText("Film, který existuje jen pro testy.");
});

test("skip catalog lookup keeps the title unmatched through a scan", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  await page.getByRole("button", { name: `Možnosti: ${folderName}` }).click();
  if (await page.getByRole("button", { name: "Zrušit přiřazení" }).isVisible()) {
    await page.getByRole("button", { name: "Zrušit přiřazení" }).click();
    await page.getByRole("button", { name: `Možnosti: ${folderName}` }).click();
  }
  await page.getByRole("button", { name: "Vyloučit z přiřazování" }).click();
  await expect(page.getByText("Vyloučeno z přiřazování.")).toBeVisible();
  await scanLibrary(page);
  await expect(fixtureTile(page).locator(".library-desc")).toHaveCount(0);
  await page.getByRole("button", { name: `Možnosti: ${folderName}` }).click();
  await page.getByRole("button", { name: "Zahrnout do přiřazování" }).click();
  await expect(page.getByText("Zahrnuto do přiřazování.")).toBeVisible();
});

test("each episode of a matched series shows its own plot", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  const seriesTile = page.locator(".browse-item", { hasText: seriesName });
  await expect(seriesTile).toBeVisible();
  await page.getByRole("button", { name: `Možnosti: ${seriesName}` }).click();
  const identify = page.getByRole("button", { name: "Přiřadit…" });
  if (await identify.isVisible()) await identify.click();
  else await page.getByRole("button", { name: "Opravit přiřazení…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /Zkušební seriál/ }).first().click();
  await dialog.getByRole("button", { name: "Použít tento titul" }).click();
  await expect(dialog).toHaveCount(0);

  await seriesTile.getByRole("button", { name: /Otevřít složku/ }).click();
  const first = page.locator(".browse-item", { hasText: "S01E01" });
  const second = page.locator(".browse-item", { hasText: "S01E02" });
  await expect(first.locator(".library-desc")).toContainText("V prvním dílu");
  await expect(second.locator(".library-desc")).toContainText("Ve druhém dílu");
});

test("find metadata on one item matches just that item", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  await expect(fixtureTile(page)).toBeVisible();
  await page.getByRole("button", { name: `Možnosti: ${folderName}` }).click();
  if (await page.getByRole("button", { name: "Zrušit přiřazení" }).isVisible()) {
    await page.getByRole("button", { name: "Zrušit přiřazení" }).click();
    await page.getByRole("button", { name: `Možnosti: ${folderName}` }).click();
  }
  await page.getByRole("button", { name: "Najít metadata" }).click();
  await expect(page.getByText("Hledám metadata…")).toBeVisible();
  await expect(fixtureTile(page).locator(".library-desc")).toContainText("Film, který existuje jen pro testy.", { timeout: 20_000 });
});

// A tile draws the address of the picture it holds when the listing answers, and the browser keeps
// a thumbnail address for a year. An assignment writes its picture a moment after the listing the
// dialog refreshes, so the row has to be asked for again once the write lands -- otherwise the
// tile keeps the name and the picture of the title that was just replaced.
test("an assignment renames the tile and makes it ask for the new picture's address", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  await expect(fixtureTile(page)).toBeVisible();
  const tile = fixtureTile(page);
  const rowPath = async () => (await tile.getAttribute("data-path")) ?? "";
  // What the server tells a listing to draw for this row, which is what the tile then asks for.
  const address = async () => {
    const path = await rowPath();
    const listing = await (await page.request.get("/api/library/browse")).json() as { items: Array<{ path: string; poster?: string }>; pending: boolean };
    return { poster: listing.items.find((item) => item.path === path)?.poster ?? "", pending: listing.pending };
  };

  // From an unbound folder that already has a picture of its own, so the assignment is a real
  // change to both the name and the picture. The clear that unmatching runs is redrawn from the
  // video; the page has to be still before the address this test watches is read.
  await page.getByRole("button", { name: `Možnosti: ${folderName}` }).click();
  if (await page.getByRole("button", { name: "Zrušit přiřazení" }).isVisible()) await page.getByRole("button", { name: "Zrušit přiřazení" }).click();
  else await page.keyboard.press("Escape");
  await expect.poll(async () => { const row = await address(); return row.pending === false && row.poster !== ""; },
    { timeout: 30_000, message: "the folder never settled on a picture to start from" }).toBe(true);
  const path = await rowPath();
  const replaced = (await address()).poster;
  expect(replaced, "the tile starts on the address of the picture it has").not.toBe("");

  // The catalogue answers slowly, so the listing the dialog refreshes cannot already hold the
  // picture the assignment is about to write.
  await page.request.get(new URL("/poster-delay?ms=1500", addonManifest).href);
  const asked = new Set<string>();
  const browses: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/library/browse") browses.push(`${url.searchParams.get("path") ?? ""}`);
    if (url.pathname === "/api/library/thumb" && url.searchParams.get("dir") === path) asked.add(url.href);
  });
  const version = (href: string) => new URL(href, appUrl).searchParams.get("v") ?? "";
  try {
    await page.getByRole("button", { name: `Možnosti: ${folderName}` }).click();
    const identify = page.getByRole("button", { name: "Přiřadit…" });
    if (await identify.isVisible()) await identify.click();
    else await page.getByRole("button", { name: "Opravit přiřazení…" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: /Zkušební film/ }).first().click();
    await dialog.getByRole("button", { name: "Použít tento titul" }).click();
    await expect(dialog).toHaveCount(0);

    await expect(tile.locator("strong")).toHaveText("Zkušební film", { timeout: 20_000 });
    // The row is drawn from a new address once the write lands, and the interface has to ask for
    // it: the address it held names the picture that was just replaced.
    // The row loses its picture the moment the binding changes and gains the catalogue's only when
    // the write lands, so the poll waits for a picture, at a version other than the one it had.
    const mintedAddress = async () => {
      const poster = (await address()).poster;
      return poster && version(poster) !== version(replaced) ? poster : "";
    };
    await expect.poll(mintedAddress, { timeout: 30_000, message: "the assignment never gave the row a new address" }).not.toBe("");
    const minted = await mintedAddress();
    await expect.poll(() => [...asked].some((href) => version(href) === version(minted)), { timeout: 30_000, message: "the tile never asked for the address of the picture that replaced it" }).toBe(true);
  } finally {
    await page.request.get(new URL("/poster-delay?ms=0", addonManifest).href);
  }
});
