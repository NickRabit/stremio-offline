import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { cleanupJourney, profileByNameKey, resetFixture, type Job } from "./source-selection-journey";

const SERIES_ID = "tt-e2e-series";
const SERIES_NAME = "Zkušební seriál";
const SMALLER_LABEL = /^Menší soubory/;
const BALANCED_LABEL = /^Vyvážené/;
const MY_LANGUAGE_LABEL = /^Jen můj jazyk/;

interface Follow {
  id: string;
  metaId: string;
  episodeCount: number;
  autoDownload?: { sourceProfile?: { profileId: string; revision: number } };
}

interface QueueJob extends Job {
  media?: { id?: string; season?: number; episode?: number };
}

interface QueueResponse {
  jobs?: QueueJob[];
}

const listFollows = async (request: APIRequestContext): Promise<Follow[]> =>
  (await (await request.get("/api/follows")).json() as { follows?: Follow[] }).follows ?? [];

const openCatalog = async (page: Page, label: RegExp) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Katalog", exact: true }).click();
  const select = page.getByRole("combobox", { name: "Procházet katalog" });
  const labels = await select.locator("option").allTextContents();
  await select.selectOption({ label: labels.find((text) => label.test(text))! });
};

const openSeries = async (page: Page): Promise<Locator> => {
  await openCatalog(page, /Seriály/);
  await page.getByRole("button", { name: new RegExp(SERIES_NAME) }).click();
  return page.locator(".detail-panel");
};

const queue = async (request: APIRequestContext): Promise<QueueJob[]> => {
  const response = await request.get("/api/downloads");
  expect(response.status()).toBe(200);
  return (await response.json() as QueueResponse).jobs ?? [];
};

test.afterEach(async ({ request }) => {
  for (const follow of await listFollows(request).catch(() => [])) {
    if (follow.metaId === SERIES_ID) await request.delete(`/api/follows/${follow.id}`);
  }
  await cleanupJourney(request, SERIES_NAME);
});

test("bulk download queues season one with the Smaller preset", async ({ page, request }) => {
  expect((await resetFixture(request)).ok()).toBe(true);
  const smaller = await profileByNameKey(request, "rules.preset.smaller");

  const detail = await openSeries(page);
  await detail.getByTitle("Stáhnout celou 1. sérii").click();
  const dialog = page.getByRole("dialog", { name: "Stažení seriálu" });
  await expect(dialog).toBeVisible();

  await dialog.getByRole("radio", { name: SMALLER_LABEL }).check();
  await expect(dialog.locator("fieldset.bulk-sources")).toHaveCount(0);
  await expect(dialog.getByRole("heading", { name: "Výběr zdroje", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("heading", { name: "Zvuk", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("heading", { name: "Titulky", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("heading", { name: "Kam uložit", exact: true })).toBeVisible();

  const requestPromise = page.waitForRequest((candidate) =>
    candidate.method() === "POST" && new URL(candidate.url()).pathname === "/api/downloads/bulk");
  const responsePromise = page.waitForResponse((candidate) =>
    candidate.request().method() === "POST" && new URL(candidate.url()).pathname === "/api/downloads/bulk");
  await dialog.getByRole("button", { name: "Přidat do fronty" }).click();
  const [submitted, response] = await Promise.all([requestPromise, responsePromise]);

  expect((submitted.postDataJSON() as { selection: unknown }).selection)
    .toEqual({ profile: { profileId: smaller.id, revision: smaller.revision } });
  expect(response.status()).toBe(201);

  await expect.poll(async () => (await queue(request))
    .filter((job) => job.media?.id === SERIES_ID && job.media.season === 1)
    .map((job) => job.media?.episode)
    .sort((left, right) => (left ?? 0) - (right ?? 0)), {
    message: "the bulk request did not queue one job for each season-one episode",
  }).toEqual([1, 2]);

  const seasonOneJobs = (await queue(request))
    .filter((job) => job.media?.id === SERIES_ID && job.media.season === 1);
  const serialized = JSON.stringify(seasonOneJobs);
  for (const privateField of ["sourceAdmission", "sourceStreamAddonIdentity", "rulesCursor"]) {
    expect(serialized).not.toContain(privateField);
  }
});

test("follow setup starts with the my-language preset and saves another preset", async ({ page, request }) => {
  const balanced = await profileByNameKey(request, "rules.preset.balanced");
  const myLanguage = await profileByNameKey(request, "rules.preset.myLanguage");
  const created = await request.post("/api/follows", {
    data: { type: "series", id: SERIES_ID, name: SERIES_NAME },
  });
  expect(created.status()).toBe(201);
  const followId = (await created.json() as Follow).id;
  await expect.poll(async () => (await listFollows(request)).find((follow) => follow.id === followId)?.episodeCount, {
    timeout: 15_000,
  }).toBe(3);

  const detail = await openSeries(page);
  await detail.getByRole("button", { name: "Sledujete" }).click();
  const followDialog = page.getByRole("dialog", { name: "Sledování seriálu" });
  await followDialog.getByRole("button", { name: "Automaticky stahovat nové díly…" }).click();
  const setup = page.getByRole("dialog", { name: "Automatické stahování nových dílů" });
  await expect(setup).toBeVisible();

  await setup.getByRole("radio", { name: "Od vybraného dílu" }).check();
  await setup.getByLabel("Série").selectOption("1");
  await setup.getByLabel("Epizody").selectOption("1");
  await expect(setup.getByRole("radio", { name: MY_LANGUAGE_LABEL })).toBeChecked();
  await setup.getByRole("radio", { name: BALANCED_LABEL }).check();
  const grace = setup.getByRole("combobox", { name: "Čekat na zvukovou stopu v mém jazyce" });
  await expect(grace).toBeVisible();
  await grace.selectOption("7");

  const patchPath = `/api/follows/${followId}`;
  const patchRequestPromise = page.waitForRequest((candidate) =>
    candidate.method() === "PATCH" && new URL(candidate.url()).pathname === patchPath);
  const patchResponsePromise = page.waitForResponse((candidate) =>
    candidate.request().method() === "PATCH" && new URL(candidate.url()).pathname === patchPath);
  await setup.getByRole("button", { name: "Zapnout" }).click();
  const [patched, patchResponse] = await Promise.all([patchRequestPromise, patchResponsePromise]);
  const patchBody = patched.postDataJSON() as {
    autoDownload: { selection: unknown; graceDays: unknown };
  };
  expect(patchBody.autoDownload.selection)
    .toEqual({ profile: { profileId: balanced.id, revision: balanced.revision } });
  expect(patchBody.autoDownload.graceDays).toBe(7);
  expect(patchResponse.status()).toBe(200);

  const enabledFollow = (await listFollows(request)).find((follow) => follow.id === followId);
  expect(enabledFollow?.autoDownload?.sourceProfile)
    .toEqual({ profileId: balanced.id, revision: balanced.revision });
  const episodes = await request.get(`/api/follows/${followId}/episodes`);
  expect(episodes.status()).toBe(200);
  expect(JSON.stringify(await episodes.json())).not.toContain("sourceAdmission");

  await expect(setup).toHaveCount(0);
  await followDialog.getByRole("button", { name: "Změnit nastavení…" }).click();
  await expect(setup.getByRole("radio", { name: BALANCED_LABEL })).toBeChecked();

  const saveRequestPromise = page.waitForRequest((candidate) =>
    candidate.method() === "PATCH" && new URL(candidate.url()).pathname === patchPath);
  const saveResponsePromise = page.waitForResponse((candidate) =>
    candidate.request().method() === "PATCH" && new URL(candidate.url()).pathname === patchPath);
  await setup.getByRole("radio", { name: MY_LANGUAGE_LABEL }).check();
  await expect(grace).toBeHidden();
  await setup.getByRole("button", { name: "Zapnout" }).click();
  const [saved, savedResponse] = await Promise.all([saveRequestPromise, saveResponsePromise]);
  expect(savedResponse.status()).toBe(200);
  expect((saved.postDataJSON() as { autoDownload: { selection: unknown } }).autoDownload.selection)
    .toEqual({ profile: { profileId: myLanguage.id, revision: myLanguage.revision } });

  await expect.poll(async () => (await listFollows(request)).find((follow) => follow.id === followId)
    ?.autoDownload?.sourceProfile).toEqual({ profileId: myLanguage.id, revision: myLanguage.revision });
});
