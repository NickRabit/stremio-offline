import { afterEach, describe, expect, it, vi } from "vitest";
import { rememberedStartView, rememberStartView, resolveStartView } from "./start-view";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("rememberedStartView", () => {
  it("defaults to Home", () => {
    expect(rememberedStartView()).toBe("home");
  });

  it("returns a stored start view", () => {
    localStorage.setItem("start-view", "library");
    expect(rememberedStartView()).toBe("library");
  });

  it("defaults to Home for an invalid value", () => {
    localStorage.setItem("start-view", "search");
    expect(rememberedStartView()).toBe("home");
  });

  it("defaults to Home when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(rememberedStartView()).toBe("home");
  });

  it("remembers a start view", () => {
    rememberStartView("catalog");
    expect(localStorage.getItem("start-view")).toBe("catalog");
  });
});

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

  it("keeps an install with no catalogue on the catalogue's onboarding", () => {
    expect(resolveStartView("home", { restricted: false, navigated: false, hasCatalogs: false })).toBe(null);
    expect(resolveStartView("library", { restricted: false, navigated: false, hasCatalogs: false })).toBe(null);
  });
});
