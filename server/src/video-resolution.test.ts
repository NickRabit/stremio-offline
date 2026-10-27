import assert from "node:assert/strict";
import test from "node:test";
import { videoResolutionClass } from "./video-resolution.js";

test("video resolution classes account for width and height", () => {
  const cases: Array<[number | undefined, number | undefined, number | undefined]> = [
    [1920, 1080, 1080],
    [1920, 800, 1080],
    [1916, 798, 1080],
    [1280, 534, 720],
    [1280, 720, 720],
    [3840, 1600, 2160],
    [4096, 1716, 2160],
    [1440, 1080, 1080],
    [720, 576, 576],
    [720, 480, 480],
    [854, 480, 480],
    [undefined, 1080, 1080],
    [undefined, 800, 720],
    [undefined, undefined, undefined],
    [0, 0, undefined],
    [Number.NaN, Number.NaN, undefined],
  ];
  for (const [width, height, expected] of cases) {
    assert.equal(videoResolutionClass(width, height), expected, `${width}x${height}`);
  }
});
