import type { ReactNode, Ref } from "react";
import { hideBroken } from "./settings-ui";

/**
 * One library tile of the browse root. The library page and the remote library page both draw
 * their roots with it, so a remote root library looks and behaves exactly like a local one: the
 * same `.browse-item.library` shell, the same collage or fallback picture, the same copy and
 * action line. `art` lets the remote root swap in a lazily loaded mosaic in place of the
 * ordinary picture without changing the shell around it.
 */
export function LibraryTile({ name, meta, posters, poster, fallback, count, enabled = true, action, unreachable, path, art, containerRef, onOpen }: {
  name: string; meta: string; posters?: string[]; poster?: string; fallback: ReactNode;
  count?: number; enabled?: boolean; action: ReactNode; unreachable?: boolean;
  /** A stable key that survives into the DOM, so the same browse-focus machinery finds the tile. */
  path?: string;
  /** Replaces the whole picture block; the remote root uses it for the lazy mosaic. */
  art?: ReactNode;
  /** The tile element, so the remote root can watch it for the lazy preview. */
  containerRef?: Ref<HTMLElement>;
  onOpen: () => void;
}) {
  return <article className={`browse-item library${unreachable ? " unreachable" : ""}`} data-path={path} ref={containerRef}>
    <button className="library-open" disabled={!enabled} onClick={onOpen}>
      <span className="browse-art">{art ?? ((posters?.length ?? 0) > 1
        ? <span className="library-preview-collage" aria-hidden="true">{posters?.map((url) => <img key={url} src={url} alt="" loading="lazy" onError={hideBroken}/>)}</span>
        : posters?.[0] || poster ? <img src={posters?.[0] ?? poster} alt="" loading="lazy" onError={hideBroken}/> : fallback)}
        {count != null && <i className="browse-badge">{count}</i>}</span>
      <span className="library-copy"><strong>{name}</strong><small>{meta}</small></span>
      <span className="library-action">{action}</span>
    </button>
  </article>;
}
