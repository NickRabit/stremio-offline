import { readdir } from "node:fs/promises";
import path from "node:path";
import { isPathWithin, isVideo, resolveInside } from "./library.js";
import { toPosix } from "./libraries.js";
import { episodeNumberOf } from "./library-match.js";
import { safeName, targetPath } from "./naming.js";
import type { DownloadTargetSettings } from "./types.js";

export interface BulkScope {
  scope: "season" | "series";
  season?: number;
  specials?: boolean;
}

export interface BulkEpisodeIdentity {
  season?: number;
  episode?: number;
}

export const episodeKey = (season: number, episode: number): string => `${season}:${episode}`;

export const episodesInBulkScope = <T extends BulkEpisodeIdentity>(
  episodes: readonly T[],
  scope: BulkScope,
): T[] => {
  if (scope.scope === "season") {
    return episodes.filter((entry) => entry.season === scope.season);
  }
  return episodes.filter((entry) => entry.season !== undefined
    && (entry.season >= 1 || (scope.specials === true && entry.season === 0)));
};

export const bulkEpisodeIsReleased = (value: unknown, now = Date.now()): boolean => {
  if (typeof value !== "string" || !value.trim()) return true;
  const releasedAt = Date.parse(value);
  return !Number.isFinite(releasedAt) || releasedAt <= now;
};

const missingDirectory = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

const listVideoFiles = async (
  root: string,
  relative: string,
  depth: number,
  found: string[],
): Promise<void> => {
  if (depth < 1) return;
  const absolute = resolveInside(root, relative);
  if (!absolute || !isPathWithin(absolute, path.resolve(root))) {
    throw new Error("The bulk target resolved outside its library root.");
  }
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch (error) {
    if (missingDirectory(error)) return;
    throw error;
  }
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isFile() && isVideo(entry.name)) {
      found.push(toPosix(path.relative(path.resolve(root), resolveInside(root, child)!)));
    } else if (entry.isDirectory() && depth > 1) {
      await listVideoFiles(root, child, depth - 1, found);
    }
  }
};

export async function episodesInTarget(input: {
  root: string;
  settings: DownloadTargetSettings;
  seriesTitle: string;
}): Promise<Set<string>> {
  const { directory } = targetPath(
    { kind: "episode", title: input.seriesTitle, season: 1, episode: 1 },
    input.seriesTitle,
    ".mkv",
    input.settings,
  );
  const files: string[] = [];
  if (input.settings.layout === "flat") {
    await listVideoFiles(input.root, directory, 1, files);
  } else {
    const parent = path.dirname(directory);
    await listVideoFiles(input.root, parent === "." ? "" : parent, 2, files);
  }
  const prefix = input.settings.layout === "flat" ? safeName(input.seriesTitle) : undefined;
  const numbers = new Set<string>();
  for (const file of files) {
    if (prefix !== undefined && !path.posix.basename(file).startsWith(prefix)) continue;
    const numbered = episodeNumberOf(file, undefined);
    if (numbered) numbers.add(episodeKey(numbered.season, numbered.episode));
  }
  return numbers;
}
