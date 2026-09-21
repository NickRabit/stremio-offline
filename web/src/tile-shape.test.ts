import { describe, expect, it } from "vitest";
import { fitFor, pickTileArt } from "./tile-shape";

describe("pickTileArt", () => {
  it("fills the frame with the picture the shape asked for", () => {
    expect(pickTileArt("poster", "poster.jpg", "wide.jpg")).toEqual({ url: "poster.jpg", fit: "cover" });
    expect(pickTileArt("wide", "poster.jpg", "wide.jpg")).toEqual({ url: "wide.jpg", fit: "cover" });
  });

  it("letterboxes the other picture rather than cropping it", () => {
    expect(pickTileArt("wide", "poster.jpg", undefined)).toEqual({ url: "poster.jpg", fit: "contain" });
    expect(pickTileArt("poster", undefined, "wide.jpg")).toEqual({ url: "wide.jpg", fit: "contain" });
  });

  it("leaves the tile to draw its own icon when the title has no picture", () => {
    expect(pickTileArt("poster", undefined, undefined)).toEqual({ fit: "cover" });
    expect(pickTileArt("wide", undefined, undefined)).toEqual({ fit: "cover" });
  });

  it("treats an empty address as no picture at all", () => {
    expect(pickTileArt("wide", "poster.jpg", "")).toEqual({ url: "poster.jpg", fit: "contain" });
    expect(pickTileArt("poster", "   ", "wide.jpg")).toEqual({ url: "wide.jpg", fit: "contain" });
    expect(pickTileArt("poster", "", "")).toEqual({ fit: "cover" });
  });
});

describe("fitFor", () => {
  it("fills the frame when the picture really is the shape the tile wants", () => {
    expect(fitFor("poster", 1000, 1500)).toBe("cover");
    expect(fitFor("wide", 1280, 720)).toBe("cover");
  });

  it("letterboxes a picture the catalogue filed under the wrong shape", () => {
    expect(fitFor("poster", 1280, 720)).toBe("contain");
    expect(fitFor("wide", 1024, 1979)).toBe("contain");
  });

  it("leaves a near-square picture and an unmeasured one filling the frame", () => {
    expect(fitFor("poster", 1000, 1000)).toBe("cover");
    expect(fitFor("wide", 0, 0)).toBe("cover");
  });
});
