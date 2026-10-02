/** NFD, strip combining marks, lowercase, every run of non-letter, non-digit
 *  characters to one space, trim. */
export function matchKey(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Stable; returns a new array; items without a name rank last. */
export function rankByTitle<T extends { name?: string }>(items: T[], query: string): T[] {
  const key = matchKey(query);
  if (!key) return [...items];
  const tokens = key.split(" ");
  const rankOf = (item: T) => {
    if (!item.name) return 4;
    const name = matchKey(item.name);
    if (!name) return 4;
    if (name === key) return 0;
    if (name.startsWith(key)) return 1;
    const nameTokens = new Set(name.split(" "));
    if (tokens.every((token) => nameTokens.has(token))) return 2;
    if (name.includes(key)) return 3;
    return 4;
  };
  return items
    .map((item, index) => ({ item, index, rank: rankOf(item) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.item);
}
