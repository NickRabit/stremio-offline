import { t } from "./i18n";

/** The parenthesised type hint the catalogue pickers show beside a catalogue's own name, so two
 *  catalogues that share a name (Cinemeta's "Popular" as a film and as a series) are told apart.
 *  A remote manifest names its types freely; only the two the picker filters by are translated. */
export const catalogTypeTag = (type: string): string =>
  type === "movie" ? t("catalog.typeMovie") : type === "series" ? t("catalog.typeSeries") : type;
