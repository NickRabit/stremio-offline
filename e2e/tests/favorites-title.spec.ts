import { expect, test, type Page } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { goToView } from "./nav";

/** One star per title: a library folder bound to a catalogue film and the film's own catalogue star
 *  are one favourite, whichever side it was starred from. */
test("a bound library folder and its catalogue film are one favourite", async ({ page, request }) => {
  const downloads = path.resolve("e2e/.tmp/downloads");
  const directory = path.join(downloads, "favorite-title");
  const relative = "favorite-title";
  const key = "movie:tt-e2e-movie";
  const title = "Zkušební film";
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "film.mp4"), "fixture");
  // The library's own rows, read back by the same door the listing uses: the folder's star.
  const [library] = ((await (await request.get("/api/libraries")).json()) as Array<{ id: string; root: string }>)
    .filter((entry) => entry.root === downloads);
  const rows = async () => ((await (await request.get(`/api/library/browse?path=${encodeURIComponent(library.id)}`)).json()) as
    { items: Array<{ path: string; favorite: boolean }> }).items;
  const folderRow = (items: Array<{ path: string; favorite: boolean }>) =>
    items.find((item) => item.path === relative || item.path.endsWith(`/${relative}`));
  const tile = () => page.locator(".favorites-grid .browse-item", { hasText: title });
  try {
    expect((await request.post("/api/library/match", { data: { path: relative, type: "movie", id: "tt-e2e-movie" } })).ok()).toBe(true);
    expect((await request.post("/api/library/favorite", { data: { path: relative, favorite: true } })).ok()).toBe(true);

    // The folder's own star wrote the title's: one star, not two.
    expect(((await (await request.get("/api/watchlist")).json()) as Array<{ key: string }>).map((entry) => entry.key)).toContain(key);
    expect(folderRow(await rows())?.favorite).toBe(true);

    await page.goto("/");
    await goToView(page, "Oblíbené");
    await expect(page.locator(".favorites-grid .browse-item")).toHaveCount(1);
    await expect(tile()).toBeVisible();
    // A favourite bound to a title opens the one catalogue detail, never the folder behind it.
    await tile().click();
    await expect(page.locator("main.view-title-detail")).toBeVisible();

    // Unstarring the title from the catalogue takes the folder's own star with it.
    expect((await request.post("/api/watchlist", { data: { type: "movie", id: "tt-e2e-movie", favorite: false } })).ok()).toBe(true);
    expect(folderRow(await rows())?.favorite).toBe(false);
  } finally {
    await request.post("/api/library/favorite", { data: { path: relative, favorite: false } });
    await request.post("/api/watchlist", { data: { type: "movie", id: "tt-e2e-movie", favorite: false } });
    await request.post("/api/library/match", { data: { path: relative, id: "", type: "movie" } });
    await rm(directory, { recursive: true, force: true });
  }
});
