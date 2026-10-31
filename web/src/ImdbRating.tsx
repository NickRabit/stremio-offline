import { Star } from "lucide-react";
import { t } from "./i18n";

/** The IMDb score the catalogue addon carries, as it writes it. Absent for a title nobody
 *  has rated, and never TMDB's own average, which is a different number. */
export const imdbRating = (item: { [key: string]: unknown } | null): string | null => {
  const raw = item?.imdbRating;
  const value = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  return /^\d+(\.\d+)?$/.test(value) ? value : null;
};

export function ImdbRating({ rating }: { rating: string }) {
  return <b className="imdb-rating" title={t("catalog.imdbRating", { rating })}><Star/>{rating}</b>;
}
