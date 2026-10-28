import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ListFilter, X } from "lucide-react";
import { api, ApiError, describeError } from "./api";
import { useDialogFocus } from "./dialog-focus";
import { useDialogViewport } from "./dialog-viewport";
import { languageName, t, type Key } from "./i18n";
import { rulesSummary, sourceProfileName } from "./source-profile-copy";
import { SettingsSectionHead } from "./settings-ui";
import { providerLabel } from "./source-rows";
import type { Addon, AdminRemoteLibrary, AdminSourceProfile, DownloadRules, RulePreference, RuleResolution } from "./types";

const RESOLUTIONS: RuleResolution[] = [360, 480, 720, 1080, 2160];
const PREFERENCES: RulePreference[] = ["language", "resolutionHigher", "resolutionLower", "smaller", "larger", "addonOrder"];
const PREFERENCE_LABEL: Record<RulePreference, Key> = {
  language: "rules.preference.language",
  resolutionHigher: "rules.preference.resolutionHigher",
  resolutionLower: "rules.preference.resolutionLower",
  smaller: "rules.preference.smaller",
  larger: "rules.preference.larger",
  addonOrder: "rules.preference.addonOrder",
};

interface Draft { name: string; rules: DownloadRules }
type EditorSession =
  | { kind: "create"; builtIn: false; draft: Draft }
  | { kind: "edit"; id: string; revision: number; builtIn: boolean; draft: Draft };
interface DuplicateSession { id: string; sourceName: string; name: string }
interface DeleteSession { id: string; revision: number; name: string }

const providesStreams = (addon: Addon) =>
  (addon.manifest.resources ?? []).some((resource) => typeof resource === "string" ? resource === "stream" : resource.name === "stream");
const addonRows = (addons: readonly Addon[]) => addons.filter(providesStreams)
  .map((addon) => ({ key: addon.key, name: addon.manifest.name || addon.key }));

const blankRules = (): DownloadRules => ({
  addons: { scope: "all", order: "viewer" }, torrents: true,
  resolution: { min: 720, max: 1080 }, audio: { mode: "prefer", language: "mine", fallback: null },
  subtitles: "ifAvailable", subtitleLanguage: "mine", sizeGb: {
    episode: { min: null, max: 4 }, movie: { min: null, max: 15 },
  }, skipCinema: true,
  preference: ["language", "resolutionHigher", "addonOrder", "smaller"],
});
const draftFrom = (profile: AdminSourceProfile): Draft => ({
  name: profile.name ?? "",
  rules: profile.parameters ? structuredClone(profile.parameters) : blankRules(),
});
const nameOk = (name: string) => name.trim().length >= 1 && name.trim().length <= 60;
const validSize = (value: number | null) => value === null
  || Number.isFinite(value) && value >= 0.1 && value <= 200 && Math.round(value * 10) === value * 10;
const validRange = (range: DownloadRules["sizeGb"]["episode"]) =>
  validSize(range.min) && validSize(range.max)
  && (range.min === null || range.max === null || range.min <= range.max);
const canSave = (draft: Draft, builtIn: boolean) => {
  const { rules } = draft;
  return (builtIn || nameOk(draft.name))
    && (rules.addons.scope === "all" || rules.addons.scope.selected.length > 0)
    && (rules.resolution.min === null || rules.resolution.max === null || rules.resolution.min <= rules.resolution.max)
    && (rules.audio.mode === "prefer" || rules.audio.fallback === null)
    && validRange(rules.sizeGb.episode) && validRange(rules.sizeGb.movie)
    && rules.preference.length >= 1 && rules.preference.length <= 4
    && !(rules.preference.includes("resolutionHigher") && rules.preference.includes("resolutionLower"))
    && !(rules.preference.includes("smaller") && rules.preference.includes("larger"));
};
const profileName = (profile: AdminSourceProfile) => sourceProfileName(profile.nameKey, profile.name) || profile.id;

const move = <T,>(items: readonly T[], index: number, direction: -1 | 1): T[] => {
  const next = index + direction;
  if (index < 0 || next < 0 || next >= items.length) return [...items];
  const copy = [...items];
  [copy[index], copy[next]] = [copy[next]!, copy[index]!];
  return copy;
};

const readCatalogue = async () => {
  const [profileAnswer, addons, remoteLibraries] = await Promise.all([
    api.adminSourceProfiles(),
    api.addons(),
    api.adminRemoteLibraries().catch(() => []),
  ]);
  return {
    profiles: Array.isArray(profileAnswer?.profiles) ? profileAnswer.profiles.filter((profile) => profile.template === "rules") : [],
    addons: Array.isArray(addons) ? addons : [],
    remoteLibraries: Array.isArray(remoteLibraries) ? remoteLibraries : [],
  };
};

function DialogShell({ label, title, busy, onClose, onSubmit, children, footer }: {
  label: string; title: string; busy: boolean; onClose: () => void; onSubmit?: () => void;
  children: ReactNode; footer: ReactNode;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog);
  useDialogViewport(dialog);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
  const card = <>
    <div className="identify-head"><h2>{title}</h2><button type="button" className="icon-button" aria-label={t("common.close")} disabled={busy} onClick={onClose}><X/></button></div>
    <div className="dialog-body">{children}</div>
    <footer className="dialog-foot">{footer}</footer>
  </>;
  return <div ref={dialog} tabIndex={-1} className="identify-overlay" role="dialog" aria-modal="true" aria-label={label}
    onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    {onSubmit
      ? <form className="panel identify-card dialog-split source-profile-card" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>{card}</form>
      : <div className="panel identify-card dialog-split source-profile-card">{card}</div>}
  </div>;
}

export function SourceProfilesSettings({ languages, titleKey = "rules.title", hintKey = "rules.hint", onChanged }: {
  /** Told after a rule was added, duplicated, edited or deleted, so other lists can reload. */
  onChanged?: () => void;
  languages: Array<{ code: string; name: string }>;
  titleKey?: Key;
  hintKey?: Key;
}) {
  const [profiles, setProfiles] = useState<AdminSourceProfile[]>([]);
  const [addons, setAddons] = useState<Addon[]>([]);
  const [remoteLibraries, setRemoteLibraries] = useState<AdminRemoteLibrary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const [canReload, setCanReload] = useState(false);
  const [session, setSession] = useState<EditorSession | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [duplicate, setDuplicate] = useState<DuplicateSession | null>(null);
  const [remove, setRemove] = useState<DeleteSession | null>(null);
  const rows = [
    { key: "local", name: t("rules.localLibrary") },
    ...remoteLibraries.filter((library) => library.enabled)
      .sort((left, right) => left.order - right.order)
      .map((library) => ({
        key: `remote:${library.id}`,
        name: library.provider ? `${providerLabel(library.provider)} · ${library.name}` : library.name,
      })),
    ...addonRows(addons),
  ];
  const keys = rows.map((row) => row.key);

  const refresh = async () => {
    const loaded = await readCatalogue();
    setProfiles(loaded.profiles); setAddons(loaded.addons); setRemoteLibraries(loaded.remoteLibraries); setLoadError("");
    return loaded;
  };
  const changed = async () => { await refresh(); onChanged?.(); };
  useEffect(() => {
    let stale = false;
    readCatalogue().then((loaded) => {
      if (!stale) {
        setProfiles(loaded.profiles); setAddons(loaded.addons); setRemoteLibraries(loaded.remoteLibraries); setLoadError("");
      }
    }).catch((error) => { if (!stale) setLoadError(describeError(error)); })
      .finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
  }, []);

  const closeEditor = () => { if (!busy) { setSession(null); setDialogError(""); setCanReload(false); setAdvanced(false); } };
  const updateDraft = (draft: Draft) => setSession((current) => current ? { ...current, draft } : current);
  const updateRules = (rules: DownloadRules) => { if (session) updateDraft({ ...session.draft, rules }); };
  const openCreate = () => {
    setDialogError(""); setCanReload(false); setAdvanced(false);
    setSession({ kind: "create", builtIn: false, draft: { name: "", rules: blankRules() } });
  };
  const openEdit = (profile: AdminSourceProfile) => {
    setDialogError(""); setCanReload(false); setAdvanced(false);
    setSession({ kind: "edit", id: profile.id, revision: profile.revision, builtIn: profile.nameKey !== undefined, draft: draftFrom(profile) });
  };

  const save = async () => {
    if (!session || !canSave(session.draft, session.builtIn)) return;
    setBusy(true); setDialogError(""); setCanReload(false);
    try {
      if (session.kind === "create") await api.createAdminSourceProfile({ name: session.draft.name.trim(), rules: session.draft.rules });
      else await api.updateAdminSourceProfile(session.id, {
        revision: session.revision,
        ...(session.builtIn ? {} : { name: session.draft.name.trim() }),
        rules: session.draft.rules,
      });
      setSession(null); await changed();
    } catch (error) {
      setDialogError(describeError(error));
      setCanReload(error instanceof ApiError && error.status === 409 && session.kind === "edit");
    } finally { setBusy(false); }
  };
  const reloadEditor = async () => {
    if (!session || session.kind !== "edit") return;
    setBusy(true);
    try {
      const loaded = await refresh();
      const fresh = loaded.profiles.find((profile) => profile.id === session.id);
      if (!fresh) { closeEditor(); return; }
      setSession({ kind: "edit", id: fresh.id, revision: fresh.revision, builtIn: fresh.nameKey !== undefined, draft: draftFrom(fresh) });
      setDialogError(""); setCanReload(false);
    } catch (error) { setDialogError(describeError(error)); }
    finally { setBusy(false); }
  };
  const saveDuplicate = async () => {
    if (!duplicate || !nameOk(duplicate.name)) return;
    setBusy(true); setDialogError("");
    try { await api.duplicateAdminSourceProfile(duplicate.id, duplicate.name.trim()); setDuplicate(null); await changed(); }
    catch (error) { setDialogError(describeError(error)); }
    finally { setBusy(false); }
  };
  const confirmDelete = async () => {
    if (!remove) return;
    setBusy(true); setDialogError(""); setCanReload(false);
    try { await api.deleteAdminSourceProfile(remove.id, remove.revision); setRemove(null); await changed(); }
    catch (error) { setDialogError(describeError(error)); setCanReload(error instanceof ApiError && error.status === 409); }
    finally { setBusy(false); }
  };
  const reloadDelete = async () => {
    if (!remove) return;
    setBusy(true);
    try {
      const loaded = await refresh();
      const fresh = loaded.profiles.find((profile) => profile.id === remove.id);
      if (!fresh || fresh.nameKey !== undefined) setRemove(null);
      else setRemove({ id: fresh.id, revision: fresh.revision, name: profileName(fresh) });
      setDialogError(""); setCanReload(false);
    } catch (error) { setDialogError(describeError(error)); }
    finally { setBusy(false); }
  };

  const draft = session?.draft;
  const explicit = draft?.rules.addons.order === "viewer" ? [] : draft?.rules.addons.order.explicit ?? [];
  const orderedRows = explicit.map((key) => rows.find((row) => row.key === key) ?? { key, name: key });
  const setScope = (scope: "all" | "selected") => {
    if (!draft) return;
    const selected = draft.rules.addons.scope === "all" ? keys : draft.rules.addons.scope.selected;
    const available = scope === "all" ? keys : selected;
    updateRules({ ...draft.rules, addons: {
      scope: scope === "all" ? "all" : { selected },
      order: draft.rules.addons.order === "viewer" ? "viewer" : { explicit: explicit.filter((key) => available.includes(key)) },
    } });
  };
  const toggleProvider = (key: string) => {
    if (!draft || draft.rules.addons.scope === "all") return;
    const selected = draft.rules.addons.scope.selected.includes(key)
      ? draft.rules.addons.scope.selected.filter((item) => item !== key)
      : [...draft.rules.addons.scope.selected, key];
    updateRules({ ...draft.rules, addons: {
      scope: { selected },
      order: draft.rules.addons.order === "viewer" ? "viewer" : { explicit: [
        ...explicit.filter((item) => selected.includes(item)),
        ...selected.filter((item) => !explicit.includes(item)),
      ] },
    } });
  };
  const setOrder = (order: "viewer" | "explicit") => {
    if (!draft) return;
    const available = draft.rules.addons.scope === "all" ? keys : draft.rules.addons.scope.selected;
    updateRules({ ...draft.rules, addons: { ...draft.rules.addons, order: order === "viewer" ? "viewer" : { explicit: [...available] } } });
  };
  const togglePreference = (preference: RulePreference) => {
    if (!draft) return;
    const selected = draft.rules.preference.includes(preference);
    const preferenceOrder = selected
      ? draft.rules.preference.filter((item) => item !== preference)
      : draft.rules.preference.length < 4 ? [...draft.rules.preference, preference] : draft.rules.preference;
    updateRules({ ...draft.rules, preference: preferenceOrder });
  };
  const setAudioMode = (mode: DownloadRules["audio"]["mode"]) => {
    if (!draft) return;
    let preference = draft.rules.preference;
    let audio = draft.rules.audio;
    if (mode === "any") {
      preference = preference.filter((item) => item !== "language");
      if (!preference.length) preference = ["addonOrder"];
      audio = { mode, language: "mine", fallback: null };
    } else if (mode === "only") {
      audio = { ...audio, mode, fallback: null };
    } else {
      audio = { ...audio, mode };
    }
    updateRules({ ...draft.rules, audio, preference });
  };
  const setAudioLanguage = (language: "mine" | string) => {
    if (!draft) return;
    const fallback = language !== "mine" && draft.rules.audio.fallback === language
      ? null
      : draft.rules.audio.fallback;
    updateRules({ ...draft.rules, audio: { ...draft.rules.audio, language, fallback } });
  };
  const setSubtitles = (subtitles: DownloadRules["subtitles"]) => {
    if (!draft) return;
    updateRules({
      ...draft.rules,
      subtitles,
      subtitleLanguage: subtitles === "off" ? "mine" : draft.rules.subtitleLanguage,
    });
  };
  // A rule for a chosen language names it; "my language" stays generic.
  const preferenceLabel = (preference: RulePreference) =>
    preference === "language" && draft && draft.rules.audio.language !== "mine"
      ? languageName(draft.rules.audio.language)
      : t(PREFERENCE_LABEL[preference]);
  const preferenceDisabled = (preference: RulePreference) => {
    if (!draft || draft.rules.preference.includes(preference)) return false;
    if (draft.rules.preference.length >= 4) return true;
    if (preference === "resolutionHigher") return draft.rules.preference.includes("resolutionLower");
    if (preference === "resolutionLower") return draft.rules.preference.includes("resolutionHigher");
    if (preference === "smaller") return draft.rules.preference.includes("larger");
    if (preference === "larger") return draft.rules.preference.includes("smaller");
    return false;
  };

  return <section className="panel settings-section source-profiles-section">
    <SettingsSectionHead icon={<ListFilter/>} title={t(titleKey)} text={t(hintKey)}/>
    {loading && <p className="identify-hint">{t("common.loading")}</p>}
    {loadError && <p className="login-error" role="alert">{loadError}</p>}
    {!loading && <ul className="source-profile-list">{profiles.map((profile) => {
      const builtIn = profile.nameKey !== undefined;
      return <li key={profile.id} className="source-profile-row" data-profile-id={profile.id}>
        <span><strong>{profileName(profile)}</strong>{profile.parameters && <small>{rulesSummary(profile.parameters)}</small>}</span>
        <span className="source-profile-actions">
          <button type="button" onClick={() => openEdit(profile)}>{t("rules.edit")}</button>
          <button type="button" onClick={() => { setDialogError(""); setDuplicate({ id: profile.id, sourceName: profileName(profile), name: "" }); }}>{t("rules.duplicate")}</button>
          {!builtIn && <button type="button" onClick={() => { setDialogError(""); setCanReload(false); setRemove({ id: profile.id, revision: profile.revision, name: profileName(profile) }); }}>{t("common.delete")}</button>}
        </span>
      </li>;
    })}</ul>}
    <div className="setting-actions"><button type="button" className="primary" onClick={openCreate}>{t("rules.add")}</button></div>

    {session && draft && <DialogShell label={t(session.kind === "create" ? "rules.newTitle" : "rules.editTitle")}
      title={t(session.kind === "create" ? "rules.newTitle" : "rules.editTitle")}
      busy={busy} onClose={closeEditor} onSubmit={() => void save()} footer={<>
        {dialogError && <p className="login-error" role="alert">{dialogError}</p>}
        {session.kind === "edit" && <p className="identify-hint">{t("rules.effect")}</p>}
        {canReload && <button type="button" disabled={busy} onClick={() => void reloadEditor()}>{t("rules.reload")}</button>}
        <button type="button" disabled={busy} onClick={closeEditor}>{t("common.cancel")}</button>
        <button type="submit" className="primary" disabled={busy || !canSave(draft, session.builtIn)}>{busy ? t("common.saving") : t("common.save")}</button>
      </>}>
      {!session.builtIn && <label className="manifest-field"><span>{t("rules.name")}</span>
        <input value={draft.name} maxLength={60} autoComplete="off" aria-label={t("rules.name")} onChange={(event) => updateDraft({ ...draft, name: event.target.value })}/>
      </label>}
      <fieldset className="rules-fieldset"><legend>{t("rules.sources")}</legend>
        <div className="bulk-strategy" role="radiogroup" aria-label={t("rules.addons")}>
          <label className={draft.rules.addons.scope === "all" ? "selected" : ""}><input type="radio" name="download-rules-scope" value="all" checked={draft.rules.addons.scope === "all"} onChange={() => setScope("all")}/><span><strong>{t("rules.addonsAll")}</strong></span></label>
          <label className={draft.rules.addons.scope !== "all" ? "selected" : ""}><input type="radio" name="download-rules-scope" value="selected" checked={draft.rules.addons.scope !== "all"} onChange={() => setScope("selected")}/><span><strong>{t("rules.addonsSelected")}</strong></span></label>
        </div>
        {draft.rules.addons.scope !== "all" && <div className="bulk-sources">{rows.map((row) => {
          const checked = draft.rules.addons.scope !== "all" && draft.rules.addons.scope.selected.includes(row.key);
          return <div key={row.key} className={checked ? "selected" : ""}><label><input type="checkbox" aria-label={row.name} checked={checked} onChange={() => toggleProvider(row.key)}/><span>{row.name}</span></label></div>;
        })}</div>}
        <div className="bulk-strategy" role="radiogroup" aria-label={t("rules.addonOrder")}>
          <label className={draft.rules.addons.order === "viewer" ? "selected" : ""}><input type="radio" name="download-rules-order" value="viewer" checked={draft.rules.addons.order === "viewer"} onChange={() => setOrder("viewer")}/><span><strong>{t("rules.orderViewer")}</strong></span></label>
          <label className={draft.rules.addons.order !== "viewer" ? "selected" : ""}><input type="radio" name="download-rules-order" value="explicit" checked={draft.rules.addons.order !== "viewer"} onChange={() => setOrder("explicit")}/><span><strong>{t("rules.orderCustom")}</strong></span></label>
        </div>
        {draft.rules.addons.order !== "viewer" && <div className="rules-order-list">{orderedRows.map((row, index) => <div key={row.key}><span>{row.name}</span><span>
          <button type="button" className="icon-button" aria-label={t("rules.moveUp", { name: row.name })} disabled={index === 0} onClick={() => updateRules({ ...draft.rules, addons: { ...draft.rules.addons, order: { explicit: move(explicit, index, -1) } } })}><ArrowUp/></button>
          <button type="button" className="icon-button" aria-label={t("rules.moveDown", { name: row.name })} disabled={index === orderedRows.length - 1} onClick={() => updateRules({ ...draft.rules, addons: { ...draft.rules.addons, order: { explicit: move(explicit, index, 1) } } })}><ArrowDown/></button>
        </span></div>)}</div>}
        <label className="rules-check"><input type="checkbox" aria-label={t("rules.allowTorrents")} checked={draft.rules.torrents} onChange={(event) => updateRules({ ...draft.rules, torrents: event.target.checked })}/><span>{t("rules.allowTorrents")}</span></label>
      </fieldset>
      <fieldset className="rules-fieldset"><legend>{t("rules.qualitySize")}</legend>
        <div className="bulk-language-grid">
          <label><span>{t("rules.resolutionFrom")}</span><select aria-label={t("rules.resolutionFrom")} value={draft.rules.resolution.min ?? ""} onChange={(event) => updateRules({ ...draft.rules, resolution: { ...draft.rules.resolution, min: event.target.value ? Number(event.target.value) as RuleResolution : null } })}><option value="">{t("rules.resolutionAny")}</option>{RESOLUTIONS.map((height) => <option key={height} value={height}>{t("rules.resolutionValue", { height })}</option>)}</select></label>
          <label><span>{t("rules.resolutionTo")}</span><select aria-label={t("rules.resolutionTo")} value={draft.rules.resolution.max ?? ""} onChange={(event) => updateRules({ ...draft.rules, resolution: { ...draft.rules.resolution, max: event.target.value ? Number(event.target.value) as RuleResolution : null } })}><option value="">{t("rules.resolutionAny")}</option>{RESOLUTIONS.map((height) => <option key={height} value={height}>{t("rules.resolutionValue", { height })}</option>)}</select></label>
        </div>
        <span className="rules-subheading">{t("rules.sizeRange")}</span>
        <div className="bulk-language-grid">
          <label><span>{t("rules.sizeEpisodeFrom")}</span><input type="number" min="0.1" max="200" step="0.1" aria-label={t("rules.sizeEpisodeFrom")} value={draft.rules.sizeGb.episode.min ?? ""} onChange={(event) => updateRules({ ...draft.rules, sizeGb: { ...draft.rules.sizeGb, episode: { ...draft.rules.sizeGb.episode, min: event.target.value ? Number(event.target.value) : null } } })}/></label>
          <label><span>{t("rules.sizeEpisodeTo")}</span><input type="number" min="0.1" max="200" step="0.1" aria-label={t("rules.sizeEpisodeTo")} value={draft.rules.sizeGb.episode.max ?? ""} onChange={(event) => updateRules({ ...draft.rules, sizeGb: { ...draft.rules.sizeGb, episode: { ...draft.rules.sizeGb.episode, max: event.target.value ? Number(event.target.value) : null } } })}/></label>
          <label><span>{t("rules.sizeMovieFrom")}</span><input type="number" min="0.1" max="200" step="0.1" aria-label={t("rules.sizeMovieFrom")} value={draft.rules.sizeGb.movie.min ?? ""} onChange={(event) => updateRules({ ...draft.rules, sizeGb: { ...draft.rules.sizeGb, movie: { ...draft.rules.sizeGb.movie, min: event.target.value ? Number(event.target.value) : null } } })}/></label>
          <label><span>{t("rules.sizeMovieTo")}</span><input type="number" min="0.1" max="200" step="0.1" aria-label={t("rules.sizeMovieTo")} value={draft.rules.sizeGb.movie.max ?? ""} onChange={(event) => updateRules({ ...draft.rules, sizeGb: { ...draft.rules.sizeGb, movie: { ...draft.rules.sizeGb.movie, max: event.target.value ? Number(event.target.value) : null } } })}/></label>
        </div>
        {!validRange(draft.rules.sizeGb.episode) || !validRange(draft.rules.sizeGb.movie) ? <p className="login-error" role="alert">{t("rules.sizeMinAboveMax")}</p> : null}
        <label className="rules-check"><input type="checkbox" aria-label={t("rules.skipCinema")} checked={draft.rules.skipCinema} onChange={(event) => updateRules({ ...draft.rules, skipCinema: event.target.checked })}/><span>{t("rules.skipCinema")}</span></label>
      </fieldset>
      <fieldset className="rules-fieldset"><legend>{t("rules.language")}</legend>
        <div className="bulk-language-grid">
          <label><span>{t("rules.audio")}</span><select aria-label={t("rules.audio")} value={draft.rules.audio.mode} onChange={(event) => setAudioMode(event.target.value as DownloadRules["audio"]["mode"])}><option value="any">{t("rules.audioAny")}</option><option value="prefer">{t("rules.audioModePrefer")}</option><option value="only">{t("rules.audioModeOnly")}</option></select></label>
          <label><span>{t("rules.audioLanguage")}</span><select aria-label={t("rules.audioLanguage")} disabled={draft.rules.audio.mode === "any"} value={draft.rules.audio.language} onChange={(event) => setAudioLanguage(event.target.value)}><option value="mine">{t("rules.audioLanguageMine")}</option>{languages.map(({ code }) => <option key={code} value={code}>{languageName(code)}</option>)}</select></label>
          <label><span>{t("rules.fallbackLanguage")}</span><select aria-label={t("rules.fallbackLanguage")} disabled={draft.rules.audio.mode !== "prefer"} value={draft.rules.audio.fallback ?? ""} onChange={(event) => updateRules({ ...draft.rules, audio: { ...draft.rules.audio, fallback: event.target.value || null } })}><option value="">{t("rules.fallbackNone")}</option>{languages.filter(({ code }) => draft.rules.audio.language === "mine" || code !== draft.rules.audio.language).map(({ code }) => <option key={code} value={code}>{languageName(code)}</option>)}</select></label>
          <label><span>{t("rules.subtitles")}</span><select aria-label={t("rules.subtitles")} value={draft.rules.subtitles} onChange={(event) => setSubtitles(event.target.value as DownloadRules["subtitles"])}><option value="off">{t("rules.subtitlesOff")}</option><option value="ifAvailable">{t("rules.subtitlesIfAvailable")}</option><option value="required">{t("rules.subtitlesRequired")}</option></select></label>
          <label><span>{t("rules.subtitleLanguage")}</span><select aria-label={t("rules.subtitleLanguage")} disabled={draft.rules.subtitles === "off"} value={draft.rules.subtitleLanguage} onChange={(event) => updateRules({ ...draft.rules, subtitleLanguage: event.target.value })}><option value="mine">{t("rules.audioLanguageMine")}</option>{languages.map(({ code }) => <option key={code} value={code}>{languageName(code)}</option>)}</select></label>
        </div>
      </fieldset>
      <fieldset className="rules-fieldset"><legend>{t("rules.preferSection")}</legend>
        <button type="button" className="rules-advanced-toggle" aria-expanded={advanced} onClick={() => setAdvanced((value) => !value)}>{t("rules.advanced")}</button>
        {advanced && <><span className="rules-subheading">{t("rules.preferenceOrder")}</span>
          <div className="rules-preference-choices">{PREFERENCES.filter((preference) => preference !== "language" || draft.rules.audio.mode !== "any").map((preference) => <label key={preference}><input type="checkbox" aria-label={preferenceLabel(preference)} checked={draft.rules.preference.includes(preference)} disabled={preferenceDisabled(preference)} onChange={() => togglePreference(preference)}/><span>{preferenceLabel(preference)}</span></label>)}</div>
          <div className="rules-order-list">{draft.rules.preference.map((preference, index) => <div key={preference}><span><b>{index + 1}</b> {preferenceLabel(preference)}</span><span>
            <button type="button" className="icon-button" aria-label={t("rules.moveUp", { name: preferenceLabel(preference) })} disabled={index === 0} onClick={() => updateRules({ ...draft.rules, preference: move(draft.rules.preference, index, -1) })}><ArrowUp/></button>
            <button type="button" className="icon-button" aria-label={t("rules.moveDown", { name: preferenceLabel(preference) })} disabled={index === draft.rules.preference.length - 1} onClick={() => updateRules({ ...draft.rules, preference: move(draft.rules.preference, index, 1) })}><ArrowDown/></button>
          </span></div>)}</div>
        </>}
      </fieldset>
    </DialogShell>}

    {duplicate && <DialogShell label={t("rules.duplicateTitle")} title={t("rules.duplicateTitle")} busy={busy}
      onClose={() => { if (!busy) { setDuplicate(null); setDialogError(""); } }} onSubmit={() => void saveDuplicate()} footer={<>
        {dialogError && <p className="login-error" role="alert">{dialogError}</p>}
        <button type="button" disabled={busy} onClick={() => { setDuplicate(null); setDialogError(""); }}>{t("common.cancel")}</button>
        <button type="submit" className="primary" disabled={busy || !nameOk(duplicate.name)}>{t("rules.duplicate")}</button>
      </>}><p><strong>{duplicate.sourceName}</strong></p><label className="manifest-field"><span>{t("rules.name")}</span><input value={duplicate.name} maxLength={60} autoComplete="off" aria-label={t("rules.name")} onChange={(event) => setDuplicate({ ...duplicate, name: event.target.value })}/></label></DialogShell>}
    {remove && <DialogShell label={t("rules.deleteTitle")} title={t("rules.deleteTitle")} busy={busy}
      onClose={() => { if (!busy) { setRemove(null); setDialogError(""); setCanReload(false); } }} onSubmit={() => void confirmDelete()} footer={<>
        <p className="identify-hint">{t("rules.effect")}</p><p className="identify-hint">{t("rules.deleteFallback")}</p>
        {dialogError && <p className="login-error" role="alert">{dialogError}</p>}{canReload && <button type="button" disabled={busy} onClick={() => void reloadDelete()}>{t("rules.reload")}</button>}
        <button type="button" disabled={busy} onClick={() => { setRemove(null); setDialogError(""); setCanReload(false); }}>{t("common.cancel")}</button><button type="submit" className="primary" disabled={busy}>{t("common.delete")}</button>
      </>}><p><strong>{remove.name}</strong></p></DialogShell>}
  </section>;
}
