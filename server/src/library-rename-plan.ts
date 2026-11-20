import path from "node:path";
import { AppError } from "./errors.js";
import { renamedSidecar } from "./library-sidecars.js";
import { assertUsableName } from "./naming.js";

export type RenameField = "title" | "year" | "season" | "episode";
export type RenameStatus = "rename" | "same" | "unidentified" | "missing" | "invalid" | "collision" | "duplicate" | "chain" | "busy" | "parts";

export interface RenamePlanRow {
  key: string;
  from: string;
  to?: string;
  isFile: boolean;
  kind: "movie" | "episode" | "unknown";
  status: RenameStatus;
  missing?: RenameField[];
  sidecars: number;
}

export type RenameFields = Partial<Record<RenameField, string | number>>;

export interface RenamePatternPart {
  kind: "literal" | "field";
  value: string;
  width?: number;
}

export interface RenamePattern {
  source: string;
  parts: RenamePatternPart[];
}

export interface RenameCandidate {
  key: string;
  folder: string;
  name: string;
  isFile: boolean;
  kind: "movie" | "episode" | "unknown";
  fields: RenameFields;
  /** A film keyed by its file whose title holds other files beside it (CD parts, versions):
   *  renaming the key alone would split the set, so the row is refused. */
  parts?: true;
}

export interface RenamePlanInput {
  candidates: RenameCandidate[];
  moviePattern: RenamePattern;
  episodePattern: RenamePattern;
  siblings: Map<string, string[]>;
  caseInsensitive(folder: string): boolean;
  sidecarsOf(key: string): string[];
  busy: Set<string>;
}

const FIELD = /^(title|year|season|episode)(?::([1-4]))?$/;
const invalidPattern = () =>
  new AppError("The pattern names an unknown field or leaves a brace open.", "err.renamePatternInvalid", 400);

export function parsePattern(source: string): RenamePattern {
  const parts: RenamePatternPart[] = [];
  let literal = "";
  const flush = () => {
    if (!literal) return;
    parts.push({ kind: "literal", value: literal });
    literal = "";
  };

  for (let index = 0; index < source.length;) {
    if (source[index] !== "{") {
      literal += source[index];
      index += 1;
      continue;
    }
    const end = source.indexOf("}", index + 1);
    if (end < 0) throw invalidPattern();
    const match = FIELD.exec(source.slice(index + 1, end));
    if (!match) throw invalidPattern();
    flush();
    parts.push({
      kind: "field",
      value: match[1]!,
      ...(match[2] ? { width: Number(match[2]) } : {}),
    });
    index = end + 1;
  }
  flush();
  return { source, parts };
}

export function renderPattern(
  pattern: RenamePattern,
  fields: RenameFields,
): { value: string; missing: RenameField[] } {
  const missing: RenameField[] = [];
  let value = "";
  for (const part of pattern.parts) {
    if (part.kind === "literal") {
      value += part.value;
      continue;
    }
    const field = part.value as RenameField;
    const raw = fields[field];
    if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) {
      if (!missing.includes(field)) missing.push(field);
      continue;
    }
    const rendered = String(raw);
    value += part.width ? rendered.padStart(part.width, "0") : rendered;
  }
  return { value, missing };
}

const folded = (value: string) => value.normalize("NFC").toLowerCase();
const sameName = (left: string, right: string, caseInsensitive: boolean) =>
  left === right || (caseInsensitive && folded(left) === folded(right));

export function planRenames(input: RenamePlanInput): RenamePlanRow[] {
  const sidecars = new Map(input.candidates.map((candidate) => [candidate.key, input.sidecarsOf(candidate.key)]));
  const rows = input.candidates.map((candidate): RenamePlanRow => {
    const names = sidecars.get(candidate.key) ?? [];
    const row: RenamePlanRow = {
      key: candidate.key,
      from: candidate.name,
      isFile: candidate.isFile,
      kind: candidate.kind,
      status: "unidentified",
      sidecars: names.length,
    };
    if (candidate.kind === "unknown") return row;
    if (candidate.parts) return { ...row, status: "parts" };

    const rendered = renderPattern(candidate.kind === "movie" ? input.moviePattern : input.episodePattern, candidate.fields);
    if (rendered.missing.length) return { ...row, status: "missing", missing: rendered.missing };

    let stem: string;
    try {
      stem = assertUsableName(rendered.value);
    } catch {
      return { ...row, status: "invalid" };
    }
    const extension = candidate.isFile ? path.extname(candidate.name) : "";
    row.to = `${stem}${extension}`;
    if (input.busy.has(candidate.key) || names.some((name) => input.busy.has(`${candidate.folder ? `${candidate.folder}/` : ""}${name}`))) {
      return { ...row, status: "busy" };
    }
    if (row.to === candidate.name) return { ...row, status: "same" };
    return { ...row, status: "rename" };
  });

  for (const [index, row] of rows.entries()) {
    if (row.status !== "rename" || row.to === undefined) continue;
    const candidate = input.candidates[index]!;
    const chain = input.candidates.some((other) =>
      other.key !== candidate.key
      && other.folder === candidate.folder
      && sameName(other.name, row.to!, input.caseInsensitive(candidate.folder)));
    if (chain) rows[index] = { ...row, status: "chain" };
  }

  for (const [index, row] of rows.entries()) {
    if (row.status !== "rename" || row.to === undefined) continue;
    const candidate = input.candidates[index]!;
    const caseInsensitive = input.caseInsensitive(candidate.folder);
    const siblings = input.siblings.get(candidate.folder) ?? [];
    const targetTaken = siblings.some((name) =>
      sameName(name, row.to!, caseInsensitive) && !sameName(name, candidate.name, caseInsensitive));
    if (targetTaken) {
      rows[index] = { ...row, status: "collision" };
      continue;
    }

    const targetStem = row.to.slice(0, row.to.length - path.extname(row.to).length);
    const sidecarTaken = (sidecars.get(candidate.key) ?? []).some((name) => {
      const target = renamedSidecar(name, path.extname(candidate.name) ? candidate.name.slice(0, -path.extname(candidate.name).length) : candidate.name, targetStem);
      return siblings.some((sibling) =>
        sameName(sibling, target, caseInsensitive) && !sameName(sibling, name, caseInsensitive));
    });
    if (sidecarTaken) rows[index] = { ...row, status: "collision" };
  }

  const targets = new Map<string, number[]>();
  for (const [index, row] of rows.entries()) {
    if (row.status !== "rename" || row.to === undefined) continue;
    const folder = input.candidates[index]!.folder;
    const key = `${folder}\0${input.caseInsensitive(folder) ? folded(row.to) : row.to}`;
    const found = targets.get(key);
    if (found) found.push(index);
    else targets.set(key, [index]);
  }
  for (const indexes of targets.values()) {
    if (indexes.length < 2) continue;
    for (const index of indexes) rows[index] = { ...rows[index]!, status: "duplicate" };
  }
  return rows;
}
