import type { Meta } from "./types";

export function mergeMetaDetail(summary: Meta, detail: Meta): Meta {
  return { ...summary, ...detail, id: summary.id, type: summary.type || detail.type, name: summary.name };
}

/**
 * The two pictures the catalogue grid drew for a title, which are the ones a download carries
 * into the library: what the viewer was looking at has to be what they find afterwards.
 *
 * The catalogue row is the grid's source, so it wins over the detail the metadata answered
 * with -- those two disagree often enough for a library tile to end up showing a picture that
 * was never on screen. A row with no background of its own drew its poster in the landscape
 * tiles, so that is what the wide variant inherits.
 */
export function gridArt(summary?: Meta | null, detail?: Meta | null) {
  const poster = summary?.poster || detail?.poster;
  return { poster, background: summary?.background || poster || detail?.background };
}

export function localizedDownloadTitle(summary: Meta, detail: Meta, language: string): string {
  return detail.nameLanguage === language ? detail.name : summary.name;
}
