export function remoteDetailArtwork(url?: string): string | undefined {
  if (!url || !/^\/api\/remote-libraries\/[^/?#]+\/items\/[^/?#]+\/artwork\/Primary(?:\?|$)/.test(url)) return url;
  const [path, query] = url.split("?", 2);
  const params = new URLSearchParams(query);
  params.set("size", "detail");
  return `${path}?${params.toString()}`;
}
