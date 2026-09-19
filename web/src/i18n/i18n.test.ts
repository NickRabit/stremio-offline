import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectLocale } from "./detect";
import { pluralForm } from "./plural";
import { en } from "./en";
import { cs } from "./cs";

describe("detectLocale", () => {
  const withLanguages = (languages: string[] | undefined, run: () => void) => {
    const original = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { value: languages, configurable: true });
    try { run(); }
    finally { if (original) Object.defineProperty(navigator, "languages", original); }
  };

  it("takes the first supported language, region tag and all", () => {
    withLanguages(["cs-CZ", "en-US"], () => expect(detectLocale(["en", "cs"], "en")).toBe("cs"));
  });

  it("skips languages we do not ship", () => {
    withLanguages(["de-DE", "sk", "cs"], () => expect(detectLocale(["en", "cs"], "en")).toBe("cs"));
  });

  it("falls back when nothing matches", () => {
    withLanguages(["de-DE", "fr"], () => expect(detectLocale(["en", "cs"], "en")).toBe("en"));
  });

  it("survives a browser that exposes no language list", () => {
    withLanguages([], () => expect(detectLocale(["en", "cs"], "en")).toBe("en"));
  });
});

describe("pluralForm", () => {
  const forms = { one: "one", few: "few", other: "other" };

  it("counts in two for English", () => {
    expect(pluralForm("en", 1, forms)).toBe("one");
    expect(pluralForm("en", 3, forms)).toBe("other");
  });

  it("counts in three for Czech", () => {
    expect(pluralForm("cs", 1, forms)).toBe("one");
    expect(pluralForm("cs", 3, forms)).toBe("few");
    expect(pluralForm("cs", 5, forms)).toBe("other");
  });

  it("falls back to other where a locale has no few form", () => {
    expect(pluralForm("cs", 3, { one: "one", other: "other" })).toBe("other");
  });
});

describe("catalogues", () => {
  it("cover exactly the same keys", () => {
    expect(Object.keys(cs).sort()).toEqual(Object.keys(en).sort());
  });

  it("agree on which entries are plural", () => {
    const shape = (catalog: Record<string, unknown>) =>
      Object.entries(catalog).filter(([, value]) => typeof value !== "string").map(([key]) => key).sort();
    expect(shape(cs)).toEqual(shape(en));
  });

  it("keep every placeholder the English text uses", () => {
    const placeholders = (value: unknown): string[] => typeof value === "string"
      ? [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1])
      : Object.values(value as Record<string, string>).flatMap(placeholders);
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      const wanted = new Set(placeholders(en[key]));
      const got = new Set(placeholders(cs[key]));
      expect({ key, missing: [...wanted].filter((name) => !got.has(name)) }).toEqual({ key, missing: [] });
    }
  });
});

/** A key the server can send that the catalogue does not carry falls back to the server's
 *  English text, so a Czech reader gets an English sentence. The build cannot catch it --
 *  `cs.ts` is typed against `en.ts`, and neither is typed against the server -- so the two
 *  sides are compared here instead. Three keys were found missing this way. */
describe("every message key the server can send exists in the catalogue", () => {
  const serverKeys = () => {
    // vitest runs from the web workspace, so the server sits one level up.
    const root = path.resolve(process.cwd(), "../server/src");
    const keys = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const child = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(child); continue; }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
        for (const [, key] of readFileSync(child, "utf8").matchAll(/"((?:err|auth|download)\.[A-Za-z0-9_]+)"/g)) keys.add(key);
      }
    };
    walk(root);
    return [...keys].sort();
  };

  it("en.ts carries them all", () => {
    const missing = serverKeys().filter((key) => !(key in en));
    expect(missing, `add these to web/src/i18n/en.ts: ${missing.join(", ")}`).toEqual([]);
  });

  it("cs.ts carries them all", () => {
    const missing = serverKeys().filter((key) => !(key in cs));
    expect(missing, `add these to web/src/i18n/cs.ts: ${missing.join(", ")}`).toEqual([]);
  });
});
