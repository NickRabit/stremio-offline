import type { ReactNode, Ref } from "react";
import { MoreVertical } from "lucide-react";
import { t } from "./i18n";

export function LibraryItem({ art, artRef, title, meta, description, action, onOpen, disabled = false, folder = false, focused = false, selected = false, dataPath, dataRemoteId, children }: {
  /** The content of the picture block, its badges and marks included. */
  art: ReactNode;
  /** The picture block itself, so a caller can watch the element it draws for a lazy preview. */
  artRef?: Ref<HTMLSpanElement>;
  title: ReactNode;
  meta: ReactNode;
  /** The description line under the meta; drawn only when it has text. */
  description?: string;
  action: ReactNode;
  onOpen: () => void;
  disabled?: boolean;
  /** Adds the `folder` modifier, the one class that differs between a folder and a file row. */
  folder?: boolean;
  focused?: boolean;
  selected?: boolean;
  /** A local path or a remote id, whichever keys the row in its own listing. */
  dataPath?: string;
  dataRemoteId?: string;
  /** The selection, gallery and overflow controls, drawn beside the opening button. */
  children?: ReactNode;
}) {
  return <article className={`browse-item${folder ? " folder" : ""}${focused ? " focused" : ""}${selected ? " selected" : ""}`}
    data-path={dataPath} data-remote-id={dataRemoteId} aria-current={focused ? "true" : undefined}>
    <button className="library-open" disabled={disabled} onClick={onOpen}>
      <span className="browse-art" ref={artRef}>{art}</span>
      <span className="library-copy"><strong>{title}</strong><small>{meta}</small>{description && <small className="library-desc" title={description}>{description}</small>}</span>
      <span className="library-action">{action}</span>
    </button>
    {children}
  </article>;
}

export function LibraryItemMenu({ name, open, onToggle, children }: { name: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return <>
    <button className="browse-menu" aria-label={t("library.options", { name })} aria-expanded={open} onClick={(event) => { event.stopPropagation(); onToggle(); }}><MoreVertical/></button>
    {open && <span className="browse-actions" onClick={(event) => event.stopPropagation()}>{children}</span>}
  </>;
}
