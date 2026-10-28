import { useSyncExternalStore } from "react";
import { detectLocale } from "./detect";
import { pluralForm, type PluralForms } from "./plural";
import { en } from "./en";

export const LOCALES = ["en", "cs", "sk", "de", "es", "fr", "it", "pl", "pt-BR", "ru"] as const;
export type Locale = (typeof LOCALES)[number];
export type Catalog = { [K in keyof typeof en]: (typeof en)[K] extends string ? string : PluralForms };
export type Key = keyof Catalog;
export type Vars = Record<string, string | number>;

/** Always written in the language itself: someone looking for Czech finds "Čeština"
 *  even while the interface is still English. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English", cs: "Čeština", sk: "Slovenčina", de: "Deutsch", es: "Español",
  fr: "Français", it: "Italiano", pl: "Polski", "pt-BR": "Português (Brasil)", ru: "Русский",
};

// English ships with the page and stands in for any missing key. Every other language is its own
// chunk, fetched when it is chosen: nine catalogues nobody reads were nearly half the first load.
const LOADERS: Record<Exclude<Locale, "en">, () => Promise<Catalog>> = {
  cs: () => import("./cs").then((module) => module.cs),
  sk: () => import("./sk").then((module) => module.sk),
  de: () => import("./de").then((module) => module.de),
  es: () => import("./es").then((module) => module.es),
  fr: () => import("./fr").then((module) => module.fr),
  it: () => import("./it").then((module) => module.it),
  pl: () => import("./pl").then((module) => module.pl),
  "pt-BR": () => import("./ptBR").then((module) => module.ptBR),
  ru: () => import("./ru").then((module) => module.ru),
};
const catalogs: Partial<Record<Locale, Catalog>> = { en };

export async function loadCatalog(next: Locale): Promise<void> {
  if (catalogs[next]) return;
  catalogs[next] = await LOADERS[next as Exclude<Locale, "en">]();
}
const CACHE_KEY = "ui-language";
const isLocale = (value: unknown): value is Locale => LOCALES.includes(value as Locale);

/** The cached value only decides the first paint. The server's answer replaces it as
 *  soon as /api/auth/me lands, and private mode may refuse storage entirely. */
const cached = (): Locale | undefined => {
  try { const value = localStorage.getItem(CACHE_KEY); return isLocale(value) ? value : undefined; }
  catch { return undefined; }
};

/** The desktop app hands its own language to the page of the server it runs, so a first run
 *  speaks the language picked on the app's welcome screen rather than the one Chromium started with. */
const desktopLocale = (): Locale | undefined => {
  const value = (globalThis as { stremioDesktop?: { locale?: unknown } }).stremioDesktop?.locale;
  return isLocale(value) ? value : undefined;
};

// A language only becomes current once its catalogue is here, so nothing is ever drawn half in
// English. The last one asked for wins when two are still loading.
let current: Locale = "en";
let requested: Locale = cached() ?? desktopLocale() ?? detectLocale(LOCALES, "en");
const listeners = new Set<() => void>();

const apply = (next: Locale) => {
  current = next;
  document.documentElement.lang = localeTag(next);
  for (const listener of listeners) listener();
};

export const locale = () => current;
export function setLocale(next: Locale) {
  if (!isLocale(next)) return;
  requested = next;
  try { localStorage.setItem(CACHE_KEY, next); } catch { /* storage may be unavailable */ }
  if (next === current) return;
  if (catalogs[next]) { apply(next); return; }
  // A catalogue that cannot be fetched leaves the interface in the language it already speaks.
  void loadCatalog(next).then(() => { if (requested === next) apply(next); }, () => undefined);
}

/** Settles once the first language is ready to draw; the page renders after it, not before. */
export const i18nReady: Promise<void> = (() => {
  const first = requested;
  return loadCatalog(first).then(() => { if (requested === first && first !== current) apply(first); }, () => undefined);
})();

const fill = (text: string, vars?: Vars) =>
  vars ? text.replace(/\{(\w+)\}/g, (match, name) => name in vars ? String(vars[name]) : match) : text;

/** Missing keys render as the key itself: visible in a screenshot, harmless in
 *  production, and the typed catalogue makes them a build error anyway. */
export function t(key: Key, vars?: Vars): string {
  const entry = (catalogs[current] ?? en)[key] ?? en[key];
  if (entry === undefined) return key;
  const text = typeof entry === "string" ? entry : pluralForm(current, Number(vars?.count ?? 0), entry);
  return fill(text, vars);
}

/** A message the server produced: the key is translated when we ship it, and the
 *  server's own English text stands in for anything this build does not know -- a
 *  message added after it, or one that only exists in a log. */
export function serverText(key: string | undefined, fallback: string, vars?: Vars): string {
  return key && key in en ? t(key as Key, vars) : fallback;
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function useI18n() {
  const active = useSyncExternalStore(subscribe, locale, locale);
  return { t, locale: active, setLocale };
}

/** Language names come from the browser, so every UI locale gets them for free and
 *  no hand-written table can go stale. Czech writes them lower case in a sentence;
 *  standing on their own in a menu they read better capitalised. */
export function languageName(code: string): string {
  try {
    const name = new Intl.DisplayNames([current], { type: "language" }).of(code);
    return name ? name.charAt(0).toLocaleUpperCase(current) + name.slice(1) : code.toUpperCase();
  }
  catch { return code.toUpperCase(); }
}

/** The language's name as it reads inside a sentence: "angličtina" in Czech, "English" in English. */
export function inlineLanguageName(code: string): string {
  try { return new Intl.DisplayNames([current], { type: "language" }).of(code) ?? code.toUpperCase(); }
  catch { return code.toUpperCase(); }
}

const LOCALE_TAGS: Record<Locale, string> = {
  en: "en-GB", cs: "cs-CZ", sk: "sk-SK", de: "de-DE", es: "es-ES", fr: "fr-FR",
  it: "it-IT", pl: "pl-PL", "pt-BR": "pt-BR", ru: "ru-RU",
};
export const localeTag = (value: Locale = current) => LOCALE_TAGS[value];
if (typeof document !== "undefined") document.documentElement.lang = localeTag();
