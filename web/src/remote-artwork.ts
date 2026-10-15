export function remoteDetailArtwork(url?: string): string | undefined {
  if (!url || !/^\/api\/remote-libraries\/[^/?#]+\/items\/[^/?#]+\/artwork\/Primary(?:\?|$)/.test(url)) return url;
  const [path, query] = url.split("?", 2);
  const params = new URLSearchParams(query);
  params.set("size", "detail");
  return `${path}?${params.toString()}`;
}

/** The listing width of a remote picture, which is what a tile draws. The proxy serves a Backdrop
 *  at the detail width unless the request names the tile variant, and a tile is the one place that
 *  wants the narrow one. A Primary poster is already fetched at the listing width, so its address
 *  is left exactly as it is; anything that is not remote artwork keeps its own size. Setting the
 *  size twice changes nothing, so applying this to an address that already names the tile is safe. */
export function remoteTileArtwork(url?: string): string | undefined {
  if (!url || !/^\/api\/remote-libraries\/[^/?#]+\/items\/[^/?#]+\/artwork\/Backdrop(?:\?|$)/.test(url)) return url;
  const [path, query] = url.split("?", 2);
  const params = new URLSearchParams(query);
  params.set("size", "tile");
  return `${path}?${params.toString()}`;
}

/** A composed fan at the shape a tile draws. The address the server hands out carries the stamp
 *  of the pictures behind it, so the same fan serves both shapes and each shape is its own entry.
 *  Every other address is handed back untouched. */
export function remoteMosaicArtwork(url: string | undefined | null, shape: "poster" | "wide"): string | undefined {
  if (!url || !/\/mosaic\?/.test(url)) return url ?? undefined;
  const params = new URLSearchParams(url.split("?", 2)[1]);
  params.set("shape", shape);
  return `${url.split("?", 1)[0]}?${params.toString()}`;
}
