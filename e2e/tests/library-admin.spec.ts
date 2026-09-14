import { expect, test } from "@playwright/test";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

// Its own root, outside the download directory: the walk of the download library must not
// see it, and the layout baselines are taken against the tree the journeys leave behind.
const grantedRoot = path.resolve("e2e/.tmp/granted-root");
const outsideRoot = path.resolve("e2e/.tmp/not-granted-root");

test.beforeAll(async () => {
  await mkdir(path.join(grantedRoot, "Zkušební film"), { recursive: true });
  await writeFile(path.join(grantedRoot, "Zkušební film", "Zkušební film.mkv"), "not a real video");
  await mkdir(outsideRoot, { recursive: true });
});

test.afterAll(async () => {
  await rm(grantedRoot, { recursive: true, force: true });
  await rm(outsideRoot, { recursive: true, force: true });
});

test("a granted root is added, previewed and revoked without losing what it remembers", async ({ page }) => {
  const request = page.request;

  const refused = await request.post("/api/libraries", { data: { name: "Outside", type: "movie", root: outsideRoot } });
  expect(refused.status(), "a root nobody granted is refused").toBe(403);
  expect(await refused.json()).toMatchObject({ messageKey: "err.libraryRootNotGranted" });

  const granted = await request.post("/api/libraries/grants", { data: { path: grantedRoot } });
  expect(granted.status()).toBe(201);
  expect(await granted.json()).toEqual(expect.arrayContaining([expect.objectContaining({ path: grantedRoot, source: "user" })]));

  // The picker lists the grants with an empty path and their children below one.
  const roots = await (await request.get("/api/libraries/browse")).json();
  expect(roots.entries).toEqual(expect.arrayContaining([expect.objectContaining({ path: grantedRoot })]));
  const children = await (await request.get(`/api/libraries/browse?path=${encodeURIComponent(grantedRoot)}`)).json();
  expect(children.entries).toEqual([expect.objectContaining({ name: "Zkušební film" })]);
  expect(children.entries[0].libraryId, "a folder no library owns carries no flag").toBeUndefined();

  const preview = await request.post("/api/libraries/preview", { data: { root: grantedRoot, type: "movie" } });
  expect(await preview.json()).toMatchObject({ titles: 1, files: 1, truncated: false });

  const created = await request.post("/api/libraries", { data: { name: "Granted", type: "movie", root: grantedRoot } });
  expect(created.status()).toBe(201);
  const library = await created.json();
  expect(library).toMatchObject({ name: "Granted", type: "movie", readOnly: false, unreachable: false });

  const listed = await (await request.get("/api/libraries")).json();
  expect(listed.map((entry: { id: string }) => entry.id)).toContain(library.id);

  // The browse root lists the libraries while more than one is configured, and the
  // breadcrumb names the library instead of its id once one is opened.
  const root = await (await request.get("/api/library/browse")).json();
  const rows = root.items.filter((item: { kind: string }) => item.kind === "library");
  expect(rows.map((row: { libraryId: string }) => row.libraryId)).toEqual(expect.arrayContaining([library.id]));
  expect(rows.find((row: { libraryId: string }) => row.libraryId === library.id)).toMatchObject({
    name: "Granted", type: "movie", enabled: true, fileCount: 1, unreachable: false,
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  const libraryRows = page.locator(".browse-item.library");
  await expect(libraryRows).toHaveCount(2);
  await libraryRows.filter({ hasText: "downloads" }).getByRole("button").first().click();
  await expect(page.locator(".crumbs button", { hasText: "downloads" })).toBeVisible();

  // The library tools open the same manager the settings section renders. On a wide
  // viewport these actions are inline; the toggle that hides them is the mobile layout.
  await page.getByRole("button", { name: "Knihovny", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Knihovny" });
  await expect(dialog.locator(".library-admin-row")).toHaveCount(2);

  // The picker walks the granted roots and reports what the scan would cost before
  // anything is created.
  await dialog.getByRole("button", { name: "Přidat knihovnu" }).click();
  const picker = page.getByRole("dialog", { name: "Vyberte složku" });
  await picker.locator(".move-list button", { hasText: "granted-root" }).click();
  await picker.getByRole("button", { name: "Použít tuto složku" }).click();
  await expect(picker).toContainText("Nalezeno 1 titulů, 1 souborů.");
  await picker.getByRole("button", { name: "Zrušit" }).click();
  await expect(picker).toHaveCount(0);
  await dialog.getByRole("button", { name: "Zrušit" }).click();
  await expect(dialog).toHaveCount(0);

  // A folder that is not on disk yet is named in the picker and created by the request that
  // adds the library -- the only way in for an owner whose app runs in a container.
  const added = path.join(grantedRoot, "Nové filmy");
  expect(await stat(added).catch(() => undefined), "nothing is created before the library is").toBeUndefined();
  await page.getByRole("button", { name: "Knihovny", exact: true }).click();
  const tools = page.getByRole("dialog", { name: "Knihovny" });
  await tools.getByRole("button", { name: "Přidat knihovnu" }).click();
  const creator = page.getByRole("dialog", { name: "Vyberte složku" });
  await creator.locator(".move-list button", { hasText: "granted-root" }).click();
  const newFolder = creator.locator('input[aria-label="Nová složka"]');
  await newFolder.click();
  await newFolder.fill("Nové filmy");
  await creator.getByRole("button", { name: "Nová složka" }).click();
  await expect(creator).toContainText("Složka ještě neexistuje.");
  await expect(creator.locator('input[aria-label="Název"]')).toHaveValue("Nové filmy");
  await creator.getByRole("button", { name: "Přidat knihovnu" }).click();
  await expect(creator).toHaveCount(0);
  expect((await stat(added)).isDirectory(), "the grant makes the folder creatable").toBe(true);

  const withFolder = await (await request.get("/api/libraries")).json();
  const made = withFolder.find((entry: { root: string }) => entry.root === added);
  expect(made).toMatchObject({ name: "Nové filmy", type: "mixed" });
  await request.delete(`/api/libraries/${made.id}?forget=1`);
  await rm(added, { recursive: true, force: true });
  await tools.getByRole("button", { name: "Zrušit" }).click();
  await expect(tools).toHaveCount(0);

  // A rename goes through the prompt and the row follows.
  await page.getByRole("button", { name: "Nastavení", exact: true }).click();
  const manager = page.locator(".library-manager");
  await expect(manager.locator(".library-admin-row")).toHaveCount(2);
  page.once("dialog", (prompt) => void prompt.accept("Přejmenovaná"));
  await manager.locator(".library-admin-row", { hasText: "Granted" }).getByRole("button", { name: "Přejmenovat" }).click();
  await expect(manager.locator(".library-admin-row", { hasText: "Přejmenovaná" })).toBeVisible();
  await expect(manager.locator(".library-admin-row", { hasText: "Přejmenovaná" })).toContainText("Filmy");

  // Revoking disables the library under it; the media, the metadata file and the artwork
  // directory stay, so granting the root again brings it back.
  const revoked = await request.delete(`/api/libraries/grants?path=${encodeURIComponent(grantedRoot)}`);
  expect(revoked.status(), "the grants route must not be read as a library id").toBe(200);
  const afterRevoke = await (await request.get("/api/libraries")).json();
  expect(afterRevoke.find((entry: { id: string }) => entry.id === library.id)).toMatchObject({ enabled: false });

  // A disabled library is refused at every path, and the picker no longer offers a root.
  const browse = await request.get(`/api/library/browse?path=${library.id}`);
  expect(browse.status()).toBe(400);
  const remaining = await (await request.get("/api/libraries/browse")).json();
  expect(remaining.entries.map((entry: { path: string }) => entry.path)).not.toContain(grantedRoot);

  // A disabled library is still part of the setup: its row stays and says so instead of
  // disappearing, and it cannot be opened.
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  const disabledRow = page.locator(".browse-item.library").filter({ hasText: "Přejmenovaná" });
  await expect(disabledRow).toContainText("Vypnutá");
  await expect(disabledRow.getByRole("button").first()).toBeDisabled();

  // Cleanup through the API the test just used, so the run leaves one library behind.
  const removed = await request.delete(`/api/libraries/${library.id}?forget=1`);
  expect(removed.status()).toBe(204);
  const final = await (await request.get("/api/libraries")).json();
  expect(final).toHaveLength(1);

  // Back to one library, the browse root passes through to it and the list is gone.
  const passedThrough = await (await request.get("/api/library/browse")).json();
  expect(passedThrough.items.some((item: { kind: string }) => item.kind === "library")).toBe(false);
});

// The dialog says a plain Remove keeps the metadata "for a later re-add". This is what makes
// that true: the folder takes its identity back, so everything keyed to it is live again.
test("a folder added again is the same library, not a new one", async ({ request }) => {
  const root = path.join(grantedRoot, "Remembered");
  const remembered = "Zapamatovaný film";
  await mkdir(path.join(root, remembered), { recursive: true });
  await writeFile(path.join(root, remembered, `${remembered}.mkv`), "not a real video");
  // Its own grant: the first journey revokes the one it made, and a library may only be
  // added inside a granted root.
  expect((await request.post("/api/libraries/grants", { data: { path: grantedRoot } })).status()).toBe(201);

  const first = await (await request.post("/api/libraries", { data: { name: "Remembers", type: "mixed", root } })).json();
  const favorite = await request.post("/api/library/favorite", { data: { path: `${first.id}/${remembered}`, favorite: true } });
  expect(favorite.status()).toBe(200);

  const removed = await request.delete(`/api/libraries/${first.id}`);
  expect(removed.status()).toBe(204);
  expect((await request.delete(`/api/libraries/${first.id}?forget=1`)).status(), "removing it again changes nothing").toBe(404);

  const again = await (await request.post("/api/libraries", { data: { name: "Remembers again", type: "mixed", root } })).json();
  expect(again.id, "the folder keeps the identity it had").toBe(first.id);
  const favorites = await (await request.get("/api/library/favorites")).json();
  expect(favorites.items.map((item: { path: string }) => item.path), "so what was starred is still starred").toContain(`${first.id}/${remembered}`);

  // Forget drops the note as well: a third add is a new library with a new id.
  await request.delete(`/api/libraries/${first.id}?forget=1`);
  const third = await (await request.post("/api/libraries", { data: { name: "Remembers once more", type: "mixed", root } })).json();
  expect(third.id).not.toBe(first.id);
  await request.delete(`/api/libraries/${third.id}?forget=1`);
  await request.delete(`/api/libraries/grants?path=${encodeURIComponent(grantedRoot)}`);
  await rm(root, { recursive: true, force: true });
});
