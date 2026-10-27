import { expect, type APIRequestContext } from "@playwright/test";
import { rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { addonManifest } from "../../playwright.config";

export const E2E_LIBRARY = path.resolve("e2e/.tmp/downloads");

export interface Profile {
  id: string;
  revision: number;
  operations: string[];
  nameKey?: string;
  name?: string;
}

export interface Job {
  id: string;
  title: string;
  status: string;
  target: string;
  pending: boolean;
}

export interface SourceRequest {
  provider: string;
  type: string;
  id: string;
}

export const listJobs = async (request: APIRequestContext): Promise<Job[]> =>
  (await (await request.get("/api/downloads")).json() as { jobs?: Job[] }).jobs ?? [];

export const sourceRequests = async (request: APIRequestContext): Promise<SourceRequest[]> =>
  (await (await request.get(new URL("/source-requests", addonManifest).href)).json() as {
    requests: SourceRequest[];
  }).requests;

export const profileByNameKey = async (request: APIRequestContext, nameKey: string): Promise<Profile> => {
  const response = await request.get("/api/source-profiles");
  expect(response.status(), await response.text()).toBe(200);
  const { profiles } = await response.json() as { profiles: Profile[] };
  const profile = profiles.find((candidate) => candidate.nameKey === nameKey);
  expect(profile, `the ${nameKey} source profile is not available`).toBeDefined();
  expect(profile!.operations).toContain("downloadToLibrary");
  return profile!;
};

export const resetFixture = (request: APIRequestContext) =>
  request.get(new URL("/source-control?reset=1&fail=none", addonManifest).href);

const removeDownloadedTarget = async (job: Job) => {
  if (!job.target) return;
  const target = path.resolve(E2E_LIBRARY, job.target);
  if (path.relative(E2E_LIBRARY, target).split(path.sep).includes("..")) return;
  await unlink(target).catch(() => undefined);
  await rmdir(path.dirname(target)).catch(() => undefined);
};

export const cleanupJourney = async (request: APIRequestContext, titlePrefix: string) => {
  for (const job of (await listJobs(request).catch(() => [])).filter((item) => item.title.startsWith(titlePrefix))) {
    await removeDownloadedTarget(job);
    expect((await request.delete(`/api/downloads/${job.id}`)).status()).toBe(204);
  }
  expect((await resetFixture(request)).ok()).toBe(true);
};
