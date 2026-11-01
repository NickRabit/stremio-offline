import { useContext, useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Play, Star } from "lucide-react";
import { localeTag, t, useI18n } from "./i18n";
import { imdbRating } from "./ImdbRating";
import { TitleExtrasActions } from "./TitleExtras";
import { trailerAction } from "./trailers";
import type { TitleExtras, TitlePerson, Trailer } from "./types";

const SCORE = { minimumFractionDigits: 1, maximumFractionDigits: 1 } as const;
const LINE_ROLES = ["director", "creator", "novel"] as const;

const scoreText = (value: number) => new Intl.NumberFormat(localeTag(), SCORE).format(value);

/** IMDb from the extras when the server sent one, otherwise the catalogue meta the host already has. */
export function ratingsFrom(extras: TitleExtras | null | undefined, meta?: { [key: string]: unknown } | null): { imdb?: string; tmdb?: number; tmdbVotes?: number } {
  const ratings = extras?.ratings ?? {};
  const raw = typeof ratings.imdb === "string" ? ratings.imdb.trim() : "";
  const imdb = /^\d+(\.\d+)?$/.test(raw) ? raw : imdbRating(meta ?? null) ?? undefined;
  const tmdb = typeof ratings.tmdb === "number" && Number.isFinite(ratings.tmdb) ? ratings.tmdb : undefined;
  const tmdbVotes = tmdb !== undefined && typeof ratings.tmdbVotes === "number" && Number.isFinite(ratings.tmdbVotes) && ratings.tmdbVotes >= 0
    ? ratings.tmdbVotes : undefined;
  return {
    ...(imdb ? { imdb } : {}),
    ...(tmdb !== undefined ? { tmdb } : {}),
    ...(tmdbVotes !== undefined ? { tmdbVotes } : {}),
  };
}

/** Age, IMDb and TMDB, each only when it is known. The site names are trademarks. */
export function DetailRatings({ age, imdb, tmdb, tmdbVotes }: { age?: ReactNode; imdb?: string; tmdb?: number; tmdbVotes?: number }) {
  useI18n();
  const imdbNumber = imdb === undefined ? Number.NaN : Number(imdb);
  const imdbText = Number.isFinite(imdbNumber) ? scoreText(imdbNumber) : undefined;
  const tmdbText = tmdb !== undefined && Number.isFinite(tmdb) ? scoreText(tmdb) : undefined;
  const votes = tmdbText !== undefined && tmdbVotes !== undefined
    ? new Intl.NumberFormat(localeTag(), { notation: "compact" }).format(tmdbVotes) : undefined;
  if (!age && !imdbText && !tmdbText) return null;
  return <div className="detail-ratings">
    {age ? <span className="detail-rate age">{age}</span> : null}
    {imdbText ? <span className="detail-rate"><b className="imdb">IMDb</b>{imdbText}</span> : null}
    {tmdbText ? <span className="detail-rate"><b className="tmdb">TMDB</b>{tmdbText}{votes ? <small>{votes}</small> : null}</span> : null}
  </div>;
}

/** Three lines until the viewer asks for the rest. The control stays hidden while the text fits. */
export function ClampedDescription({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => { setOpen(false); }, [text]);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || open) return;
    const measure = () => setOverflows(node.scrollHeight > node.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text, open]);
  return <>
    <p ref={ref} className={`library-detail-synopsis${open ? "" : " is-clamped"}`}>{text}</p>
    {overflows && <button type="button" className="detail-more" onClick={() => setOpen((value) => !value)}>{t(open ? "detail.less" : "detail.more")}</button>}
  </>;
}

/** Director, creator and novel under the synopsis. Empty roles disappear; a role keeps three names. */
export function CrewLine({ people }: { people?: TitlePerson[] }) {
  const actions = useContext(TitleExtrasActions);
  const { t: translate } = useI18n();
  const groups = LINE_ROLES.map((role) => {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const person of people ?? []) {
      if (person.role !== role) continue;
      const trimmed = person.name.trim();
      const key = trimmed.toLocaleLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      names.push(trimmed);
      if (names.length === 3) break;
    }
    return { role, names };
  }).filter((group) => group.names.length > 0);
  if (!groups.length) return null;
  return <p className="detail-crew">{groups.map((group, index) => <span key={group.role}>
    {index > 0 ? " · " : null}
    {translate(`detail.role.${group.role}`)}{" "}
    {group.names.map((name, nameIndex) => <span key={name}>
      {nameIndex > 0 ? ", " : null}
      <button type="button" title={translate("detail.searchPerson", { name })} onClick={() => actions.searchPerson(name)}><b>{name}</b></button>
    </span>)}
  </span>)}</p>;
}

export function DetailIcon({ icon, label, className, ...rest }: { icon: ReactNode; label: string; className?: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`detail-icon${className ? ` ${className}` : ""}`} {...rest}>
    <span>{icon}</span>{label}
  </button>;
}

/** The secondary trailer: Secure Mode leaves the app, otherwise the overlay the host already owns. */
export function DetailTrailerButton({ trailer, secureMode, onTrailer }: { trailer?: Trailer | null; secureMode?: boolean; onTrailer?: (trailer: Trailer) => void }) {
  const action = trailerAction(trailer, secureMode ?? false);
  if (!action) return null;
  const icon = <Play/>;
  const label = t("detail.action.trailer");
  if (action.kind === "external") {
    return <a className="detail-icon" href={action.href} target="_blank" rel="noopener noreferrer" title={t("trailers.openHint")}>
      <span>{icon}</span>{label}
    </a>;
  }
  return <button type="button" className="detail-icon" title={t("trailers.openHint")} aria-label={t("trailers.watch")} onClick={() => onTrailer?.(action.trailer)}>
    <span>{icon}</span>{label}
  </button>;
}

export function DetailFavoriteButton({ favorite, disabled, onToggle, ariaLabel, title }: {
  favorite?: boolean;
  disabled?: boolean;
  onToggle: (favorite: boolean) => void;
  ariaLabel?: string;
  title?: string;
}) {
  const name = ariaLabel ?? t(favorite ? "favorite.remove" : "favorite.add");
  return <button type="button" className={`detail-icon watch-star${favorite ? " on" : ""}`} aria-pressed={favorite ?? false} disabled={disabled ?? false}
    aria-label={name} title={title ?? name} onClick={() => onToggle(!(favorite ?? false))}>
    <span><Star/></span>{t("detail.action.favorite")}
  </button>;
}
