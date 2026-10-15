import { catalogueRef, type CatalogueRef } from "./title-enrichment";
import type { RemoteItem, Stream } from "./types";

/**
 * The identity a native title is looked up under on the catalogue, when it can be named exactly.
 * A movie uses its own ids. An episode never does: it is asked about through its parent series'
 * ids with its own numbering appended, so a supplementary addon answer belongs to the one episode
 * and not to its show. Anything else -- a folder, a season, an unmatched video -- has no identity.
 */
export function supplementaryIdentity(item: RemoteItem | null | undefined, series: RemoteItem | null | undefined): CatalogueRef | null {
  if (!item) return null;
  if (item.type === "movie") return catalogueRef("movie", item.providerIds);
  if (item.type !== "episode") return null;
  const parent = catalogueRef("series", series?.providerIds);
  if (!parent) return null;
  const season = item.season;
  const episode = item.episode;
  if (typeof season !== "number" || !Number.isFinite(season) || !Number.isInteger(season) || season < 0) return null;
  if (typeof episode !== "number" || !Number.isFinite(episode) || !Number.isInteger(episode) || episode < 1) return null;
  return { type: parent.type, id: `${parent.id}:${season}:${episode}` };
}

/** The catalogue key a supplementary stream plays and remembers its progress under. */
export const genericProgressKey = (ref: CatalogueRef): string => `${ref.type}:${ref.id}`;

/**
 * The exact media subject a supplementary stream is saved under: a film's own catalogue fields,
 * or an episode's parent series plus its numbering. Nothing native travels here -- no provider id,
 * no proxy address, no media-source id -- because the stream is a generic addon source.
 */
export function addonMediaSubject(item: RemoteItem, series: RemoteItem | null, artwork?: { poster?: string; background?: string }): Record<string, unknown> {
  const ref = item.type === "movie" ? catalogueRef("movie", item.providerIds) : catalogueRef("series", series?.providerIds);
  const art = {
    ...(artwork?.poster ? { poster: artwork.poster } : {}),
    ...(artwork?.background ? { background: artwork.background } : {}),
  };
  if (item.type === "movie") {
    return { kind: "movie", title: item.name, ...(item.year ? { year: item.year } : {}), ...(ref ? { id: ref.id, metaType: ref.type } : {}), ...art };
  }
  return {
    kind: "episode", title: series?.name ?? item.name,
    ...(item.season != null ? { season: item.season } : {}),
    ...(item.episode != null ? { episode: item.episode } : {}),
    episodeTitle: item.name, ...(ref ? { id: ref.id, metaType: ref.type } : {}), ...art,
  };
}
