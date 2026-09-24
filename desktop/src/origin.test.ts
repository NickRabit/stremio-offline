import assert from "node:assert/strict";
import test from "node:test";
import { externalBrowserUrl, httpAllowed, httpAllowedHost, parseServerOrigin, partitionForOrigin } from "./origin.js";

test("input that is not a bare origin is rejected", () => {
  const rejected = [
    "",
    "   ",
    "192.168.1.20:8090",
    "ftp://192.168.1.20",
    "http://user:pass@192.168.1.20:8090",
    "http://192.168.1.20:8090/library",
    "http://192.168.1.20:8090?x=1",
    "http://192.168.1.20:8090#x",
    "https://example.com/stremio",
  ];
  for (const input of rejected) assert.equal(parseServerOrigin(input), null, JSON.stringify(input));
});

test("the origin, transport, host and port come from the address", () => {
  assert.deepEqual(parseServerOrigin("http://192.168.1.20:8090"), { origin: "http://192.168.1.20:8090", transport: "http", host: "192.168.1.20", port: "8090" });
  assert.deepEqual(parseServerOrigin("http://192.168.1.20:8090/"), { origin: "http://192.168.1.20:8090", transport: "http", host: "192.168.1.20", port: "8090" });
  assert.deepEqual(parseServerOrigin("HTTP://NAS.local:8090"), { origin: "http://nas.local:8090", transport: "http", host: "nas.local", port: "8090" });
  assert.deepEqual(parseServerOrigin("http://[::1]:8080/"), { origin: "http://[::1]:8080", transport: "http", host: "[::1]", port: "8080" });
  assert.deepEqual(parseServerOrigin("https://example.com"), { origin: "https://example.com", transport: "https", host: "example.com", port: "" });
  assert.deepEqual(parseServerOrigin("http://127.0.0.1"), { origin: "http://127.0.0.1", transport: "http", host: "127.0.0.1", port: "" });
});

test("plain HTTP is allowed for localhost and a private address", () => {
  const allowed = ["localhost", "LOCALHOST", "localhost.", "LocalHost.", "192.168.1.20", "10.1.2.3", "172.16.0.1", "172.31.255.255", "127.0.0.1", "127.1.2.3", "169.254.1.1", "[::1]", "[fe80::1]", "[fd00::1]", "[::ffff:192.168.1.5]"];
  for (const host of allowed) assert.equal(httpAllowedHost(host), true, host);
  assert.equal(httpAllowed({ origin: "http://localhost:8090", transport: "http", host: "localhost", port: "8090" }), true);
  assert.equal(httpAllowed({ origin: "https://example.com", transport: "https", host: "example.com", port: "" }), true);
});

test("two origins never share a session, including two ports of one name", () => {
  const first = partitionForOrigin("http://nas.local:8090");
  const second = partitionForOrigin("http://nas.local:8091");
  assert.notEqual(first, second);
  assert.equal(first, partitionForOrigin("http://nas.local:8090"));
  assert.notEqual(first, partitionForOrigin("https://nas.local:8090"));
  assert.equal(first.startsWith("persist:stremio-"), true);
  assert.equal(first.includes("/"), false);
});

test("only a plain http(s) link may leave the shell", () => {
  assert.equal(externalBrowserUrl("https://addon.example/configure"), "https://addon.example/configure");
  assert.equal(externalBrowserUrl("http://192.168.1.20:8090/docs"), "http://192.168.1.20:8090/docs");
  assert.equal(externalBrowserUrl("javascript:alert(1)"), null);
  assert.equal(externalBrowserUrl("file:///etc/passwd"), null);
  assert.equal(externalBrowserUrl("http://user:pass@nas.local/configure"), null);
  assert.equal(externalBrowserUrl("not a url"), null);
});

test("plain HTTP is refused for a name and for the public internet", () => {
  const refused = ["foo.localhost", "nas.localhost", "localhost.example.com", "localhost.local", "notlocalhost", "localhostx", "nas.local", "example.com", "172.15.0.1", "172.32.0.1", "8.8.8.8", "0.0.0.0", "[2001:db8::1]", "[::ffff:8.8.8.8]"];
  for (const host of refused) assert.equal(httpAllowedHost(host), false, host);
  assert.equal(httpAllowed({ origin: "http://8.8.8.8", transport: "http", host: "8.8.8.8", port: "" }), false);
  assert.equal(httpAllowed({ origin: "http://foo.localhost:8090", transport: "http", host: "foo.localhost", port: "8090" }), false);
  assert.equal(httpAllowed({ origin: "http://nas.local:8090", transport: "http", host: "nas.local", port: "8090" }), false);
  assert.equal(httpAllowed({ origin: "https://nas.local", transport: "https", host: "nas.local", port: "" }), true);
});
