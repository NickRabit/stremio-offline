import { useState } from "react";
import { AddonLogo } from "./AddonLogo";
import { CatalogPicker } from "./CatalogPicker";
import {
  bucketsPresent,
  effectiveGenre,
  fallbackForBucket,
  genreOptions,
  genrePaused,
  genreRequired,
  refOf,
  typeBucket,
  type CatalogRef,
  type TypeBucket,
} from "./catalog-picker-model";
import { GenrePicker } from "./GenrePicker";
import { genreLabel } from "./genres";
import { t, useI18n } from "./i18n";
import type { Catalog, CatalogViewPrefs } from "./types";

export interface CatalogFiltersProps {
  catalogs: Catalog[];
  current: Catalog;
  genre: string;
  prefs: CatalogViewPrefs;
  logos: Record<string, string | undefined>;
  compact: boolean;
  sortLabel: string;
  onPickCatalog: (ref: CatalogRef) => void;
  onBucket: (bucket: TypeBucket) => void;
  onGenre: (genre: string) => void;
  onPrefs: (patch: Partial<CatalogViewPrefs>) => void;
}

type OpenPicker = "catalog" | "genre";

let pickerClosedAt = Number.NEGATIVE_INFINITY;

export const consumePickerFocusReturn = (): boolean => {
  const returned = performance.now() - pickerClosedAt <= 400;
  pickerClosedAt = Number.NEGATIVE_INFINITY;
  return returned;
};

const typeLabel = (type: string): string =>
  type === "movie" ? t("catalog.movies") : type === "series" ? t("catalog.series") : type;

const bucketLabel = (bucket: TypeBucket): string =>
  bucket === "movie" ? t("catalog.movies") : bucket === "series" ? t("catalog.series") : t("catalog.typeOther");

export function CatalogFilters({
  catalogs, current, genre, prefs, logos, compact, sortLabel, onPickCatalog, onBucket, onGenre, onPrefs,
}: CatalogFiltersProps) {
  useI18n();
  const [picker, setPicker] = useState<OpenPicker | null>(null);
  const currentBucket = typeBucket(current.type);
  const options = genreOptions(current);
  const effective = effectiveGenre(current, genre);
  const paused = genrePaused(current, genre);
  const closePicker = () => {
    pickerClosedAt = performance.now();
    setPicker(null);
  };
  const summary = [typeLabel(current.type), effective ? genreLabel(effective) : "", sortLabel].filter(Boolean).join(" · ");
  const addonLine = `${current.addonName}${currentBucket === "other" ? ` · ${current.type}` : ""}`;

  return <>
    <div className="catalog-type-switch" role="group" aria-label={t("catalog.type")}>
      {bucketsPresent(catalogs).map((bucket) => {
        const pressed = bucket === currentBucket;
        const available = fallbackForBucket(catalogs, refOf(current), bucket, prefs.hiddenAddons);
        return <button key={bucket} type="button" aria-pressed={pressed}
          disabled={!pressed && available === null} onClick={() => onBucket(bucket)}>
          {bucketLabel(bucket)}
        </button>;
      })}
    </div>
    <button type="button" className={`catalog-trigger${compact ? " compact" : ""}`}
      aria-haspopup="dialog" aria-label={t("catalog.browse")} aria-expanded={picker === "catalog"}
      onClick={() => setPicker("catalog")}>
      <AddonLogo addonKey={current.addonKey} name={current.addonName} src={logos[current.addonKey]}/>
      <span className="catalog-trigger-copy">
        <strong>{current.name || current.id}</strong>
        <small>{compact ? summary : addonLine}</small>
      </span>
    </button>
    <button type="button" className={`genre-trigger${effective && !paused ? " active" : ""}${paused ? " genre-paused" : ""}`}
      aria-haspopup="dialog" aria-label={t("catalog.genre")} aria-expanded={picker === "genre"}
      disabled={!options.length} onClick={() => setPicker("genre")}>
      <span>{options.length ? (paused || !effective ? t("catalog.allGenres") : genreLabel(effective)) : t("catalog.genreNone")}</span>
      {paused && <small>{t("catalog.genrePaused", { genre: genreLabel(genre) })}</small>}
    </button>
    {picker === "catalog" && <CatalogPicker catalogs={catalogs} current={refOf(current)} prefs={prefs} logos={logos}
      onPick={(ref) => { closePicker(); onPickCatalog(ref); }}
      onBucket={onBucket}
      onPrefs={onPrefs}
      onClose={closePicker}/>}
    {picker === "genre" && <GenrePicker catalogName={current.name || current.id} options={options}
      required={genreRequired(current)} value={effective}
      onPick={(picked) => { closePicker(); onGenre(picked); }}
      onClose={closePicker}/>}
  </>;
}
