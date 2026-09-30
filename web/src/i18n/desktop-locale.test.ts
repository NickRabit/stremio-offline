import { afterEach, describe, expect, it, vi } from "vitest";

const memoryStorage = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
  };
};

const firstLocale = async (desktop: string, browser: string, stored: Record<string, string> = {}) => {
  vi.resetModules();
  vi.stubGlobal("localStorage", memoryStorage(stored));
  vi.stubGlobal("stremioDesktop", { version: 1, locale: desktop, pickFolder: async () => null });
  vi.stubGlobal("navigator", { ...navigator, language: browser, languages: [browser] });
  return (await import("./index")).locale();
};

describe("the first language of a page the desktop app serves", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  it("is the language picked in the app, not the browser's", async () => {
    expect(await firstLocale("cs", "en-US")).toBe("cs");
  });

  it("gives way to a language the page already stored", async () => {
    expect(await firstLocale("cs", "en-US", { "ui-language": "de" })).toBe("de");
  });

  it("falls back to the browser for a language it does not know", async () => {
    expect(await firstLocale("xx", "sk")).toBe("sk");
  });
});
