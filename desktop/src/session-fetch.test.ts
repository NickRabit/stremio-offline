import assert from "node:assert/strict";
import test from "node:test";
import { responseHeaders } from "./session-fetch.js";

test("a header value that came as a list is joined on one line", () => {
  const headers = responseHeaders({ "set-cookie": ["a=1", "b=2"], "content-type": "text/html" });
  assert.equal(headers.get("set-cookie"), "a=1, b=2");
});

test("a header value that came as one string is kept as it is", () => {
  const headers = responseHeaders({ location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/x" });
  assert.equal(headers.get("location"), "https://team.cloudflareaccess.com/cdn-cgi/access/login/x");
});
