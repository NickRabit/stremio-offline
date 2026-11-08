import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectLocale } from "./detect";
import { pluralForm } from "./plural";
import { en } from "./en";
import { cs } from "./cs";
import { sk } from "./sk";
import { de } from "./de";
import { es } from "./es";
import { fr } from "./fr";
import { it as itIT } from "./it";
import { pl } from "./pl";
import { ptBR } from "./ptBR";
import { ru } from "./ru";

const catalogues: Record<string, Record<keyof typeof en, unknown>> = { en, cs, sk, de, es, fr, it: itIT, pl, "pt-BR": ptBR, ru };

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

  it("matches a language region and prefers an exact regional choice", () => {
    withLanguages(["pt-BR", "pt-PT"], () => expect(detectLocale(["en", "pt-BR"], "en")).toBe("pt-BR"));
    withLanguages(["pt-PT"], () => expect(detectLocale(["en", "pt-BR"], "en")).toBe("pt-BR"));
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

  it("uses each language's grammatical plural categories", () => {
    const forms = { one: "one", few: "few", many: "many", other: "other" };
    expect(pluralForm("sk", 3, forms)).toBe("few");
    expect(pluralForm("pl", 2, forms)).toBe("few");
    expect(pluralForm("pl", 5, forms)).toBe("many");
    expect(pluralForm("ru", 22, forms)).toBe("few");
    expect(pluralForm("ru", 25, forms)).toBe("many");
    expect(pluralForm("de", 2, forms)).toBe("other");
  });
});

describe("catalogues", () => {
  it("cover exactly the same keys", () => {
    for (const [locale, catalog] of Object.entries(catalogues)) {
      expect(Object.keys(catalog).sort(), locale).toEqual(Object.keys(en).sort());
    }
  });

  it("agree on which entries are plural", () => {
    const shape = (catalog: Record<string, unknown>) =>
      Object.entries(catalog).filter(([, value]) => typeof value !== "string").map(([key]) => key).sort();
    for (const [locale, catalog] of Object.entries(catalogues)) {
      expect(shape(catalog), locale).toEqual(shape(en));
    }
  });

  it("keep every placeholder the English text uses", () => {
    const placeholders = (value: unknown): string[] => typeof value === "string"
      ? [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1])
      : Object.values(value as Record<string, string>).flatMap(placeholders);
    for (const [locale, catalog] of Object.entries(catalogues)) {
      for (const key of Object.keys(en) as Array<keyof typeof en>) {
        const wanted = new Set(placeholders(en[key]));
        const got = new Set(placeholders(catalog[key]));
        expect({ locale, key, missing: [...wanted].filter((name) => !got.has(name)) }).toEqual({ locale, key, missing: [] });
      }
    }
  });

  it("carry no invisible characters a translation tool left behind", () => {
    const texts = (value: unknown): string[] => typeof value === "string" ? [value] : Object.values(value as Record<string, string>);
    for (const [locale, catalog] of Object.entries(catalogues)) {
      const found = Object.entries(catalog)
        .filter(([, value]) => texts(value).some((text) => /[\u200b-\u200d\u2060\ufeff]/.test(text)))
        .map(([key]) => key);
      expect({ locale, found }).toEqual({ locale, found: [] });
    }
  });

  it("describe an invalid follow as generic invalid settings", () => {
    expect(catalogues.en["err.followInvalid"]).toBe("The follow settings are not valid.");
    expect(catalogues.cs["err.followInvalid"]).toBe("Nastavení sledování není platné.");
    for (const [locale, catalog] of Object.entries(catalogues)) {
      expect(String(catalog["err.followInvalid"]).toLowerCase(), locale)
        .not.toMatch(/series|serial|seriál/);
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

  it("each added locale carries every message the server can send", () => {
    for (const [locale, catalog] of Object.entries(catalogues)) {
      const missing = serverKeys().filter((key) => !(key in catalog));
      expect(missing, `${locale}: ${missing.join(", ")}`).toEqual([]);
    }
  });
});

describe("plural catalogues", () => {
  // French and Brazilian Portuguese file 0 under "one", Russian files 21, 31, 101 there: a form
  // that spells out "1" shows that number for all of them.
  const samples = [0, 1, 2, 5, 21, 22, 25, 101];
  // Counts that never reach the other numbers of "one": the download of a whole show starts at one
  // episode, and the refresh interval is picked from 6, 12, 24 and 48 hours.
  const exempt = new Set(["fr episodes.wholeShowCount", "pt-BR episodes.wholeShowCount", "settings.addonRefreshHoursOption"]);

  it("never spells out the number in a form that covers more than one count", () => {
    const wrong: string[] = [];
    for (const [code, catalogue] of Object.entries(catalogues)) {
      const rules = new Intl.PluralRules(code);
      for (const [key, value] of Object.entries(catalogue)) {
        if (typeof value !== "object" || value === null) continue;
        for (const [category, text] of Object.entries(value as Record<string, string>)) {
          const counts = samples.filter((count) => rules.select(count) === category);
          if (exempt.has(`${code} ${key}`) || exempt.has(key)) continue;
          if (counts.length > 1 && !text.includes("{count}")) wrong.push(`${code} ${key}.${category}: ${text}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it("counts titles, items and versions with the plural rules of each language", () => {
    const counted = ["library.titleCount", "library.fileCount", "library.bulkItems", "library.bulkDeleteConfirm", "library.suggestionsWaiting", "mediaServer.versionsAvailable"] as const;
    for (const [code, catalogue] of Object.entries(catalogues)) {
      for (const key of counted) expect(typeof catalogue[key], `${code} ${key}`).toBe("object");
      // The counts are filled in already pluralised, so the template itself carries no noun.
      expect(catalogue["library.libraryCounts"], code).toBe("{titles} · {files} · {size}");
    }
    expect(pluralForm("cs", 4, cs["library.titleCount"] as never).replace("{count}", "4")).toBe("4 tituly");
    expect(pluralForm("cs", 2, cs["library.bulkItems"] as never).replace("{count}", "2")).toBe("2 položky");
    expect(pluralForm("en", 1, en["mediaServer.versionsAvailable"])).toBe("{count} version available");
  });
});
