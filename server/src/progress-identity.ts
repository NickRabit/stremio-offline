import { episodeNumberOf, knownEntryForUnit, unitFor, type LibraryMetaRecord, type TitleUnit } from "./library-match.js";
import { isVideo } from "./library.js";
import { posixBase } from "./libraries.js";

/** The title key a library file's progress is stored under, or undefined when the file is not
 *  bound to exactly one film or one episode. `qualified` is the library-qualified path
 *  (`lib_xxx/Films/Film.mkv`); `listed` is the numbering the library listing read from the
 *  file, when the caller has it. */
export function titleProgressKey(
  qualified: string,
  records: Record<string, LibraryMetaRecord>,
  units: TitleUnit[],
  listed?: { season?: number | null; episode?: number | null },
): { key: string; type: "movie" | "series"; id: string; name?: string; season?: number; episode?: number } | undefined {
  if (!isVideo(posixBase(qualified))) return undefined;
  const unit = unitFor(qualified, units);
  const record = knownEntryForUnit(unit ?? qualified, records, qualified)?.record;
  const id = record?.id;
  if (!record || !id) return undefined;
  if (record.type === "movie") return { key: `movie:${id}`, type: "movie", id, name: record.name };
  if (record.type !== "series") return undefined;
  const ownRecord = records[qualified]?.id ? records[qualified] : undefined;
  const numbers = episodeNumberOf(qualified, ownRecord, { loose: unit?.kind === "series" });
  const season = listed?.season ?? numbers?.season ?? record.season;
  const episode = listed?.episode ?? numbers?.episode ?? record.episode;
  if (typeof season !== "number" || !Number.isInteger(season) || season < 0) return undefined;
  if (typeof episode !== "number" || !Number.isInteger(episode) || episode < 1) return undefined;
  return { key: `series:${id}:${season}:${episode}`, type: "series", id, name: record.name, season, episode };
}

/** The newest of the rows that stand for one title: the title's own row and any legacy
 *  `file:` row whose file resolves to it. Ties go to the title's own row. */
export function newestProgress<T extends { updatedAt: string }>(rows: Array<[string, T]>, own: string): [string, T] | undefined {
  let newest: [string, T] | undefined;
  for (const row of rows) {
    if (!newest) { newest = row; continue; }
    const order = row[1].updatedAt.localeCompare(newest[1].updatedAt);
    if (order > 0 || (order === 0 && row[0] === own)) newest = row;
  }
  return newest;
}

/** Every stored key that names one file: the legacy `file:` key a client sends and every row a
 *  write from that file left behind, which says so through its `path`. */
export function fileProgressKeys<T extends { path?: string }>(all: Record<string, T>, file: string): string[] {
  const keys = new Set([`file:${file}`]);
  for (const [key, row] of Object.entries(all)) if (row.path === file) keys.add(key);
  return [...keys];
}
