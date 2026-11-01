import { useEffect, useState } from "react";
import { api, describeError } from "./api";
import type { BrowseFile } from "./types";

const finished = (file: BrowseFile) => Boolean(file.progress && file.progress.duration > 0 && file.progress.position / file.progress.duration >= 0.9);

/** One file per episode, in season and episode order with the specials last: of several copies the
 *  one last watched stands for it, else the largest, the way a media server folds its versions. */
export function episodeFiles(files: BrowseFile[]): BrowseFile[] {
  const groups = new Map<string, BrowseFile[]>();
  for (const file of files) {
    const key = file.season != null && file.episode != null ? `${file.season}:${file.episode}` : file.path;
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }
  const pick = (copies: BrowseFile[]) => copies.reduce((best, file) => {
    const watched = (file.progress?.position ?? 0) > 0;
    const bestWatched = (best.progress?.position ?? 0) > 0;
    if (watched !== bestWatched) return watched ? file : best;
    return file.size > best.size ? file : best;
  });
  const order = (file: BrowseFile) => [file.season === 0 ? 1 : 0, file.season ?? Number.MAX_SAFE_INTEGER, file.episode ?? Number.MAX_SAFE_INTEGER] as const;
  return [...groups.values()].map(pick).sort((left, right) => {
    const a = order(left);
    const b = order(right);
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || left.path.localeCompare(right.path);
  });
}

/** Where the viewer left off: the last episode they started, or the one after it once finished. */
export function nextEpisode(episodes: BrowseFile[]): BrowseFile | undefined {
  let touched = -1;
  episodes.forEach((file, index) => { if ((file.progress?.position ?? 0) > 0) touched = index; });
  if (touched < 0) return episodes[0];
  const last = episodes[touched]!;
  return finished(last) ? episodes[touched + 1] ?? last : last;
}

/** The episode's own title read out of a file name such as `Show - S01E02 - Title`. */
export function episodeName(file: BrowseFile): string {
  const match = /^.*?\b(?:S\d{1,3}\s*E\d{1,4}|\d{1,2}x\d{1,3})\b[\s._\-–—]*/i.exec(file.label);
  const rest = match ? file.label.slice(match[0].length).replace(/\s*\(\d+\)$/, "").trim() : "";
  return rest || file.label;
}

/** Every video under a show's folder, its season folders included, read level by level. */
async function seriesFiles(path: string, depth = 0): Promise<BrowseFile[]> {
  const found: BrowseFile[] = [];
  for (let skip = 0; ;) {
    const page = await api.browse({ path, skip, limit: 120 });
    for (const item of page.items) {
      if (item.kind === "file") found.push(item);
      else if (item.kind === "folder" && depth < 3) found.push(...await seriesFiles(item.path, depth + 1));
    }
    skip += page.items.length;
    if (!page.items.length || skip >= page.total || found.length >= 4000) return found;
  }
}

export function useLocalSeries(path: string, revision: number): { episodes: BrowseFile[]; loading: boolean; error: string } {
  const [state, setState] = useState<{ path: string; revision: number; episodes: BrowseFile[]; loading: boolean; error: string }>({
    path,
    revision,
    episodes: [],
    loading: Boolean(path),
    error: "",
  });

  useEffect(() => {
    if (!path) {
      setState({ path, revision, episodes: [], loading: false, error: "" });
      return;
    }
    let live = true;
    // A refresh after a play keeps the episodes on screen until the new read lands, so the
    // detail the viewer returns to is not replaced by a loading line for a moment.
    setState((previous) => previous.path === path && previous.episodes.length
      ? { ...previous, revision }
      : { path, revision, episodes: [], loading: true, error: "" });
    void seriesFiles(path)
      .then((files) => { if (live) setState({ path, revision, episodes: episodeFiles(files), loading: false, error: "" }); })
      .catch((reason) => { if (live) setState({ path, revision, episodes: [], loading: false, error: describeError(reason) }); });
    return () => { live = false; };
  }, [path, revision]);

  return state.path === path
    ? state
    : { episodes: [], loading: Boolean(path), error: "" };
}
