import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  cleanupJourney,
  E2E_LIBRARY,
  profileByNameKey,
  resetFixture,
  type Job,
  type Profile,
} from "./source-selection-journey";

const SERIES_ID = "tt-e2e-series";
const SERIES_NAME = "Zkušební seriál";
const RULES_NAME = "E2E jen 480";
const VIDEO_ID = "tt-e2e-travel-episode";
const SOURCE_SECRET = "travel-signed-source-canary";
const SMALLER_TITLE = "SRCSEL rules smaller";
const BEST_TITLE = "SRCSEL rules best";

interface AdminProfile extends Profile {
  parameters: unknown;
}

interface Follow {
  id: string;
  metaId: string;
  episodeCount: number;
  autoDownload?: { sourceProfile?: { profileId: string; revision: number } };
}

interface RulesJob extends Job {
  errorKey?: string;
  media?: { id?: string; season?: number; episode?: number };
}

const reference = (profile: Profile) => ({ profileId: profile.id, revision: profile.revision });

const queue = async (request: APIRequestContext): Promise<RulesJob[]> =>
  (await (await request.get("/api/downloads")).json() as { jobs?: RulesJob[] }).jobs ?? [];

const findJob = async (request: APIRequestContext, title: string) =>
  (await queue(request)).find((job) => job.title.startsWith(title));

const queueEpisode = async (request: APIRequestContext, profile: Profile, title: string) => {
  const response = await request.post("/api/downloads/bulk", {
    data: {
      title,
      type: "series",
      media: { id: "tt-e2e-rules", metaType: "series" },
      episodes: [{ id: VIDEO_ID, season: 1, episode: 1, title: "Rules journey" }],
      selection: { profile: reference(profile) },
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  expect(await response.json()).toEqual({ added: 1, skipped: 0 });
};

const openSeries = async (page: Page): Promise<Locator> => {
  await page.goto("/");
  await page.getByRole("button", { name: "Katalog", exact: true }).click();
  const select = page.getByRole("combobox", { name: "Procházet katalog" });
  const labels = await select.locator("option").allTextContents();
  await select.selectOption({ label: labels.find((text) => /Seriály/.test(text))! });
  await page.getByRole("button", { name: new RegExp(SERIES_NAME) }).click();
  return page.locator(".detail-panel");
};

const listFollows = async (request: APIRequestContext): Promise<Follow[]> =>
  (await (await request.get("/api/follows")).json() as { follows?: Follow[] }).follows ?? [];

const cleanupRules = async (request: APIRequestContext) => {
  const profiles = await request.get("/api/admin/source-profiles")
    .then((response) => response.json() as Promise<{ profiles: AdminProfile[] }>)
    .catch(() => ({ profiles: [] }));
  for (const profile of profiles.profiles.filter((item) => item.name === RULES_NAME)) {
    expect((await request.delete(`/api/admin/source-profiles/${profile.id}?revision=${profile.revision}`)).status()).toBe(204);
  }
};

test.afterEach(async ({ request }) => {
  await cleanupRules(request);
  for (const follow of await listFollows(request).catch(() => [])) {
    if (follow.metaId === SERIES_ID) expect((await request.delete(`/api/follows/${follow.id}`)).status()).toBe(204);
  }
  await cleanupJourney(request, SMALLER_TITLE);
  await cleanupJourney(request, BEST_TITLE);
  await cleanupJourney(request, SERIES_NAME);
});

test("the Smaller preset completes the 480p fixture download without exposing queue internals", async ({ request }) => {
  expect((await resetFixture(request)).ok()).toBe(true);
  const smaller = await profileByNameKey(request, "rules.preset.smaller");
  await queueEpisode(request, smaller, SMALLER_TITLE);

  const privateQueueData = new Set<string>();
  let job: RulesJob | undefined;
  await expect.poll(async () => {
    const response = await request.get("/api/downloads");
    expect(response.status(), await response.text()).toBe(200);
    const snapshot = await response.json() as { jobs: RulesJob[] };
    const serialized = JSON.stringify(snapshot);
    for (const value of ["sourceAdmission", "rulesCursor", "sourceStreamAddonIdentity", SOURCE_SECRET]) {
      if (serialized.includes(value)) privateQueueData.add(value);
    }
    job = snapshot.jobs.find((item) => item.title.startsWith(SMALLER_TITLE));
    return job?.status === "completed" || job?.status === "failed" ? job.status : job?.status;
  }, {
    timeout: 60_000,
    message: "the Smaller preset download did not settle",
  }).toBe("completed");

  expect(job?.pending).toBe(false);
  expect([...privateQueueData]).toEqual([]);
  const target = path.resolve(E2E_LIBRARY, job!.target);
  expect(path.relative(E2E_LIBRARY, target).split(path.sep)).not.toContain("..");
  await expect.poll(() => stat(target).then((info) => info.isFile() && info.size > 0, () => false), {
    message: "the completed rules download is not a nonempty library file",
  }).toBe(true);
});

test("the Best quality preset rejects the 480p fixture with a reason key", async ({ request }) => {
  expect((await resetFixture(request)).ok()).toBe(true);
  const best = await profileByNameKey(request, "rules.preset.best");
  await queueEpisode(request, best, BEST_TITLE);

  await expect.poll(async () => {
    const job = await findJob(request, BEST_TITLE);
    return job?.status === "failed" || job?.status === "waiting" ? job.status : job?.status;
  }, {
    timeout: 60_000,
    message: "the Best quality download did not settle without a matching file",
  }).toMatch(/^(failed|waiting)$/);

  const job = await findJob(request, BEST_TITLE);
  expect(job?.status).not.toBe("completed");
  expect(job?.errorKey).toMatch(/^err\./);
});

test("an administrator creates, lists and deletes a download rule", async ({ page, request }) => {
  await cleanupRules(request);
  await page.goto("/");
  await page.getByRole("button", { name: "Nastavení", exact: true }).click();
  await page.getByRole("tab", { name: "Stahování", exact: true }).click();

  const section = page.locator(".source-profiles-section");
  await expect(section.getByText("Pravidla stahování", { exact: true })).toBeVisible();
  await section.getByRole("button", { name: "Přidat pravidla" }).click();
  const editor = page.getByRole("dialog", { name: "Nová pravidla stahování" });
  for (const legend of ["Zdroje", "Kvalita a velikost", "Jazyk", "Čemu dát přednost"]) {
    await expect(editor.getByText(legend, { exact: true })).toBeVisible();
  }
  await editor.getByRole("textbox", { name: "Název" }).fill(RULES_NAME);
  await editor.getByRole("combobox", { name: "Rozlišení od" }).selectOption("480");
  await editor.getByRole("combobox", { name: "Rozlišení do" }).selectOption("480");
  await editor.getByRole("combobox", { name: "Jazyk zvuku" }).selectOption("en");
  await editor.getByRole("combobox", { name: "Záložní jazyk" }).selectOption("cs");
  await editor.getByRole("spinbutton", { name: "Díl od" }).fill("1.2");
  await editor.getByRole("spinbutton", { name: "Díl do" }).fill("4");
  await editor.getByRole("spinbutton", { name: "Film od" }).fill("5");
  await editor.getByRole("spinbutton", { name: "Film do" }).fill("15");
  await editor.getByRole("button", { name: "Uložit" }).click();
  await expect(editor).toHaveCount(0);

  const row = page.locator(".source-profile-row", { hasText: RULES_NAME });
  await expect(row).toBeVisible();
  await expect(row).toContainText("480p · přednost: angličtina · ~1,2–4 GB na díl");
  await row.getByRole("button", { name: "Smazat", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Smazat pravidla stahování" });
  await expect(confirmation).toContainText(RULES_NAME);
  await confirmation.getByRole("button", { name: "Smazat", exact: true }).click();
  await expect(row).toHaveCount(0);
});

test("the series dialog posts the Smaller preset without legacy source controls", async ({ page, request }) => {
  const smaller = await profileByNameKey(request, "rules.preset.smaller");
  const detail = await openSeries(page);
  await detail.getByTitle("Stáhnout celou 1. sérii").click();
  const dialog = page.getByRole("dialog", { name: "Stažení seriálu" });
  await expect(dialog).toBeVisible();

  for (const name of ["Výběr zdroje", "Zvuk", "Titulky"]) {
    await expect(dialog.getByRole("heading", { name, exact: true })).toHaveCount(0);
  }
  await expect(dialog.locator("fieldset.bulk-sources")).toHaveCount(0);
  await expect(dialog.getByRole("radio", { name: /Největší vyhovující soubor|Nejdřív preferovaný doplněk/ })).toHaveCount(0);
  for (const preset of ["Vyvážené", "Nejlepší kvalita", "Menší soubory", "Jen můj jazyk"]) {
    await expect(dialog.getByRole("radio", { name: new RegExp(`^${preset}`) })).toBeVisible();
  }

  await dialog.getByRole("radio", { name: /^Menší soubory/ }).check();
  const requestPromise = page.waitForRequest((candidate) =>
    candidate.method() === "POST" && new URL(candidate.url()).pathname === "/api/downloads/bulk");
  const responsePromise = page.waitForResponse((candidate) =>
    candidate.request().method() === "POST" && new URL(candidate.url()).pathname === "/api/downloads/bulk");
  await dialog.getByRole("button", { name: "Přidat do fronty" }).click();
  const [submitted, response] = await Promise.all([requestPromise, responsePromise]);

  expect(submitted.postDataJSON()).toMatchObject({ selection: { profile: reference(smaller) } });
  expect(response.status()).toBe(201);
});

test("follow setup waits for audio with Balanced and hides the wait for my language only", async ({ page, request }) => {
  const balanced = await profileByNameKey(request, "rules.preset.balanced");
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

  const grace = setup.getByRole("combobox", { name: "Čekat na zvukovou stopu v mém jazyce" });
  await setup.getByRole("radio", { name: /^Vyvážené/ }).check();
  await expect(grace).toBeVisible();
  await setup.getByRole("radio", { name: /^Jen můj jazyk/ }).check();
  await expect(grace).toBeHidden();
  await setup.getByRole("radio", { name: /^Vyvážené/ }).check();
  await grace.selectOption("7");

  const patchPath = `/api/follows/${followId}`;
  const patchRequestPromise = page.waitForRequest((candidate) =>
    candidate.method() === "PATCH" && new URL(candidate.url()).pathname === patchPath);
  const patchResponsePromise = page.waitForResponse((candidate) =>
    candidate.request().method() === "PATCH" && new URL(candidate.url()).pathname === patchPath);
  await setup.getByRole("button", { name: "Zapnout" }).click();
  const [patched, patchResponse] = await Promise.all([patchRequestPromise, patchResponsePromise]);
  const body = patched.postDataJSON() as { autoDownload: { selection: unknown; graceDays: unknown } };
  expect(body.autoDownload.selection).toEqual({ profile: reference(balanced) });
  expect(body.autoDownload.graceDays).toBe(7);
  expect(patchResponse.status()).toBe(200);

  const saved = (await listFollows(request)).find((follow) => follow.id === followId);
  expect(saved?.autoDownload?.sourceProfile).toEqual(reference(balanced));
});
