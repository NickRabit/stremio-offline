import type { ReactNode } from "react";
import { t, useI18n } from "./i18n";
import { trailerAction } from "./trailers";
import type { SiteLink, Trailer } from "./types";

/** The names of the linked sites. They are trademarks, not interface text, so they are
 *  spelled the same in every language and live here rather than in the catalogues. */
export const SITE_LINKS: Record<SiteLink["site"], string> = { csfd: "ČSFD", tmdb: "TMDB", imdb: "IMDb" };

/** The one order the sites keep, whatever order the server listed them in. */
const SITE_ORDER: SiteLink["site"][] = ["csfd", "tmdb", "imdb"];

export interface TitleChipsProps {
  /** The title's own kind, as the catalogue names it; without one the pill is left out. */
  kind?: string;
  trailer?: Trailer | null;
  links?: SiteLink[];
  /** The controls that belong in front of the chips, such as the catalogue's watch star. */
  leading?: ReactNode;
  /** Opens the trailer overlay, which the app owns. */
  onTrailer: (trailer: Trailer) => void;
  /** Secure Mode sends the trailer to YouTube in a new tab instead of the overlay. */
  secureMode: boolean;
}

/** Everything that identifies a title, as one row of chips of one size: the caller's controls,
 *  the kind, the trailer and the sites that know the title. The catalogue detail, a library menu
 *  and a library detail draw the same row, so the three cannot drift apart. */
export function TitleChips({ kind, trailer, links = [], leading, onTrailer, secureMode }: TitleChipsProps) {
  useI18n();
  const action = trailerAction(trailer, secureMode);
  const sorted = [...links].sort((left, right) => SITE_ORDER.indexOf(left.site) - SITE_ORDER.indexOf(right.site));
  if (!leading && !kind && !action && !sorted.length) return null;
  return <div className="title-chips">
    {leading}
    {kind && <span className="pill">{kind}</span>}
    {action && (action.kind === "external"
      ? <a className="trailer-action" href={action.href} target="_blank" rel="noopener noreferrer" title={t("trailers.openHint")}>{t("trailers.openOnYouTube")}</a>
      : <button className="trailer-action" title={t("trailers.openHint")} onClick={() => onTrailer(action.trailer)}>{t("trailers.watch")}</button>)}
    {sorted.length > 0 && <div className="title-links">
      {sorted.map((link) => <a key={link.site} href={link.url} target="_blank" rel="noopener noreferrer"
        title={t("links.openOn", { site: SITE_LINKS[link.site] })}>{SITE_LINKS[link.site]}</a>)}
    </div>}
  </div>;
}
