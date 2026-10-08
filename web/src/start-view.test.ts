import { describe, expect, it } from "vitest";
import { resolveStartView } from "./start-view";

describe("resolveStartView", () => {
  it("does nothing for the default catalogue", () => {
    expect(resolveStartView("catalog", { restricted: false, navigated: false })).toBe(null);
  });

  it("never opens Home for a restricted account", () => {
    expect(resolveStartView("home", { restricted: true, navigated: false })).toBe(null);
  });

  it("does nothing once the person has navigated", () => {
    expect(resolveStartView("home", { restricted: false, navigated: true })).toBe(null);
    expect(resolveStartView("library", { restricted: false, navigated: true })).toBe(null);
  });

  it("hands back the chosen view otherwise", () => {
    expect(resolveStartView("catalog", { restricted: false, navigated: false })).toBe(null);
    expect(resolveStartView("home", { restricted: false, navigated: false })).toBe("home");
    expect(resolveStartView("library", { restricted: false, navigated: false })).toBe("library");
  });
});
