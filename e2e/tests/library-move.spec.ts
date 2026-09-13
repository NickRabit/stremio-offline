import { expect, test } from "@playwright/test";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const sample = path.resolve("e2e/fixtures/media/sample.mp4");
const sourceName = "Přesun zdroj";
const targetName = "Přesun cíl";
const downloads = path.resolve("e2e/.tmp/downloads");
const clip = "Přesouvaný klip.mkv";
// Its own folder, so the scan binds it to the fixture title and the file inside inherits that.
const matchedName = "Zkušební film (2024) přesun";
// A second library, granted from a directory of its own, far from the download directory.
const otherRoot = path.resolve("e2e/.tmp/move-library");
const crossName = "Přesun mezi knihovnami";
const crossClip = "Přesouvaný klip mezi knihovnami.mkv";
// The list shows the name without its extension, which is also what the row menu is labelled with.
const crossLabel = "Přesouvaný klip mezi knihovnami";

test.beforeAll(async () => {
  await mkdir(path.join(downloads, matchedName), { recursive: true });
  await copyFile(sample, path.join(downloads, matchedName, "Dědičný klip.mkv"));
  await mkdir(path.join(downloads, sourceName), { recursive: true });
  await copyFile(sample, path.join(downloads, sourceName, clip));
  // Empty on purpose: browsing hides a folder with no video, the move dialog offers it.
  await mkdir(path.join(downloads, targetName), { recursive: true });
  await mkdir(path.join(downloads, crossName), { recursive: true });
  await copyFile(sample, path.join(downloads, crossName, crossClip));
  await mkdir(otherRoot, { recursive: true });
});

test.afterAll(async () => {
  for (const name of [sourceName, targetName, matchedName, crossName]) {
    await rm(path.join(downloads, name), { recursive: true, force: true });
  }
  await rm(otherRoot, { recursive: true, force: true });
});

const assertFileExists = async (file: string) => {
  const info = await stat(file).catch(() => undefined);
  expect(info?.isFile(), `${file} should be on disk`).toBe(true);
};

const moveInto = async (page: import("@playwright/test").Page, label: RegExp, destination: string) => {
  await page.getByRole("button", { name: label }).click();
  await page.getByRole("button", { name: "Přesunout", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator(".move-crumbs button", { hasText: "Knihovna" }).click();
  if (destination) await dialog.locator(".move-list button", { hasText: destination }).click();
  await dialog.getByRole("button", { name: "Přesunout sem" }).click();
  await expect(dialog).toHaveCount(0);
};

test("a moved file takes the listing into its new folder and empties the old one", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  await page.locator(".browse-item", { hasText: sourceName }).getByRole("button", { name: /Otevřít složku/ }).click();
  await expect(page.locator(".browse-item", { hasText: "Přesouvaný klip" })).toBeVisible();

  await page.getByRole("button", { name: /^Možnosti: Přesouvaný klip/ }).click();
  await page.getByRole("button", { name: "Přesunout", exact: true }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // It opens in the folder the file sits in, which is no destination at all.
  await expect(dialog.getByRole("button", { name: "Přesunout sem" })).toBeDisabled();
  await dialog.locator(".move-crumbs button", { hasText: "Knihovna" }).click();
  await dialog.locator(".move-list button", { hasText: targetName }).click();
  await dialog.getByRole("button", { name: "Přesunout sem" }).click();

  await expect(dialog).toHaveCount(0);
  // The listing follows the file: the destination folder is open and the file is marked in it.
  await expect(page.locator(".crumbs button", { hasText: targetName })).toBeVisible();
  await expect(page.locator(".browse-item.focused", { hasText: "Přesouvaný klip" })).toBeVisible();

  await page.locator(".crumbs button", { hasText: "Knihovna" }).click();
  await expect(page.locator(".browse-item", { hasText: targetName })).toBeVisible();
  await expect(page.locator(".browse-item", { hasText: sourceName })).toHaveCount(0);
});

test("a moved file keeps its own title instead of inheriting the destination's", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  const matched = page.locator(".browse-item", { hasText: matchedName });
  await expect(matched).toBeVisible();

  // Bind the source folder to the fixture title; the file inside inherits that binding.
  await page.getByRole("button", { name: `Možnosti: ${matchedName}` }).click();
  await page.getByRole("button", { name: /^(Přiřadit…|Opravit přiřazení…)$/ }).click();
  const identify = page.getByRole("dialog");
  // The folder name carries a suffix the catalogue does not know, so the title is typed out --
  // after the dialog has loaded its own parse, which would otherwise overwrite the field.
  const title = identify.getByLabel("Název");
  await expect(title).toHaveValue(/přesun/);
  await title.fill("Zkušební film");
  // The fixture catalogue matches on the name alone, so the year must not ride along.
  await identify.getByLabel("Rok").fill("");
  await identify.getByRole("button", { name: "Hledat" }).click();
  await identify.getByRole("button", { name: /Zkušební film/ }).click();
  await identify.getByRole("button", { name: "Použít tento titul" }).click();
  await expect(identify).toHaveCount(0);
  await expect(matched.locator(".library-desc")).toContainText("Film, který existuje jen pro testy.");

  await matched.getByRole("button", { name: /Otevřít složku/ }).click();
  const file = page.locator(".browse-item", { hasText: "Dědičný klip" });
  await expect(file.locator(".library-desc")).toContainText("Film, který existuje jen pro testy.");

  await moveInto(page, /^Možnosti: Dědičný klip/, targetName);

  // In its new folder the file still carries the title it had, not the folder's.
  const moved = page.locator(".browse-item", { hasText: "Dědičný klip" });
  await expect(moved.locator(".library-desc")).toContainText("Film, který existuje jen pro testy.");
});

test("a file crosses into another library, and a typed library refuses the wrong kind", async ({ page }) => {
  const request = page.request;
  // Idempotent on purpose: a retry after a failed attempt meets its own leftovers.
  for (const entry of await (await request.get("/api/libraries")).json() as { id: string; root?: string }[]) {
    if (entry.root === otherRoot) await request.delete(`/api/libraries/${entry.id}?forget=1`);
  }
  const granted = await (await request.get("/api/libraries/grants")).json() as { path: string }[];
  if (granted.some((grant) => grant.path === otherRoot)) {
    await request.delete(`/api/libraries/grants?path=${encodeURIComponent(otherRoot)}`);
  }
  expect((await request.post("/api/libraries/grants", { data: { path: otherRoot } })).status()).toBe(201);
  const created = await request.post("/api/libraries", { data: { name: "Druhá", type: "series", root: otherRoot } });
  expect(created.status()).toBe(201);
  const library = await created.json();

  await page.goto("/");
  // Two libraries are configured, so the root lists them instead of opening the tree.
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  await page.locator(".browse-item.library").filter({ hasText: "downloads" }).getByRole("button").first().click();
  const folder = page.locator(".browse-item", { hasText: crossName });
  await folder.getByRole("button", { name: /Otevřít složku/ }).click();

  await page.getByRole("button", { name: `Možnosti: ${crossLabel}` }).click();
  await page.getByRole("button", { name: "Přesunout", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // The other library is offered by name, and opening it walks its own tree.
  const chip = dialog.locator(".move-libraries button", { hasText: "Druhá" });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(dialog.locator(".move-crumbs button", { hasText: "Druhá" })).toBeVisible();

  // The type gate is the backstop behind the dialog: a series library takes no film.
  await dialog.getByRole("button", { name: "Přesunout sem" }).click();
  await expect(dialog).toContainText("Tato knihovna nebere tento druh titulku.");
  await expect(dialog).toBeVisible();

  const retyped = await request.patch(`/api/libraries/${library.id}`, { data: { type: "mixed" } });
  expect(retyped.status()).toBe(200);

  await dialog.getByRole("button", { name: "Přesunout sem" }).click();
  await expect(dialog).toHaveCount(0);
  // The listing follows the item across: the destination library is open and the file is in it.
  await expect(page.locator(".crumbs button", { hasText: "Druhá" })).toBeVisible();
  await expect(page.locator(".browse-item", { hasText: crossLabel })).toBeVisible();
  // On disk the item left its folder, and the folder it emptied went with it. The metadata
  // of the move is asserted through the interface above; this is where the bytes are.
  await assertFileExists(path.join(otherRoot, crossClip));
  await expect.poll(() => stat(path.join(downloads, crossName)).then(() => true, () => false)).toBe(false);

  // Cleanup through the API the test just used, so the run leaves one library behind.
  expect((await request.delete(`/api/libraries/${library.id}?forget=1`)).status()).toBe(204);
  expect((await request.delete(`/api/libraries/grants?path=${encodeURIComponent(otherRoot)}`)).status()).toBe(200);
  const final = await (await request.get("/api/libraries")).json();
  expect(final).toHaveLength(1);
});
