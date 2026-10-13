import type { ReactNode } from "react";
import { t } from "./i18n";

interface DetailHeroProps {
  /** A hero modifier, usually `series-hero`. */
  className?: string;
  /** The backdrop the provider or the catalogue gave; without one the band stays plain. */
  background?: string;
  /** The title block: chips, the heading, its facts and the description. */
  copy: ReactNode;
  /** The corner art slot; a remote poster or the catalogue's gallery shortcut. */
  gallery?: ReactNode;
}

/** The one detail header: the gradient band with its title block and corner art, shared by the
 *  catalogue and a remote title so the two cannot drift apart. */
export function DetailHero({ className, background, copy, gallery }: DetailHeroProps) {
  return <div
    className={`hero${className ? ` ${className}` : ""}${gallery ? " has-gallery" : ""}`}
    style={background ? { backgroundImage: `linear-gradient(90deg,#121721 25%,transparent),url(${background})` } : undefined}
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
