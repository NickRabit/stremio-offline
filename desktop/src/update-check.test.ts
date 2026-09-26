import assert from "node:assert/strict";
import test from "node:test";
import { checkForUpdate, isNewer, parseVersion, readRelease, UPDATE_FEED_URL } from "./update-check.js";

const releaseBody = (overrides: Record<string, unknown> = {}) => ({
  tag_name: "v0.5.0",
  html_url: "https://github.com/NickRabit/stremio-offline/releases/tag/v0.5.0",
  draft: false,
  prerelease: false,
  ...overrides,
});

/** A fetch that answers with `body`, and remembers how it was called. */
const answering = (body: unknown, ok = true) => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
};

test("a plain version is read with or without its tag's leading v", () => {
  assert.deepEqual(parseVersion("v0.4.86"), [0, 4, 86]);
  assert.deepEqual(parseVersion("0.4.86"), [0, 4, 86]);
  assert.deepEqual(parseVersion("v10.0.1"), [10, 0, 1]);
});

test("anything that is not exactly x.y.z has no version", () => {
  const rejected = ["", "v", "0.4", "0.4.86.1", "0.4.86-beta.1", "0.4.86+build", "release-0.4.86", " v0.4.86", "v0.4.86 ", "x.y.z", "0.4.-1"];
  for (const value of rejected) assert.equal(parseVersion(value), null, value);
});

test("a release is newer only when one of its numbers is larger", () => {
  const version = (value: string) => parseVersion(value)!;
  assert.equal(isNewer(version("0.4.87"), version("0.4.86")), true);
  assert.equal(isNewer(version("0.5.0"), version("0.4.86")), true);
  assert.equal(isNewer(version("1.0.0"), version("0.99.99")), true);
  assert.equal(isNewer(version("0.4.86"), version("0.4.86")), false);
  assert.equal(isNewer(version("0.4.85"), version("0.4.86")), false);
  assert.equal(isNewer(version("0.3.99"), version("0.4.0")), false);
});

test("a feed entry is read only when it names a real release of this project", () => {
  assert.deepEqual(readRelease(releaseBody()), {
    version: "0.5.0",
    url: "https://github.com/NickRabit/stremio-offline/releases/tag/v0.5.0",
  });
  assert.equal(readRelease(releaseBody({ draft: true })), null, "a draft is not announced");
  assert.equal(readRelease(releaseBody({ prerelease: true })), null, "nor is a pre-release");
  assert.equal(readRelease(releaseBody({ html_url: "https://github.com/NickRabit/stremio-offline/releases" })), null, "the release list is not a release");
  assert.equal(readRelease(releaseBody({ html_url: "https://github.com/SomeoneElse/stremio-offline/releases/tag/v0.5.0" })), null);
  assert.equal(readRelease(releaseBody({ html_url: "http://github.com/NickRabit/stremio-offline/releases/tag/v0.5.0" })), null);
  assert.equal(readRelease(releaseBody({ html_url: "https://example.com/releases/tag/v0.5.0" })), null);
  assert.equal(readRelease(releaseBody({ tag_name: 5 })), null);
  assert.equal(readRelease(releaseBody({ html_url: null })), null);
  const rejected: unknown[] = [null, "body", [], 42, {}];
  for (const body of rejected) assert.equal(readRelease(body), null, JSON.stringify(body));
});

test("the newest release comes back only when it is newer than this app", async () => {
  const newer = answering(releaseBody());
  assert.deepEqual(await checkForUpdate("0.4.86", newer.fetchImpl, UPDATE_FEED_URL), {
    version: "0.5.0",
    url: "https://github.com/NickRabit/stremio-offline/releases/tag/v0.5.0",
  });
  const same = answering(releaseBody({ tag_name: "0.4.86", html_url: "https://github.com/NickRabit/stremio-offline/releases/tag/0.4.86" }));
  assert.equal(await checkForUpdate("0.4.86", same.fetchImpl, UPDATE_FEED_URL), null);
  const older = answering(releaseBody({ tag_name: "v0.4.1", html_url: "https://github.com/NickRabit/stremio-offline/releases/tag/v0.4.1" }));
  assert.equal(await checkForUpdate("0.4.86", older.fetchImpl, UPDATE_FEED_URL), null);
});

test("the check asks the feed for this app and asks for nothing else", async () => {
  const { fetchImpl, calls } = answering(releaseBody());
  await checkForUpdate("0.4.86", fetchImpl, UPDATE_FEED_URL);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, UPDATE_FEED_URL);
  assert.deepEqual(calls[0].init?.headers, {
    Accept: "application/vnd.github+json",
    "User-Agent": "Stremio-Offline/0.4.86",
  });
  assert.equal(calls[0].init?.method, undefined);
  assert.equal(calls[0].init?.body, undefined);
});

test("every failure answers null instead of throwing", async () => {
  const badStatus = answering(releaseBody(), false);
  assert.equal(await checkForUpdate("0.4.86", badStatus.fetchImpl, UPDATE_FEED_URL), null);
  const notJson = (async () => ({ ok: true, json: async () => { throw new Error("not json"); } }) as unknown as Response) as unknown as typeof fetch;
  assert.equal(await checkForUpdate("0.4.86", notJson, UPDATE_FEED_URL), null);
  const refusing = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  assert.equal(await checkForUpdate("0.4.86", refusing, UPDATE_FEED_URL), null);
  assert.equal(await checkForUpdate("", refusing, UPDATE_FEED_URL), null, "an app version that is not x.y.z has nothing to compare");
});

test("a feed that never answers is left behind", async () => {
  const hanging = (async (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  })) as unknown as typeof fetch;
  assert.equal(await checkForUpdate("0.4.86", hanging, UPDATE_FEED_URL, 20), null);
});
