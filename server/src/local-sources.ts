import { isPathWithin, type FoundFile } from "./library.js";
import { episodeNumberOf, knownTitleForUnit, unitFor, type LibraryMetaRecord, type TitleUnit } from "./library-match.js";
import { parseLibraryPath, type LibraryRecord } from "./libraries.js";

export const LOCAL_COPY_LIMIT = 20;

export interface LocalRequest { type: "movie" | "series"; titleId: string; season?: number; episode?: number }

/** The title and episode numbers behind the catalogue id the clients pass to `GET /api/streams`. */
export function parseLocalRequest(type: string, id: string): LocalRequest | undefined {
  if (type === "movie") return { type: "movie", titleId: id };
  if (type !== "series") return undefined;
  const parts = id.split(":");
  if (parts.length < 3) return undefined;
  const episode = parts[parts.length - 1]!;
  const season = parts[parts.length - 2]!;
  if (!/^\d+$/.test(season) || !/^\d+$/.test(episode)) return undefined;
  return { type: "series", titleId: parts.slice(0, -2).join(":"), season: Number(season), episode: Number(episode) };
}

export interface LocalCopy { key: string; libraryId: string; size: number }

/** The library files that are a copy of one catalogue title or episode, in answer order. */
export function localCopies(input: {
  type: string; id: string;
  files: FoundFile[];
  units: TitleUnit[];
  records: Record<string, LibraryMetaRecord>;
  libraries: LibraryRecord[];
}): LocalCopy[] {
  const request = parseLocalRequest(input.type, input.id);
  if (!request) return [];

  const bindingKeys = Object.keys(input.records)
    .filter((key) => input.records[key]!.id === request.titleId && input.records[key]!.type === request.type);
  if (!bindingKeys.length) return [];

  const covered = (key: string) => bindingKeys.some((binding) => isPathWithin(key, binding));
  const byKey = new Map(input.files.map((file) => [file.relative, file]));
  const candidates = new Set<string>();
  for (const file of input.files) if (covered(file.relative)) candidates.add(file.relative);
  // A folder unit may be keyed by one representative video, so an alternate encode is only
  // reached through the unit's sample files, not through path containment.
  for (const unit of input.units) {
    if (!covered(unit.key)) continue;
    for (const sample of unit.sampleFiles) if (byKey.has(sample)) candidates.add(sample);
  }

  const orders = new Map(input.libraries.map((library) => [library.id, library.order]));
  const kept: Array<{ copy: LocalCopy; order: number }> = [];
  for (const key of candidates) {
    const libraryId = parseLibraryPath(key)?.libraryId;
    const order = libraryId ? orders.get(libraryId) : undefined;
    if (libraryId === undefined || order === undefined) continue;
    const record = knownTitleForUnit(unitFor(key, input.units), input.records, key);
    if (!record || record.type !== request.type || record.id !== request.titleId) continue;
    const file = byKey.get(key);
    if (!file) continue;
    if (request.type === "series") {
      const own = input.records[key]?.id ? input.records[key] : undefined;
      const numbers = episodeNumberOf(key, own, { loose: true });
      if (!numbers || numbers.season !== request.season || numbers.episode !== request.episode) continue;
    }
    kept.push({ copy: { key, libraryId, size: file.size }, order });
  }
  kept.sort((left, right) => left.order - right.order
    || right.copy.size - left.copy.size
    || (left.copy.key < right.copy.key ? -1 : left.copy.key > right.copy.key ? 1 : 0));
  return kept.slice(0, LOCAL_COPY_LIMIT).map((entry) => entry.copy);
}
