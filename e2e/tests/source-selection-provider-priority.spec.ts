import { expect, test } from "@playwright/test";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  cleanupJourney,
  E2E_LIBRARY,
  profileByNameKey,
  sourceRequests,
  type Job,
  resetFixture,
} from "./source-selection-journey";

const PRIMARY_PROVIDER = "com.linvo.cinemeta";
const TITLE_PREFIX = "SRCSEL provider fixture smaller";
const VIDEO_ID = "tt-e2e-provider-priority-episode";
const SOURCE_SECRET = "provider-priority-signed-source-canary";

test.afterEach(async ({ request }) => {
  await cleanupJourney(request, TITLE_PREFIX);
});

test("the Smaller preset downloads through the bulk queue journey", async ({ request }) => {
  expect((await resetFixture(request)).ok()).toBe(true);
  const smaller = await profileByNameKey(request, "rules.preset.smaller");

  const queued = await request.post("/api/downloads/bulk", {
    data: {
      title: TITLE_PREFIX,
      type: "series",
      media: { id: "tt-e2e-provider-rules", metaType: "series" },
      episodes: [{ id: VIDEO_ID, season: 1, episode: 1, title: "Provider journey" }],
      selection: { profile: { profileId: smaller.id, revision: smaller.revision } },
    },
  });
  expect(queued.status(), await queued.text()).toBe(201);
  expect(await queued.json()).toEqual({ added: 1, skipped: 0 });

  const privateQueueData = new Set<string>();
  let job: Job | undefined;
  await expect.poll(async () => {
    const response = await request.get("/api/downloads");
    expect(response.status(), await response.text()).toBe(200);
    const queue = await response.json() as { jobs: Job[] };
    const serialized = JSON.stringify(queue);
    for (const value of [
      "sourceAdmission",
      "sourceStreamAddonIdentity",
      "sourceSubtitleAddonIdentity",
      "sourceFallbackAttempts",
      "rulesCursor",
      "rulesTemporaryFailures",
      "rulesBudgetAttempts",
      SOURCE_SECRET,
    ]) {
      if (serialized.includes(value)) privateQueueData.add(value);
    }
    job = queue.jobs.find((item) => item.title.startsWith(TITLE_PREFIX));
    return job?.status === "completed" || job?.status === "failed" ? job.status : job?.status;
  }, {
    timeout: 60_000,
    message: "the Provider priority download did not settle",
  }).toMatch(/^(completed|failed)$/);

  expect(job?.status).toBe("completed");
  expect(job?.pending).toBe(false);
  expect([...privateQueueData]).toEqual([]);
  expect(await sourceRequests(request)).toEqual([{
    provider: PRIMARY_PROVIDER,
    type: "series",
    id: VIDEO_ID,
  }]);

  const target = path.resolve(E2E_LIBRARY, job!.target);
  expect(path.relative(E2E_LIBRARY, target).split(path.sep)).not.toContain("..");
  await expect.poll(() => stat(target).then((info) => info.isFile() && info.size > 0, () => false), {
    message: "the completed rules download is not a nonempty file",
  }).toBe(true);
});
