import { expect, test } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { goToView } from "./nav";

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

/** The one Continue watching section and Home's row read the same merged list, so hiding a
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
  const listed = async () => (await (await request.get("/api/resume?limit=60")).json())
    .items.some((item: { title: string }) => item.title === title) as boolean;
  const card = () => page.locator(".section-grid .browse-item", { hasText: title });
  try {
    expect(library.showInContinueWatching, "a library stored before the switch existed is in the row").toBe(true);
    expect((await request.post("/api/progress", { data: { key: `file:${relative}`, path: relative, title, position: 120, duration: 2400 } })).ok()).toBe(true);
    expect(await listed()).toBe(true);

    await page.goto("/");
    await goToView(page, "Pokračovat ve sledování");
    await expect(card()).toBeVisible();

    const off = await request.patch(`/api/libraries/${library.id}`, { data: { showInContinueWatching: false } });
    expect(await off.json()).toMatchObject({ id: library.id, showInContinueWatching: false });
    expect((await (await request.get("/api/libraries")).json()).find((entry: { id: string }) => entry.id === library.id))
      .toMatchObject({ showInContinueWatching: false });
    expect(await listed(), "the merged list drops the row").toBe(false);
    expect(await (await request.get(`/api/progress/${encodeURIComponent(`file:${relative}`)}`)).json(), "the position is hidden, not forgotten")
      .toMatchObject({ position: 120, title });

    await page.reload();
    await goToView(page, "Pokračovat ve sledování");
    await expect(card(), "the section drops it too").toHaveCount(0);
    await page.getByRole("button", { name: "Nastavení", exact: true }).click();
    const row = page.locator(".library-manager .library-admin-row", { hasText: library.name });
    await row.getByRole("button", { name: "Upravit knihovnu" }).click();
    const editor = page.getByRole("dialog", { name: "Upravit knihovnu" });
    await expect(editor.getByRole("checkbox", { name: "Zobrazovat v Pokračovat ve sledování" })).not.toBeChecked();
    await editor.getByRole("button", { name: "Zrušit" }).last().click();

    expect(await (await request.patch(`/api/libraries/${library.id}`, { data: { showInContinueWatching: true } })).json())
      .toMatchObject({ showInContinueWatching: true });
    expect(await listed(), "turning it back on brings the stored position with it").toBe(true);
    await page.reload();
    await goToView(page, "Pokračovat ve sledování");
    await expect(card()).toBeVisible();
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
  const tile = (title: string) => page.locator(".section-grid .browse-item", { hasText: title });
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
    await goToView(page, "Pokračovat ve sledování");
  };
  try {
    expect(addon.showInContinueWatching, "an addon stored before the switch existed is in the list").toBe(true);
    await request.post("/api/progress", { data: { key: "movie:tt-e2e-movie", position: 120, duration: 2400, title: "Zkušební film", addonKey: addon.key } });
    await request.post("/api/progress", { data: { key: "movie:tt-e2e-old", position: 90, duration: 2400, title: "Starší záznam" } });

    await openList();
    await expect(tile("Zkušební film")).toBeVisible();
    await expect(tile("Starší záznam")).toBeVisible();

    await setContinueWatching(false);

    await openList();
    await expect(tile("Zkušební film"), "the addon's own titles leave the list").toHaveCount(0);
    await expect(tile("Starší záznam"), "a row with no addon of its own stays").toBeVisible();
    expect(await (await request.get(`/api/progress/${encodeURIComponent("movie:tt-e2e-movie")}`)).json(), "the position is kept")
      .toMatchObject({ position: 120 });

    await setContinueWatching(true);
    await openList();
    await expect(tile("Zkušební film")).toBeVisible();
  } finally {
    await request.delete(`/api/progress/${encodeURIComponent("movie:tt-e2e-movie")}`);
    await request.delete(`/api/progress/${encodeURIComponent("movie:tt-e2e-old")}`);
    await request.patch(`/api/addons/${addon.key}`, { data: { showInContinueWatching: true } });
  }
});

/** The section's own action: the menu forgets every key the merged card stands for, and the
 *  card has to be gone on the next read, not only until the next poll. */
test("a card can be forgotten from the Continue watching section", async ({ page, request }) => {
  const key = "series:tt-e2e-forget:1:2";
  const title = "Zapomenutý seriál";
  await request.post("/api/progress", { data: { key, position: 120, duration: 2400, title, series: { id: "tt-e2e-forget", name: title, season: 1, episode: 2 } } });
  try {
    await page.goto("/");
    await goToView(page, "Pokračovat ve sledování");
    const card = page.locator(".section-grid .browse-item", { hasText: title });
    await expect(card).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept());
    await card.getByRole("button", { name: /Akce pro/ }).click();
    await page.getByRole("button", { name: "Zapomenout postup" }).click();
    await expect(card).toHaveCount(0);
    expect(await (await request.get(`/api/progress/${encodeURIComponent(key)}`)).json()).toBeNull();
  } finally {
    await request.delete(`/api/progress/${encodeURIComponent(key)}`);
  }
});
