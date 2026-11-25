import { useMemo, useState } from "react";
import { genreLabel } from "./genres";
import { t, useI18n } from "./i18n";
import { matchesQuery } from "./catalog-picker-model";
import { PickerDialog, type PickerOption } from "./PickerDialog";

export interface GenrePickerProps {
  catalogName: string;
  options: string[];
  required: boolean;
  value: string;
  onPick: (genre: string) => void;
  onClose: () => void;
}

export function GenrePicker({ catalogName, options, required, value, onPick, onClose }: GenrePickerProps) {
  useI18n();
  const [query, setQuery] = useState("");
  const searchable = options.length > 12;
  const shown = useMemo(() => searchable
    ? options.filter((option) => matchesQuery(genreLabel(option), query) || matchesQuery(option, query))
    : options, [options, query, searchable]);
  const rows: PickerOption[] = [
    ...(!required && matchesQuery(t("catalog.allGenres"), query) ? [{
      key: "",
      label: t("catalog.allGenres"),
      selected: value === "",
      onChoose: () => onPick(""),
    }] : []),
    ...shown.map((option) => ({
      key: option,
      label: genreLabel(option),
      sublabel: genreLabel(option) === option ? undefined : option,
      selected: value === option,
      onChoose: () => onPick(option),
    })),
  ];

  return <PickerDialog label={t("catalog.genre")}
    subtitle={required ? `${catalogName} · ${t("catalog.genreRequired")}` : catalogName}
    searchPlaceholder={searchable ? t("picker.searchGenre") : undefined}
    query={searchable ? query : ""} onQuery={setQuery} leading={rows} groups={[]}
    className="picker-card-narrow"
    empty={<><p>{t("picker.noMatch", { query })}</p></>}
    onClose={onClose}/>;
}
