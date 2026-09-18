import { describe, expect, it } from "vitest";
import { pickTileArt } from "./tile-shape";

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
