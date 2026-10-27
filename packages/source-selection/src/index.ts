export interface ListedSource {
  name?: string;
  title?: string;
  description?: string;
  behaviorHints?: {
    filename?: string;
    videoSize?: number;
    bingeGroup?: string;
  };
}

export const sourceText = (source: ListedSource): string =>
  [source.name, source.title, source.description, source.behaviorHints?.filename].filter(Boolean).join(" ");

const UNITS: Record<string, number> = { tb: 1e12, gb: 1e9, mb: 1e6, kb: 1e3, t: 1e12, g: 1e9 };
// Addons put sizes in text, including Luna's short "2.2G", sometimes beside a bitrate.
const SIZE = /(\d+(?:[.,]\d+)?)\s*(TB|GB|MB|KB|T|G)\b(?!\s*(?:\/\s*s|ps|it)\b)/gi;

export function sourceSize(source: ListedSource): number | undefined {
  const hinted = source.behaviorHints?.videoSize;
  if (typeof hinted === "number" && hinted > 0) return hinted;
  const matches = [...sourceText(source).matchAll(SIZE)];
  const match = matches[matches.length - 1];
  if (!match) return undefined;
  const value = Number(match[1].replace(",", "."));
  const unit = UNITS[match[2].toLowerCase()];
  return Number.isFinite(value) && unit ? Math.round(value * unit) : undefined;
}

const FLAGS: Record<string, string> = {
  "\u{1F1E8}\u{1F1FF}": "cs", "\u{1F1F8}\u{1F1F0}": "sk", "\u{1F1EC}\u{1F1E7}": "en", "\u{1F1FA}\u{1F1F8}": "en",
  "\u{1F1E9}\u{1F1EA}": "de", "\u{1F1F5}\u{1F1F1}": "pl", "\u{1F1ED}\u{1F1FA}": "hu", "\u{1F1EB}\u{1F1F7}": "fr",
  "\u{1F1EA}\u{1F1F8}": "es", "\u{1F1EE}\u{1F1F9}": "it", "\u{1F1F7}\u{1F1FA}": "ru", "\u{1F1FA}\u{1F1E6}": "uk",
};
const WORDS: Array<[RegExp, string]> = [
  [/\b(czech|cesky|česky|čeština|cestina|cz|cze|ces)\b/i, "cs"],
  [/\b(slovak|slovensky|slovenčina|sk|slk)\b/i, "sk"],
  [/\b(english|eng|en)\b/i, "en"],
  [/\b(german|deutsch|ger|deu)\b/i, "de"],
  [/\b(polish|polski|pol)\b/i, "pl"],
  [/\b(hungarian|magyar|hun)\b/i, "hu"],
];

// Only a whole field can name a language; Torrentio sometimes puts an infohash here.
const BINGE_CODES: Record<string, string> = {
  cz: "cs", cs: "cs", cze: "cs", ces: "cs", czech: "cs",
  sk: "sk", slk: "sk", slovak: "sk",
  en: "en", eng: "en", english: "en",
  de: "de", ger: "de", deu: "de", german: "de",
  pl: "pl", pol: "pl", polish: "pl",
  hu: "hu", hun: "hu", hungarian: "hu",
};

const LANGUAGE_NAMES: Record<string, string> = {
  czech: "cs", slovak: "sk", english: "en", german: "de", polish: "pl", hungarian: "hu",
  french: "fr", spanish: "es", italian: "it", russian: "ru", ukrainian: "uk",
};

export function guessLanguages(text: string): string[] {
  const found = new Set<string>();
  for (const [flag, code] of Object.entries(FLAGS)) if (text.includes(flag)) found.add(code);
  for (const [pattern, code] of WORDS) if (pattern.test(text)) found.add(code);
  return [...found];
}

export function bingeGroupLanguages(value?: string): string[] {
  if (!value) return [];
  const found = new Set<string>();
  for (const token of value.split(/[|,/\s]+/)) {
    const code = BINGE_CODES[token.toLowerCase()];
    if (code) found.add(code);
  }
  return [...found];
}

export const leavesLanguageBlank = (value?: string): boolean =>
  !!value && value.includes("|") && value.split("|").includes("");

export function sourceLanguages(source: ListedSource, titleFallback?: string): string[] {
  const found = new Set([...guessLanguages(sourceText(source)), ...bingeGroupLanguages(source.behaviorHints?.bingeGroup)]);
  // A blank addon field admits no match; a torrent listing's absent field does not.
  if (!found.size && titleFallback && leavesLanguageBlank(source.behaviorHints?.bingeGroup)) found.add(titleFallback);
  return [...found];
}

export function titleLanguage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  for (const part of value.split(/[,/]/)) {
    const code = LANGUAGE_NAMES[part.trim().toLowerCase()];
    if (code) return code;
  }
  return undefined;
}
