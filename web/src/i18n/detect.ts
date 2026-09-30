/** First run only: no account exists yet, so there is nothing stored to read and the
 *  browser is the best guess we have. Once a language is stored it always wins --
 *  a Czech install opened from an English laptop must stay Czech. */
export function detectLocale<T extends string>(supported: readonly T[], fallback: T): T {
  const tags = (typeof navigator !== "undefined" && navigator.languages?.length ? navigator.languages : [navigator?.language]).filter(Boolean);
  const normalized = tags.map((tag) => String(tag).toLowerCase().replaceAll("_", "-"));
  for (const tag of normalized) {
    const exact = supported.find((candidate) => candidate.toLowerCase() === tag);
    if (exact) return exact;
    const base = tag.split("-")[0];
    const language = supported.find((candidate) => candidate.toLowerCase().split("-")[0] === base);
    if (language) return language;
  }
  return fallback;
}
