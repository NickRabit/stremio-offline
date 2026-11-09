import { describe, expect, it } from "vitest";
import { formatRuntime, runtimeLabel, runtimeMinutes } from "./runtime-format";

describe("runtimeMinutes", () => {
  it("reads the shapes addons send", () => {
    expect(runtimeMinutes("136 min")).toBe(136);
    expect(runtimeMinutes("2h 16min")).toBe(136);
    expect(runtimeMinutes("2 h 16 min")).toBe(136);
    expect(runtimeMinutes("PT2H16M")).toBe(136);
    expect(runtimeMinutes(136)).toBe(136);
  });

  it("ignores zero, junk and missing values", () => {
    expect(runtimeMinutes("0 min")).toBeUndefined();
    expect(runtimeMinutes("PT")).toBeUndefined();
    expect(runtimeMinutes("N/A")).toBeUndefined();
    expect(runtimeMinutes(undefined)).toBeUndefined();
  });
});

describe("formatRuntime", () => {
  it("writes hours and minutes instead of a minute count", () => {
    expect(formatRuntime(136, "cs-CZ")).toBe("2 h 16 min");
    expect(formatRuntime(120, "cs-CZ")).toBe("2 h");
    expect(formatRuntime(49, "cs-CZ")).toBe("49 min");
    expect(formatRuntime(136, "en-US")).toBe("2 hr 16 min");
  });
});

describe("runtimeLabel", () => {
  it("keeps a short text it cannot read and drops a long one", () => {
    expect(runtimeLabel("136 min", "cs-CZ")).toBe("2 h 16 min");
    expect(runtimeLabel("ca. 2 Std.", "de-DE")).toBe("ca. 2 Std.");
    expect(runtimeLabel("x".repeat(40), "cs-CZ")).toBeUndefined();
    expect(runtimeLabel("  ", "cs-CZ")).toBeUndefined();
  });
});
