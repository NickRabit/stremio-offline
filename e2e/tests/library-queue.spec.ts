import { expect, test, type Page } from "@playwright/test";
import { libraryTool } from "./library-tools";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const sample = path.resolve("e2e/fixtures/media/sample.mp4");
const downloads = path.resolve("e2e/.tmp/downloads");
const source = "Fronta zdroj";
const target = "Fronta cíl";
const clip = "Zařazený klip.mkv";
const kept = "Zařazený ponechaný klip.mkv";
const doomed = "Zařazený smazaný klip.mkv";
// The catalogue title is "Zkušební film": a folder named after its first word still scores a
// hit, but too little of one to bind on its own, so the scan leaves it as a suggestion.
const proposed = "Zkušební";
const bound = "Zkušební film 2024";

// Per test, not per file: a retry has to meet the same media it met the first time, and the
// move and the delete below each take one of these away for good.
test.beforeEach(async () => {
  for (const folder of [source, target, proposed, bound]) {
    await rm(path.join(downloads, folder), { recursive: true, force: true });
    await mkdir(path.join(downloads, folder), { recursive: true });
  }
  await copyFile(sample, path.join(downloads, source, clip));
  await copyFile(sample, path.join(downloads, source, kept));
  await copyFile(sample, path.join(downloads, source, doomed));
  await copyFile(sample, path.join(downloads, proposed, "Návrhový klip.mkv"));
  await copyFile(sample, path.join(downloads, bound, "Zkušební film.mkv"));
});

test.afterAll(async () => {
  for (const folder of [source, target, proposed, bound]) {
    await rm(path.join(downloads, folder), { recursive: true, force: true });
  }
});

/** The tile whose three-dot menu is labelled with exactly this name. */
const row = (page: Page, name: string) =>
  page.locator(".browse-item").filter({ has: page.getByRole("button", { name: `Možnosti: ${name}`, exact: true }) });

const exists = (file: string) => stat(file).then(() => true, () => false);

/** Every request the page makes to a library route, so a test can say which road was taken. */
const watchLibraryRoutes = (page: Page) => {
  const calls: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/api/library/")) calls.push(`${request.method()} ${pathname}`);
  });
  return calls;
};

test("moving one item queues the job instead of holding the request", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  const calls = watchLibraryRoutes(page);
  const folder = row(page, source);
  await folder.getByRole("button", { name: /Otevřít složku/ }).click();

  await page.getByRole("button", { name: `Možnosti: ${path.parse(clip).name}`, exact: true }).click();
  await page.getByRole("button", { name: "Přesunout", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator(".move-crumbs button", { hasText: "Knihovna" }).click();
  await dialog.locator(".move-list button", { hasText: target }).click();

  const queued = page.waitForResponse((response) => response.url().endsWith("/api/library/ops") && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "Přesunout sem" }).click();
  expect((await queued).status()).toBe(202);

  // The dialog is out of the way before the bytes are, and the singular wording arrives when
  // the job does: the item, not "an operation", was moved.
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Přesunuto.")).toBeVisible();
  await expect.poll(() => exists(path.join(downloads, target, clip))).toBe(true);
  expect(calls.filter((call) => call.endsWith("/api/library/move")), "the request that used to copy inside the answer").toEqual([]);
  // The listing followed the file into its new folder.
  await expect(page.locator(".crumbs button", { hasText: target })).toBeVisible();
  await expect(page.locator(".browse-item.focused", { hasText: path.parse(clip).name })).toBeVisible();
});

test("deleting one file goes through the queue too", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  const calls = watchLibraryRoutes(page);
  await row(page, source).getByRole("button", { name: /Otevřít složku/ }).click();

  await page.getByRole("button", { name: `Možnosti: ${path.parse(doomed).name}`, exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  const queued = page.waitForResponse((response) => response.url().endsWith("/api/library/ops") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Smazat", exact: true }).click();
  expect((await queued).status()).toBe(202);

  await expect(page.getByText("Smazáno.")).toBeVisible();
  await expect.poll(() => exists(path.join(downloads, source, doomed))).toBe(false);
  expect(calls.filter((call) => call.includes("/api/library/item")), "the synchronous delete route").toEqual([]);
  // The file next to it was not deleted, and is still listed.
  await expect(row(page, path.parse(kept).name)).toBeVisible();
});

test("the awaiting-confirmation filter lists only what the scan has not bound", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  await expect(row(page, proposed)).toBeVisible();
  (await libraryTool(page, "Prohledat knihovnu")).click();
  await expect(page.getByText(/spárováno,/)).toBeVisible({ timeout: 30_000 });

  // One folder the catalogue matched on its own, one it only proposed.
  await expect(row(page, bound).locator(".library-desc")).toContainText("Film, který existuje jen pro testy.");
  const filter = page.getByRole("button", { name: "Jen čekající na potvrzení" });
  await expect(filter).toBeVisible();

  await filter.click();
  await expect(filter).toHaveAttribute("aria-pressed", "true");
  await expect(row(page, proposed)).toBeVisible();
  await expect(page.getByRole("button", { name: `Možnosti: ${bound}`, exact: true }), "a bound title is not waiting for anything").toHaveCount(0);

  await filter.click();
  await expect(page.getByRole("button", { name: `Možnosti: ${bound}`, exact: true })).toBeVisible();
});
