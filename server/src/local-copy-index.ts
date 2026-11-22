import { isVideo } from "./library.js";
import type { LibraryMetaRecord } from "./library-match.js";
import { posixBase, posixDir } from "./libraries.js";
import { localTitleIds } from "./local-sources.js";
import type { TmdbConfig } from "./tmdb.js";

interface Trie {
  records: string[];
  children: Map<string, Trie>;
}

interface MetaIndex {
  records: Record<string, LibraryMetaRecord>;
  identities: Map<string, string[]>;
  patterns: Map<string, { imdb: string[]; tmdb: string[] }>;
  paths: Trie;
  order: Map<string, number>;
}

const indexes = new WeakMap<Record<string, LibraryMetaRecord>, MetaIndex>();

const child = (node: Trie, part: string): Trie => {
  let next = node.children.get(part);
  if (!next) {
    next = { records: [], children: new Map() };
    node.children.set(part, next);
  }
  return next;
};

const indexOf = (records: Record<string, LibraryMetaRecord>): MetaIndex => {
  const known = indexes.get(records);
  if (known) return known;
  const identities = new Map<string, string[]>();
  const patterns = new Map<string, { imdb: string[]; tmdb: string[] }>();
  const paths: Trie = { records: [], children: new Map() };
  const order = new Map<string, number>();
  let position = 0;
  for (const [key, record] of Object.entries(records)) {
    order.set(key, position++);
    let node = paths;
    for (const part of key.split("/")) node = child(node, part);
    node.records.push(key);
    if (!record.id) continue;
    const identity = `${record.type}:${record.id}`;
    const bound = identities.get(identity);
    if (bound) bound.push(key);
    else identities.set(identity, [key]);
    const pattern = patterns.get(record.type) ?? { imdb: [], tmdb: [] };
    if (/^tt\d+$/.test(record.id)) pattern.imdb.push(key);
    if (/^tmdb:\d+$/.test(record.id)) pattern.tmdb.push(key);
    patterns.set(record.type, pattern);
  }
  const index = { records, identities, patterns, paths, order };
  indexes.set(records, index);
  return index;
};

const subtree = (node: Trie | undefined, found: string[]): void => {
  if (!node) return;
  found.push(...node.records);
  for (const childNode of node.children.values()) subtree(childNode, found);
};

const below = (index: MetaIndex, key: string): string[] => {
  let node: Trie | undefined = index.paths;
  for (const part of key.split("/")) {
    node = node.children.get(part);
    if (!node) return [];
  }
  const found: string[] = [];
  subtree(node, found);
  return found;
};

/** The records a local-copy read can distinguish for one title, without walking every
 *  metadata row on each request. A file binding also brings its sibling records because a
 *  unit may group alternate encodes by its representative file. */
export async function localCopyRecords(
  records: Record<string, LibraryMetaRecord>,
  type: string,
  id: string,
  config?: TmdbConfig,
  include: (key: string, record: LibraryMetaRecord) => boolean = () => true,
): Promise<{ records: Record<string, LibraryMetaRecord>; titleIds: string[] }> {
  const index = indexOf(records);
  const probe: Record<string, LibraryMetaRecord> = {};
  const addProbe = (identity: string) => {
    const key = index.identities.get(identity)?.find((candidate) => include(candidate, index.records[candidate]!));
    if (key) probe[key] = index.records[key]!;
  };
  addProbe(`${type}:${id}`);
  const pattern = index.patterns.get(type);
  for (const keys of [pattern?.imdb ?? [], pattern?.tmdb ?? []]) {
    const key = keys.find((candidate) => include(candidate, index.records[candidate]!));
    if (key) probe[key] = index.records[key]!;
  }
  const titleIds = await localTitleIds(type, id, probe, config);

  const wanted = new Set<string>();
  for (const titleId of titleIds) {
    for (const key of index.identities.get(`${type}:${titleId}`) ?? []) {
      for (const record of below(index, key)) wanted.add(record);
      if (isVideo(posixBase(key))) for (const record of below(index, posixDir(key))) wanted.add(record);
    }
  }
  const visible = [...wanted]
    .filter((key) => include(key, index.records[key]!))
    .sort((left, right) => index.order.get(left)! - index.order.get(right)!);
  return {
    records: Object.fromEntries(visible.map((key) => [key, index.records[key]!])),
    titleIds,
  };
}
