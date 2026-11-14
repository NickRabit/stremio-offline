import assert from "node:assert/strict";
import test from "node:test";
import { SourceLanding } from "./source-landing.js";

test("a source landing can be read, replaced and forgotten", () => {
  const landings = new SourceLanding();

  assert.equal(landings.get("source"), undefined);
  landings.put("source", "https://cdn.example/first.mp4");
  assert.equal(landings.get("source"), "https://cdn.example/first.mp4");
  landings.put("source", "https://cdn.example/second.mp4");
  assert.equal(landings.get("source"), "https://cdn.example/second.mp4");
  landings.forget("source");
  assert.equal(landings.get("source"), undefined);
});

test("a source landing expires on the injected clock", () => {
  let now = 1_000;
  const landings = new SourceLanding(10_000, 512, () => now);
  landings.put("source", "https://cdn.example/film.mp4");

  now += 9_999;
  assert.equal(landings.get("source"), "https://cdn.example/film.mp4");
  now += 1;
  assert.equal(landings.get("source"), undefined);
});

test("using a source landing refreshes it", () => {
  let now = 1_000;
  const landings = new SourceLanding(10_000, 512, () => now);
  landings.put("source", "https://cdn.example/film.mp4");

  now += 8_000;
  landings.put("source", "https://cdn.example/film.mp4");
  now += 8_000;
  assert.equal(landings.get("source"), "https://cdn.example/film.mp4");
});

test("the oldest source landing is dropped at the bound", () => {
  const landings = new SourceLanding(10_000, 2);
  landings.put("first", "https://cdn.example/first.mp4");
  landings.put("second", "https://cdn.example/second.mp4");
  landings.put("third", "https://cdn.example/third.mp4");

  assert.equal(landings.get("first"), undefined);
  assert.equal(landings.get("second"), "https://cdn.example/second.mp4");
  assert.equal(landings.get("third"), "https://cdn.example/third.mp4");
});
