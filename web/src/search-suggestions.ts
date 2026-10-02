import { matchKey, rankByTitle } from "./title-match";

export const SUGGESTION_ROWS = 8;
export const SUGGESTION_RECENT_ROWS = 3;
export const CANDIDATE_LIMIT = 500;

export interface Candidate { id: string; type: string; name: string; addonKey?: string }
export interface Suggestion { kind: "recent" | "title"; text: string }

/** Titles this session has already been shown, newest first. Only text that was on screen
 *  goes in: a suggestion is submitted as an ordinary search, which the server authorizes
 *  again, so the pool needs no provenance beyond the addon a page came from. */
export class CandidatePool {
  private entries = new Map<string, Candidate>();

  constructor(private limit = CANDIDATE_LIMIT) {}

  /** `addonKey` is set when the page came from one addon -- a browsed catalog or a scoped search. */
  add(items: Array<{ id: string; type?: string; name?: string }>, addonKey?: string) {
    for (const item of items) {
      if (!item.name || !item.id) continue;
      const key = `${item.type ?? ""}:${item.id}`;
      const previous = this.entries.get(key);
      this.entries.delete(key);
      this.entries.set(key, { id: item.id, type: item.type ?? "", name: item.name, addonKey: previous && previous.addonKey !== addonKey ? undefined : addonKey });
    }
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
  }

  clear() { this.entries.clear(); }

  /** Newest first. */
  list(): Candidate[] { return [...this.entries.values()].reverse(); }
}

export function suggest(options: {
  draft: string;
  recent: Array<{ query: string }>;
  candidates: Candidate[];
  addonKey?: string;
  type?: string;
}): Suggestion[] {
  const key = matchKey(options.draft);
  if (!options.draft.trim()) return options.recent.slice(0, SUGGESTION_ROWS).map((entry) => ({ kind: "recent", text: entry.query }));
  if (!key) return [];
  const seenRecent = new Set<string>();
  const recent: Suggestion[] = [];
  for (const entry of options.recent) {
    const entryKey = matchKey(entry.query);
    if (recent.length >= SUGGESTION_RECENT_ROWS || !entryKey.includes(key) || seenRecent.has(entryKey)) continue;
    seenRecent.add(entryKey);
    recent.push({ kind: "recent", text: entry.query });
  }
  const eligible = options.candidates.filter((candidate) =>
    (!options.type || candidate.type === options.type)
    && (!options.addonKey || candidate.addonKey === options.addonKey)
    && matchKey(candidate.name).includes(key));
  const seenTitles = new Set<string>();
  const titles: Suggestion[] = [];
  for (const candidate of rankByTitle(eligible, options.draft)) {
    if (recent.length + titles.length >= SUGGESTION_ROWS) break;
    const titleKey = matchKey(candidate.name);
    if (seenTitles.has(titleKey)) continue;
    seenTitles.add(titleKey);
    titles.push({ kind: "title", text: candidate.name });
  }
  return [...recent, ...titles];
}
