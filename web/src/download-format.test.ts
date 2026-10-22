import { describe, expect, it } from "vitest";
import { bytes, fmtEta } from "./download-format";

describe("fmtEta", () => {
  it("never shows sixty of a unit", () => {
    expect(fmtEta(59.5)).toBe("1 min");
    expect(fmtEta(3599)).toBe("1 h 0 min");
    expect(fmtEta(7199)).toBe("2 h 0 min");
    expect(fmtEta(3660)).toBe("1 h 1 min");
  });

  it("does not count below zero when more arrived than was announced", () => {
    expect(fmtEta(-3)).toBe("0 s");
  });
});

describe("bytes", () => {
  it("names terabytes rather than thousands of gigabytes", () => {
    expect(bytes(4e12)).toBe("4.0 TB");
    expect(bytes(48.5e9)).toBe("48.5 GB");
  });
});
