import { numberedEpisode } from "./library.js";
import { parseMediaName } from "./library-parse.js";
import { titleSimilarity } from "./library-match.js";
import { posixBase } from "./libraries.js";

export interface DiskEpisode {
  season: number;
  episode: number;
  title?: string;
}

export interface CatalogueEpisode {
  season: number;
  episode: number;
  name?: string;
}

export interface EpisodeEvidence {
  numbered: number;
  present: number;
  titled: number;
  named: number;
}

const TAG_EPISODE = /\bs\d{1,3}[\s._-]*e\d{1,4}\b[\s._-]*(.*)$/i;
const CROSS_EPISODE = /\b\d{1,2}x\d{1,4}\b[\s._-]*(.*)$/i;
const LEADING_EPISODE = /^\s*\d{1,4}\s*[-–.)]?\s*(.*)$/;
const PLACEHOLDER_TITLE = /^(?:episode|epizoda)\s*\d+$/i;

function episodeTitle(relative: string): string | undefined {
  const stem = posixBase(relative).replace(/\.[^.]+$/, "");
  const match = TAG_EPISODE.exec(stem) ?? CROSS_EPISODE.exec(stem) ?? LEADING_EPISODE.exec(stem);
  if (!match) return undefined;
  const parsed = parseMediaName(match[1] ?? "").title;
  return parsed && !PLACEHOLDER_TITLE.test(parsed) ? parsed : undefined;
}

/** Keep at most `limit` items, evenly spread across the list, endpoints included. */
function spread<T>(items: T[], limit: number): T[] {
  if (limit <= 0) return [];
  if (items.length <= limit) return items;
  if (limit === 1) return [items[0]!];
  const out: T[] = [];
  for (let index = 0; index < limit; index += 1) {
    out.push(items[Math.round((index * (items.length - 1)) / (limit - 1))]!);
  }
  return out;
}

/** The episodes a unit's files name: numbers from `numberedEpisode`, and the title that
 *  follows the number in the file name. A placeholder title is no title. */
export function diskEpisodes(files: string[], limit = 40): DiskEpisode[] {
  const found: DiskEpisode[] = [];
  for (const file of files) {
    const numbers = numberedEpisode(file);
    if (!numbers) continue;
    const title = episodeTitle(file);
    found.push({ ...numbers, ...(title ? { title } : {}) });
  }
  return spread(found, limit);
}

/** How far a candidate's episode list agrees with the disk. */
export function episodeEvidence(disk: DiskEpisode[], catalogue: CatalogueEpisode[]): EpisodeEvidence {
  const byNumber = new Map(catalogue.map((episode) => [`${episode.season}:${episode.episode}`, episode]));
  let present = 0;
  let titled = 0;
  let named = 0;
  for (const episode of disk) {
    const found = byNumber.get(`${episode.season}:${episode.episode}`);
    if (found) present += 1;
    if (!episode.title) continue;
    titled += 1;
    if (!found?.name) continue;
    if (titleSimilarity(episode.title, found.name) >= 0.8) named += 1;
  }
  return { numbered: disk.length, present, titled, named };
}

/** Index of the candidate the episodes confirm, or undefined. */
export function confirmedByEpisodes(evidence: EpisodeEvidence[]): number | undefined {
  let confirmed: number | undefined;
  for (let index = 0; index < evidence.length; index += 1) {
    const current = evidence[index]!;
    if (current.titled < 2 || current.named < 2 || current.named < 0.5 * current.titled) continue;
    if (evidence.some((other, otherIndex) => otherIndex !== index && other.named >= current.named)) continue;
    if (confirmed !== undefined) return undefined;
    confirmed = index;
  }
  return confirmed;
}
