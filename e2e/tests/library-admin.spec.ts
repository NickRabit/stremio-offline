import { expect, test } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
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

  // Cleanup through the API the test just used, so the run leaves one library behind.
  const removed = await request.delete(`/api/libraries/${library.id}?forget=1`);
  expect(removed.status()).toBe(204);
  const final = await (await request.get("/api/libraries")).json();
  expect(final).toHaveLength(1);
});
