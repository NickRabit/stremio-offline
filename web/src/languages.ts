export { bingeGroupLanguages, guessLanguages, leavesLanguageBlank, titleLanguage } from "@stremio-offline/source-selection";

export const LANGUAGE_LABEL: Record<string, string> = {
  cs: "CZ", sk: "SK", en: "EN", de: "DE", pl: "PL", hu: "HU", fr: "FR", es: "ES", it: "IT",
  ru: "RU", uk: "UA", ja: "JP", ko: "KR", zh: "CN", pt: "PT", nl: "NL", da: "DK", sv: "SE",
  no: "NO", fi: "FI", ro: "RO", bg: "BG", hr: "HR", sr: "RS", el: "GR", tr: "TR", ar: "AR", he: "IL", hi: "IN",
};
export const label = (code?: string) => code ? LANGUAGE_LABEL[code] ?? code.toUpperCase() : "?";

/** Which subtitles an addon should supply when the viewer has not chosen for themselves.
 *  Addon subtitles are always the whole film, never the forced lines alone, so they belong
 *  to a viewer who cannot follow the dialogue: nothing at all while the audio is the language
 *  they asked for, and otherwise their language, with English after it. */
export function pickAddonSubtitle<T extends { lang?: string }>(
  items: T[], preferred: string, spoken?: string, understood?: string,
): T | null {
  if (understood && spoken === understood) return null;
  const speaks = (item: T, language: string) => (item.lang ?? "").toLowerCase().startsWith(language);
  return items.find((item) => speaks(item, preferred)) ?? items.find((item) => speaks(item, "en")) ?? null;
}
