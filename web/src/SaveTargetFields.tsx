import { useId, useState } from "react";
import { FolderBrowser } from "./FolderBrowser";
import { t, useI18n } from "./i18n";
import { offeredLibraries, ruleTarget, targetPreview, type SaveKind, type SaveTarget } from "./save-target";
import type { AddonDownloadSettings, LibraryView } from "./types";

/** The destination section the title and series dialogs share. `value` null means the addon
 *  rule; anything else is a library, a folder below it and a layout the user picked. */
export function SaveTargetFields({ kind, title, season, libraries, rule, value, onChange }: {
  kind: SaveKind;
  title: string;
  season?: number;
  libraries: LibraryView[];
  rule: AddonDownloadSettings | undefined;
  value: SaveTarget | null;
  onChange: (value: SaveTarget | null) => void;
}) {
  useI18n();
  const [error, setError] = useState("");
  const name = useId();
  const offered = offeredLibraries(libraries, kind);
  const ruleValue = ruleTarget(rule, kind, libraries);
  const custom = value !== null;
  const chosen = custom ? (offered.find((library) => library.id === value.libraryId) ?? offered[0]) : undefined;
  // The folder listing is always asked with the library named, which the server accepts however
  // many libraries exist. What it answers is bare or qualified by the libraries configured, not
  // by the ones this account sees, so the prefix is stripped where it is there. The target the
  // server stores is relative to the library's own root.
  const wire = (subfolder: string) => chosen ? (subfolder ? `${chosen.id}/${subfolder}` : chosen.id) : subfolder;
  const subfolderOf = (path: string) => {
    if (!chosen) return path;
    if (path === chosen.id) return "";
    return path.startsWith(`${chosen.id}/`) ? path.slice(chosen.id.length + 1) : path;
  };

  // The manual choice starts where the rule would land, so the common case is one switch.
  const startCustom = (): SaveTarget => {
    const wanted = ruleValue.libraryId && offered.some((library) => library.id === ruleValue.libraryId)
      ? ruleValue.libraryId
      : offered[0]?.id ?? "";
    return { libraryId: wanted, subfolder: ruleValue.subfolder, layout: ruleValue.layout };
  };

  return <>
    <div className="bulk-strategy" role="radiogroup" aria-label={t("saveTarget.where")}>
      <label className={!custom ? "selected" : ""}>
        <input type="radio" name={`${name}-where`} checked={!custom} onChange={() => onChange(null)}/>
        <span><strong>{t("saveTarget.rule")}</strong><small>{targetPreview(ruleValue, libraries, title, kind, season).join(" › ")}</small></span>
      </label>
      <label className={custom ? "selected" : ""}>
        <input type="radio" name={`${name}-where`} checked={custom} disabled={!offered.length} onChange={() => onChange(startCustom())}/>
        <span><strong>{t("saveTarget.custom")}</strong>{!offered.length && <small>{t("saveTarget.noLibrary")}</small>}</span>
      </label>
    </div>
    {custom && chosen && <>
      {offered.length > 1 && <div className="move-libraries" role="group" aria-label={t("saveTarget.where")}>
        {offered.map((library) => <button type="button" key={library.id} aria-pressed={chosen.id === library.id}
          onClick={() => onChange({ libraryId: library.id, subfolder: "", layout: value.layout })}>{library.name}</button>)}
      </div>}
      <FolderBrowser libraries={libraries} folder={wire(value.subfolder)} onFolder={(path) => onChange({ ...value, subfolder: subfolderOf(path) })} onError={setError}/>
      <div className="bulk-strategy" role="radiogroup" aria-label={t("saveTarget.layout")}>
        {(["structured", "flat"] as const).map((layout) => <label key={layout} className={value.layout === layout ? "selected" : ""}>
          <input type="radio" name={`${name}-layout`} checked={value.layout === layout} onChange={() => onChange({ ...value, layout })}/>
          <span><strong>{t(layout === "structured" ? "saveTarget.layout.structured" : "saveTarget.layout.flat")}</strong></span>
        </label>)}
      </div>
      <p className="identify-hint save-target-preview">{targetPreview(value, libraries, title, kind, season).join(" › ")}<br/>{t("saveTarget.previewHint")}</p>
    </>}
    {error && <p className="login-error" role="alert">{error}</p>}
  </>;
}
