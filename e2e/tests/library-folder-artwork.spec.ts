import { expect, test } from "@playwright/test";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";

// The fixture video is two seconds long, which is the whole point of this journey. A probe
// that cannot read the file learns no duration, and the frame grab falls back to the fixed
// five-minute position -- which a two-second video does not have, so no thumbnail is made
// at all. A probe that can read it asks for a frame one second in and gets one. The
// difference between the two is the only thing this test looks at.
const grantedRoot = path.resolve("e2e/.tmp/folder-artwork-root");
const sample = path.resolve("e2e/fixtures/media/sample.mp4");
const folder = "Krátký film";

let libraryId = "";

test.beforeAll(async () => {
  await mkdir(path.join(grantedRoot, folder), { recursive: true });
  await copyFile(sample, path.join(grantedRoot, folder, `${folder}.mp4`));
});

test.afterAll(async ({ playwright }) => {
  // The layout baselines are taken against the tree the journeys leave behind, so this
  // one puts the setup back exactly as it found it.
  const request = await playwright.request.newContext({ baseURL: process.env.APP_URL ?? "http://127.0.0.1:8099", storageState: "e2e/.tmp/session.json" });
  if (libraryId) await request.delete(`/api/libraries/${libraryId}?forget=1`);
  await request.delete(`/api/libraries/grants?path=${encodeURIComponent(grantedRoot)}`);
  await request.dispose();
  await rm(grantedRoot, { recursive: true, force: true });
});

test("a folder thumbnail is taken from a video the probe could actually read", async ({ page }) => {
  const request = page.request;

  expect((await request.post("/api/libraries/grants", { data: { path: grantedRoot } })).status()).toBe(201);
  const created = await request.post("/api/libraries", { data: { name: "Krátké filmy", type: "movie", root: grantedRoot } });
  expect(created.status(), await created.text()).toBe(201);
  libraryId = (await created.json()).id;

  // The defect only bites once a path can no longer say which library it means, so the
  // journey is worthless unless a second library is really configured.
  const libraries = await (await request.get("/api/libraries")).json() as Array<{ id: string }>;
  expect(libraries.length, "the download library and this one").toBeGreaterThan(1);

  // Browsing the library root is what schedules the folder's thumbnail.
  await expect.poll(async () => {
    const listing = await (await request.get(`/api/library/browse?path=${encodeURIComponent(libraryId)}`)).json();
    const item = listing.items.find((entry: { name?: string; label?: string }) => (entry.label ?? entry.name) === folder);
    expect(item, "the folder is listed").toBeTruthy();
    return item.poster ?? null;
  }, { timeout: 30_000, message: "the folder never got a thumbnail" }).toBeTruthy();
});
