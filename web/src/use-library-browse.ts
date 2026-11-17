import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { BrowseResult, LibrarySort } from "./types";

export interface LibraryBrowseOptions {
  ready: boolean;
  active: boolean;
  applied: boolean;
  path: string;
  query: string;
  sort: LibrarySort;
  desc: boolean;
  unconfirmed: boolean;
  scanEpoch: number;
  fail(error: unknown): void;
}

export interface LibraryBrowse {
  browse: BrowseResult | null;
  busy: boolean;
  load(target?: string, skip?: number): Promise<void>;
  refresh(limit: number): Promise<void>;
  location(): string;
}

export function useLibraryBrowse(options: LibraryBrowseOptions): LibraryBrowse {
  const { ready, active, applied, path, query, sort, desc, unconfirmed, scanEpoch, fail } = options;
  const [browse, setBrowse] = useState<BrowseResult | null>(null);
  const [busy, setBusy] = useState(false);
  const browseRequest = useRef(0);
  const browseLocation = useRef("");
  const browseSeed = useRef(String(Date.now()));
  browseLocation.current = JSON.stringify([path, query, sort, desc, unconfirmed]);

  const load = useCallback(async (target = path, skip = 0) => {
    const request = ++browseRequest.current;
    const wanted = JSON.stringify([target, query, sort, desc, unconfirmed]);
    setBusy(true);
    try {
      const options = { skip, limit: 60, sort, order: desc ? "desc" : "asc", seed: browseSeed.current };
      // Favorites include entries from the entire library tree.
      const page = target === ":favorites"
        ? await api.favorites(options)
        : await api.browse({ ...options, path: target, query, unconfirmed });
      if (request !== browseRequest.current || wanted !== browseLocation.current) return;
      setBrowse((previous) => skip && previous ? { ...page, items: [...previous.items, ...page.items] } : page);
    } catch (error) { if (request === browseRequest.current && wanted === browseLocation.current) fail(error); }
    finally { if (request === browseRequest.current) setBusy(false); }
  }, [path, query, sort, desc, unconfirmed, fail]);

  const refresh = useCallback(async (limit: number) => {
    const location = JSON.stringify([path, query, sort, desc, unconfirmed]);
    if (location !== browseLocation.current) return;
    const request = browseRequest.current;
    try {
      const options = { limit: Math.max(60, limit), sort, order: desc ? "desc" : "asc", seed: browseSeed.current };
      const page = path === ":favorites"
        ? await api.favorites(options)
        : await api.browse({ ...options, path, query, unconfirmed });
      if (location === browseLocation.current && request === browseRequest.current) setBrowse(page);
    } catch { /* Artwork refresh is optional. */ }
  }, [path, query, sort, desc, unconfirmed]);

  const location = useCallback(() => browseLocation.current, []);

  // The first listing waits for that apply: an account that sorts by size must not see the
  // name order first and then watch it jump.
  useEffect(() => {
    if (!ready || !active || !applied) return;
    void load(path);
  }, [ready, active, applied, path, query, sort, desc, unconfirmed, scanEpoch]);

  // Artwork is finished in the background; once it is ready the page refreshes itself.
  // Asking once was not enough: a poster fetched from a catalogue takes longer than a
  // second, and the answer still said "pending", which left the tile bare until the user
  // reloaded the page. The wait doubles instead, and gives up rather than polling forever
  // over a file that will never produce a thumbnail.
  const artworkPolls = useRef(0);
  useEffect(() => { artworkPolls.current = 0; }, [path, query, sort, desc, unconfirmed, scanEpoch]);
  useEffect(() => {
    if (!active || !browse?.pending) return;
    const attempt = artworkPolls.current;
    if (attempt >= 8) return;
    // Only as many entries as are already loaded are refreshed, so the list does not scroll back.
    const loaded = browse.items.length;
    const timer = setTimeout(() => { artworkPolls.current = attempt + 1; void refresh(loaded); }, Math.min(8000, 1000 * 2 ** attempt));
    return () => clearTimeout(timer);
  }, [active, browse, path, query, sort, desc, unconfirmed]);

  return { browse, busy, load, refresh, location };
}
