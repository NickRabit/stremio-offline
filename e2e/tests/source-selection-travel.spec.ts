import { expect, test } from "@playwright/test";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  cleanupJourney,
  E2E_LIBRARY,
  sourceRequests,
  type Job,
  type Profile,
  resetFixture,
} from "./source-selection-journey";

const TRAVEL_PROFILE_ID = "7e15d713-965c-4636-9ed3-3a112c521fe1";
const PRIMARY_PROVIDER = "com.linvo.cinemeta";
const VIDEO_ID = "tt-e2e-travel-episode";
const TITLE = "SRCSEL Travel E2E journey";
const SOURCE_SECRET = "travel-signed-source-canary";

test.afterEach(async ({ request }) => {
  await cleanupJourney(request, TITLE);
});

test("the fixed Travel profile downloads a local addon video through the queue", async ({ request }) => {
  expect((await resetFixture(request)).ok()).toBe(true);
  const listed = await request.get("/api/source-profiles");
  expect(listed.status(), await listed.text()).toBe(200);
  const { profiles } = await listed.json() as { profiles: Profile[] };
  const travel = profiles.find((profile) => profile.id === TRAVEL_PROFILE_ID);
  expect(travel, "the fixed Travel profile is not available").toBeDefined();
  expect(travel!.operations).toContain("downloadToLibrary");

  const queued = await request.post("/api/downloads/bulk", {
    data: {
      title: TITLE,
      type: "series",
      media: { id: "tt-e2e-travel", metaType: "series" },
      episodes: [{ id: VIDEO_ID, season: 1, episode: 1, title: "Travel journey" }],
      selection: { profile: { profileId: travel!.id, revision: travel!.revision } },
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
      "travelCursor",
      "travelTemporaryFailures",
      "travelBudgetAttempts",
      "sourceAdmission",
      "travel-video.mp4",
      SOURCE_SECRET,
    ]) {
      if (serialized.includes(value)) privateQueueData.add(value);
    }
    job = queue.jobs.find((item) => item.title.startsWith(TITLE));
    return job?.status === "completed" || job?.status === "failed" ? job.status : job?.status;
  }, {
    timeout: 60_000,
    message: "the Travel download did not settle",
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
    message: "the completed download is not a nonempty file in the E2E library",
  }).toBe(true);
});
