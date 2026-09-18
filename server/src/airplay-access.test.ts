import assert from "node:assert/strict";
import test from "node:test";
import { AirPlayAccess } from "./airplay-access.js";
import { flushLog } from "./logger.js";
import { mediaChildPath, MediaResources } from "./media-resources.js";

function fixture() {
  let now = 1000;
  const resources = new MediaResources(() => now);
  const owner = { sid: "owner", expiresAt: now + 24 * 60 * 60_000 };
  const root = resources.add({ url: "https://example.test/video.mp4" }, owner, "media");
  const access = new AirPlayAccess(resources, () => now);
  access.create("playback-1", owner, root);
  const token = new URL(access.url("playback-1", `/api/media/${root}`), "http://test").searchParams.get("airplay");
  return { resources, owner, root, access, token, advance: (ms: number) => { now += ms; } };
}

test("AirPlay grants read only the selected media tree and its HLS files", () => {
  const { resources, owner, root, access, token } = fixture();
  const child = mediaChildPath(root, "https://example.test/segment.ts");
  const unrelated = resources.add({ url: "https://example.test/other" }, owner, "media");
  for (const method of ["GET", "HEAD"]) {
    for (const url of [`/api/media/${root}`, child, "/api/playback/playback-1/1/master.m3u8", "/api/playback/playback-1/1/init.mp4", "/api/playback/playback-1/1/segment_1.m4s"]) {
      assert.equal(access.authorize(method, url, token)?.owner.sid, owner.sid);
    }
  }
  for (const url of [`/api/media/${unrelated}`, "/api/settings", "/api/playback/playback-2/1/master.m3u8", "/api/playback/playback-1/preview", "/api/playback/playback-1/1/../../settings", "/api/playback/playback-1/1/file.json"]) {
    assert.equal(access.authorize("GET", url, token), undefined);
  }
  for (const method of ["POST", "DELETE", "PUT"]) assert.equal(access.authorize(method, `/api/media/${root}`, token), undefined);
  for (const invalid of [undefined, "forged", [token], {}]) assert.equal(access.authorize("GET", `/api/media/${root}`, invalid), undefined);
});

test("AirPlay grants expire and are revoked by stop and logout", () => {
  for (const invalidate of [
    (f: ReturnType<typeof fixture>) => f.access.remove("playback-1"),
    (f: ReturnType<typeof fixture>) => f.resources.revoke(f.owner.sid),
    (f: ReturnType<typeof fixture>) => f.resources.remove(f.root),
    (f: ReturnType<typeof fixture>) => f.advance(12 * 60 * 60_000),
  ]) {
    const f = fixture();
    invalidate(f);
    assert.equal(f.access.authorize("GET", `/api/media/${f.root}`, f.token), undefined);
    assert.equal(f.access.authorize("GET", "/api/playback/playback-1/1/master.m3u8", f.token), undefined);
  }
});

test("AirPlay grants never extend the login lifetime", () => {
  const f = fixture();
  const shortOwner = { sid: "short", expiresAt: 2000 };
  const root = f.resources.add({ url: "https://example.test/short" }, shortOwner, "media");
  f.access.create("short", shortOwner, root);
  const token = new URL(f.access.url("short", `/api/media/${root}`), "http://test").searchParams.get("airplay");
  f.advance(1000);
  assert.equal(f.access.authorize("GET", `/api/media/${root}`, token), undefined);
});

test("a refusal is written down, the token is not", async () => {
  const { root, access, token, advance } = fixture();
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    assert.equal(access.authorize("GET", "/api/settings", token), undefined);
    advance(13 * 60 * 60_000);
    assert.equal(access.authorize("GET", `/api/media/${root}`, token), undefined);
  } finally {
    process.stdout.write = original;
    await flushLog();
  }
  const lines = written.filter((line) => line.includes("AirPlay request refused"));
  assert.equal(lines.length, 2, "both refusals reported, and for different reasons");
  assert.ok(lines.some((line) => line.includes("the grant does not cover this file")));
  assert.ok(lines.some((line) => line.includes("the grant expired")));
  for (const line of written) assert.ok(!line.includes(token!), "the AirPlay token never reaches the log");
});

test("an ordinary request carrying no AirPlay token stays out of the log", async () => {
  const { root, access } = fixture();
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    for (const method of ["GET", "POST", "DELETE"]) assert.equal(access.authorize(method, `/api/media/${root}`, undefined), undefined);
  } finally {
    process.stdout.write = original;
    await flushLog();
  }
  assert.equal(written.filter((line) => line.includes("AirPlay")).length, 0);
});
