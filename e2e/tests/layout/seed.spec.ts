import { expect, test } from "@playwright/test";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * The state every layout baseline is taken against.
 *
 * A layout job used to replay the whole chromium suite -- 79 page launches, a couple of minutes
 * per viewport -- only to end up with the fixture titles in the download library. This builds the
 * same state through the API instead: the files the screens show, bound to the catalogue titles
 * they belong to, so a baseline is still taken against a state that is the same every run.
 */
const sample = path.resolve("e2e/fixtures/media/sample.mp4");
const downloads = path.resolve("e2e/.tmp/downloads");
const titles = [
  { folder: "Zkušební film (2024)", files: ["Zkušební film.mkv"], id: "tt-e2e-movie", type: "movie" },
  { folder: "Zkušební seriál", files: ["Zkušební seriál S01E01.mkv", "Zkušební seriál S01E02.mkv"], id: "tt-e2e-series", type: "series" },
];

test("the screens are taken against the fixture titles", async ({ page, request }) => {
  // The journeys queue a real download before the library holds anything by that name, and the
  // library keeps it beside the fixture file afterwards: the order is part of the state, since
  // the interface offers a download only for a title it does not have yet.
  await page.goto("/");
  await page.getByRole("button", { name: "Katalog", exact: true }).click();
  const catalog = page.getByRole("combobox", { name: "Procházet katalog" });
  const movies = await catalog.locator("option").filter({ hasText: "Filmy" }).first().getAttribute("value");
  await catalog.selectOption(movies!);
  await page.getByRole("button", { name: /Zkušební film/ }).click();
  const detail = page.locator(".detail-panel");
  await detail.locator(".stream-list button").first().click();
  await detail.getByRole("button", { name: "Do knihovny" }).click();
  await expect(page.getByText("Přidáno do fronty.")).toBeVisible();
  const landed = async () => (await readdir(path.join(downloads, titles[0]!.folder)).catch(() => [])).length;
  await expect.poll(landed, { timeout: 60_000, message: "the queued download never landed in the library" }).toBe(1);

  for (const title of titles) {
    await mkdir(path.join(downloads, title.folder), { recursive: true });
    for (const file of title.files) await copyFile(sample, path.join(downloads, title.folder, file));
  }

  const listing = async () => {
    const page = await (await request.get("/api/library/browse")).json() as { items: Array<{ path: string; name?: string }> };
    return page.items;
  };
  await expect.poll(async () => (await listing()).length, { timeout: 60_000, message: "the walk never saw the fixture folders" }).toBe(titles.length);

  for (const title of titles) {
    const matched = await request.post("/api/library/match", { data: { path: title.folder, id: title.id, type: title.type } });
    expect(matched.status(), await matched.text()).toBe(200);
  }

  // The tile draws the catalogue's own picture and name once the binding has landed, and the
  // artwork is written on the way; the screenshots wait for the row to carry a description.
  await expect.poll(async () => (await listing()).map((item) => item.name).join(" "), { timeout: 60_000 })
    .toContain("Zkušební film");
  await expect.poll(landed, { timeout: 60_000, message: "the fixture file never joined the download" }).toBe(2);
});
