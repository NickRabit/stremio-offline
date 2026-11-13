import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectLocale } from "./detect";
import { localePreloadSource } from "./locale-preload";

const chunks = { cs: "/assets/cs-x.js", sk: "/assets/sk-x.js", "pt-BR": "/assets/ptBR-x.js" };
const source = localePreloadSource(chunks);
const supported = ["en", ...Object.keys(chunks)];

const run = () => {
  new Function(source)();
};

const preloads = () => document.head.querySelectorAll("link[rel=modulepreload]");

const stubModulePreload = (supported: boolean) => {
  const relList = document.createElement("link").relList;
  const proto = Object.getPrototypeOf(relList) as { supports?: (token: string) => boolean };
  const original = Object.getOwnPropertyDescriptor(proto, "supports");
  Object.defineProperty(proto, "supports", {
    configurable: true,
    value: () => supported,
  });
  return () => {
    if (original) Object.defineProperty(proto, "supports", original);
    else delete proto.supports;
  };
};

const setLanguages = (languages: readonly string[]) => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: languages });
  return () => {
    if (descriptor) Object.defineProperty(navigator, "languages", descriptor);
  };
};

describe("localePreloadSource", () => {
  let restoreSupports: (() => void) | undefined;
  let restoreLanguages: (() => void) | undefined;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve()));
  });

  afterEach(() => {
    for (const link of preloads()) link.remove();
    localStorage.removeItem("ui-language");
    delete (globalThis as { stremioDesktop?: unknown }).stremioDesktop;
    restoreSupports?.();
    restoreSupports = undefined;
    restoreLanguages?.();
    restoreLanguages = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const enablePreload = () => {
    restoreSupports = stubModulePreload(true);
  };

  const useLanguages = (languages: readonly string[]) => {
    restoreLanguages = setLanguages(languages);
  };

  it("preloads the chunk for a stored language", () => {
    enablePreload();
    useLanguages(["sk"]);
    localStorage.setItem("ui-language", "cs");
    run();
    expect(preloads()).toHaveLength(1);
    expect(document.head.querySelector('link[rel=modulepreload][href="/assets/cs-x.js"]')).not.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("adds nothing for English", () => {
    enablePreload();
    useLanguages(["cs"]);
    localStorage.setItem("ui-language", "en");
    run();
    expect(preloads()).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("matches a regional browser tag against the catalogue", () => {
    enablePreload();
    useLanguages(["pt-br"]);
    run();
    expect(document.head.querySelector('link[rel=modulepreload][href="/assets/ptBR-x.js"]')).not.toBeNull();
  });

  it("matches the base language before later browser tags", () => {
    enablePreload();
    useLanguages(["sk-SK", "en"]);
    run();
    expect(preloads()).toHaveLength(1);
    expect(document.head.querySelector('link[rel=modulepreload][href="/assets/sk-x.js"]')).not.toBeNull();
  });

  it("prefers the desktop app language over the browser", () => {
    enablePreload();
    useLanguages(["sk"]);
    (globalThis as { stremioDesktop?: { locale: string } }).stremioDesktop = { locale: "cs" };
    run();
    expect(preloads()).toHaveLength(1);
    expect(document.head.querySelector('link[rel=modulepreload][href="/assets/cs-x.js"]')).not.toBeNull();
  });

  it("ignores a stored value that is not a supported locale", () => {
    enablePreload();
    useLanguages(["sk"]);
    localStorage.setItem("ui-language", "xx");
    run();
    expect(document.head.querySelector('link[rel=modulepreload][href="/assets/sk-x.js"]')).not.toBeNull();
  });

  it("fetches the chunk when modulepreload is unsupported", () => {
    restoreSupports = stubModulePreload(false);
    localStorage.setItem("ui-language", "cs");
    run();
    expect(preloads()).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/assets/cs-x.js");
  });

  it("falls through when localStorage throws", () => {
    enablePreload();
    useLanguages(["pt-br"]);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    expect(() => run()).not.toThrow();
    expect(document.head.querySelector('link[rel=modulepreload][href="/assets/ptBR-x.js"]')).not.toBeNull();
  });

  it("chooses the same locale as detectLocale", () => {
    enablePreload();
    const lists = [
      ["cs-CZ", "en-US"],
      ["de-DE", "sk", "cs"],
      ["pt-BR", "pt-PT"],
      ["pt-PT"],
      ["pt_BR"],
      ["sk-SK", "en"],
      ["en-US"],
      ["fr-FR"],
      ["SK"],
      [],
    ];
    for (const languages of lists) {
      for (const link of preloads()) link.remove();
      localStorage.removeItem("ui-language");
      useLanguages(languages);
      run();
      const link = document.head.querySelector("link[rel=modulepreload]");
      const href = link?.getAttribute("href");
      const chosen = href ? Object.entries(chunks).find(([, url]) => url === href)?.[0] : "en";
      expect(chosen, languages.join(",")).toBe(detectLocale(supported, "en"));
      restoreLanguages?.();
      restoreLanguages = undefined;
    }
  });
});
