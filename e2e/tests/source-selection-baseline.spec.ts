import { expect, test, type APIRequestContext } from "@playwright/test";
import { addonManifest } from "../../playwright.config";

const PRIMARY_PROVIDER = "com.linvo.cinemeta";
const SECONDARY_PROVIDER = "e2e.secondary.source";
const SECONDARY_MANIFEST = new URL("secondary/manifest.json", addonManifest).href;
const TITLE_PREFIX = "SRCSEL source baseline";

interface Addon {
  key: string;
  manifest: { id: string; name: string };
}

interface Job {
  id: string;
  title: string;
  status: string;
  pending: boolean;
  errorKey?: string;
  updatedAt: string;
}

interface SourceRequest {
  provider: string;
  type: string;
  id: string;
}

const listJobs = async (request: APIRequestContext): Promise<Job[]> =>
  (await (await request.get("/api/downloads")).json() as { jobs?: Job[] }).jobs ?? [];

const findJob = async (request: APIRequestContext, title: string) =>
  (await listJobs(request)).find((job) => job.title.startsWith(title));

const sourceRequests = async (request: APIRequestContext): Promise<SourceRequest[]> =>
  (await (await request.get(new URL("/source-requests", addonManifest).href)).json() as { requests: SourceRequest[] }).requests;

const control = async (
  request: APIRequestContext,
  options: { reset?: boolean; recover?: boolean; fail?: { provider: string; id: string } } = {},
) => {
  const url = new URL("/source-control", addonManifest);
  if (options.reset) url.searchParams.set("reset", "1");
  if (options.recover) url.searchParams.set("fail", "none");
  if (options.fail) {
    url.searchParams.set("fail", options.fail.provider);
    url.searchParams.set("id", options.fail.id);
  }
  return request.get(url.href);
};

const installSecondary = async (request: APIRequestContext): Promise<Addon> => {
  const response = await request.post("/api/addons", { data: { url: SECONDARY_MANIFEST, role: "source" } });
  expect(response.status()).toBe(201);
  return await response.json() as Addon;
};

const queueEpisode = async (
  request: APIRequestContext,
  addonKey: string,
  title: string,
  videoId: string,
) => {
  const response = await request.post("/api/downloads/bulk", {
    data: {
      title,
      type: "series",
      episodes: [{ id: videoId, season: 9, episode: 1, title: "Provider request" }],
      selection: {
        addonKeys: [addonKey],
        sourceStrategy: "priority",
        audioLanguage: "cs",
        audioMode: "listed",
        subtitleMode: "off",
      },
    },
  });
  expect(response.status()).toBe(201);
  expect(await response.json()).toEqual({ added: 1, skipped: 0 });
  return `${title} · Provider request`;
};

test.afterEach(async ({ request }) => {
  for (const job of await listJobs(request).catch(() => [])) {
    if (job.title.startsWith(TITLE_PREFIX)) expect((await request.delete(`/api/downloads/${job.id}`)).status()).toBe(204);
  }
  const addons = await request.get("/api/addons").then((response) => response.json() as Promise<Addon[]>).catch(() => []);
  for (const addon of addons.filter((item) => item.manifest.id === SECONDARY_PROVIDER)) {
    expect((await request.delete(`/api/addons/${addon.key}`)).status()).toBe(204);
  }
  expect((await control(request, { reset: true, recover: true })).ok()).toBe(true);
});

test("a selected-provider job requests streams only from the selected provider", async ({ request }) => {
  expect((await control(request, { reset: true })).ok()).toBe(true);
  const secondary = await installSecondary(request);
  expect(secondary.manifest).toMatchObject({ id: SECONDARY_PROVIDER, name: "E2E doplněk" });

  const videoId = "tt-e2e-source-selected";
  const title = await queueEpisode(request, secondary.key, `${TITLE_PREFIX} selected`, videoId);
  await expect.poll(async () => {
    const job = await findJob(request, title);
    const rows = (await sourceRequests(request)).filter((row) => row.type === "series" && row.id === videoId);
    return [
      job?.status === "failed" || job?.pending === false,
      rows.filter((row) => row.provider === PRIMARY_PROVIDER).length,
      rows.filter((row) => row.provider === SECONDARY_PROVIDER).length,
    ];
  }, { timeout: 30_000, message: "the lazy resolver did not finish with only the selected addon's stream request" }).toEqual([true, 0, 1]);
});

test("characterization: retrying inside the stream cache window does not ask the failed selected addon again", async ({ request }) => {
  const videoId = "tt-e2e-source-retry-cache";
  const failure = { provider: SECONDARY_PROVIDER, id: videoId };
  expect((await control(request, { reset: true, fail: failure })).ok()).toBe(true);
  const secondary = await installSecondary(request);

  const title = await queueEpisode(request, secondary.key, `${TITLE_PREFIX} retry`, videoId);
  await expect.poll(async () => (await findJob(request, title))?.status, {
    timeout: 30_000,
    message: "the selected addon's controlled failure did not fail the lazy job",
  }).toBe("failed");
  const failed = await findJob(request, title);
  expect(failed?.errorKey).toBe("err.noMatchingSource");
  expect(await sourceRequests(request)).toEqual([{ ...failure, type: "series" }]);

  expect((await control(request, { reset: true, recover: true })).ok()).toBe(true);
  expect((await request.post(`/api/downloads/${failed!.id}/retry`)).status()).toBe(204);
  await expect.poll(async () => {
    const job = await findJob(request, title);
    return job?.status === "failed" && job.updatedAt !== failed!.updatedAt;
  }, { timeout: 30_000, message: "the retried lazy job did not finish its second resolution" }).toBe(true);

  expect(await sourceRequests(request)).toEqual([]);
});
