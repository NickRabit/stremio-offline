import assert from "node:assert/strict";
import test from "node:test";
import { isInternalMediaPath, mediaChildPath, MediaResources, openMediaUrl, ResourceError, sealedMediaUrl } from "./media-resources.js";

const owner = { userId: "user-a", sid: "owner-a", expiresAt: 10_000_000 };
const source = { url: "https://provider-canary.test/private-canary?token=query-canary", title: "Movie query-canary", behaviorHints: { proxyHeaders: { request: { Authorization: "Bearer header-canary" } } }, subtitles: [{ url: "https://subtitle-canary.test/sub?secret=sub-canary", lang: "cs" }] };

test("a raw infoHash is a torrent, not a playable HTTP source", () => {
  const registry = new MediaResources(() => 0);
  const publicSource = registry.publicStream({
    infoHash: "59e11cef8c2152ac73681092844ebd3db19025bc", fileIdx: 0,
    name: "1080p WEB", title: "Movie 2 GB",
  }, owner);
  assert.equal(publicSource.kind, "torrent");
  assert.equal(publicSource.playable, false);
  const stored = registry.get(publicSource.sourceId, owner.sid, "source").stream;
  assert.equal(stored.infoHash, "59e11cef8c2152ac73681092844ebd3db19025bc");
  assert.equal(stored.fileIdx, 0);
  assert.equal("url" in publicSource, false);
  assert.equal(JSON.stringify(publicSource).includes("59e11cef"), false);
});

test("a magnet URL is stored as an infoHash and shown as a torrent", () => {
  const registry = new MediaResources(() => 0);
  const publicSource = registry.publicStream({ url: "magnet:?xt=urn:btih:59e11cef8c2152ac73681092844ebd3db19025bc&dn=Movie" }, owner);
  assert.equal(publicSource.kind, "torrent");
  assert.equal(publicSource.playable, false);
  assert.equal(registry.get(publicSource.sourceId, owner.sid, "source").stream.infoHash, "59e11cef8c2152ac73681092844ebd3db19025bc");
  assert.equal(registry.get(publicSource.sourceId, owner.sid, "source").stream.url, undefined);
});

test("public sources allowlist fields and never contain provider addresses or encoded credentials", () => {
  const registry = new MediaResources(() => 0);
  const publicSource = registry.publicStream({ ...source, unknown: { secret: source.url }, externalUrl: source.url, name: encodeURIComponent(source.url), description: Buffer.from(source.url).toString("base64url") }, owner);
  const serialized = JSON.stringify(publicSource);
  assert.match(publicSource.sourceId, /^[A-Za-z0-9_-]{43}$/);
  for (const secret of [source.url, "query-canary", "provider-canary.test", "header-canary", "subtitle-canary.test"]) {
    for (const value of [secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("base64url")]) assert.ok(!serialized.includes(value), value);
  }
  assert.equal(publicSource.playable, true);
  assert.equal("url" in publicSource, false);
  assert.equal("unknown" in publicSource, false);
  assert.equal("proxyHeaders" in publicSource.behaviorHints, false);
});

test("a library source may expose its own local subtitle sidecars", () => {
  const registry = new MediaResources(() => 0);
  const publicSource = registry.publicStream({ url: "file://Show/01.mkv", subtitles: [{ url: "file://Show/01.cs.vtt", lang: "cs" }] }, owner);
  assert.equal(publicSource.subtitles.length, 1);
  assert.equal(publicSource.subtitles[0].lang, "cs");
  assert.equal(registry.get(publicSource.subtitles[0].subtitleId, owner.sid, "subtitle").stream.url, "file://Show/01.cs.vtt");
});

test("resources enforce owners, scope, expiry, revocation and deduplication", () => {
  let now = 0;
  const registry = new MediaResources(() => now);
  const id = registry.add(source, owner, "source");
  assert.equal(registry.add(source, owner, "source"), id);
  assert.throws(() => registry.get(id, "owner-b", "source"), { status: 404 });
  assert.throws(() => registry.get(id, owner.sid, "media"), { status: 404 });
  now = 30 * 60_000;
  assert.throws(() => registry.get(id, owner.sid, "source"), { status: 410, code: "RESOURCE_EXPIRED" });
  assert.throws(() => registry.get(id, "owner-b", "source"), { status: 404 });
  const fresh = registry.add(source, owner, "source");
  assert.notEqual(fresh, id);
  registry.revoke(owner.sid);
  assert.throws(() => registry.get(fresh, owner.sid, "source"), { status: 404 });
});

test("playback claims survive selection expiry but not auth expiry or parent removal", () => {
  let now = 0;
  const registry = new MediaResources(() => now);
  const first = registry.mediaStream(source, owner);
  const second = registry.mediaStream(source, owner);
  assert.notEqual(first.resourceId, second.resourceId);
  const child = registry.add({ url: "https://cdn.test/segment" }, owner, "media", first.resourceId);
  now = 31 * 60_000;
  assert.equal(registry.get(child, owner.sid, "media").owner.sid, owner.sid);
  registry.remove(first.resourceId);
  assert.throws(() => registry.get(child, owner.sid, "media"), { status: 404 });
  assert.equal(registry.path(second.stream), `/api/media/${second.resourceId}`);
  now = owner.expiresAt;
  assert.throws(() => registry.get(second.resourceId, owner.sid, "media"), { status: 410 });
});

test("playlist children are sealed onto the parent instead of stored", () => {
  const registry = new MediaResources(() => 0, 2);
  const parent = registry.mediaStream(source, owner);
  const url = "https://cdn.test/seg-1.ts";
  const token = sealedMediaUrl(parent.resourceId, url);
  assert.equal(openMediaUrl(parent.resourceId, token), url);
  assert.equal(openMediaUrl(parent.resourceId, token), url);
  assert.equal(openMediaUrl("other-parent", token), undefined);
  assert.equal(openMediaUrl(parent.resourceId, "forged"), undefined);
  assert.match(mediaChildPath(parent.resourceId, url), new RegExp(`^/api/media/${parent.resourceId}/u/[A-Za-z0-9_-]+$`));
  assert.equal(isInternalMediaPath(`/media/${parent.resourceId}`), true);
  assert.equal(isInternalMediaPath(`/media/${parent.resourceId}/u/${token}`), true);
  assert.equal(isInternalMediaPath(`/media/${parent.resourceId}/other`), false);
  // Sealing must not spend a registry slot — a long VOD would otherwise 429.
  assert.ok(registry.add({ url: "https://other.test" }, owner, "source"));
});

test("count and byte budgets fail safely without evicting active playback", () => {
  const registry = new MediaResources(() => 0, 1);
  const active = registry.mediaStream(source, owner);
  assert.throws(() => registry.add({ url: "https://other.test" }, owner, "source"), { status: 429 });
  assert.equal(registry.get(active.resourceId, owner.sid, "media").id, active.resourceId);
  assert.throws(() => new MediaResources(() => 0, 10, 10).add(source, owner, "source"), ResourceError);
});

test("claimed subtitles inherit playback lifetime and are revoked with their parent", () => {
  let now = 0;
  const registry = new MediaResources(() => now);
  const selected = registry.add({ url: "https://provider.test/sub" }, owner, "subtitle");
  const media = registry.mediaStream(source, owner);
  const claimed = registry.add(registry.get(selected, owner.sid, "subtitle").stream, owner, "subtitle", media.resourceId);
  now = 31 * 60_000;
  assert.throws(() => registry.get(selected, owner.sid, "subtitle"), { status: 410 });
  assert.equal(registry.get(claimed, owner.sid, "subtitle").parent, media.resourceId);
  registry.remove(media.resourceId);
  assert.throws(() => registry.get(claimed, owner.sid, "subtitle"), { status: 404 });
});

test("selection creation is rate limited but duplicate lookups do not consume capacity", () => {
  let now = 0;
  const registry = new MediaResources(() => now, 10, 100_000, 1);
  const first = registry.add(source, owner, "source");
  assert.equal(registry.add(source, owner, "source"), first);
  assert.throws(() => registry.add({ url: "https://other.test" }, owner, "source"), { status: 429 });
  now = 60_000;
  assert.ok(registry.add({ url: "https://other.test" }, owner, "source"));
});

test("subtitle tracks ride along with their listing instead of spending the window", () => {
  const registry = new MediaResources(() => 0, 100, 100_000, 1);
  const [listed] = registry.listing([{ ...source, subtitles: [{ url: "https://a.test/1" }, { url: "https://a.test/2" }] }], owner);
  assert.equal(listed.subtitles.length, 2);
  assert.throws(() => registry.listing([{ url: "https://other.test" }], owner), { status: 429 });
});

test("a listing spends one charge however many streams the provider answers with", () => {
  let now = 0;
  const registry = new MediaResources(() => now, 500, 10_000_000, 1);
  const listed = registry.listing(Array.from({ length: 200 }, (_, index) => ({ url: `https://provider.test/${index}` })), owner);
  assert.equal(listed.length, 200);
  // The one click that asked for them is what the window counts, not the provider's catalogue size.
  assert.throws(() => registry.listing([{ url: "https://other.test" }], owner), { status: 429 });
  now = 60_000;
  assert.equal(registry.listing([{ url: "https://other.test" }], owner).length, 1);
});

test("a full registry drops the oldest selections instead of refusing new ones", () => {
  const registry = new MediaResources(() => 0, 3);
  const active = registry.mediaStream(source, owner);
  const stale = registry.add({ url: "https://stale.test" }, owner, "source");
  const kept = registry.add({ url: "https://kept.test" }, owner, "source");
  const fresh = registry.add({ url: "https://fresh.test" }, owner, "source");
  assert.throws(() => registry.get(stale, owner.sid, "source"), { status: 410, code: "RESOURCE_EXPIRED" });
  assert.equal(registry.get(kept, owner.sid, "source").id, kept);
  assert.equal(registry.get(fresh, owner.sid, "source").id, fresh);
  assert.equal(registry.get(active.resourceId, owner.sid, "media").id, active.resourceId);
});

test("a released media resource leaves its owner a tombstone instead of a plain miss", () => {
  const registry = new MediaResources(() => 0);
  const released = registry.mediaStream(source, owner);
  registry.remove(released.resourceId, true);
  assert.throws(() => registry.get(released.resourceId, owner.sid, "media"), { status: 410, code: "RESOURCE_EXPIRED" });
  const dropped = registry.mediaStream(source, owner);
  registry.remove(dropped.resourceId);
  assert.throws(() => registry.get(dropped.resourceId, owner.sid, "media"), { status: 404, code: "RESOURCE_NOT_FOUND" });
});

test("a subtitle child is tombstoned with the media resource it hangs off", () => {
  const registry = new MediaResources(() => 0);
  const media = registry.mediaStream(source, owner);
  const child = registry.add({ url: "https://provider.test/sub" }, owner, "subtitle", media.resourceId);
  registry.remove(media.resourceId, true);
  assert.throws(() => registry.get(child, owner.sid, "subtitle"), { status: 410, code: "RESOURCE_EXPIRED" });
});
