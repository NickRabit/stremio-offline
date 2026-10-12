import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isRemoteContentRef,
  isRemoteMediaStream,
  openRemoteContent,
  remoteSecretStamp,
  sealRemoteContent,
  type RemoteContentRef,
} from "./media-server-reference.js";

const base = (over: Partial<RemoteContentRef> = {}): RemoteContentRef => ({
  provider: "jellyfin",
  serverId: "server-1",
  accountId: "account-1",
  itemId: "item-1",
  connectionId: `mconn_${"a".repeat(32)}`,
  libraryId: `rlib_${"b".repeat(32)}`,
  generation: 3,
  mediaSourceId: "source-1",
  owner: { userId: "usr_00000001", sid: "sid-1", expiresAt: 10_000, secretStamp: "c".repeat(64) },
  ...over,
});

test("a sealed reference round-trips, survives a structured clone and is a fresh object", () => {
  const sealed = sealRemoteContent(base());
  const opened = openRemoteContent(sealed);
  assert.deepEqual(opened, base());
  assert.deepEqual(openRemoteContent(structuredClone(sealed)), base());
  const first = openRemoteContent(sealed)!;
  const second = openRemoteContent(sealed)!;
  assert.notEqual(first, second);
  first.owner.userId = "usr_tampered";
  assert.equal(openRemoteContent(sealed)!.owner.userId, "usr_00000001");
});

test("the sealed address never carries a public scheme or a URL", () => {
  const sealed = sealRemoteContent(base());
  assert.match(sealed, /^media-server:[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
  assert.equal(/^https?:|^file:|^magnet:/.test(sealed), false);
  assert.equal(sealed.includes("://"), false);
});

test("a tampered payload or signature is refused", () => {
  const sealed = sealRemoteContent(base());
  const flipped = `${sealed.slice(0, -1)}${sealed.endsWith("0") ? "1" : "0"}`;
  assert.equal(openRemoteContent(flipped), undefined, "a changed signature is refused");
  const dot = sealed.lastIndexOf(".");
  const payload = sealed.slice("media-server:".length, dot);
  const body = sealed.slice(dot + 1);
  const swapped = `${payload.slice(0, 5)}${payload[5] === "A" ? "B" : "A"}${payload.slice(6)}`;
  assert.equal(openRemoteContent(`media-server:${swapped}.${body}`), undefined, "a changed payload is refused");
  assert.equal(openRemoteContent("media-server:"), undefined);
  assert.equal(openRemoteContent("http://example.test/x"), undefined);
  assert.equal(openRemoteContent("x".repeat(20_000)), undefined, "an oversize address is refused");
  assert.equal(openRemoteContent(null), undefined);
  assert.equal(openRemoteContent(42), undefined);
});

test("validation refuses unknown keys, a missing owner and a prototype trick", () => {
  assert.equal(isRemoteContentRef(base()), true);
  assert.equal(isRemoteContentRef({ ...base(), extra: 1 }), false);
  assert.equal(isRemoteContentRef({ ...base(), owner: { ...base().owner, extra: 1 } }), false);
  const noOwner = { ...base() } as Record<string, unknown>;
  delete noOwner.owner;
  assert.equal(isRemoteContentRef(noOwner), false);
  assert.equal(isRemoteContentRef(Object.assign(Object.create({ generation: 3 }), {})), false);
  assert.equal(isRemoteContentRef(structuredClone({ ...base(), owner: Object.create(base().owner) })), false);
});

test("validation refuses malformed identifiers, generations and owner fields", () => {
  assert.equal(isRemoteContentRef(base({ provider: "plex" as never })), false);
  assert.equal(isRemoteContentRef(base({ itemId: "a/b" })), false);
  assert.equal(isRemoteContentRef(base({ itemId: ".." })), false);
  assert.equal(isRemoteContentRef(base({ mediaSourceId: "%2e%2e" })), false);
  assert.equal(isRemoteContentRef(base({ serverId: "x".repeat(513) })), false);
  assert.equal(isRemoteContentRef(base({ connectionId: "mconn_nothex" })), false);
  assert.equal(isRemoteContentRef(base({ libraryId: "lib_00000001" })), false);
  assert.equal(isRemoteContentRef(base({ generation: -1 })), false);
  assert.equal(isRemoteContentRef(base({ generation: 1.5 })), false);
  assert.equal(isRemoteContentRef(base({ owner: { ...base().owner, secretStamp: "C".repeat(64) } })), false);
  assert.equal(isRemoteContentRef(base({ owner: { ...base().owner, secretStamp: "c".repeat(63) } })), false);
  assert.equal(isRemoteContentRef(base({ owner: { ...base().owner, expiresAt: 0 } })), false);
  assert.equal(isRemoteContentRef(base({ owner: { ...base().owner, userId: "" } })), false);
  assert.equal(isRemoteContentRef(base({ owner: { ...base().owner, sid: "x".repeat(513) } })), false);
});

test("sealing refuses a malformed reference instead of minting provenance", () => {
  assert.throws(() => sealRemoteContent(base({ itemId: "a/b" })), /malformed/);
  assert.throws(() => sealRemoteContent({ ...base(), extra: 1 } as never), /malformed/);
});

test("every media-server attempt is recognised, valid or not", () => {
  assert.equal(isRemoteMediaStream({ url: sealRemoteContent(base()) }), true);
  assert.equal(isRemoteMediaStream({ url: "media-server:not-a-seal" }), true);
  assert.equal(isRemoteMediaStream({ url: "media-server:" }), true);
  assert.equal(isRemoteMediaStream({ url: "https://example.test/x" }), false);
  assert.equal(isRemoteMediaStream({ url: undefined }), false);
});

test("remoteSecretStamp is a stable lowercase sha256 of the secret", () => {
  const stamp = remoteSecretStamp("secret-usr_00000001");
  assert.match(stamp, /^[0-9a-f]{64}$/);
  assert.equal(stamp, remoteSecretStamp("secret-usr_00000001"));
  assert.notEqual(stamp, remoteSecretStamp("secret-other"));
});

const payloadOf = (sealed: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(sealed.slice("media-server:".length, sealed.lastIndexOf(".")), "base64url").toString("utf8")) as Record<string, unknown>;

test("an original reference keeps its exact canonical shape without the optional index", () => {
  const payload = payloadOf(sealRemoteContent(base()));
  assert.equal("subtitleIndex" in payload, false, "the optional key is absent, not null");
  assert.deepEqual(openRemoteContent(sealRemoteContent(base())), base());
});

test("a subtitle index is a signed part of the reference and is validated like any other field", () => {
  const subtitle = sealRemoteContent(base({ subtitleIndex: 2 }));
  const payload = payloadOf(subtitle);
  assert.equal(payload.subtitleIndex, 2, "the index is inside the signed payload");
  assert.equal(openRemoteContent(subtitle)?.subtitleIndex, 2);
  assert.notEqual(subtitle, sealRemoteContent(base({ subtitleIndex: 3 })));
  assert.equal(isRemoteContentRef(base({ subtitleIndex: 1023 })), true);
  assert.equal(isRemoteContentRef(base({ subtitleIndex: 1024 })), false);
  assert.equal(isRemoteContentRef(base({ subtitleIndex: -1 })), false);
  assert.equal(isRemoteContentRef(base({ subtitleIndex: 1.5 })), false);
  assert.equal(isRemoteContentRef(base({ subtitleIndex: "2" as never })), false);
  assert.equal(isRemoteContentRef({ ...base(), [Symbol("subtitleIndex")]: 2 }), false, "a symbol key is refused");
  assert.equal(isRemoteContentRef({ ...base(), get subtitleIndex() { return 2; } }), false, "an accessor is refused");
});
