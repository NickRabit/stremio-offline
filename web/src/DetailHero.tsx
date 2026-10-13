import { useEffect, useState, type ReactNode } from "react";
import { t } from "./i18n";

const DEFAULT_GRADIENT = "linear-gradient(90deg,#121721 25%,transparent)";

/** The cinematic wash a library detail puts over its backdrop, and the band it keeps when there
 *  is no backdrop to put under it. */
export const LIBRARY_HERO_GRADIENT = "linear-gradient(90deg,#121721f2,#121721c9 46%,#12172155 78%,transparent)";
export const LIBRARY_HERO_EMPTY_GRADIENT = "linear-gradient(160deg,#212836,#10141b)";

/**
 * The first candidate backdrop that actually loads, or nothing. A URL that 404s is skipped for
 * the next one instead of leaving the hero without artwork, and when every candidate fails the
 * hero keeps its own gradient. Only an explicit detail asks; a listing row never calls this.
 */
export function useBackdrop(candidates: Array<string | undefined>): string | undefined {
  const list = candidates.filter((url): url is string => Boolean(url));
  const key = list.join("|");
  const [chosen, setChosen] = useState<{ key: string; url: string | undefined }>({ key, url: list[0] });
  useEffect(() => {
    let live = true;
    if (!list.length) { setChosen({ key, url: undefined }); return; }
    setChosen({ key, url: list[0] });
    let index = 0;
    const probe = () => {
      if (!live) return;
      const url = list[index];
      if (!url) { setChosen({ key, url: undefined }); return; }
      const image = new Image();
      image.onerror = () => { if (live) { index += 1; probe(); } };
      image.onload = () => { if (live) setChosen({ key, url }); };
      image.src = url;
    };
    probe();
    return () => { live = false; };
    // Keyed on the candidate list itself: another title re-probes from the start.
  }, [key]);
  return chosen.key === key ? chosen.url : list[0];
}

interface DetailHeroProps {
  /** A hero modifier, usually `series-hero`. */
  className?: string;
  /** The backdrop the provider or the catalogue gave; without one the band stays plain. */
  background?: string;
  /** The gradient laid over the backdrop; the catalogue's own is used when this is left out. */
  gradient?: string;
  /** The whole band when there is no backdrop at all, so it is never flat black. */
  emptyGradient?: string;
  /** The title block: chips, the heading, its facts and the description. */
  copy: ReactNode;
  /** The corner art slot; a remote poster or the catalogue's gallery shortcut. */
  gallery?: ReactNode;
}

/** The one detail header: the gradient band with its title block and corner art, shared by the
 *  catalogue and a remote title so the two cannot drift apart. */
export function DetailHero({ className, background, gradient, emptyGradient, copy, gallery }: DetailHeroProps) {
  const style = background
    ? { backgroundImage: `${gradient ?? DEFAULT_GRADIENT},url(${background})` }
    : emptyGradient ? { backgroundImage: emptyGradient } : undefined;
  return <div
    className={`hero${className ? ` ${className}` : ""}${gallery ? " has-gallery" : ""}`}
    style={style}
  >
    <div className="detail-copy">{copy}</div>
    {gallery}
  </div>;
}

interface DetailDescriptionProps {
  /** The full text: the catalogue's overview or the provider's. */
  text?: string;
  /** True while the catalogue is still reading its metadata. */
  loading?: boolean;
  /** Rebuilds the disclosure when another title opens over it. */
  identityKey: string;
  /** What a loading description shows instead of the text. */
  skeleton?: ReactNode;
}

/** The description block the catalogue already used: a two-line preview that opens into the whole
 *  text. A remote overview reads through the same component. */
export function DetailDescription({ text, loading, identityKey, skeleton }: DetailDescriptionProps) {
  const body = loading ? skeleton : (text || t("catalog.noDescription"));
  return <div className="catalog-description" aria-busy={loading}>
    <p className="description-preview" aria-hidden={loading ? true : undefined}>{body}</p>
    <details key={identityKey}>
      <summary>{t("catalog.description")}</summary>
      <p tabIndex={0}>{body}</p>
    </details>
  </div>;
}
