import assert from "node:assert/strict";
import test from "node:test";
import { localPageSent, type BridgeSender } from "./bridge-sender.js";
import { LOCAL_PARTITION } from "./local-backend.js";
import { partitionForOrigin } from "./origin.js";

const local: BridgeSender = {
  currentView: true, partition: LOCAL_PARTITION,
  frame: { url: "http://127.0.0.1:53001/libraries", top: true }, localOrigin: "http://127.0.0.1:53001",
};

test("the local backend's own page on screen may ask", () => {
  assert.equal(localPageSent(local), true);
});

test("a remote server's page is refused, even at the same origin", () => {
  assert.equal(localPageSent({ ...local, partition: partitionForOrigin("http://127.0.0.1:53001") }), false);
  assert.equal(localPageSent({ ...local, localOrigin: null }), false);
});

test("a subframe, a destroyed frame or a view no longer on screen is refused", () => {
  assert.equal(localPageSent({ ...local, frame: { ...local.frame!, top: false } }), false);
  assert.equal(localPageSent({ ...local, frame: null }), false);
  assert.equal(localPageSent({ ...local, currentView: false }), false);
});

test("a page from before the backend came back on another port is refused", () => {
  assert.equal(localPageSent({ ...local, localOrigin: "http://127.0.0.1:53002" }), false);
  assert.equal(localPageSent({ ...local, frame: { url: "about:blank", top: true } }), false);
});
