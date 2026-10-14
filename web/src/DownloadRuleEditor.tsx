import { t, useI18n } from "./i18n";
import type { AddonDownloadSettings, DownloadTargetSettings, LibraryView } from "./types";

export type DownloadRuleKind = "movie" | "series";

/** The per-kind storage rule fields an addon and a remote media-server library share: the
 *  library, the subfolder below its root, the layout and the resulting path example. `kinds`
 *  picks the sections to draw -- a typed remote library shows its one applicable kind, a mixed
 *  one both. `defaultLibraryIds` lets a caller name the automatic destination its own resolver
 *  falls back to, so a remote mixed library shows the mixed default without a second editor. */
export function DownloadRuleEditor({ settings, libraries, disabled, kinds = ["movie", "series"], defaultLibraryIds, onChange }: {
  settings: AddonDownloadSettings;
  libraries: LibraryView[];
  disabled: boolean;
  kinds?: readonly DownloadRuleKind[];
  defaultLibraryIds?: Partial<Record<DownloadRuleKind, string>>;
  onChange: (kind: DownloadRuleKind, patch: Partial<DownloadTargetSettings>) => void;
}) {
  useI18n();
  // Where a rule may point: the same set the server accepts, in the same order, so the
  // "Default" entry names the library the queue would fall back to.
  const offered = (kind: DownloadRuleKind) => libraries
    .filter((library) => library.enabled && !library.unreachable && !library.readOnly && (library.type === kind || library.type === "mixed"))
    .sort((a, b) => a.order - b.order);
  const defaultLibrary = (kind: DownloadRuleKind) => {
    const available = offered(kind);
    const named = defaultLibraryIds?.[kind];
    return (named ? available.find((library) => library.id === named) : undefined)
      ?? available.find((library) => (kind === "movie" ? library.defaultMovie : library.defaultSeries))
      ?? available[0];
  };
  // A rule may name a library that is no longer offered (switched off, unplugged, removed).
  // It stays visible and stays selected: silently rewriting somebody's rule would be worse.
  const strayLibrary = (kind: DownloadRuleKind): { id: string; name: string } | undefined => {
    const wanted = settings[kind].libraryId;
    if (!wanted || offered(kind).some((library) => library.id === wanted)) return undefined;
    // A removed library is kept by its raw handle, so the rule is never silently emptied; a
    // library that is merely switched off or read-only keeps its name and its place.
    return { id: wanted, name: libraries.find((library) => library.id === wanted)?.name ?? wanted };
  };
  const preview = (kind: DownloadRuleKind) => {
    const rule = settings[kind];
    const folder = rule.subfolder.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
    const destination = rule.libraryId ? libraries.find((library) => library.id === rule.libraryId) : defaultLibrary(kind);
    const root = `${destination?.root ?? t("addons.noLibraryRoot")}${folder ? `/${folder}` : ""}`;
    if (kind === "movie") {
      const movie = `${t("addons.sampleMovie")} (${t("addons.sampleYear")})`;
      return rule.layout === "flat" ? `${root}/${t("addons.sampleMovie")}.mkv` : `${root}/${movie}/${movie}.mkv`;
    }
    const show = t("addons.sampleShow");
    return rule.layout === "flat"
      ? `${root}/${show} - S01E01 - ${t("addons.sampleEpisode")}.mkv`
      : `${root}/${show}/01 ${t("addons.sampleSeasonFolder")}/${show} - S01E01 - ${t("addons.sampleEpisode")}.mkv`;
  };

  return <div className="download-rule-grid">{kinds.map((kind) => {
    const kindLabel = t(kind === "movie" ? "catalog.movies" : "catalog.series");
    const rule = settings[kind];
    const chosen = libraries.find((library) => library.id === rule.libraryId);
    const stray = strayLibrary(kind);
    const fallback = defaultLibrary(kind);
    return <div className="download-rule" key={kind}><b>{kindLabel}</b>
      <label><span>{t("addons.saveTo")}</span>
        <select aria-label={t("addons.saveToLabel", { kind: kindLabel })} value={rule.libraryId ?? ""} disabled={disabled}
          onChange={(event) => onChange(kind, { libraryId: event.target.value || undefined })}>
          <option value="">{fallback ? t("addons.saveToDefaultNamed", { name: fallback.name }) : t("addons.saveToDefault")}</option>
          {offered(kind).map((library) => <option key={library.id} value={library.id}>{library.name}</option>)}
          {stray && <option value={stray.id}>{t("addons.saveToUnavailable", { name: stray.name })}</option>}
        </select></label>
      <label className="folder-label"><span>{t("addons.subfolder")}</span>
        <div className="folder-field"><code>{(rule.libraryId ? chosen?.root : fallback?.root) ?? ""}/</code>
          <input aria-label={t("addons.subfolderLabel", { kind: kindLabel })} value={rule.subfolder} disabled={disabled}
            placeholder={t("addons.subfolderPlaceholder")} onChange={(event) => onChange(kind, { subfolder: event.target.value })}/></div></label>
      <label><span>{t("addons.layout")}</span>
        <select aria-label={t("addons.layoutLabel", { kind: kindLabel })} value={rule.layout} disabled={disabled}
          onChange={(event) => onChange(kind, { layout: event.target.value as "flat" | "structured" })}>
          <option value="structured">{t("addons.layoutStructured")}</option><option value="flat">{t("addons.layoutFlat")}</option>
        </select></label>
      <small className="path-preview">{t("addons.example")} <code>{preview(kind)}</code></small></div>;
  })}</div>;
}
