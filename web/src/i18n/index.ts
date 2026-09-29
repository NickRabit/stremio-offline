import { useSyncExternalStore } from "react";
import { detectLocale } from "./detect";
import { pluralForm, type PluralForms } from "./plural";
import { en } from "./en";
import { cs } from "./cs";
import { sk } from "./sk";
import { de } from "./de";
import { es } from "./es";
import { fr } from "./fr";
import { it } from "./it";
import { pl } from "./pl";
import { ptBR } from "./ptBR";
import { ru } from "./ru";

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

const CATALOGS: Record<Locale, Catalog> = { en, cs, sk, de, es, fr, it, pl, "pt-BR": ptBR, ru };
const CACHE_KEY = "ui-language";
const isLocale = (value: unknown): value is Locale => LOCALES.includes(value as Locale);

/** The cached value only decides the first paint. The server's answer replaces it as
 *  soon as /api/auth/me lands, and private mode may refuse storage entirely. */
const cached = (): Locale | undefined => {
  try { const value = localStorage.getItem(CACHE_KEY); return isLocale(value) ? value : undefined; }
  catch { return undefined; }
};

let current: Locale = cached() ?? detectLocale(LOCALES, "en");
const listeners = new Set<() => void>();

export const locale = () => current;
export function setLocale(next: Locale) {
  if (!isLocale(next) || next === current) return;
  current = next;
  try { localStorage.setItem(CACHE_KEY, next); } catch { /* storage may be unavailable */ }
  document.documentElement.lang = localeTag(next);
  for (const listener of listeners) listener();
}

const fill = (text: string, vars?: Vars) =>
  vars ? text.replace(/\{(\w+)\}/g, (match, name) => name in vars ? String(vars[name]) : match) : text;

/** Missing keys render as the key itself: visible in a screenshot, harmless in
 *  production, and the typed catalogue makes them a build error anyway. */
export function t(key: Key, vars?: Vars): string {
  const entry = CATALOGS[current][key] ?? en[key];
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

const LOCALE_TAGS: Record<Locale, string> = {
  en: "en-GB", cs: "cs-CZ", sk: "sk-SK", de: "de-DE", es: "es-ES", fr: "fr-FR",
  it: "it-IT", pl: "pl-PL", "pt-BR": "pt-BR", ru: "ru-RU",
};
export const localeTag = (value: Locale = current) => LOCALE_TAGS[value];
if (typeof document !== "undefined") document.documentElement.lang = localeTag();
