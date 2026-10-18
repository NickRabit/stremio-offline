import { normalizeTitle } from "./library-match.js";
import {
  SEARCH_LIMITS,
  type SearchKind,
  type SearchSourceClass,
  type StrongIds,
} from "./search-contracts.js";

export function strongIdsFromStremioId(id: string): StrongIds {
  if (/^tt\d{1,12}$(?![\s\S])/.test(id)) return { imdb: id };
  const tmdb = /^tmdb:([1-9]\d{0,11})$(?![\s\S])/.exec(id);
  if (tmdb) return { tmdb: tmdb[1]! };
  const tvdb = /^tvdb:([1-9]\d{0,11})$(?![\s\S])/.exec(id);
  if (tvdb) return { tvdb: tvdb[1]! };
  return {};
}

export function validStrongIds(ids: StrongIds | undefined): StrongIds {
  if (ids === undefined) return {};
  const result: StrongIds = {};
  if (typeof ids.imdb === "string") {
    const imdb = ids.imdb.toLowerCase();
    if (/^tt\d{1,12}$(?![\s\S])/.test(imdb)) result.imdb = imdb;
  }
  if (typeof ids.tmdb === "string" && /^[1-9]\d{0,11}$(?![\s\S])/.test(ids.tmdb)) result.tmdb = ids.tmdb;
  if (typeof ids.tvdb === "string" && /^[1-9]\d{0,11}$(?![\s\S])/.test(ids.tvdb)) result.tvdb = ids.tvdb;
  return result;
}

const rankOfNormalized = (query: string, title: string): number => {
  const normalizedQuery = normalizeTitle(query);
  const normalizedTitle = normalizeTitle(title);
  if (normalizedTitle === normalizedQuery) return 0;
  if (normalizedTitle.startsWith(normalizedQuery)) return 1;
  if (normalizedTitle.includes(normalizedQuery)) return 2;
  return 3;
};

export function titleRank(query: string, title: string, originalTitle?: string): number {
  return Math.min(rankOfNormalized(query, title), rankOfNormalized(query, originalTitle ?? ""));
}

export interface IdentityInput {
  memberKey: string;
  sequence: number;
  kind: SearchKind;
  ids: StrongIds;
  opaque?: string;
  title?: string;
  originalTitle?: string;
  year?: number;
}

export interface IdentityGroup {
  memberKeys: string[];
  conflict: boolean;
}

const NAMESPACES = ["imdb", "tmdb", "tvdb"] as const;
const SOLO_KINDS = new Set<SearchKind>(["folder", "season"]);
/** A file joins only the same file from the same addon: an id it might carry names a title. */
const OPAQUE_ONLY_KINDS = new Set<SearchKind>(["file"]);
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const edge = (left: IdentityInput, right: IdentityInput): boolean => {
  if (left.kind !== right.kind || SOLO_KINDS.has(left.kind)) return false;
  if (OPAQUE_ONLY_KINDS.has(left.kind)) return typeof left.opaque === "string" && left.opaque !== "" && left.opaque === right.opaque;
  for (const namespace of NAMESPACES) {
    if (left.ids[namespace] !== undefined && right.ids[namespace] !== undefined && left.ids[namespace] !== right.ids[namespace]) {
      return false;
    }
  }
  let shared = false;
  for (const namespace of NAMESPACES) {
    if (left.ids[namespace] !== undefined && left.ids[namespace] === right.ids[namespace]) shared = true;
  }
  if (typeof left.opaque === "string" && left.opaque !== "" && left.opaque === right.opaque) shared = true;
  return shared;
};

const compatibleUnion = (records: IdentityInput[]): boolean => {
  for (const namespace of NAMESPACES) {
    const values = new Set(records.map((record) => record.ids[namespace]).filter((value) => value !== undefined));
    if (values.size > 1) return false;
  }
  return true;
};

const sortedKeys = (records: IdentityInput[], sequenceOf: Map<string, number>): string[] =>
  records
    .map((record) => record.memberKey)
    .sort((left, right) => (sequenceOf.get(left)! - sequenceOf.get(right)!) || compareText(left, right));

const hasStrongId = (record: IdentityInput): boolean =>
  NAMESPACES.some((namespace) => record.ids[namespace] !== undefined);

const nameKeys = (record: IdentityInput): string[] => {
  if (record.year === undefined) return [];
  const keys: string[] = [];
  for (const title of [record.title, record.originalTitle]) {
    const normalized = normalizeTitle(title);
    if (normalized !== "") keys.push(`${normalized}|${record.year}`);
  }
  return keys;
};

const groupNamespace = (
  group: IdentityGroup,
  recordByKey: Map<string, IdentityInput>,
): (typeof NAMESPACES)[number] | undefined => {
  let namespace: (typeof NAMESPACES)[number] | undefined;
  for (const memberKey of group.memberKeys) {
    const ids = recordByKey.get(memberKey)!.ids;
    for (const candidate of NAMESPACES) {
      if (ids[candidate] === undefined) continue;
      if (namespace !== undefined && namespace !== candidate) return undefined;
      namespace = candidate;
    }
  }
  return namespace;
};

const mergeCrossNamespaceNames = (
  groups: IdentityGroup[],
  recordByKey: Map<string, IdentityInput>,
  sequenceOf: Map<string, number>,
): IdentityGroup[] => {
  const candidates = new Map<number, (typeof NAMESPACES)[number]>();
  groups.forEach((group, index) => {
    if (group.conflict) return;
    const members = group.memberKeys.map((memberKey) => recordByKey.get(memberKey)!);
    if (members[0]!.kind !== "movie" && members[0]!.kind !== "series") return;
    const namespace = groupNamespace(group, recordByKey);
    if (namespace === "imdb" || namespace === "tmdb") candidates.set(index, namespace);
  });

  const buckets = new Map<string, { imdb: Set<number>; tmdb: Set<number> }>();
  for (const index of candidates.keys()) {
    const members = groups[index]!.memberKeys.map((memberKey) => recordByKey.get(memberKey)!);
    const kind = members[0]!.kind;
    for (const key of new Set(members.flatMap(nameKeys))) {
      const bucket = `${kind}\0${key}`;
      const entry = buckets.get(bucket) ?? { imdb: new Set(), tmdb: new Set() };
      if (candidates.get(index) === "imdb") entry.imdb.add(index);
      else entry.tmdb.add(index);
      buckets.set(bucket, entry);
    }
  }

  const pairs = new Map<string, { imdb: number; tmdb: number; shared: string[] }>();
  for (const [bucket, entry] of buckets) {
    for (const imdb of entry.imdb) {
      for (const tmdb of entry.tmdb) {
        const key = `${imdb}:${tmdb}`;
        const pair = pairs.get(key) ?? { imdb, tmdb, shared: [] };
        pair.shared.push(bucket);
        pairs.set(key, pair);
      }
    }
  }

  const counterparts = new Map<number, Set<number>>();
  const valid: Array<[number, number]> = [];
  for (const pair of pairs.values()) {
    if (pair.shared.some((bucket) => {
      const entry = buckets.get(bucket)!;
      return entry.imdb.size !== 1 || entry.tmdb.size !== 1;
    })) continue;
    valid.push([pair.imdb, pair.tmdb]);
    const imdb = counterparts.get(pair.imdb) ?? new Set<number>();
    imdb.add(pair.tmdb);
    counterparts.set(pair.imdb, imdb);
    const tmdb = counterparts.get(pair.tmdb) ?? new Set<number>();
    tmdb.add(pair.imdb);
    counterparts.set(pair.tmdb, tmdb);
  }

  const mergeWith = new Map<number, number>();
  for (const [imdb, tmdb] of valid) {
    if (counterparts.get(imdb)?.size !== 1 || counterparts.get(tmdb)?.size !== 1) continue;
    const root = Math.min(imdb, tmdb);
    const partner = Math.max(imdb, tmdb);
    mergeWith.set(root, partner);
  }
  if (mergeWith.size === 0) return groups;

  return groups.flatMap((group, index) => {
    const partner = mergeWith.get(index);
    if (partner !== undefined) return [];
    const root = [...mergeWith].find(([, counterpart]) => counterpart === index)?.[0];
    if (root === undefined) return [group];
    return [{
      memberKeys: sortedKeys(
        [...groups[root]!.memberKeys, ...group.memberKeys]
          .map((memberKey) => recordByKey.get(memberKey)!),
        sequenceOf,
      ),
      conflict: false,
    }];
  });
};

export function clusterIdentities(records: IdentityInput[]): IdentityGroup[] {
  const ordered = [...records].sort(
    (left, right) => left.sequence - right.sequence || compareText(left.memberKey, right.memberKey),
  );
  const sequenceOf = new Map(ordered.map((record) => [record.memberKey, record.sequence]));
  const recordByKey = new Map(ordered.map((record) => [record.memberKey, record]));
  const edges = Array.from({ length: ordered.length }, () => [] as number[]);
  // Only records that share a value can have an edge, so pairs come from that index.
  const sharing = new Map<string, number[]>();
  ordered.forEach((record, index) => {
    if (SOLO_KINDS.has(record.kind)) return;
    const values = OPAQUE_ONLY_KINDS.has(record.kind) ? [] : NAMESPACES.flatMap((namespace) => record.ids[namespace] === undefined ? [] : [`${namespace}:${record.ids[namespace]}`]);
    if (typeof record.opaque === "string" && record.opaque !== "") values.push(`opaque:${record.opaque}`);
    for (const value of values) {
      const key = `${record.kind}|${value}`;
      const list = sharing.get(key);
      if (list) list.push(index); else sharing.set(key, [index]);
    }
  });
  const linked = new Set<number>();
  for (const list of sharing.values()) {
    for (let a = 0; a < list.length; a += 1) {
      for (let b = a + 1; b < list.length; b += 1) {
        const left = list[a]!, right = list[b]!;
        const pair = left * ordered.length + right;
        if (linked.has(pair)) continue;
        linked.add(pair);
        if (edge(ordered[left]!, ordered[right]!)) {
          edges[left]!.push(right);
          edges[right]!.push(left);
        }
      }
    }
  }

  const seen = new Set<number>();
  const groups: IdentityGroup[] = [];
  for (let start = 0; start < ordered.length; start += 1) {
    if (seen.has(start)) continue;
    const component: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length > 0) {
      const index = stack.pop()!;
      component.push(index);
      for (const next of edges[index]!) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    const members = component.map((index) => ordered[index]!);
    if (compatibleUnion(members)) {
      groups.push({ memberKeys: sortedKeys(members, sequenceOf), conflict: false });
      continue;
    }
    if (members.length > 200) {
      for (const member of members) groups.push({ memberKeys: [member.memberKey], conflict: true });
      continue;
    }

    let partitions = members.map((_, index) => [index]);
    const partitionEdge = (left: number[], right: number[]): boolean =>
      left.some((a) =>
        right.some((b) => edges[component[a]!]!.includes(component[b]!)),
      );
    for (;;) {
      let best: { left: number; right: number; key: string } | undefined;
      for (let left = 0; left < partitions.length; left += 1) {
        for (let right = left + 1; right < partitions.length; right += 1) {
          if (!partitionEdge(partitions[left]!, partitions[right]!)) continue;
          const merged = [...partitions[left]!, ...partitions[right]!];
          if (!compatibleUnion(merged.map((index) => members[index]!))) continue;
          const key = merged.map((index) => members[index]!.memberKey).sort(compareText).join("\n");
          if (best === undefined || key < best.key) best = { left, right, key };
        }
      }
      if (best === undefined) break;
      partitions[best.left] = [...partitions[best.left]!, ...partitions[best.right]!];
      partitions.splice(best.right, 1);
    }
    for (const partition of partitions) {
      groups.push({
        memberKeys: sortedKeys(partition.map((index) => members[index]!), sequenceOf),
        conflict: true,
      });
    }
  }

  const identityGroups = mergeCrossNamespaceNames(groups, recordByKey, sequenceOf);
  const candidatesByKey = new Map<string, Set<number>>();
  identityGroups.forEach((group, index) => {
    if (group.conflict) return;
    const members = group.memberKeys.map((memberKey) => recordByKey.get(memberKey)!);
    const kind = members[0]!.kind;
    if ((kind !== "movie" && kind !== "series") || !members.some(hasStrongId)) return;
    for (const key of new Set(members.flatMap(nameKeys))) {
      const bucket = `${kind}\0${key}`;
      const candidates = candidatesByKey.get(bucket);
      if (candidates === undefined) candidatesByKey.set(bucket, new Set([index]));
      else candidates.add(index);
    }
  });

  const targetOf = new Map<number, number>();
  identityGroups.forEach((group, index) => {
    if (group.conflict) return;
    const members = group.memberKeys.map((memberKey) => recordByKey.get(memberKey)!);
    const kind = members[0]!.kind;
    if ((kind !== "movie" && kind !== "series") || members.some(hasStrongId)) return;
    const candidates = new Set<number>();
    for (const key of new Set(members.flatMap(nameKeys))) {
      for (const candidate of candidatesByKey.get(`${kind}\0${key}`) ?? []) candidates.add(candidate);
    }
    if (candidates.size === 1) targetOf.set(index, [...candidates][0]!);
  });

  const joined = new Map<number, string[]>();
  for (const [source, target] of targetOf) {
    const memberKeys = joined.get(target) ?? [];
    memberKeys.push(...identityGroups[source]!.memberKeys);
    joined.set(target, memberKeys);
  }
  const merged = identityGroups.flatMap((group, index) => {
    if (targetOf.has(index)) return [];
    const memberKeys = joined.get(index);
    return [memberKeys === undefined
      ? group
      : {
        memberKeys: sortedKeys(
          [...group.memberKeys, ...memberKeys].map((memberKey) => recordByKey.get(memberKey)!),
          sequenceOf,
        ),
        conflict: false,
      }];
  });

  return merged.sort((left, right) =>
    sequenceOf.get(left.memberKeys[0]!)! - sequenceOf.get(right.memberKeys[0]!)!
    || compareText(left.memberKeys[0]!, right.memberKeys[0]!),
  );
}

export function episodeIdentity(
  parentIds: StrongIds,
  season: number,
  episode: number,
  episodeEnd?: number,
): StrongIds {
  const suffix = `#${season}#${episode}#${episodeEnd ?? ""}`;
  const result: StrongIds = {};
  for (const namespace of NAMESPACES) {
    if (parentIds[namespace] !== undefined) result[namespace] = `${parentIds[namespace]}${suffix}`;
  }
  return result;
}

export interface DisplayCandidate {
  memberKey: string;
  sequence: number;
  sourceOrder: number;
  sourceClass: SearchSourceClass;
  itemKey: string;
  title: string;
  originalTitle?: string;
  year?: number;
  poster?: string;
  background?: string;
  description?: string;
  hasStrongId: boolean;
  score: number;
}

const classOrder: Record<SearchSourceClass, number> = { local: 0, remote: 1, catalog: 2 };

const metadataCount = (candidate: DisplayCandidate): number =>
  (candidate.poster ? 1 : 0)
  + (candidate.background ? 1 : 0)
  + (candidate.year === undefined ? 0 : 1)
  + (candidate.description ? 1 : 0);

export function pickPrimary(_query: string, members: DisplayCandidate[]): DisplayCandidate {
  return [...members].sort((left, right) =>
    right.score - left.score
    || Number(right.hasStrongId) - Number(left.hasStrongId)
    || metadataCount(right) - metadataCount(left)
    || classOrder[left.sourceClass] - classOrder[right.sourceClass]
    || left.sourceOrder - right.sourceOrder
    || compareText(left.itemKey, right.itemKey)
    || compareText(left.memberKey, right.memberKey),
  )[0]!;
}

export class ClusterKeyTracker {
  private previous: string[] = [];
  private aliases: { retired: string; current: string }[] = [];

  assign(
    groups: string[][],
    seqOf: (memberKey: string) => number,
  ): { keys: string[]; aliases: { retired: string; current: string }[] } {
    const keys = groups.map((group) => `c${Math.min(...group.map((memberKey) => seqOf(memberKey)))}`);
    const current = new Set(keys);
    this.aliases = this.aliases.filter((alias) => !current.has(alias.retired));

    for (const retired of this.previous) {
      if (current.has(retired)) continue;
      const sequence = Number(retired.slice(1));
      const index = groups.findIndex((group) =>
        group.some((memberKey) => seqOf(memberKey) === sequence),
      );
      if (index < 0) continue;
      const alias = { retired, current: keys[index]! };
      this.aliases = this.aliases.filter((item) => item.retired !== retired || item.current !== alias.current);
      this.aliases.push(alias);
    }
    this.previous = [...keys];
    if (this.aliases.length > SEARCH_LIMITS.aliasesMax) {
      this.aliases = this.aliases.slice(this.aliases.length - SEARCH_LIMITS.aliasesMax);
    }
    return { keys, aliases: this.aliases.map((alias) => ({ ...alias })) };
  }
}
