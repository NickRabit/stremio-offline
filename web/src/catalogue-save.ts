import type { CatalogueDetailTarget } from "./CatalogueTitleDetail";

/** Whether the save dialog can name this title: a film always, an episode only with its id,
 *  season and number. A full detail can play an episode by its id alone, and then only the
 *  direct save is offered. */
export const catalogueSaveNamesTitle = (detail: CatalogueDetailTarget): boolean =>
  detail.type !== "series" || Boolean(detail.videoId && detail.season != null && detail.episode != null);
