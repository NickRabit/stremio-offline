import { describe, expect, it } from "vitest";
import { cropSquare } from "./avatar-image";

describe("cropSquare", () => {
  it("takes equal margins from a wide picture", () => {
    expect(cropSquare(1200, 800)).toEqual({ sx: 200, sy: 0, side: 800 });
  });

  it("takes equal margins from a tall picture", () => {
    expect(cropSquare(600, 1000)).toEqual({ sx: 0, sy: 200, side: 600 });
  });

  it("leaves a square unchanged", () => {
    expect(cropSquare(512, 512)).toEqual({ sx: 0, sy: 0, side: 512 });
  });
});
