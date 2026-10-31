import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { localeTag, t, useI18n, type Locale } from "./i18n";
import { hideBroken } from "./settings-ui";
import type { RelatedTitle, TitleExtras, TitlePerson } from "./types";

export interface TitleExtrasTarget {
  type: "movie" | "series";
  id: string;
  name: string;
  poster?: string;
}

export interface TitleExtrasActionsValue {
  searchPerson: (name: string) => void;
  openTitle: (title: TitleExtrasTarget) => void;
}

export const TitleExtrasActions = createContext<TitleExtrasActionsValue>({
  searchPerson: () => undefined,
  openTitle: () => undefined,
});

const CREW_ROLES = ["creator", "director", "writer", "novel"] as const;

const ROLE_KEY = {
  creator: "detail.role.creator",
  director: "detail.role.director",
  writer: "detail.role.writer",
  novel: "detail.role.novel",
} as const;

const UI_LOCALES = new Set<string>(["en", "cs", "sk", "de", "es", "fr", "it", "pl", "pt-BR", "ru"]);

const initials = (name: string) => {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = (words.length > 1 ? words.slice(0, 2) : words).map((word) => word.charAt(0));
  return letters.join("").toLocaleUpperCase();
};

function PersonFace({ name, photo }: { name: string; photo?: string }) {
  const [broken, setBroken] = useState(false);
  const source = photo?.trim();
  if (!source || broken) return <span className="person-face">{initials(name)}</span>;
  return <span className="person-face"><img src={source} alt="" onError={() => setBroken(true)}/></span>;
}

function emphasize(template: string, value: string): ReactNode {
  const marker = "\u0000";
  const [before, after] = template.split(marker);
  if (after === undefined) return template;
  return <>{before}<b>{value}</b>{after}</>;
}

/** The day an episode is released, the same UTC calendar date the follow list uses. */
function releaseDay(value: string, language: string): string {
  if (!value) return "";
  const tag = UI_LOCALES.has(language) ? localeTag(language as Locale) : localeTag();
  return new Date(value).toLocaleDateString(tag, { timeZone: "UTC" });
}

function displayName(code: string, uiLanguage: string, type: "language" | "region"): string | null {
  try {
    return new Intl.DisplayNames([uiLanguage], { type }).of(code) ?? null;
  } catch {
    return null;
  }
}

function languageLabel(code: string, uiLanguage: string): string {
  return displayName(code, uiLanguage, "language") ?? code.toUpperCase();
}

function regionLabel(code: string, uiLanguage: string): string {
  return displayName(code, uiLanguage, "region") ?? code;
}

const sameText = (left: string, right: string) => left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();

/** Still in the future: an episode that has already aired is not the next one. */
const upcoming = (released: string) => {
  const at = Date.parse(released);
  return Number.isFinite(at) && at > Date.now();
};

function episodeCode(next: NonNullable<TitleExtras["nextEpisode"]>): string {
  const code = `S${String(next.season).padStart(2, "0")}E${String(next.episode).padStart(2, "0")}`;
  const name = next.name?.trim();
  return name ? `${code} „${name}“` : code;
}

/** Re-reads the clock once a minute so a pill leaves when the episode airs, without a remount. */
function NextEpisodePill({ next, language }: { next: NonNullable<TitleExtras["nextEpisode"]>; language: string }) {
  const [, setTick] = useState(0);
  const aired = !upcoming(next.released);
  useEffect(() => {
    if (aired) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 60_000);
    return () => window.clearInterval(timer);
  }, [aired, next.released]);
  if (!upcoming(next.released)) return null;
  return <p className="next-episode">{nextEpisodeLine(episodeCode(next), releaseDay(next.released, language))}</p>;
}

/**
 * The hero pieces a title detail places itself: the age badge at the end of the facts line,
 * and the original-title line plus the next-episode pill between the facts and the synopsis.
 * A plain function, so a host can call it after an early return. The pill is its own component
 * because only it has to tick.
 */
export function TitleExtraFacts({ extras, language, name }: { extras: TitleExtras | null; language: string; name?: string }): { ageBadge: ReactNode; heroLines: ReactNode } {
  const rating = extras?.ageRating?.trim();
  const regionCode = extras?.ageRatingRegion?.trim();
  const ageBadge = rating
    ? <em className="age-badge" title={regionCode
      ? t("detail.ageRatingIn", { rating, region: regionLabel(regionCode, language) })
      : t("detail.ageRating", { rating })}>{rating}</em>
    : null;
  const original = extras?.originalTitle?.trim() ?? "";
  const spoken = extras?.originalLanguage?.trim() ?? "";
  const titleDiffers = original.length > 0 && !sameText(original, name ?? "");
  const languageDiffers = spoken.length > 0 && !sameText(spoken, language);
  const originalLine = titleDiffers
    ? <p className="original-line">
        {emphasize(t("detail.originalTitle", { title: "\u0000" }), original)}
        {languageDiffers ? ` · ${languageLabel(spoken, language)}` : null}
      </p>
    : languageDiffers
      ? <p className="original-line">{t("detail.originalLanguage", { language: languageLabel(spoken, language) })}</p>
      : null;
  const next = extras?.nextEpisode;
  const heroLines = originalLine || next ? <>{originalLine}{next ? <NextEpisodePill next={next} language={language}/> : null}</> : null;
  return { ageBadge, heroLines };
}

function nextEpisodeLine(episode: string, date: string): ReactNode {
  const text = t("detail.nextEpisode", { episode: "\u0000", date: "\u0001" });
  const [before, rest] = text.split("\u0000");
  if (rest === undefined) return text;
  const [middle, after] = rest.split("\u0001");
  return <>{before}<b>{episode}</b>{middle}{date}{after ?? ""}</>;
}

function PersonButton({ name, onSearch, children }: { name: string; onSearch: (name: string) => void; children: ReactNode }) {
  return <button type="button" title={t("detail.searchPerson", { name })} onClick={() => onSearch(name)}>{children}</button>;
}

function CrewLine({ people, onSearch }: { people: TitlePerson[]; onSearch: (name: string) => void }) {
  const groups = CREW_ROLES.map((role) => ({ role, names: people.filter((person) => person.role === role) }))
    .filter((group) => group.names.length > 0);
  if (!groups.length) return null;
  return <p className="extras-crew">{groups.map((group, index) => <span key={group.role}>
    {index > 0 ? " · " : null}
    {t(ROLE_KEY[group.role])}{" "}
    {group.names.map((person, nameIndex) => <span key={`${person.name}:${nameIndex}`}>
      {nameIndex > 0 ? ", " : null}
      <PersonButton name={person.name} onSearch={onSearch}>{person.name}</PersonButton>
    </span>)}
  </span>)}</p>;
}

const SKELETONS = [0, 1, 2, 3, 4, 5, 6];

/** Cast, crew and similar titles under the actions. Nothing while there is nothing to show,
 *  and never an error: a failed read looks the same as an empty one. */
export function TitleExtrasRows({ extras, loading }: { extras: TitleExtras | null; loading: boolean }) {
  const { t: translate } = useI18n();
  const actions = useContext(TitleExtrasActions);
  if (loading) return <section className="title-extras" aria-busy="true">
    <div className="extras-row extras-skeleton">
      <h3>{translate("detail.people")} <small>{translate("detail.peopleHint")}</small></h3>
      <div className="extras-strip">{SKELETONS.map((index) => <div className="person" key={index}><span className="person-face"/></div>)}</div>
    </div>
    <div className="extras-row extras-skeleton">
      <h3>{translate("detail.related")}</h3>
      <div className="extras-strip">{SKELETONS.map((index) => <div className="related" key={index}><span className="related-art"/></div>)}</div>
    </div>
  </section>;
  const people = extras?.people ?? [];
  const related = extras?.related ?? [];
  if (!people.length && !related.length) return null;
  const cast = people.filter((person) => person.role === "cast");
  return <section className="title-extras">
    {people.length > 0 && <div className="extras-row">
      <h3>{translate("detail.people")} <small>{translate("detail.peopleHint")}</small></h3>
      <CrewLine people={people} onSearch={actions.searchPerson}/>
      {cast.length > 0 && <div className="extras-strip">{cast.map((person, index) => <button type="button" className="person" key={`${person.name}:${person.photo ?? ""}:${index}`}
        title={translate("detail.searchPerson", { name: person.name })} onClick={() => actions.searchPerson(person.name)}>
        <PersonFace name={person.name} photo={person.photo}/>
        <strong>{person.name}</strong>
        {person.character ? <small>{person.character}</small> : null}
      </button>)}</div>}
    </div>}
    {related.length > 0 && <div className="extras-row">
      <h3>{translate("detail.related")}</h3>
      <div className="extras-strip">{related.map((title) => <RelatedTile key={`${title.type}:${title.id}`} title={title} onOpen={actions.openTitle}/>)}</div>
    </div>}
  </section>;
}

function RelatedTile({ title, onOpen }: { title: RelatedTitle; onOpen: (title: TitleExtrasTarget) => void }) {
  return <button type="button" className="related" onClick={() => onOpen({ type: title.type, id: title.id, name: title.name, poster: title.poster })}>
    <span className="related-art">{title.poster ? <img src={title.poster} alt="" onError={hideBroken}/> : title.name}</span>
    <strong>{title.name}</strong>
    {title.year ? <small>{title.year}</small> : null}
    {title.inLibrary ? <small className="in-library">{t("detail.inLibrary")}</small> : null}
  </button>;
}
