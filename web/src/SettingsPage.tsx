import { useRef, useState } from "react";
import { Check, ChevronRight, CirclePlay, Download, FileJson, HardDrive, Heart, KeyRound, Languages, Library, PackagePlus, ShieldCheck, Trash2, Upload, Users } from "lucide-react";
import { api } from "./api";
import { DiagnosticsSection } from "./DiagnosticsPanel";
import { AccountSettings } from "./Login";
import { LibraryManager } from "./LibraryManager";
import { SearchSettings } from "./SearchSettings";
import { Heading, SettingControl, SettingsSectionHead } from "./settings-ui";
import { LOCALES, LOCALE_NAMES, languageName, localeTag, t, useI18n, type Locale } from "./i18n";
import type { BuildInfo, LibraryView, SearchState, Session, Settings as AppSettings, SettingsPatch } from "./types";
import { UserManager } from "./UserManager";

export function TmdbSettings({ configured, onSave, onError, restricted = false }: { configured: boolean; onSave: (patch: SettingsPatch) => Promise<void>; onError: (error: unknown) => void; restricted?: boolean }) {
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const value = apiKey.trim();
    if (!value) return;
    setBusy(true);
    try { await onSave({ tmdbApiKey: value }); setApiKey(""); }
    catch (error) { onError(error); }
    finally { setBusy(false); }
  };
  const clear = async () => {
    if (!confirm(t("tmdb.removeConfirm"))) return;
    setBusy(true);
    try { await onSave({ tmdbApiKey: "" }); setApiKey(""); }
    catch (error) { onError(error); }
    finally { setBusy(false); }
  };
  return <section className="panel settings-section credentials-section">
    <SettingsSectionHead icon={<KeyRound/>} title={t("tmdb.title")} text={t("tmdb.sectionText")}/>
    {configured
      ? <p className="credentials-status" role="status">{t("tmdb.stored")}</p>
      : <p className="credentials-status muted">{t("tmdb.missing")}</p>}
    {!restricted && <div className="credentials-row"><label className="credentials-field">
      <span>{t(configured ? "tmdb.replaceKey" : "tmdb.apiKey")}</span>
      <input type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(event) => setApiKey(event.target.value)}
        aria-label={t("tmdb.keyLabel")} placeholder={configured ? "••••••••" : t("tmdb.keyPlaceholder")}/>
    </label>
    <div className="setting-actions">
      <button className="primary" disabled={busy || !apiKey.trim()} onClick={() => void submit()}>{t(configured ? "tmdb.replaceKey" : "tmdb.saveKey")}</button>
      {configured && <button className="danger" disabled={busy} onClick={() => void clear()}>{t("common.remove")}</button>}
    </div></div>}
  </section>;
}

export function RealDebridSettings({ configured, onSave, onError, restricted = false }: { configured: boolean; onSave: (patch: SettingsPatch) => Promise<void>; onError: (error: unknown) => void; restricted?: boolean }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const value = token.trim();
    if (!value) return;
    setBusy(true);
    try { await onSave({ realDebridToken: value }); setToken(""); }
    catch (error) { onError(error); }
    finally { setBusy(false); }
  };
  const clear = async () => {
    if (!confirm(t("debrid.removeConfirm"))) return;
    setBusy(true);
    try { await onSave({ realDebridToken: "" }); setToken(""); }
    catch (error) { onError(error); }
    finally { setBusy(false); }
  };
  return <section className="panel settings-section credentials-section">
    <SettingsSectionHead icon={<KeyRound/>} title={t("debrid.title")} text={t("debrid.sectionText")}/>
    {configured
      ? <p className="credentials-status" role="status">{t("debrid.stored")}</p>
      : <p className="credentials-status muted">{t("debrid.missing")}</p>}
    {!restricted && <div className="credentials-row"><label className="credentials-field">
      <span>{t(configured ? "debrid.replaceToken" : "debrid.apiToken")}</span>
      <input type="password" autoComplete="off" spellCheck={false} value={token} onChange={(event) => setToken(event.target.value)}
        aria-label={t("debrid.tokenLabel")} placeholder={configured ? "••••••••" : t("debrid.tokenPlaceholder")}/>
    </label>
    <div className="setting-actions">
      <button className="primary" disabled={busy || !token.trim()} onClick={() => void submit()}>{t(configured ? "debrid.replaceToken" : "debrid.saveToken")}</button>
      {configured && <button className="danger" disabled={busy} onClick={() => void clear()}>{t("common.remove")}</button>}
    </div></div>}
  </section>;
}

const REFRESH_HOURS = [0, 6, 12, 24, 48, 168] as const;
const refreshIntervalLabel = (hours: number) =>
  hours === 0 ? t("settings.addonRefreshOff")
  : hours === 168 ? t("settings.addonRefreshWeekly")
  : t("settings.addonRefreshHoursOption", { count: hours });

export function SettingsPage({ build, restricted = false, settings, search, onSearch, languages, libraries = [], session, onSession, onSave, onImported, onLibrariesChanged, onNotify, onError }: { build: BuildInfo | null; restricted?: boolean; settings: AppSettings; search: SearchState | null; onSearch: (state: SearchState) => void; languages: Array<{ code: string; name: string }>; libraries?: LibraryView[]; session: Session; onSession: (session: Session) => void; onSave: (patch: SettingsPatch) => Promise<void>; onImported: (backup: unknown) => Promise<void>; onLibrariesChanged: () => void; onNotify: (message: string) => void; onError: (error: unknown) => void }) {
  const { t, locale, setLocale } = useI18n();
  // An ordinary user decides only what is personal, and the panels the instance owns are
  // not rendered for one at all -- a disabled control still says what the instance runs.
  // `restricted` is a separate axis: it is the demo mode, and it takes the controls away
  // from an administrator too. The server is what enforces either; this is the interface
  // agreeing with it.
  const admin = session.role === "admin";
  // The names come from the browser in the active language, so they need sorting there too.
  const languageOptions = languages
    .map((item) => ({ code: item.code, name: languageName(item.code) }))
    .sort((a, b) => a.name.localeCompare(b.name, localeTag()))
    .map((item) => <option key={item.code} value={item.code}>{item.name}</option>);
  const tileShapes = [{ value: "poster", key: "settings.shape.poster" }, { value: "wide", key: "settings.shape.wide" }] as const;
  const tileSizes = [{ value: "compact", key: "settings.tile.compact" }, { value: "small", key: "settings.tile.small" }, { value: "medium", key: "settings.tile.medium" }, { value: "large", key: "settings.tile.large" }] as const;
  const importInput = useRef<HTMLInputElement>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  // Which root a download lands under is a property of the library, and a mount differs per
  // install; showing a fixed path was the last thing here that assumed one.
  const libraryRoot = (libraries.find((library) => library.defaultMovie) ?? libraries[0])?.root ?? t("settings.noLibraryRoot");
  const exportSettings = async () => {
    setBackupBusy(true);
    try {
      const backup = await api.exportSettings();
      const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url; link.download = `stremio-offline-settings-${new Date().toISOString().slice(0, 10)}.json`; link.click();
      URL.revokeObjectURL(url);
      onNotify(t("settings.exported"));
    } catch (error) { onError(error); }
    finally { setBackupBusy(false); }
  };
  const importSettings = async (file?: File) => {
    if (!file) return;
    if (importInput.current) importInput.current.value = "";
    if (!confirm(t("settings.importConfirm"))) return;
    setBackupBusy(true);
    try {
      let backup: unknown;
      try { backup = JSON.parse(await file.text()); }
      catch { throw new Error(t("settings.importNotJson")); }
      await onImported(backup);
      onNotify(t("settings.imported"));
    } catch (error) { onError(error); }
    finally { setBackupBusy(false); }
  };
  return <section className="settings-page"><div className="settings-title"><Heading eyebrow={t("settings.eyebrow")} title={t("settings.title")}/><span><Check/> {t("settings.autosave")}</span></div>
    {restricted && <p className="notice">{t("restricted.notice")}</p>}
    <div className="settings-grid">
      {admin && <section className="panel settings-section library-manager-section"><SettingsSectionHead icon={<Library/>} title={t("library.libraries")} text={t("library.librariesHint")}/><LibraryManager restricted={restricted || !admin} onChanged={onLibrariesChanged} onError={onError} onNotify={onNotify}/></section>}
      {admin && <section className="panel settings-section user-manager-section"><SettingsSectionHead icon={<Users/>} title={t("users.title")} text={t("users.hint")}/><UserManager session={session} restricted={restricted} onChanged={onLibrariesChanged} onNotify={onNotify} onError={onError}/></section>}
      <section className="panel settings-section"><SettingsSectionHead icon={<Library/>} title={t("nav.library")} /><SettingControl title={t("settings.sameTitles")} text={t("settings.sameTitlesHint")}><select aria-label={t("settings.sameTitles")} disabled={restricted} value={settings.mergeByName ? "1" : "0"} onChange={(event) => void onSave({ mergeByName: event.target.value === "1" })}><option value="1">{t("settings.merge")}</option><option value="0">{t("settings.showSeparately")}</option></select></SettingControl>
        <SettingControl title={t("settings.resumeRow")} text={t("settings.resumeRowHint")}>
          <select aria-label={t("settings.resumeRowLabel")} disabled={restricted} value={settings.showResumeRow ? "1" : "0"} onChange={(event) => void onSave({ showResumeRow: event.target.value === "1" })}>
            <option value="1">{t("settings.show")}</option><option value="0">{t("settings.hide")}</option>
          </select></SettingControl>
        {admin && <SettingControl title={t("settings.autoScan")} text={t("settings.autoScanHint")}>
          <select aria-label={t("settings.autoScanLabel")} disabled={restricted || !admin} value={settings.libraryAutoScan ? "1" : "0"} onChange={(event) => void onSave({ libraryAutoScan: event.target.value === "1" })}>
            <option value="1">{t("settings.autoScanOn")}</option><option value="0">{t("settings.autoScanOff")}</option>
          </select></SettingControl>}
        {admin && <SettingControl title={t("settings.scanDuringDownload")} text={t("settings.scanDuringDownloadHint")}>
          <select aria-label={t("settings.scanDuringDownloadLabel")} disabled={restricted || !admin} value={settings.libraryScanPauseOnDownload ? "0" : "1"} onChange={(event) => void onSave({ libraryScanPauseOnDownload: event.target.value === "0" })}>
            <option value="1">{t("settings.scanDuringDownloadOn")}</option><option value="0">{t("settings.scanDuringDownloadOff")}</option>
          </select></SettingControl>}
      </section>
      {admin && <section className="panel settings-section storage-section"><SettingsSectionHead icon={<HardDrive/>} title={t("settings.storageTitle")} text={t("settings.storageText")}/><p>{t("settings.artworkMoved")}</p><div className="storage-path"><span>{t("settings.dockerPath")}</span><code>{libraryRoot}</code></div><p>{t("settings.storageNoteBefore")} <code>DOWNLOAD_PATH</code> {t("settings.storageNoteAfter")}</p></section>}
      {admin && <section className="panel settings-section"><SettingsSectionHead icon={<PackagePlus/>} title={t("settings.addonsTitle")} text={t("settings.addonsText")}/>
        <SettingControl title={t("settings.addonRefresh")} text={t("settings.addonRefreshHint")}>
          <select aria-label={t("settings.addonRefreshLabel")} disabled={restricted} value={settings.addonRefreshHours ?? 24} onChange={(event) => void onSave({ addonRefreshHours: Number(event.target.value) })}>
            {REFRESH_HOURS.map((hours) => <option key={hours} value={hours}>{refreshIntervalLabel(hours)}</option>)}
          </select></SettingControl>
      </section>}
      <section className="panel settings-section"><SettingsSectionHead icon={<Download/>} title={t("nav.downloads")} text={t("settings.downloadsText")}/>
        <SettingControl title={t("settings.downloadTitleLanguage")} text={t("settings.downloadTitleLanguageHint")}>
          <select aria-label={t("settings.downloadTitleLanguage")} disabled={restricted} value={settings.downloadTitleLanguage} onChange={(event) => void onSave({ downloadTitleLanguage: event.target.value })}>
            <option value="ui">{t("settings.downloadTitleLanguageUi", { language: LOCALE_NAMES[locale] })}</option>{languageOptions}
          </select></SettingControl>
        {admin && <SettingControl title={t("settings.concurrent")} text={t("settings.concurrentHint")}>
          <select aria-label={t("settings.concurrent")} disabled={restricted || !admin} value={settings.concurrentDownloads} onChange={(event) => void onSave({ concurrentDownloads: Number(event.target.value) })}>
            {[1,2,3,4,5,6,7,8].map((value) => <option key={value} value={value}>{value}</option>)}
          </select></SettingControl>}
        {admin && <SettingControl title={t("settings.perProvider")} text={t("settings.perProviderHint")}>
          <select aria-label={t("settings.perProvider")} disabled={restricted || !admin} value={settings.parallelPerProvider ?? 1} onChange={(event) => void onSave({ parallelPerProvider: Number(event.target.value) })}>
            {[1,2,3,4].map((value) => <option key={value} value={value}>{value}</option>)}
          </select></SettingControl>}
        {admin && <SettingControl title={t("settings.segments")} text={t("settings.segmentsHint")}>
          <select aria-label={t("settings.segments")} disabled={restricted || !admin} value={settings.downloadSegments ?? 1} onChange={(event) => void onSave({ downloadSegments: Number(event.target.value) })}>
            {[1,2,3,4,6,8].map((value) => <option key={value} value={value}>{value}</option>)}
          </select></SettingControl>}</section>
      {admin && <TmdbSettings configured={settings.tmdbConfigured} onSave={onSave} onError={onError} restricted={restricted || !admin}/>}
      {admin && <RealDebridSettings configured={settings.realDebridConfigured} onSave={onSave} onError={onError} restricted={restricted || !admin}/>}
      <section className="panel settings-section playback-section"><SettingsSectionHead icon={<CirclePlay/>} title={t("settings.playbackTitle")} text={t("settings.playbackText")}/><div className="playback-settings"><SettingControl title={t("settings.audioLanguage")} text={t("settings.audioLanguageHint")}><select aria-label={t("settings.audioLanguageLabel")} disabled={restricted} value={settings.audioLanguage} onChange={(event) => void onSave({ audioLanguage: event.target.value })}>{languageOptions}</select></SettingControl><SettingControl title={t("settings.subtitleLanguage")} text={t("settings.subtitleLanguageHint")}><select aria-label={t("settings.subtitleLanguageLabel")} disabled={restricted} value={settings.subtitleLanguage} onChange={(event) => void onSave({ subtitleLanguage: event.target.value })}>{languageOptions}</select></SettingControl></div><SettingControl title={t("settings.streamSort")} text={t("settings.streamSortHint")}><select aria-label={t("settings.streamSort")} disabled={restricted} value={settings.streamSort} onChange={(event) => void onSave({ streamSort: event.target.value })}><option value="recommended">{t("sources.sortRecommended")}</option><option value="size-desc">{t("sources.sortLargest")}</option><option value="size-asc">{t("sources.sortSmallest")}</option><option value="addon">{t("sources.sortAddon")}</option></select></SettingControl><SettingControl title={t("settings.trackProgress")} text={t("settings.trackProgressHint")}>
          <select aria-label={t("settings.trackProgressLabel")} disabled={restricted} value={settings.trackProgress ? "1" : "0"} onChange={(event) => void onSave({ trackProgress: event.target.value === "1" })}>
            <option value="1">{t("settings.store")}</option><option value="0">{t("settings.doNotStore")}</option>
          </select></SettingControl>{!restricted && <SettingControl title={t("settings.history")} text={t("settings.historyHint")}>
          <button className="danger" onClick={async () => {
            if (!confirm(t("settings.historyConfirm"))) return;
            try { await api.clearProgress(); onNotify(t("settings.historyCleared")); } catch (error) { onError(error); }
          }}><Trash2/> {t("settings.clearHistory")}</button></SettingControl>}</section>
      <SearchSettings state={search} onState={onSearch} onNotify={onNotify} onError={onError}/>
      <section className="panel settings-section language-section"><SettingsSectionHead icon={<Languages/>} title={t("settings.appearanceTitle")}/>
        <SettingControl title={t("settings.uiLanguage")} text={t("settings.uiLanguageHint")}>
          <select aria-label={t("settings.uiLanguage")} disabled={restricted} value={locale} onChange={(event) => {
            const next = event.target.value as Locale;
            setLocale(next);
            void onSave({ uiLanguage: next });
          }}>{LOCALES.map((code) => <option key={code} value={code}>{LOCALE_NAMES[code]}</option>)}</select>
        </SettingControl><SettingControl title={t("settings.catalogTiles")} text={t("settings.catalogTilesHint")}><select aria-label={t("settings.catalogTiles")} disabled={restricted} value={settings.catalogTileSize} onChange={(event) => void onSave({ catalogTileSize: event.target.value as AppSettings["catalogTileSize"] })}>{tileSizes.map((size) => <option key={size.value} value={size.value}>{t(size.key)}</option>)}</select></SettingControl><SettingControl title={t("settings.libraryTiles")} text={t("settings.libraryTilesHint")}><select aria-label={t("settings.libraryTiles")} disabled={restricted} value={settings.libraryTileSize} onChange={(event) => void onSave({ libraryTileSize: event.target.value as AppSettings["libraryTileSize"] })}>{tileSizes.map((size) => <option key={size.value} value={size.value}>{t(size.key)}</option>)}</select></SettingControl><SettingControl title={t("settings.catalogShape")} text={t("settings.catalogShapeHint")}><select aria-label={t("settings.catalogShape")} disabled={restricted} value={settings.catalogTileShape} onChange={(event) => void onSave({ catalogTileShape: event.target.value as AppSettings["catalogTileShape"] })}>{tileShapes.map((shape) => <option key={shape.value} value={shape.value}>{t(shape.key)}</option>)}</select></SettingControl><SettingControl title={t("settings.libraryShape")} text={t("settings.libraryShapeHint")}><select aria-label={t("settings.libraryShape")} disabled={restricted} value={settings.libraryTileShape} onChange={(event) => void onSave({ libraryTileShape: event.target.value as AppSettings["libraryTileShape"] })}>{tileShapes.map((shape) => <option key={shape.value} value={shape.value}>{t(shape.key)}</option>)}</select></SettingControl></section>
      {admin && <section className="panel settings-section"><SettingsSectionHead icon={<ShieldCheck/>} title={t("settings.privacyTitle")} text={t("settings.privacyText")}/>
        <SettingControl title={t("settings.secureMode")} text={t("settings.secureModeHint")}>
          <select aria-label={t("settings.secureModeLabel")} disabled={restricted} value={settings.secureMode ? "1" : "0"} onChange={(event) => void onSave({ secureMode: event.target.value === "1" })}>
            <option value="1">{t("settings.secureModeOn")}</option><option value="0">{t("settings.secureModeOff")}</option>
          </select></SettingControl>
      </section>}
      <AccountSettings session={session} onSession={onSession} onNotify={onNotify} onError={onError} restricted={restricted}/>
      {!restricted && admin && <section className="panel settings-section backup-section"><SettingsSectionHead icon={<FileJson/>} title={t("settings.backupTitle")} text={t("settings.backupText")}/><p>{t("settings.backupBody")}</p><p className="notice">{t("settings.backupWarning")}</p><div className="setting-actions"><button disabled={backupBusy} onClick={() => void exportSettings()}><Download/> {t("settings.export")}</button><button disabled={backupBusy} onClick={() => importInput.current?.click()}><Upload/> {t("settings.import")}</button><input ref={importInput} className="file-input" type="file" accept="application/json,.json" aria-label={t("settings.pickBackup")} onChange={(event) => void importSettings(event.target.files?.[0])}/></div></section>}
      {!restricted && admin && <DiagnosticsSection build={build} onNotify={onNotify} onError={onError}/>}
    </div>
    <a className="support-link" href="https://ko-fi.com/nickrabit" target="_blank" rel="noopener noreferrer"><Heart aria-hidden="true"/><span><strong>{t("settings.supportTitle")}</strong><small>{t("settings.supportText")}</small></span><ChevronRight aria-hidden="true"/></a>
  </section>;
}
