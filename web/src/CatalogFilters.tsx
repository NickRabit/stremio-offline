import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { AddonLogo } from "./AddonLogo";
import { CatalogPicker } from "./CatalogPicker";
import {
  browseMembers,
  browseBucket,
  bucketsPresent,
  effectiveGenre,
  fallbackForBucket,
  genreOptions,
  genrePaused,
  genreRequired,
  refOf,
  type CatalogRef,
  type BrowseCatalog,
  type TypeBucket,
} from "./catalog-picker-model";
import { GenrePicker } from "./GenrePicker";
import { genreLabel } from "./genres";
import { t, useI18n } from "./i18n";
import type { CatalogViewPrefs } from "./types";

export interface CatalogFiltersProps {
  catalogs: BrowseCatalog[];
  current: BrowseCatalog;
  genre: string;
  prefs: CatalogViewPrefs;
  logos: Record<string, string | undefined>;
  compact: boolean;
  sortLabel: string;
  onPickCatalog: (ref: CatalogRef) => void;
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
  bucket === "all" ? t("common.all") : bucket === "movie" ? t("catalog.movies") : bucket === "series" ? t("catalog.series") : t("catalog.typeOther");

export function CatalogFilters({
  catalogs, current, genre, prefs, logos, compact, sortLabel, onPickCatalog, onGenre, onPrefs,
}: CatalogFiltersProps) {
  useI18n();
  const [picker, setPicker] = useState<OpenPicker | null>(null);
  const [pickerBucket, setPickerBucket] = useState<TypeBucket | undefined>(undefined);
  // The same catalogue in the other type is switched to at once; anything else is the
  // viewer's choice, so the picker opens on that type instead of guessing a catalogue.
  const switchBucket = (bucket: TypeBucket) => {
    if (bucket === currentBucket) return;
    const next = fallbackForBucket(catalogs, refOf(current), bucket, prefs.hiddenAddons);
    if (next?.sameId) { onPickCatalog(next.ref); return; }
    setPickerBucket(bucket);
    setPicker("catalog");
  };
  const currentBucket = browseBucket(current);
  const options = genreOptions(current);
  const effective = effectiveGenre(current, genre);
  const paused = genrePaused(current, genre);
  const closePicker = () => {
    pickerClosedAt = performance.now();
    setPicker(null);
  };
  const summary = [current[browseMembers] ? t("catalog.moviesAndSeries") : typeLabel(current.type), effective ? genreLabel(effective) : "", sortLabel].filter(Boolean).join(" · ");
  const addonLine = `${current.addonName}${currentBucket === "other" ? ` · ${current.type}` : ""}`;

  return <>
    <div className="catalog-type-switch" role="group" aria-label={t("catalog.type")}>
      {bucketsPresent(catalogs).map((bucket) => {
        const pressed = bucket === currentBucket;
        return <button key={bucket} type="button" aria-pressed={pressed} onClick={() => switchBucket(bucket)}
          title={bucket === "all" ? t("catalog.moviesAndSeries") : undefined}>
          {bucketLabel(bucket)}
        </button>;
      })}
    </div>
    <button type="button" className={`catalog-trigger${compact ? " compact" : ""}`}
      aria-haspopup="dialog" aria-expanded={picker === "catalog"}
      onClick={() => { setPickerBucket(undefined); setPicker("catalog"); }}>
      <span className="visually-hidden">{t("catalog.browse")}: </span>
      <AddonLogo addonKey={current.addonKey} name={current.addonName} src={logos[current.addonKey]}/>
      <span className="catalog-trigger-copy">
        <strong>{current.name || current.id}</strong>
        <small>{compact ? summary : addonLine}</small>
      </span>
      <ChevronDown className="scope-chevron" aria-hidden="true"/>
    </button>
    <button type="button" className={`genre-trigger${effective && !paused ? " active" : ""}${paused ? " genre-paused" : ""}`}
      aria-haspopup="dialog" aria-expanded={picker === "genre"}
      disabled={!options.length} onClick={() => setPicker("genre")}>
      {paused && <span className="visually-hidden">{t("catalog.genre")}: </span>}
      <small>{paused ? t("catalog.genrePaused", { genre: genreLabel(genre) }) : options.length && options.every((option) => /^\d{4}$/.test(option)) ? t("catalog.genreYear") : t("catalog.genre")}</small>
      <span>{options.length ? (paused || !effective ? t("catalog.allGenres") : genreLabel(effective)) : t("catalog.genreNone")}</span>
      {options.length > 0 && <ChevronDown className="genre-chevron" aria-hidden="true"/>}
    </button>
    {picker === "catalog" && <CatalogPicker catalogs={catalogs} current={refOf(current)} prefs={prefs} logos={logos}
      onPick={(ref) => { closePicker(); onPickCatalog(ref); }}
      initialBucket={pickerBucket}
      onPrefs={onPrefs}
      onClose={closePicker}/>}
    {picker === "genre" && <GenrePicker catalogName={current.name || current.id} options={options}
      required={genreRequired(current)} value={effective}
      onPick={(picked) => { closePicker(); onGenre(picked); }}
      onClose={closePicker}/>}
  </>;
}
