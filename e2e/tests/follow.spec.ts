import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

const seriesId = "tt-e2e-series";
const seriesName = "Zkušební seriál";

interface Follow { id: string; metaId: string; episodeCount: number; enabled: boolean }
interface DownloadJob { id: string; follow?: { followId: string; episodeKey: string } }
interface EpisodeRow { key: string; download?: { state: string } }

const listFollows = (request: APIRequestContext) =>
  request.get("/api/follows").then((response) => response.json() as Promise<{ follows: Follow[] }>).then((body) => body.follows ?? []);
const followJobs = (request: APIRequestContext, followId: string) =>
  request.get("/api/downloads").then((response) => response.json() as Promise<{ jobs?: DownloadJob[] }>)
    .then((body) => (body.jobs ?? []).filter((job) => job.follow?.followId === followId));

// One server and one data directory run every spec; a follow left behind would put its
// Library row into the baselines another spec takes, so nothing may outlive a test.
test.afterEach(async ({ request }) => {
  for (const follow of await listFollows(request).catch(() => [])) {
    for (const job of await followJobs(request, follow.id).catch(() => [])) await request.delete(`/api/downloads/${job.id}`);
    await request.delete(`/api/follows/${follow.id}`);
  }
});

const openCatalog = async (page: Page, label: RegExp) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Katalog", exact: true }).click();
  const select = page.getByRole("combobox", { name: "Procházet katalog" });
  const labels = await select.locator("option").allTextContents();
  await select.selectOption({ label: labels.find((text) => label.test(text))! });
};

const openSeries = async (page: Page): Promise<Locator> => {
  await openCatalog(page, /Seriály/);
  await page.getByRole("button", { name: new RegExp(seriesName) }).click();
  return page.locator(".detail-panel");
};

test("following from the detail and pausing it through the chip dialog", async ({ page, request }) => {
  const detail = await openSeries(page);
  await detail.getByRole("button", { name: "Sledovat" }).click();
  // Following asks how first; the default only tells about new episodes and downloads nothing.
  const start = page.getByRole("dialog", { name: "Sledovat seriál" });
  await expect(start.getByRole("radio", { name: /Jen upozorňovat na nové díly/ })).toBeChecked();
  await start.getByRole("button", { name: "Sledovat", exact: true }).click();
  await expect(start).toBeHidden();

  const chip = detail.getByRole("button", { name: "Sledujete" });
  await expect(chip).toBeVisible();
  // The server checks a fresh follow at once, so its episode count settles without a press.
  await expect.poll(async () => (await listFollows(request)).find((follow) => follow.metaId === seriesId)?.episodeCount, { timeout: 15_000 }).toBe(3);

  await chip.click();
  const dialog = page.getByRole("dialog", { name: "Sledování seriálu" });
  await expect(dialog).toBeVisible();

  const pause = dialog.locator("label.follow-pause");
  await pause.click();
  await expect.poll(async () => (await listFollows(request)).find((follow) => follow.metaId === seriesId)?.enabled, { timeout: 15_000 }).toBe(false);
  await pause.click();
  await expect.poll(async () => (await listFollows(request)).find((follow) => follow.metaId === seriesId)?.enabled, { timeout: 15_000 }).toBe(true);

  await dialog.locator("footer.dialog-foot .primary").click();
  await expect(dialog).toHaveCount(0);
});

test("automatic downloads queue each episode once and removing a job skips it", async ({ page, request }) => {
  const created = await request.post("/api/follows", { data: { type: "series", id: seriesId, name: seriesName } });
  expect(created.status()).toBe(201);
  const followId = ((await created.json()) as { id: string }).id;
  // The first check runs on creation; the setup preview needs the episodes on the follow.
  await expect.poll(async () => (await listFollows(request)).find((follow) => follow.id === followId)?.episodeCount, { timeout: 15_000 }).toBe(3);

  const detail = await openSeries(page);
  const chip = detail.getByRole("button", { name: "Sledujete" });
  await expect(chip).toBeVisible();
  await chip.click();

  const dialog = page.getByRole("dialog", { name: "Sledování seriálu" });
  await dialog.getByRole("button", { name: "Automaticky stahovat nové díly…" }).click();
  const setup = page.getByRole("dialog", { name: "Automatické stahování nových dílů" });
  await expect(setup).toBeVisible();

  await setup.getByRole("radio", { name: "Od vybraného dílu" }).check();
  await setup.getByLabel("Série").selectOption("1");
  await setup.getByLabel("Epizody").selectOption("1");
  const preview = setup.locator("section.bulk-section", { hasText: "Odkud začít" }).locator('p[aria-live="polite"]');
  await expect(preview).toContainText("3");
  await setup.getByRole("button", { name: "Zapnout" }).click();
  await expect(setup).toHaveCount(0);
  await dialog.locator("footer.dialog-foot .primary").click();

  await expect.poll(async () => (await followJobs(request, followId)).length, { timeout: 15_000 }).toBe(3);
  expect(new Set((await followJobs(request, followId)).map((job) => job.follow!.episodeKey)).size).toBe(3);

  // A manual check inside the cooldown may answer 429; either way it must not add a job.
  const checked = await request.post(`/api/follows/${followId}/check`);
  expect([200, 429]).toContain(checked.status());
  await expect.poll(async () => (await followJobs(request, followId)).length, { timeout: 15_000 }).toBe(3);

  await page.getByRole("button", { name: "Stahování", exact: true }).click();
  const row = page.locator(".download-row", { hasText: seriesName }).first();
  await expect(row.locator(".follow-job-pill")).toHaveText("Automaticky");

  for (const job of await followJobs(request, followId)) await request.delete(`/api/downloads/${job.id}`);
  // Removing a running or queued automatic job skips the episode; removing one that had
  // already failed only tidies the queue and leaves it waiting. Either way it is not re-queued now.
  await expect.poll(async () => request.get(`/api/follows/${followId}/episodes`)
    .then((response) => response.json() as Promise<{ episodes: EpisodeRow[] }>)
    .then((body) => body.episodes.filter((episode) => episode.download?.state === "skipped" || episode.download?.state === "waiting").length), { timeout: 15_000 }).toBe(3);
  await request.delete(`/api/follows/${followId}`);
});

// The suite has no reusable helper that signs a second account in: `signIn` in
// accounts.spec.ts is module-local and the account there is made through the Users dialog,
// so isolation stays covered by the follow route tests on the server.
test.skip("another account cannot see a follow", () => {});
