import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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

/** Waits for whichever of these paths appears first, and hands it back. */
const waitForFile = async (candidates: string[], timeout = 20_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const file of candidates) if (await stat(file).then(() => true, () => false)) return file;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`None of ${candidates.join(", ")} appeared.`);
};

// A film in a folder of its own, bound through that folder, whose picture therefore lives with
// the folder. Move the file into a folder of unrelated videos that has a picture of its own:
// the film must not come back wearing it, and the picture it had must travel with it.
const ownFolder = "Vlastní obrázek zdroj";
const ownClip = "Vlastní obrázek klip.mkv";
const sharedFolder = "Sdílená složka cíl";
const sharedPicture = Buffer.from("this is the shared folder's picture, not the film's");

test("a film moved into a shared folder keeps its own picture", async ({ request }) => {
  // The download directory outlives a run, so a fixture left behind by an earlier failure (or by
  // this test's own second attempt) has to go first: the move refuses a name that is taken.
  await rm(path.join(downloads, ownFolder), { recursive: true, force: true });
  await rm(path.join(downloads, sharedFolder), { recursive: true, force: true });
  await mkdir(path.join(downloads, ownFolder), { recursive: true });
  await copyFile(sample, path.join(downloads, ownFolder, ownClip));
  await mkdir(path.join(downloads, sharedFolder), { recursive: true });
  await copyFile(sample, path.join(downloads, sharedFolder, "Jiný klip.mkv"));
  await writeFile(path.join(downloads, sharedFolder, "poster.jpg"), sharedPicture);

  // Bind the folder, the way the scan or Identify does: the film is the title of that folder.
  const bound = await request.post("/api/library/match", { data: { path: ownFolder, type: "movie", id: "tt-e2e-movie" } });
  expect(bound.status()).toBe(200);
  // The catalogue poster of a folder-bound title lands in the data directory, under the
  // folder's key (this install writes nothing into the media tree; that is the global default).
  const [library] = await (await request.get("/api/libraries")).json();
  const artworkDir = path.join(path.resolve("e2e/.tmp/data/artwork"), library.id);
  // Whichever layout this install chose: beside the folder, or hashed in the data directory.
  const ownPicture = await waitForFile([
    path.join(downloads, ownFolder, "poster.jpg"),
    path.join(artworkDir, `${createHash("sha1").update(`dir:${ownFolder}`).digest("hex")}.jpg`),
  ]);
  // Read before the move: the folder it belonged to is emptied and its copy of the picture is
  // cleaned up with it, which is what makes carrying the picture the only way it survives.
  const pictureBeforeTheMove = await readFile(ownPicture);

  const moved = await request.post("/api/library/move", { data: { path: `${ownFolder}/${ownClip}`, folder: sharedFolder } });
  expect(moved.status(), await moved.text()).toBe(200);

  // The picture the film had came with it, into the data directory under its new key.
  const key = `${sharedFolder}/${ownClip}`;
  const carried = path.join(artworkDir, `${createHash("sha1").update(key).digest("hex")}.jpg`);
  await waitForFile([carried]);
  expect(await readFile(carried)).toEqual(pictureBeforeTheMove);
  expect(await readFile(carried)).not.toEqual(sharedPicture);

  // And the browse view agrees that the film has a picture of its own.
  const listing = await (await request.get(`/api/library/browse?path=${encodeURIComponent(sharedFolder)}`)).json();
  const film = listing.items.find((item: { label?: string; name?: string }) => (item.label ?? item.name)?.startsWith("Vlastní obrázek klip"));
  expect(film.poster, "the film is not left blank").toBeTruthy();

  await rm(path.join(downloads, sharedFolder), { recursive: true, force: true });
});

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
  // One item and many take the same road now, so the refusal comes back from the queue as a
  // failed job rather than from the request that used to wait for the copy.
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Operace knihovny dokončena: 1 z 1 položek selhalo.")).toBeVisible();
  expect(await stat(path.join(otherRoot, crossClip)).catch(() => undefined), "nothing crossed").toBeUndefined();
  expect((await stat(path.join(downloads, crossName, crossClip))).isFile(), "and nothing left").toBe(true);

  const retyped = await request.patch(`/api/libraries/${library.id}`, { data: { type: "mixed" } });
  expect(retyped.status()).toBe(200);

  // Retyped, the same move is offered again, and this time it goes through.
  await page.getByRole("button", { name: `Možnosti: ${crossLabel}` }).click();
  await page.getByRole("button", { name: "Přesunout", exact: true }).click();
  const again = page.getByRole("dialog");
  await expect(again).toBeVisible();
  await again.locator(".move-libraries button", { hasText: "Druhá" }).click();
  await again.getByRole("button", { name: "Přesunout sem" }).click();
  await expect(again).toHaveCount(0);
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

// The data-loss shape: a library's artwork directory is made on its first thumbnail, so moving a
// title into a library that never had one used to fail with ENOENT, leave the picture in the
// source under a stale key and let the orphan sweep take it an hour later.
test("a picture crosses into another library with its title, and comes back", async ({ request }) => {
  const clipName = "Obrázek mezi knihovnami.mkv";
  const root = path.resolve("e2e/.tmp/picture-library");
  await rm(path.join(downloads, clipName), { force: true });
  await rm(root, { recursive: true, force: true });
  await copyFile(sample, path.join(downloads, clipName));
  await mkdir(root, { recursive: true });

  const [source] = await (await request.get("/api/libraries")).json();
  expect((await request.post("/api/libraries/grants", { data: { path: root } })).status()).toBe(201);
  const destination = await (await request.post("/api/libraries", { data: { name: "Obrázky", type: "movie", root } })).json();
  const artwork = (libraryId: string, key: string) =>
    path.join(path.resolve("e2e/.tmp/data/artwork"), libraryId, `${createHash("sha1").update(key).digest("hex")}.jpg`);

  try {
    // Bind the file itself to the fixture title, so it has a picture of its own under its key.
    // Qualified, because a second library is configured by now and an unqualified path names none.
    expect((await request.post("/api/library/match", { data: { path: `${source.id}/${clipName}`, type: "movie", id: "tt-e2e-movie" } })).status()).toBe(200);
    await waitForFile([artwork(source.id, clipName)]);
    // Its directory for generated thumbnails exists from the moment the library does, which is
    // what used to be missing when a picture had to cross into it.
    await expect.poll(() => stat(path.join(path.resolve("e2e/.tmp/data/artwork"), destination.id)).then(() => true, () => false)).toBe(true);

    const there = await request.post("/api/library/move", { data: { path: `${source.id}/${clipName}`, folder: destination.id } });
    expect(there.status(), await there.text()).toBe(200);
    await waitForFile([artwork(destination.id, clipName)]);
    expect(await stat(artwork(source.id, clipName)).catch(() => undefined), "the picture did not stay behind").toBeUndefined();

    const back = await request.post("/api/library/move", { data: { path: `${destination.id}/${clipName}`, folder: source.id } });
    expect(back.status(), await back.text()).toBe(200);
    await waitForFile([artwork(source.id, clipName)]);
    expect(await stat(artwork(destination.id, clipName)).catch(() => undefined), "and came back with it").toBeUndefined();
  } finally {
    await request.delete(`/api/libraries/${destination.id}?forget=1`);
    await request.delete(`/api/libraries/grants?path=${encodeURIComponent(root)}`);
    await rm(root, { recursive: true, force: true });
    await rm(path.join(downloads, clipName), { force: true });
  }
});

// The endpoint used to accept `copy: true` and move anyway -- the original deleted, a success in
// the response. It honours the field now, and a copy carries the picture to both halves.
test("the move route copies when it is asked to", async ({ request }) => {
  const clipName = "Kopírovaný klip.mkv";
  const folder = "Kopírování cíl";
  await rm(path.join(downloads, folder), { recursive: true, force: true });
  await rm(path.join(downloads, clipName), { force: true });
  await mkdir(path.join(downloads, folder), { recursive: true });
  await copyFile(sample, path.join(downloads, clipName));

  const [library] = await (await request.get("/api/libraries")).json();
  try {
    expect((await request.post("/api/library/match", { data: { path: `${library.id}/${clipName}`, type: "movie", id: "tt-e2e-movie" } })).status()).toBe(200);
    const artwork = path.join(path.resolve("e2e/.tmp/data/artwork"), library.id, `${createHash("sha1").update(clipName).digest("hex")}.jpg`);
    await waitForFile([artwork]);

    const copied = await request.post("/api/library/move", { data: { path: `${library.id}/${clipName}`, folder: `${library.id}/${folder}`, copy: true } });
    expect(copied.status(), await copied.text()).toBe(200);
    // Both files are there: the one that was copied and the one it was copied from.
    await assertFileExists(path.join(downloads, clipName));
    await assertFileExists(path.join(downloads, folder, clipName));
    await waitForFile([path.join(path.resolve("e2e/.tmp/data/artwork"), library.id, `${createHash("sha1").update(`${folder}/${clipName}`).digest("hex")}.jpg`)]);
    expect((await stat(artwork)).size, "the original keeps its picture too").toBeGreaterThan(0);
  } finally {
    await rm(path.join(downloads, folder), { recursive: true, force: true });
    await rm(path.join(downloads, clipName), { force: true });
  }
});
