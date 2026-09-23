import { expect, test } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

test("resume collection includes every existing local file and supports paging and filters", async ({ request }) => {
  const directory = path.resolve("e2e/.tmp/downloads/resume-test");
  await mkdir(directory, { recursive: true });
  try {
    for (let index = 0; index < 45; index++) {
      const relative = `resume-test/episode-${index}.mp4`;
      await writeFile(path.join(directory, `episode-${index}.mp4`), "fixture");
      expect((await request.post("/api/progress", { data: { key: `file:${relative}`, path: relative, title: `Resume episode ${index}`, position: 120, duration: 2400 } })).ok()).toBe(true);
    }
    await request.post("/api/progress", { data: { key: "file:resume-test/missing.mp4", path: "resume-test/missing.mp4", title: "Missing", position: 120, duration: 2400 } });
    const first = await (await request.get("/api/library/resume?limit=20")).json();
    expect(first.total).toBe(45);
    expect(first.items).toHaveLength(20);
    expect(first.items[0].progress.position).toBe(120);
    const last = await (await request.get("/api/library/resume?skip=40&limit=20")).json();
    expect(last.items).toHaveLength(5);
    expect(last.items.some((item: { path: string }) => first.items.some((other: { path: string }) => other.path === item.path))).toBe(false);
    const filtered = await (await request.get("/api/library/resume?query=episode%2044")).json();
    expect(filtered.total).toBe(1);
    await request.post("/api/library/favorite", { data: { path: "resume-test/episode-44.mp4", favorite: true } });
    const favorites = await (await request.get("/api/library/resume?favorites=1")).json();
    expect(favorites.total).toBe(1);
    expect(favorites.items[0].favorite).toBe(true);
  } finally {
    await request.post("/api/library/favorite", { data: { path: "resume-test/episode-44.mp4", favorite: false } });
    for (let index = 0; index < 45; index++) await request.delete(`/api/progress/${encodeURIComponent(`file:resume-test/episode-${index}.mp4`)}`);
    await request.delete(`/api/progress/${encodeURIComponent("file:resume-test/missing.mp4")}`);
    await rm(directory, { recursive: true, force: true });
  }
});

/** The homepage strip and the full :resume list both read this one endpoint, so hiding a
 *  library has to empty both while the stored position stays where the player left it. */
test("a library kept out of Continue watching hides its rows and keeps their positions", async ({ page, request }) => {
  const downloads = path.resolve("e2e/.tmp/downloads");
  const directory = path.join(downloads, "resume-hidden");
  const relative = "resume-hidden/hidden-film.mp4";
  const title = "Hidden film";
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "hidden-film.mp4"), "fixture");
  const [library] = (await (await request.get("/api/libraries")).json())
    .filter((entry: { root: string }) => entry.root === downloads);
  const listed = async () => (await (await request.get(`/api/library/resume?query=${encodeURIComponent(title.toLowerCase())}`)).json()).total as number;
  const strip = () => page.locator(".resume-strip .browse-item", { hasText: title });
  try {
    expect(library.showInContinueWatching, "a library stored before the switch existed is in the row").toBe(true);
    expect((await request.post("/api/progress", { data: { key: `file:${relative}`, path: relative, title, position: 120, duration: 2400 } })).ok()).toBe(true);
    expect(await listed()).toBe(1);

    await page.goto("/");
    await page.getByRole("button", { name: "Knihovna", exact: true }).click();
    await expect(strip()).toBeVisible();

    const off = await request.patch(`/api/libraries/${library.id}`, { data: { showInContinueWatching: false } });
    expect(await off.json()).toMatchObject({ id: library.id, showInContinueWatching: false });
    expect((await (await request.get("/api/libraries")).json()).find((entry: { id: string }) => entry.id === library.id))
      .toMatchObject({ showInContinueWatching: false });
    expect(await listed(), "the full list drops the row").toBe(0);
    expect(await (await request.get(`/api/progress/${encodeURIComponent(`file:${relative}`)}`)).json(), "the position is hidden, not forgotten")
      .toMatchObject({ position: 120, title });

    await page.reload();
    await page.getByRole("button", { name: "Knihovna", exact: true }).click();
    await expect(strip(), "the homepage strip drops it too").toHaveCount(0);
    await page.getByRole("button", { name: "Nastavení", exact: true }).click();
    const row = page.locator(".library-manager .library-admin-row", { hasText: library.name });
    await row.getByRole("button", { name: "Upravit knihovnu" }).click();
    const editor = page.getByRole("dialog", { name: "Upravit knihovnu" });
    await expect(editor.getByRole("checkbox", { name: "Zobrazovat v Pokračovat ve sledování" })).not.toBeChecked();
    await editor.getByRole("button", { name: "Zrušit" }).last().click();

    expect(await (await request.patch(`/api/libraries/${library.id}`, { data: { showInContinueWatching: true } })).json())
      .toMatchObject({ showInContinueWatching: true });
    expect(await listed(), "turning it back on brings the stored position with it").toBe(1);
    await page.reload();
    await page.getByRole("button", { name: "Knihovna", exact: true }).click();
    await expect(strip()).toBeVisible();
  } finally {
    await request.delete(`/api/progress/${encodeURIComponent(`file:${relative}`)}`);
    await request.patch(`/api/libraries/${library.id}`, { data: { showInContinueWatching: true } });
    await rm(directory, { recursive: true, force: true });
  }
});

/** A catalogue row now carries the addon it was started on. A row stored before that field
 *  existed has nothing to be hidden by, so it stays until it is played again. */
test("an addon kept out of Continue watching hides its titles and keeps their positions", async ({ page, request }) => {
  const [addon] = (await (await request.get("/api/addons")).json())
    .filter((entry: { manifest: { id: string } }) => entry.manifest.id === "com.linvo.cinemeta");
  const card = () => page.locator(".addon-card", { has: page.getByRole("heading", { name: "E2E doplněk" }) });
  const tile = (key: string) => page.locator(`.poster-card[data-catalog-key="${key}"]`);
  const dialog = () => page.getByRole("dialog", { name: "Upravit doplněk" });
  const toggle = () => dialog().getByRole("checkbox", { name: "Zobrazovat v Pokračovat ve sledování" });
  const stored = async () => (await (await request.get("/api/addons")).json())
    .find((entry: { key: string }) => entry.key === addon.key).showInContinueWatching as boolean;
  // The switch is staged in the addon dialog, so flipping it is two steps: set and save.
  const setContinueWatching = async (on: boolean) => {
    await page.getByRole("button", { name: "Doplňky", exact: true }).click();
    await card().getByRole("button", { name: "Upravit doplněk" }).click();
    await expect(toggle()).toBeVisible();
    await expect(toggle()).toBeChecked({ checked: !on });
    await toggle().click();
    await dialog().getByRole("button", { name: "Uložit změny" }).click();
    await expect(dialog()).toBeHidden();
    await expect.poll(stored).toBe(on);
  };
  const openList = async () => {
    await page.goto("/");
    await page.getByRole("button", { name: "Katalog", exact: true }).click();
    const select = page.getByRole("combobox", { name: "Procházet katalog" });
    const labels = await select.locator("option").allTextContents();
    await select.selectOption({ label: labels.find((text) => text.includes("Pokračovat ve sledování"))! });
  };
  try {
    expect(addon.showInContinueWatching, "an addon stored before the switch existed is in the list").toBe(true);
    await request.post("/api/progress", { data: { key: "movie:tt-e2e-movie", position: 120, duration: 2400, title: "Zkušební film", addonKey: addon.key } });
    await request.post("/api/progress", { data: { key: "movie:tt-e2e-old", position: 90, duration: 2400, title: "Starší záznam" } });

    await openList();
    await expect(tile("movie:tt-e2e-movie")).toBeVisible();
    await expect(tile("movie:tt-e2e-old")).toBeVisible();

    await setContinueWatching(false);

    await openList();
    await expect(tile("movie:tt-e2e-movie"), "the addon's own titles leave the list").toHaveCount(0);
    await expect(tile("movie:tt-e2e-old"), "a row with no addon of its own stays").toBeVisible();
    expect(await (await request.get(`/api/progress/${encodeURIComponent("movie:tt-e2e-movie")}`)).json(), "the position is kept")
      .toMatchObject({ position: 120 });

    await setContinueWatching(true);
    await openList();
    await expect(tile("movie:tt-e2e-movie")).toBeVisible();
  } finally {
    await request.delete(`/api/progress/${encodeURIComponent("movie:tt-e2e-movie")}`);
    await request.delete(`/api/progress/${encodeURIComponent("movie:tt-e2e-old")}`);
    await request.patch(`/api/addons/${addon.key}`, { data: { showInContinueWatching: true } });
  }
});
