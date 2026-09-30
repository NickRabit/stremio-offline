/** Containers use ISO 639-1, 639-2/B and 639-2/T side by side, and addons spell the language out on top of that. */
const ALIASES: Record<string, string[]> = {
  cs: ["cs", "cz", "cze", "ces", "czech", "cesky", "ceski", "cestina", "čeština", "český", "české"],
  sk: ["sk", "slk", "slo", "slovak", "slovensky", "slovenčina", "slovenský"],
  en: ["en", "eng", "english", "anglicky", "angličtina"],
  de: ["de", "ger", "deu", "german", "deutsch", "němčina"],
  pl: ["pl", "pol", "polish", "polski", "polština"],
  hu: ["hu", "hun", "hungarian", "magyar"],
  fr: ["fr", "fre", "fra", "french", "francais", "français"],
  es: ["es", "spa", "spanish", "espanol", "español"],
  it: ["it", "ita", "italian", "italiano"],
  ru: ["ru", "rus", "russian"],
  uk: ["uk", "ukr", "ukrainian"],
  ja: ["ja", "jpn", "japanese"],
  ko: ["ko", "kor", "korean"],
  zh: ["zh", "chi", "zho", "chinese"],
  pt: ["pt", "por", "portuguese"],
  nl: ["nl", "dut", "nld", "dutch"],
  da: ["da", "dan", "danish"],
  sv: ["sv", "swe", "swedish"],
  no: ["no", "nor", "norwegian"],
  fi: ["fi", "fin", "finnish"],
  ro: ["ro", "rum", "ron", "romanian"],
  bg: ["bg", "bul", "bulgarian"],
  hr: ["hr", "hrv", "croatian"],
  sr: ["sr", "srp", "serbian"],
  el: ["el", "gre", "ell", "greek"],
  tr: ["tr", "tur", "turkish"],
  ar: ["ar", "ara", "arabic"],
  he: ["he", "heb", "hebrew"],
  hi: ["hi", "hin", "hindi"],
};

const LOOKUP = new Map<string, string>();
for (const [code, aliases] of Object.entries(ALIASES)) for (const alias of aliases) LOOKUP.set(alias, code);

export const LANGUAGE_NAMES: Record<string, string> = {
  cs: "Čeština", sk: "Slovenština", en: "Angličtina", de: "Němčina", pl: "Polština", hu: "Maďarština",
  fr: "Francouzština", es: "Španělština", it: "Italština", ru: "Ruština", uk: "Ukrajinština",
  ja: "Japonština", ko: "Korejština", zh: "Čínština", pt: "Portugalština", nl: "Nizozemština",
  da: "Dánština", sv: "Švédština", no: "Norština", fi: "Finština", ro: "Rumunština", bg: "Bulharština",
  hr: "Chorvatština", sr: "Srbština", el: "Řečtina", tr: "Turečtina", ar: "Arabština", he: "Hebrejština", hi: "Hindština",
};

/** Locales the interface itself is translated into. Everything else is a
 *  content language: pickable for audio and subtitles, never for the UI. */
export const UI_LANGUAGES = ["en", "cs", "sk", "de", "es", "fr", "it", "pl", "pt-BR", "ru"] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];
export const isUiLanguage = (value: unknown): value is UiLanguage => UI_LANGUAGES.includes(value as UiLanguage);

/** Returns the two-letter code, or undefined when the language is not recognised. */
export function normalizeLanguage(value?: string): string | undefined {
  if (!value) return undefined;
  const cleaned = value.toLowerCase().trim().replace(/[_-].*$/, "");
  return LOOKUP.get(cleaned) ?? (/^[a-z]{2}$/.test(cleaned) ? cleaned : undefined);
}

/** The preferred language, then English, then anything. Returns an index into the list, or -1. */
export function pickByLanguage<T extends { language?: string; default?: boolean }>(tracks: T[], preferred?: string): number {
  if (!tracks.length) return -1;
  for (const wanted of [preferred, "en"].filter(Boolean) as string[]) {
    const found = tracks.findIndex((track) => track.language === wanted);
    if (found >= 0) return found;
  }
  const marked = tracks.findIndex((track) => track.default);
  return marked >= 0 ? marked : 0;
}

/** A rescue for files with no language tag: often the language is at least in the track title.
 *  Longer aliases are matched case-insensitively, two-letter ones only as a standalone
 *  upper-case word -- "CZ dabing" is a language, "no" in a sentence is not Norwegian. */
export function detectLanguage(text?: string): string | undefined {
  if (!text) return undefined;
  const haystack = text.toLowerCase();
  for (const [code, aliases] of Object.entries(ALIASES)) {
    for (const alias of aliases) {
      if (alias.length <= 2) continue;
      if (new RegExp(`(^|[^a-z])${alias}([^a-z]|$)`).test(haystack)) return code;
    }
  }
  const upper = new Set(text.match(/\b[A-Z]{2}\b/g) ?? []);
  for (const token of upper) {
    const code = LOOKUP.get(token.toLowerCase());
    if (code) return code;
  }
  return undefined;
}
