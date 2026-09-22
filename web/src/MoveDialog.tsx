import { useEffect, useRef, useState } from "react";
import { ChevronRight, CornerLeftUp, FolderOpen, HardDrive, X } from "lucide-react";
import { api, describeError } from "./api";
import { t, useI18n } from "./i18n";
import type { LibraryFolder, LibraryView } from "./types";

const parentOf = (folder: string) => folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "";

/** Picks the folder an item moves into. It opens where the item sits now, so the usual move --
 *  one level up or into the folder next door -- is a couple of clicks away. With more than one
 *  library the same dialog crosses between them: the picked library's own tree is then walked,
 *  and only the libraries that take this kind of title are offered. */
export function MoveDialog({ path, paths, copy = false, label, itemType, libraries = [], onClose, onQueued }:
  { path: string; label: string; itemType?: "movie" | "series"; libraries?: LibraryView[];
    paths?: string[]; copy?: boolean; onClose: () => void; onQueued?: (id: string) => void }) {
  useI18n();
  const [folder, setFolder] = useState(parentOf(path));
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const chips = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The row is capped at a couple of lines, so the library being browsed can sit below the fold
  // -- the one chip that has to be visible is the one that says where the listing comes from.
  useEffect(() => {
    // jsdom has no scrollIntoView, and neither has an older browser: the chip row degrades to
    // what it was before, a row the reader scrolls themselves.
    chips.current?.querySelector("[aria-pressed=true]")?.scrollIntoView?.({ block: "nearest" });
  }, [folder, libraries.length]);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    void api.libraryFolders(folder)
      .then((result) => { if (!cancelled) { setFolders(result.folders); setError(""); } })
      .catch((value) => { if (!cancelled) setError(describeError(value)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [folder]);

  // One library speaks bare paths on the wire, several name the library first.
  const qualified = libraries.length > 1;
  const libraryOf = (value: string) => libraries.find((library) => value === library.id || value.startsWith(`${library.id}/`));
  const current = libraryOf(folder) ?? (qualified ? undefined : libraries[0]);
  const root = current ? (qualified ? current.id : "") : "";
  const relative = root ? (folder === root ? "" : folder.slice(root.length + 1)) : folder;
  const source = libraryOf(path)?.id;
  const takes = (library: LibraryView) =>
    library.id === source || (library.enabled && !library.unreachable && !library.readOnly
      && (library.type === "mixed" || !itemType || library.type === itemType));
  const offered = libraries.filter(takes);
  const open = (value: string) => setFolder(root ? (value ? `${root}/${value}` : root) : value);

  // The item cannot land where it already is, and a folder cannot be moved inside itself.
  const moving = paths?.length ? paths : [path];
  const inItself = moving.some((item) => folder === item || folder.startsWith(`${item}/`));
  const unchanged = moving.every((item) => folder === parentOf(item));
  const crumbs = relative ? relative.split("/") : [];

  const move = async () => {
    setBusy(true);
    try {
      // One item and many take the same road: the move itself runs in the queue, and the
      // dialog is out of the way the moment the job is accepted rather than when it is done.
      const queued = await api.startLibraryOp({ op: copy ? "copy" : "move", items: paths?.length ? paths : [path], target: folder });
      onQueued?.(queued.id);
      onClose();
    } catch (value) { setError(describeError(value)); setBusy(false); }
  };

  return <div className="identify-overlay" role="dialog" aria-modal="true" aria-label={t("library.move")}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="panel identify-card dialog-split move-card">
      <div className="identify-head">
        <h2>{t(copy ? "library.copyTitle" : "library.moveTitle", { name: label })}</h2>
        <button type="button" className="icon-button" aria-label={t("common.close")} onClick={onClose}><X/></button>
      </div>
      {offered.length > 1 && <div className="move-libraries" ref={chips} role="group" aria-label={t("library.moveToLibrary")}>
        {offered.map((library) => <button type="button" key={library.id} aria-pressed={current?.id === library.id}
          onClick={() => setFolder(qualified ? library.id : "")}>{library.name}</button>)}
      </div>}
      <div className="dialog-body">
        <nav className="move-crumbs" aria-label={t("library.moveDestination")}>
          <button type="button" onClick={() => open("")}><HardDrive/> {qualified && current ? current.name : t("library.rootFolder")}</button>
          {crumbs.map((name, index) => <span key={name + index}>
            <ChevronRight aria-hidden="true"/>
            <button type="button" onClick={() => open(crumbs.slice(0, index + 1).join("/"))}>{name}</button>
          </span>)}
        </nav>
        <div className="move-list">
          {relative && <button type="button" className="move-up" onClick={() => open(parentOf(relative))}>
            <CornerLeftUp/> {t("library.moveUp")}
          </button>}
          {folders.map((item) => <button type="button" key={item.path} disabled={moving.includes(item.path)} onClick={() => setFolder(item.path)}>
            <FolderOpen/> <span>{item.name}</span> <ChevronRight/>
          </button>)}
          {!busy && !folders.length && <p className="identify-hint">{t("library.moveNoSubfolders")}</p>}
        </div>
      </div>
      <footer className="dialog-foot">
        {error && <p className="login-error">{error}</p>}
        <p className="identify-hint">{inItself
          ? t("library.moveIntoItself")
          : unchanged ? t("library.moveSameFolder")
            : t("library.moveTargetHint", { folder: relative || (qualified && current ? current.name : t("library.rootFolder")) })}</p>
        <button type="button" className="primary" disabled={busy || inItself || unchanged} onClick={() => void move()}>
          {t(copy ? "library.copyConfirm" : "library.moveConfirm")}
        </button>
      </footer>
    </div>
  </div>;
}
