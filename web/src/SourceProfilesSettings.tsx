import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ListFilter, X } from "lucide-react";
import { api, ApiError, describeError } from "./api";
import { useDialogFocus } from "./dialog-focus";
import { useDialogViewport } from "./dialog-viewport";
import { t, useI18n, type Key } from "./i18n";
import { sourceProfileCopy } from "./source-profile-copy";
import { SettingsSectionHead } from "./settings-ui";
import type { Addon, AdminSourceProfile, ProviderPriorityParameters, SourceProfileProviderOrder, SourceProfileScope, SourceProfileTemplate, TravelParameters } from "./types";

const MIN_HEIGHTS = [360, 480, 720, 1080, 2160] as const;
const MAX_HEIGHTS = [720, 1080, 2160] as const;
type MutableTemplate = "travel" | "providerPriority";
type AudioChoice = TravelParameters["audioMode"];
type SubtitleChoice = TravelParameters["subtitleMode"];

/** Checked addons stay in catalogue order until the person moves one. That move is the
 *  only thing that stores an explicit order; otherwise the profile follows each viewer. */
interface Draft {
  template: MutableTemplate;
  name: string;
  scopeMode: "allAvailable" | "selected";
  selectedKeys: string[];
  orderExplicit: boolean;
  explicitKeys: string[];
  audioMode: AudioChoice;
  subtitleMode: SubtitleChoice;
  minHeight: number;
  maxHeight: number | "";
  sizeDirection: "asc" | "desc";
  http: boolean;
  torrent: boolean;
}

type EditorSession =
  | { kind: "create"; builtIn: false; draft: Draft | null }
  | { kind: "edit"; id: string; revision: number; builtIn: boolean; draft: Draft };

interface DuplicateSession { id: string; sourceName: string; name: string }
interface DeleteSession { id: string; revision: number; name: string }

const AUDIO_LABEL: Record<AudioChoice, Key> = {
  listed: "bulk.audioModeListed",
  preferred: "bulk.audioModePreferred",
  strict: "bulk.audioModeStrict",
};
const SUBTITLE_LABEL: Record<SubtitleChoice, Key> = {
  off: "bulk.subtitlesOff",
  optional: "bulk.subtitlesOptional",
  required: "bulk.subtitlesRequired",
};

const providesStreams = (addon: Addon) =>
  (addon.manifest.resources ?? []).some((resource) =>
    typeof resource === "string" ? resource === "stream" : resource.name === "stream");

const catalogueKeys = (addons: readonly Addon[]) => addons.filter(providesStreams).map((addon) => addon.key);

const inCatalogueOrder = (keys: readonly string[], catalogue: readonly string[]) => {
  const rank = new Map(catalogue.map((key, index) => [key, index]));
  return [...keys].sort((left, right) =>
    (rank.get(left) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right) ?? Number.MAX_SAFE_INTEGER)
    || left.localeCompare(right));
};

const blankDraft = (template: MutableTemplate): Draft => ({
  template,
  name: "",
  scopeMode: "allAvailable",
  selectedKeys: [],
  orderExplicit: false,
  explicitKeys: [],
  audioMode: "preferred",
  subtitleMode: "optional",
  minHeight: 480,
  maxHeight: "",
  sizeDirection: "desc",
  http: true,
  torrent: true,
});

const draftFrom = (profile: AdminSourceProfile, catalogue: readonly string[]): Draft => {
  const template: MutableTemplate = profile.template === "providerPriority" ? "providerPriority" : "travel";
  const draft = blankDraft(template);
  draft.name = profile.name ?? "";
  const parameters = profile.parameters;
  if (!parameters) return draft;
  draft.scopeMode = parameters.scope.mode;
  draft.audioMode = parameters.audioMode;
  draft.subtitleMode = parameters.subtitleMode;
  const order = parameters.providerOrder;
  if (parameters.scope.mode === "selected") {
    const selected = parameters.scope.addonKeys;
    if ("addonKeys" in order) {
      const ordered = order.addonKeys.filter((key) => selected.includes(key));
      const rest = inCatalogueOrder(selected.filter((key) => !ordered.includes(key)), catalogue);
      draft.selectedKeys = [...ordered, ...rest];
      draft.orderExplicit = true;
      draft.explicitKeys = [...draft.selectedKeys];
    } else {
      draft.selectedKeys = inCatalogueOrder(selected, catalogue);
    }
  } else if ("addonKeys" in order) {
    draft.orderExplicit = true;
    draft.explicitKeys = [...order.addonKeys];
  }
  if ("heightPixels" in parameters) {
    draft.minHeight = parameters.heightPixels.min;
    draft.maxHeight = parameters.heightPixels.max ?? "";
  }
  if ("transfer" in parameters) {
    draft.sizeDirection = parameters.sizeDirection;
    draft.http = parameters.transfer.includes("http");
    draft.torrent = parameters.transfer.includes("torrent");
  }
  return draft;
};

const chooseTemplate = (draft: Draft | null, template: MutableTemplate): Draft => {
  const next: Draft = draft ? { ...draft, template } : blankDraft(template);
  if (template === "providerPriority" && next.audioMode === "strict") next.audioMode = "preferred";
  if (template === "providerPriority" && next.subtitleMode === "required") next.subtitleMode = "optional";
  return next;
};

const toggleKey = (draft: Draft, key: string, catalogue: readonly string[]): Draft => {
  const selected = draft.selectedKeys.includes(key)
    ? draft.selectedKeys.filter((item) => item !== key)
    : [...draft.selectedKeys, key];
  const selectedKeys = draft.orderExplicit ? selected : inCatalogueOrder(selected, catalogue);
  return { ...draft, selectedKeys, explicitKeys: draft.orderExplicit ? selectedKeys : draft.explicitKeys };
};

const moveKey = (draft: Draft, key: string, direction: -1 | 1): Draft => {
  const index = draft.selectedKeys.indexOf(key);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= draft.selectedKeys.length) return draft;
  const selectedKeys = [...draft.selectedKeys];
  const swapped = selectedKeys[index]!;
  selectedKeys[index] = selectedKeys[next]!;
  selectedKeys[next] = swapped;
  return { ...draft, selectedKeys, orderExplicit: true, explicitKeys: [...selectedKeys] };
};

const useViewerOrder = (draft: Draft, catalogue: readonly string[]): Draft => ({
  ...draft,
  orderExplicit: false,
  explicitKeys: [],
  selectedKeys: inCatalogueOrder(draft.selectedKeys, catalogue),
});

const scopeOf = (draft: Draft): SourceProfileScope =>
  draft.scopeMode === "allAvailable"
    ? { mode: "allAvailable" }
    : { mode: "selected", addonKeys: [...draft.selectedKeys] };

const providerOrderOf = (draft: Draft): SourceProfileProviderOrder => {
  if (!draft.orderExplicit) return { from: "viewer" };
  const keys = draft.scopeMode === "selected" ? draft.selectedKeys : draft.explicitKeys;
  return keys.length ? { addonKeys: [...keys] } : { from: "viewer" };
};

const parametersOf = (draft: Draft): TravelParameters | ProviderPriorityParameters => {
  const scope = scopeOf(draft);
  const providerOrder = providerOrderOf(draft);
  if (draft.template === "travel") {
    return {
      scope,
      providerOrder,
      audioMode: draft.audioMode,
      subtitleMode: draft.subtitleMode,
      heightPixels: draft.maxHeight === "" ? { min: draft.minHeight } : { min: draft.minHeight, max: draft.maxHeight },
    };
  }
  const transfer: ProviderPriorityParameters["transfer"] = [
    ...(draft.http ? ["http" as const] : []),
    ...(draft.torrent ? ["torrent" as const] : []),
  ];
  return {
    scope,
    providerOrder,
    sizeDirection: draft.sizeDirection,
    transfer,
    audioMode: draft.audioMode === "strict" ? "preferred" : draft.audioMode,
    subtitleMode: draft.subtitleMode === "required" ? "optional" : draft.subtitleMode,
  };
};

const nameOk = (name: string) => {
  const trimmed = name.trim();
  return trimmed.length >= 1 && trimmed.length <= 60;
};

const canSave = (draft: Draft | null, builtIn: boolean): draft is Draft => {
  if (!draft) return false;
  if (!builtIn && !nameOk(draft.name)) return false;
  if (draft.scopeMode === "selected" && draft.selectedKeys.length === 0) return false;
  if (draft.template === "providerPriority" && !draft.http && !draft.torrent) return false;
  if (draft.template === "travel" && draft.maxHeight !== "" && draft.maxHeight < draft.minHeight) return false;
  return true;
};

const templateLabel = (template: SourceProfileTemplate) => t(
  template === "recommended" ? "settings.sourceProfiles.templateRecommended"
    : template === "travel" ? "settings.sourceProfiles.templateTravel"
      : "settings.sourceProfiles.templateProviderPriority",
);

const profileName = (profile: AdminSourceProfile) => {
  const copy = sourceProfileCopy(profile.nameKey);
  return copy ? t(copy.name) : profile.name || profile.id;
};

const readCatalogue = async () => {
  const [profileAnswer, addonAnswer] = await Promise.all([
    api.adminSourceProfiles(),
    api.addons(),
  ]);
  return {
    profiles: Array.isArray(profileAnswer?.profiles) ? profileAnswer.profiles : [],
    addons: Array.isArray(addonAnswer) ? addonAnswer : [],
  };
};

const heightChoices = (options: readonly number[], current: number) =>
  options.includes(current) ? [...options] : [...options, current].sort((left, right) => left - right);

function DialogShell({ label, title, busy, onClose, onSubmit, children, footer }: {
  label: string;
  title: string;
  busy: boolean;
  onClose: () => void;
  onSubmit?: () => void;
  children: ReactNode;
  footer: ReactNode;
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
    <div className="identify-head">
      <h2>{title}</h2>
      <button type="button" className="icon-button" aria-label={t("common.close")} disabled={busy} onClick={onClose}><X/></button>
    </div>
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

function OrderNote({ draft, onUseViewer }: { draft: Draft; onUseViewer: () => void }) {
  if (draft.scopeMode !== "selected" && !draft.orderExplicit) return null;
  return <>
    <p className="identify-hint">{t(draft.orderExplicit ? "settings.sourceProfiles.orderExplicit" : "settings.sourceProfiles.orderViewer")}</p>
    {draft.orderExplicit && <button type="button" onClick={onUseViewer}>{t("settings.sourceProfiles.orderUseViewer")}</button>}
  </>;
}

export function SourceProfilesSettings() {
  useI18n();
  const [profiles, setProfiles] = useState<AdminSourceProfile[]>([]);
  const [addons, setAddons] = useState<Addon[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const [canReload, setCanReload] = useState(false);
  const [session, setSession] = useState<EditorSession | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateSession | null>(null);
  const [remove, setRemove] = useState<DeleteSession | null>(null);
  const keys = catalogueKeys(addons);

  const refresh = async () => {
    const loaded = await readCatalogue();
    setProfiles(loaded.profiles);
    setAddons(loaded.addons);
    setLoadError("");
    return loaded;
  };

  useEffect(() => {
    let stale = false;
    setLoading(true);
    readCatalogue()
      .then((loaded) => {
        if (stale) return;
        setProfiles(loaded.profiles);
        setAddons(loaded.addons);
        setLoadError("");
      })
      .catch((error) => { if (!stale) setLoadError(describeError(error)); })
      .finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
  }, []);

  const openCreate = () => {
    setDialogError("");
    setCanReload(false);
    setSession({ kind: "create", builtIn: false, draft: null });
  };
  const openEdit = (profile: AdminSourceProfile) => {
    if (profile.template === "recommended") return;
    setDialogError("");
    setCanReload(false);
    setSession({
      kind: "edit",
      id: profile.id,
      revision: profile.revision,
      builtIn: profile.nameKey !== undefined,
      draft: draftFrom(profile, keys),
    });
  };
  const closeEditor = () => { if (!busy) { setSession(null); setDialogError(""); setCanReload(false); } };

  const updateDraft = (draft: Draft) => setSession((current) => current ? { ...current, draft } : current);

  const save = async () => {
    if (!session || !canSave(session.draft, session.builtIn)) return;
    const draft = session.draft;
    const parameters = parametersOf(draft);
    setBusy(true);
    setDialogError("");
    setCanReload(false);
    try {
      if (session.kind === "create") {
        await api.createAdminSourceProfile({ template: draft.template, name: draft.name.trim(), parameters });
      } else {
        await api.updateAdminSourceProfile(session.id, {
          revision: session.revision,
          ...(session.builtIn ? {} : { name: draft.name.trim() }),
          parameters,
        });
      }
      setSession(null);
      await refresh();
    } catch (error) {
      setDialogError(describeError(error));
      setCanReload(error instanceof ApiError && error.status === 409 && session.kind === "edit");
    } finally {
      setBusy(false);
    }
  };

  const reloadEditor = async () => {
    if (!session || session.kind !== "edit") return;
    setBusy(true);
    try {
      const loaded = await refresh();
      const fresh = loaded.profiles.find((profile) => profile.id === session.id);
      if (!fresh || fresh.template === "recommended") {
        setSession(null);
        setDialogError("");
        setCanReload(false);
        return;
      }
      setSession({
        kind: "edit",
        id: fresh.id,
        revision: fresh.revision,
        builtIn: fresh.nameKey !== undefined,
        draft: draftFrom(fresh, catalogueKeys(loaded.addons)),
      });
      setDialogError("");
      setCanReload(false);
    } catch (error) {
      setDialogError(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  const saveDuplicate = async () => {
    if (!duplicate || !nameOk(duplicate.name)) return;
    setBusy(true);
    setDialogError("");
    try {
      await api.duplicateAdminSourceProfile(duplicate.id, duplicate.name.trim());
      setDuplicate(null);
      await refresh();
    } catch (error) {
      setDialogError(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!remove) return;
    setBusy(true);
    setDialogError("");
    setCanReload(false);
    try {
      await api.deleteAdminSourceProfile(remove.id, remove.revision);
      setRemove(null);
      await refresh();
    } catch (error) {
      setDialogError(describeError(error));
      setCanReload(error instanceof ApiError && error.status === 409);
    } finally {
      setBusy(false);
    }
  };

  const reloadDelete = async () => {
    if (!remove) return;
    setBusy(true);
    try {
      const loaded = await refresh();
      const fresh = loaded.profiles.find((profile) => profile.id === remove.id);
      if (!fresh || fresh.nameKey !== undefined) setRemove(null);
      else setRemove({ id: fresh.id, revision: fresh.revision, name: profileName(fresh) });
      setDialogError("");
      setCanReload(false);
    } catch (error) {
      setDialogError(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  const draft = session?.draft ?? null;
  const rows = draft ? streamRows(addons, draft.selectedKeys) : [];

  return <section className="panel settings-section source-profiles-section">
    <SettingsSectionHead icon={<ListFilter/>} title={t("settings.sourceProfiles.title")} text={t("settings.sourceProfiles.hint")}/>
    {loading && <p className="identify-hint">{t("common.loading")}</p>}
    {loadError && <p className="login-error" role="alert">{loadError}</p>}
    {!loading && <ul className="source-profile-list">
      {profiles.map((profile) => {
        const recommended = profile.template === "recommended";
        const builtIn = profile.nameKey !== undefined;
        return <li key={profile.id} className="source-profile-row" data-profile-id={profile.id}>
          <span><strong>{profileName(profile)}</strong><small>{templateLabel(profile.template)}</small></span>
          <span className="source-profile-actions">
            {!recommended && <button type="button" onClick={() => openEdit(profile)}>{t("settings.sourceProfiles.edit")}</button>}
            {!recommended && <button type="button" onClick={() => { setDialogError(""); setCanReload(false); setDuplicate({ id: profile.id, sourceName: profileName(profile), name: "" }); }}>{t("settings.sourceProfiles.duplicate")}</button>}
            {!builtIn && <button type="button" onClick={() => { setDialogError(""); setCanReload(false); setRemove({ id: profile.id, revision: profile.revision, name: profileName(profile) }); }}>{t("common.delete")}</button>}
          </span>
        </li>;
      })}
    </ul>}
    <div className="setting-actions">
      <button type="button" className="primary" onClick={openCreate}>{t("settings.sourceProfiles.add")}</button>
    </div>
    {session && <DialogShell
      label={t(session.kind === "create" ? "settings.sourceProfiles.editorNew" : "settings.sourceProfiles.editorEdit")}
      title={t(session.kind === "create" ? "settings.sourceProfiles.editorNew" : "settings.sourceProfiles.editorEdit")}
      busy={busy} onClose={closeEditor} onSubmit={() => void save()}
      footer={<>
        {dialogError && <p className="login-error" role="alert">{dialogError}</p>}
        {session.kind === "edit" && <p className="identify-hint">{t("settings.sourceProfiles.effect")}</p>}
        {canReload && <button type="button" disabled={busy} onClick={() => void reloadEditor()}>{t("settings.sourceProfiles.reload")}</button>}
        <button type="button" disabled={busy} onClick={closeEditor}>{t("common.cancel")}</button>
        <button type="submit" className="primary" disabled={busy || !canSave(draft, session.builtIn)}>{busy ? t("common.saving") : t("common.save")}</button>
      </>}>
      {session.kind === "create"
        ? <div className="bulk-strategy" role="radiogroup" aria-label={t("settings.sourceProfiles.template")}>
          {(["travel", "providerPriority"] as const).map((template) => <label key={template} className={draft?.template === template ? "selected" : ""}>
            <input type="radio" name="source-profile-template" value={template} checked={draft?.template === template} onChange={() => updateDraft(chooseTemplate(draft, template))}/>
            <span><strong>{templateLabel(template)}</strong></span>
          </label>)}
        </div>
        : draft && <p><span>{t("settings.sourceProfiles.template")}</span> <strong>{templateLabel(draft.template)}</strong></p>}
      {draft && <>
        {!session.builtIn && <label className="manifest-field"><span>{t("settings.sourceProfiles.name")}</span>
          <input value={draft.name} maxLength={60} autoComplete="off" aria-label={t("settings.sourceProfiles.name")} onChange={(event) => updateDraft({ ...draft, name: event.target.value })}/>
        </label>}
        <div className="bulk-strategy" role="radiogroup" aria-label={t("settings.sourceProfiles.addons")}>
          <label className={draft.scopeMode === "allAvailable" ? "selected" : ""}>
            <input type="radio" name="source-profile-scope" value="allAvailable" checked={draft.scopeMode === "allAvailable"} onChange={() => updateDraft({ ...draft, scopeMode: "allAvailable" })}/>
            <span><strong>{t("settings.sourceProfiles.addonsAll")}</strong></span>
          </label>
          <label className={draft.scopeMode === "selected" ? "selected" : ""}>
            <input type="radio" name="source-profile-scope" value="selected" checked={draft.scopeMode === "selected"} onChange={() => updateDraft({ ...draft, scopeMode: "selected" })}/>
            <span><strong>{t("settings.sourceProfiles.addonsSelected")}</strong></span>
          </label>
        </div>
        <OrderNote draft={draft} onUseViewer={() => updateDraft(useViewerOrder(draft, keys))}/>
        {draft.scopeMode === "selected" && <fieldset className="bulk-sources">
          <legend>{t("settings.sourceProfiles.addons")}</legend>
          {rows.map((row) => {
            const index = draft.selectedKeys.indexOf(row.key);
            const checked = index >= 0;
            return <div key={row.key} className={checked ? "selected" : ""}>
              <label>
                <input type="checkbox" aria-label={row.name} checked={checked} onChange={() => updateDraft(toggleKey(draft, row.key, keys))}/>
                {draft.orderExplicit && checked && <b aria-hidden="true">{index + 1}</b>}
                <span>{row.name}</span>
              </label>
              {checked && <span>
                <button type="button" className="icon-button" aria-label={t("bulk.moveSourceUp", { name: row.name })} disabled={index === 0} onClick={() => updateDraft(moveKey(draft, row.key, -1))}><ArrowUp/></button>
                <button type="button" className="icon-button" aria-label={t("bulk.moveSourceDown", { name: row.name })} disabled={index === draft.selectedKeys.length - 1} onClick={() => updateDraft(moveKey(draft, row.key, 1))}><ArrowDown/></button>
              </span>}
            </div>;
          })}
          {!rows.length && <p className="identify-hint">{t("settings.sourceProfiles.noStreamAddons")}</p>}
        </fieldset>}
        {draft.template === "travel" ? <div className="bulk-language-grid">
          <label><span>{t("settings.sourceProfiles.audio")}</span>
            <select aria-label={t("settings.sourceProfiles.audio")} value={draft.audioMode} onChange={(event) => updateDraft({ ...draft, audioMode: event.target.value as AudioChoice })}>
              {(["listed", "preferred", "strict"] as const).map((mode) => <option key={mode} value={mode}>{t(AUDIO_LABEL[mode])}</option>)}
            </select></label>
          <label><span>{t("settings.sourceProfiles.subtitles")}</span>
            <select aria-label={t("settings.sourceProfiles.subtitles")} value={draft.subtitleMode} onChange={(event) => updateDraft({ ...draft, subtitleMode: event.target.value as SubtitleChoice })}>
              {(["off", "optional", "required"] as const).map((mode) => <option key={mode} value={mode}>{t(SUBTITLE_LABEL[mode])}</option>)}
            </select></label>
          <label><span>{t("settings.sourceProfiles.minHeight")}</span>
            <select aria-label={t("settings.sourceProfiles.minHeight")} value={String(draft.minHeight)} onChange={(event) => {
              const minHeight = Number(event.target.value);
              updateDraft({ ...draft, minHeight, maxHeight: draft.maxHeight !== "" && draft.maxHeight < minHeight ? "" : draft.maxHeight });
            }}>
              {heightChoices(MIN_HEIGHTS, draft.minHeight).map((height) => <option key={height} value={height}>{t("settings.sourceProfiles.height", { height })}</option>)}
            </select></label>
          <label><span>{t("settings.sourceProfiles.maxHeight")}</span>
            <select aria-label={t("settings.sourceProfiles.maxHeight")} value={draft.maxHeight === "" ? "" : String(draft.maxHeight)} onChange={(event) => {
              const raw = event.target.value;
              const maxHeight = raw === "" ? "" : Number(raw);
              updateDraft({ ...draft, maxHeight: maxHeight !== "" && maxHeight < draft.minHeight ? "" : maxHeight });
            }}>
              <option value="">{t("settings.sourceProfiles.maxHeightNone")}</option>
              {heightChoices(MAX_HEIGHTS, draft.maxHeight === "" ? MAX_HEIGHTS[0] : draft.maxHeight)
                .filter((height) => height >= draft.minHeight)
                .map((height) => <option key={height} value={height}>{t("settings.sourceProfiles.height", { height })}</option>)}
            </select></label>
        </div> : <div className="bulk-language-grid">
          <label><span>{t("settings.sourceProfiles.size")}</span>
            <select aria-label={t("settings.sourceProfiles.size")} value={draft.sizeDirection} onChange={(event) => updateDraft({ ...draft, sizeDirection: event.target.value as Draft["sizeDirection"] })}>
              <option value="desc">{t("sources.sortLargest")}</option>
              <option value="asc">{t("sources.sortSmallest")}</option>
            </select></label>
          <label><span>{t("settings.sourceProfiles.audio")}</span>
            <select aria-label={t("settings.sourceProfiles.audio")} value={draft.audioMode === "strict" ? "preferred" : draft.audioMode} onChange={(event) => updateDraft({ ...draft, audioMode: event.target.value as AudioChoice })}>
              {(["listed", "preferred"] as const).map((mode) => <option key={mode} value={mode}>{t(AUDIO_LABEL[mode])}</option>)}
            </select></label>
          <label><span>{t("settings.sourceProfiles.subtitles")}</span>
            <select aria-label={t("settings.sourceProfiles.subtitles")} value={draft.subtitleMode === "required" ? "optional" : draft.subtitleMode} onChange={(event) => updateDraft({ ...draft, subtitleMode: event.target.value as SubtitleChoice })}>
              {(["off", "optional"] as const).map((mode) => <option key={mode} value={mode}>{t(SUBTITLE_LABEL[mode])}</option>)}
            </select></label>
          <fieldset className="bulk-sources">
            <legend>{t("settings.sourceProfiles.transfer")}</legend>
            <div className={draft.http ? "selected" : ""}>
              <label><input type="checkbox" aria-label={t("settings.sourceProfiles.transferHttp")} checked={draft.http} onChange={(event) => updateDraft({ ...draft, http: event.target.checked })}/><span>{t("settings.sourceProfiles.transferHttp")}</span></label>
            </div>
            <div className={draft.torrent ? "selected" : ""}>
              <label><input type="checkbox" aria-label={t("settings.sourceProfiles.transferTorrent")} checked={draft.torrent} onChange={(event) => updateDraft({ ...draft, torrent: event.target.checked })}/><span>{t("settings.sourceProfiles.transferTorrent")}</span></label>
            </div>
          </fieldset>
          {!draft.http && !draft.torrent && <p className="identify-hint">{t("settings.sourceProfiles.transferRequired")}</p>}
        </div>}
      </>}
    </DialogShell>}
    {duplicate && <DialogShell label={t("settings.sourceProfiles.duplicateTitle")} title={t("settings.sourceProfiles.duplicateTitle")}
      busy={busy} onClose={() => { if (!busy) { setDuplicate(null); setDialogError(""); } }} onSubmit={() => void saveDuplicate()}
      footer={<>
        {dialogError && <p className="login-error" role="alert">{dialogError}</p>}
        <button type="button" disabled={busy} onClick={() => { if (!busy) { setDuplicate(null); setDialogError(""); } }}>{t("common.cancel")}</button>
        <button type="submit" className="primary" disabled={busy || !nameOk(duplicate.name)}>{t("settings.sourceProfiles.duplicate")}</button>
      </>}>
      <p><strong>{duplicate.sourceName}</strong></p>
      <label className="manifest-field"><span>{t("settings.sourceProfiles.name")}</span>
        <input value={duplicate.name} maxLength={60} autoComplete="off" aria-label={t("settings.sourceProfiles.name")} onChange={(event) => setDuplicate({ ...duplicate, name: event.target.value })}/>
      </label>
    </DialogShell>}
    {remove && <DialogShell label={t("settings.sourceProfiles.deleteTitle")} title={t("settings.sourceProfiles.deleteTitle")}
      busy={busy} onClose={() => { if (!busy) { setRemove(null); setDialogError(""); setCanReload(false); } }} onSubmit={() => void confirmDelete()}
      footer={<>
        <p className="identify-hint">{t("settings.sourceProfiles.effect")}</p>
        <p className="identify-hint">{t("settings.sourceProfiles.deleteFallback")}</p>
        {dialogError && <p className="login-error" role="alert">{dialogError}</p>}
        {canReload && <button type="button" disabled={busy} onClick={() => void reloadDelete()}>{t("settings.sourceProfiles.reload")}</button>}
        <button type="button" disabled={busy} onClick={() => { if (!busy) { setRemove(null); setDialogError(""); setCanReload(false); } }}>{t("common.cancel")}</button>
        <button type="submit" className="primary" disabled={busy}>{t("common.delete")}</button>
      </>}>
      <p><strong>{remove.name}</strong></p>
    </DialogShell>}
  </section>;
}

function streamRows(addons: readonly Addon[], selectedKeys: readonly string[]) {
  const known = addons.filter(providesStreams).map((addon) => ({ key: addon.key, name: addon.manifest.name || addon.key }));
  const knownKeys = new Set(known.map((row) => row.key));
  const missing = selectedKeys.filter((key) => !knownKeys.has(key)).map((key) => ({ key, name: key }));
  return [...known, ...missing].sort((left, right) => {
    const leftIndex = selectedKeys.indexOf(left.key);
    const rightIndex = selectedKeys.indexOf(right.key);
    if (leftIndex < 0 && rightIndex < 0) return 0;
    if (leftIndex < 0 || rightIndex < 0) return leftIndex < 0 ? 1 : -1;
    return leftIndex - rightIndex;
  });
}
