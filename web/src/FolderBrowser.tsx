import { useEffect, useState } from "react";
import { ChevronRight, CornerLeftUp, FolderOpen, HardDrive } from "lucide-react";
import { api, describeError } from "./api";
import { t } from "./i18n";
import type { LibraryFolder, LibraryView } from "./types";

const parentOf = (folder: string) => folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "";

/** The crumbs, the folder list and the up button the destination pickers share. `libraries`
 *  are the configured libraries, which decide the wire format: with more than one the paths
 *  name the library first, with a single one they are bare. The caller keeps the walk inside
 *  one library by passing a `folder` that starts there. Loading errors reach the dialog that
 *  owns the footer through `onError`. */
export function FolderBrowser({ libraries, folder, onFolder, onError, disabledPaths = [] }: {
  libraries: LibraryView[];
  folder: string;
  onFolder: (folder: string) => void;
  onError: (message: string) => void;
  disabledPaths?: string[];
}) {
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [busy, setBusy] = useState(false);
  // Which libraries this walk may cross decides what a bare path means, so a picker that
  // switches between them has to load again even when the spelling of the path did not change.
  const scope = libraries.map((library) => library.id).join(",");

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    void api.libraryFolders(folder)
      .then((result) => { if (!cancelled) { setFolders(result.folders); onError(""); } })
      .catch((value) => { if (!cancelled) onError(describeError(value)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [folder, scope, onError]);

  // One library speaks bare paths on the wire, several name the library first.
  const qualified = libraries.length > 1;
  const libraryOf = (value: string) => libraries.find((library) => value === library.id || value.startsWith(`${library.id}/`));
  const current = libraryOf(folder) ?? (qualified ? undefined : libraries[0]);
  // Whether a path names its library is read from the path: the server qualifies paths by the
  // libraries configured, of which an ordinary account may see fewer than two.
  const root = current && (folder === current.id || folder.startsWith(`${current.id}/`)) ? current.id : "";
  const relative = root ? (folder === root ? "" : folder.slice(root.length + 1)) : folder;
  const open = (value: string) => onFolder(root ? (value ? `${root}/${value}` : root) : value);
  const crumbs = relative ? relative.split("/") : [];

  return <>
    <nav className="move-crumbs" aria-label={t("library.moveDestination")}>
      <button type="button" onClick={() => open("")}><HardDrive/> {root && current ? current.name : t("library.rootFolder")}</button>
      {crumbs.map((name, index) => <span key={name + index}>
        <ChevronRight aria-hidden="true"/>
        <button type="button" onClick={() => open(crumbs.slice(0, index + 1).join("/"))}>{name}</button>
      </span>)}
    </nav>
    <div className="move-list">
      {relative && <button type="button" className="move-up" onClick={() => open(parentOf(relative))}>
        <CornerLeftUp/> {t("library.moveUp")}
      </button>}
      {folders.map((item) => <button type="button" key={item.path} disabled={disabledPaths.includes(item.path)} onClick={() => onFolder(item.path)}>
        <FolderOpen/> <span>{item.name}</span> <ChevronRight/>
      </button>)}
      {!busy && !folders.length && <p className="identify-hint">{t("library.moveNoSubfolders")}</p>}
    </div>
  </>;
}
