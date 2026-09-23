import { useEffect, useState } from "react";
import { Check, Film, Sparkles, X } from "lucide-react";
import { api, describeError } from "./api";
import { t, useI18n } from "./i18n";
import type { MatchSuggestion, SuggestionRow } from "./types";

/** A picture that cannot be loaded leaves a neutral box rather than a broken icon. The
 *  alternative text stays in the tree, so the card still says whose poster it would be. */
const hideBroken = (event: React.SyntheticEvent<HTMLImageElement>) => event.currentTarget.classList.add("broken");

/** Why this proposal is worth a look, in the reader's language. */
function reviewOf(suggestion: MatchSuggestion, fallbackLabel: string): string {
  if (suggestion.reason === "ambiguous") return t("library.reviewAmbiguous");
  if (suggestion.reason === "correction") {
    const current = [suggestion.replacesName || suggestion.replacesId || fallbackLabel, suggestion.replacesYear ? `(${suggestion.replacesYear})` : ""].filter(Boolean).join(" ");
    const proposed = [suggestion.name, suggestion.year ? `(${suggestion.year})` : ""].filter(Boolean).join(" ");
    return t("library.reviewCorrection", { current, proposed });
  }
  if (suggestion.reason === "year") return t("library.reviewYear");
  return t("library.reviewNeutral");
}

/** What the scan proposed but did not dare bind on its own. */
export function SuggestionsDialog(
  { libraryId, onClose, onChanged, onIdentify }: { libraryId?: string; onClose: () => void; onChanged: () => void; onIdentify: (path: string) => void },
) {
  useI18n();
  const [rows, setRows] = useState<SuggestionRow[] | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    void api.librarySuggestions(libraryId)
      .then((result) => { if (!cancelled) setRows(result.items); })
      .catch((value) => { if (!cancelled) { setError(describeError(value)); setRows([]); } });
    return () => { cancelled = true; };
  }, [libraryId]);

  const act = async (row: SuggestionRow, confirm: boolean) => {
    setBusy(row.key); setError("");
    try {
      if (confirm) await api.matchLibraryItem({
        path: row.key, id: row.suggestion.id, type: row.suggestion.type,
        ...(row.suggestion.replacesId ? { replacesId: row.suggestion.replacesId } : {}),
      });
      else await api.dismissLibrarySuggestion(row.key);
      setRows((current) => (current ?? []).filter((item) => item.key !== row.key));
      onChanged();
    } catch (value) { setError(describeError(value)); }
    finally { setBusy(""); }
  };

  return <div className="identify-overlay" role="dialog" aria-modal="true" aria-label={t("library.suggestions")} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="panel identify-card">
      <div className="identify-head">
        <h2>{t("library.suggestions")}</h2>
        <button type="button" className="icon-button" aria-label={t("common.cancel")} onClick={onClose}><X/></button>
      </div>
      {error && <p className="login-error">{error}</p>}
      {!rows && <p className="identify-hint">{t("common.loading")}</p>}
      {rows && !rows.length && <p className="identify-hint">{t("library.suggestionsEmpty")}</p>}
      {rows && rows.length > 0 && <>
        <p className="identify-hint">{t("library.suggestionsLead")}</p>
        <div className="suggestion-list">
          {rows.map((row) => <article key={row.key} className="suggestion-row">
            <span className="suggestion-thumb">
              {row.suggestion.poster ? <>
                <span className="suggestion-placeholder" aria-hidden="true"><Film/></span>
                <img src={row.suggestion.poster} alt={t("library.suggestionPosterAlt", { name: row.suggestion.name })} onError={hideBroken}/>
              </> : <span className="suggestion-placeholder" role="img" aria-label={t("library.suggestionPosterUnavailable")}><Film/></span>}
            </span>
            <div className="suggestion-copy">
              <strong>{row.label}</strong>
              <small>{[row.suggestion.name, row.suggestion.year].filter(Boolean).join(" · ")}</small>
              {row.library && row.path && <small className="suggestion-location">{t("library.suggestionLocation", { library: row.library, path: row.path })}</small>}
              <small className="suggestion-review">{reviewOf(row.suggestion, row.label)}</small>
              <small className="suggestion-score">{row.suggestion.titleSimilarity != null
                ? t("library.nameSimilarity", { score: row.suggestion.titleSimilarity })
                : t("library.suggestionLegacyScore", { score: row.suggestion.score })}</small>
            </div>
            <div className="suggestion-actions">
              <button type="button" className="primary" disabled={busy === row.key} onClick={() => void act(row, true)}><Check/> {t("library.suggestionConfirm")}</button>
              <button type="button" disabled={busy === row.key} onClick={() => onIdentify(row.key)}><Sparkles/> {t("library.identify")}</button>
              <button type="button" disabled={busy === row.key} onClick={() => void act(row, false)}><X/> {t("library.suggestionDismiss")}</button>
            </div>
          </article>)}
        </div>
      </>}
    </div>
  </div>;
}
