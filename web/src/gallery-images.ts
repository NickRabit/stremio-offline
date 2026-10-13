import { t } from "./i18n";
import type { Meta } from "./types";

export type GalleryKind = "poster" | "background" | "logo" | "still";
export type GalleryImage = { url: string; label: string; shape: "poster" | "wide"; kind: GalleryKind };

/** The most pictures one gallery holds: the catalogue's own cap, shared by every caller. */
export const GALLERY_LIMIT = 18;

/** A stored picture's translated label, so the wording lives in the interface, not the server. */
export const galleryLabel = (kind: GalleryKind, index = 0): string =>
  kind === "still" ? t("gallery.still", { index: index + 1 }) : t(`gallery.${kind}`);

/** The catalogue's own pictures: the poster, the wide artwork and the stills, deduplicated by URL
 *  and capped. Read by the catalogue detail, a library menu and every library detail, so the one
 *  shape of the gallery never drifts between them. */
export function catalogueGalleryImages(item: Meta | null | undefined): GalleryImage[] {
  if (!item) return [];
  const images: GalleryImage[] = [];
  const seen = new Set<string>();
  let stills = 0;
  const add = (value: unknown, label: string, shape: GalleryImage["shape"], kind: GalleryKind) => {
    if (typeof value !== "string" || !value.trim() || seen.has(value)) return;
    seen.add(value); images.push({ url: value, label, shape, kind });
  };
  add(item.poster, t("gallery.poster"), "poster", "poster");
  add(item.background, t("gallery.background"), "wide", "background");
  add(item.logo, t("gallery.logo"), "wide", "logo");
  for (const key of ["images", "screenshots"]) {
    const values = item[key];
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      const candidate = typeof value === "object" && value ? value as Record<string, unknown> : undefined;
      add(typeof value === "string" ? value : candidate?.url ?? candidate?.src, t("gallery.still", { index: ++stills }), "wide", "still");
    }
  }
  for (const video of item.videos ?? []) add(video.thumbnail, video.title || video.name || t("gallery.episodeStill"), "wide", "still");
  return images.slice(0, GALLERY_LIMIT);
}

/** One gallery out of several, first source first: the local poster and backdrop merge with the
 *  catalogue's, pictures sharing a URL appear once, and the result stops at the shared cap. */
export function mergeGallery(...groups: Array<GalleryImage[] | undefined>): GalleryImage[] {
  const merged: GalleryImage[] = [];
  const seen = new Set<string>();
  for (const group of groups) for (const image of group ?? []) {
    if (seen.has(image.url)) continue;
    seen.add(image.url); merged.push(image);
  }
  return merged.slice(0, GALLERY_LIMIT);
}

/** The gallery a detail opens: its own metadata first, then the pictures the download stored,
 *  deduplicated and capped together, so a repeated URL never appears twice. */
export function detailGallery(stored: Array<{ url: string; kind: GalleryKind; shape: "poster" | "wide" }>, metadata: GalleryImage[]): GalleryImage[] {
  return mergeGallery(metadata, stored.map(localGalleryImage));
}

/** A local picture file as a gallery entry, shaped so the poster slot stays upright. */
export function localGalleryImage(image: { url: string; kind: GalleryKind; shape: "poster" | "wide" }): GalleryImage {
  return { url: image.url, kind: image.kind, shape: image.shape, label: galleryLabel(image.kind) };
}

/** The two pictures a provider or a file record carries, shaped as poster and wide artwork. */
export function posterAndWide(poster?: string, wide?: string): GalleryImage[] {
  const images: GalleryImage[] = [];
  if (poster) images.push({ url: poster, label: t("gallery.poster"), shape: "poster", kind: "poster" });
  if (wide) images.push({ url: wide, label: t("gallery.background"), shape: "wide", kind: "background" });
  return images;
}
