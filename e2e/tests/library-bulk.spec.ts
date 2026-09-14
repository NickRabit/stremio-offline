import { expect, test } from "@playwright/test";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const sample = path.resolve("e2e/fixtures/media/sample.mp4");
const downloads = path.resolve("e2e/.tmp/downloads");
const source = "Hromadný přesun zdroj";
const target = "Hromadný přesun cíl";
const created = "Hromadně vytvořená složka";
const files = ["Hromadný klip 1.mkv", "Hromadný klip 2.mkv", "Hromadný klip 3.mkv"];

test.beforeAll(async () => {
  await mkdir(path.join(downloads, source), { recursive: true });
  await mkdir(path.join(downloads, target), { recursive: true });
  for (const file of files) await copyFile(sample, path.join(downloads, source, file));
});

test.afterAll(async () => {
  await rm(path.join(downloads, source), { recursive: true, force: true });
  await rm(path.join(downloads, target), { recursive: true, force: true });
  await rm(path.join(downloads, created), { recursive: true, force: true });
});

test("library tools create a folder and the API enforces the bulk cap", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept(created));
  await page.getByRole("button", { name: "Vytvořit složku" }).click();
  await expect(page.getByText("Složka vytvořena.")).toBeVisible();
  await expect.poll(() => stat(path.join(downloads, created)).then((info) => info.isDirectory(), () => false)).toBe(true);

  const tooMany = await page.request.post("/api/library/ops", { data: { op: "delete", items: Array.from({ length: 501 }, (_, index) => `missing-${index}`) } });
  expect(tooMany.status()).toBe(400);
  expect(await tooMany.json()).toMatchObject({ messageKey: "err.tooManyItems" });
});

test("bulk move continues after one selected item disappears", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  await page.locator(".browse-item", { hasText: source }).getByRole("button", { name: /Otevřít složku/ }).click();
  await page.getByRole("button", { name: "Vybrat položky" }).click();

  for (const [index] of files.entries()) {
    await page.getByRole("button", { name: `Vybrat Hromadný klip ${index + 1}` }).click();
  }
  await expect(page.getByText("Vybráno: 3")).toBeVisible();
  await page.locator(".library-bulk-bar").getByRole("button", { name: "Přesunout" }).click();

  const dialog = page.getByRole("dialog");
  await dialog.locator(".move-crumbs button", { hasText: "Knihovna" }).click();
  await dialog.locator(".move-list button", { hasText: target }).click();
  await rm(path.join(downloads, source, files[1]!), { force: true });
  const queued = page.waitForResponse((response) => response.url().endsWith("/api/library/ops") && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "Přesunout sem" }).click();
  const id = String((await (await queued).json()).id);

  await expect.poll(async () => {
    const snapshot = await (await page.request.get("/api/library/ops")).json() as { jobs: Array<{ id: string; status: string; done: number; failed: number }> };
    return snapshot.jobs.find((job) => job.id === id);
  }).toMatchObject({ status: "completed", done: 2, failed: 1 });
  await expect.poll(() => Promise.all([files[0]!, files[2]!].map((file) => stat(path.join(downloads, target, file)).then(() => true, () => false)))).toEqual([true, true]);
});
