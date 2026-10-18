export interface RelevanceFields {
  title: string;
  originalTitle?: string;
  parentTitle?: string;
  path?: string;
}

export interface Relevance {
  score: number;
  matched: number;
  total: number;
  typos: number;
  /** The whole query is a title, leading article aside: "terminator" is "Terminátor". */
  exact: boolean;
}

interface Match {
  typos: number;
  attribute: number;
  position: number;
}

const LEADING_ARTICLE = /^(the|a|an|der|die|das|le|la|les|el|il|lo) /;
const SEASON_OR_EPISODE = /^(s\d{1,2}(e\d{1,3})?|\d{1,2}x\d{1,3}|e\d{1,3})$/;

export function normalizeSearchText(value: string | undefined): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function searchTokens(text: string): string[] {
  return normalizeSearchText(text)
    .split(" ")
    .filter((token) => token !== "" && !SEASON_OR_EPISODE.test(token));
}

const editDistance = (left: string, right: string, maximum: number): number => {
  if (Math.abs(left.length - right.length) > maximum) return maximum + 1;
  let beforePrevious: number[] = [];
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = new Array<number>(right.length + 1);
    current[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const substitution = previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1);
      let distance = Math.min(previous[column]! + 1, current[column - 1]! + 1, substitution);
      if (
        row > 1
        && column > 1
        && left[row - 1] === right[column - 2]
        && left[row - 2] === right[column - 1]
      ) {
        distance = Math.min(distance, beforePrevious[column - 2]! + 1);
      }
      current[column] = distance;
    }
    beforePrevious = previous;
    previous = current;
  }
  return previous[right.length]!;
};

const allowedTypos = (token: string): number => {
  const length = Array.from(token).length;
  if (length >= 9) return 2;
  if (length >= 5) return 1;
  return 0;
};

const tokenMatch = (query: string, candidate: string): number | undefined => {
  if (candidate === query || candidate.startsWith(query)) return 0;
  const maximum = allowedTypos(query);
  if (maximum === 0) return undefined;
  const distance = editDistance(query, candidate, maximum);
  return distance <= maximum ? distance : undefined;
};

const bestMatch = (query: string, fields: string[][]): Match | undefined => {
  let best: Match | undefined;
  for (let attribute = 0; attribute < fields.length; attribute += 1) {
    const tokens = fields[attribute]!;
    for (let position = 0; position < tokens.length; position += 1) {
      const typos = tokenMatch(query, tokens[position]!);
      if (typos === undefined) continue;
      if (
        best === undefined
        || typos < best.typos
        || (typos === best.typos && attribute < best.attribute)
      ) {
        best = { typos, attribute, position };
      }
    }
  }
  return best;
};

const fieldPositions = (tokens: string[], matched: string[]): number[] | undefined => {
  const positions: number[] = [];
  let from = 0;
  for (const query of matched) {
    let found = -1;
    for (let index = from; index < tokens.length; index += 1) {
      if (tokenMatch(query, tokens[index]!) !== undefined) {
        found = index;
        break;
      }
    }
    if (found < 0) return undefined;
    positions.push(found);
    from = found + 1;
  }
  return positions;
};

const proximityPoints = (query: string[], matched: string[], fields: string[][]): number => {
  if (matched.length === 0) return 0;
  for (const tokens of fields) {
    const positions = fieldPositions(tokens, matched);
    if (positions === undefined) continue;
    let adjacent = true;
    for (let index = 1; index < positions.length; index += 1) {
      if (positions[index] !== positions[index - 1]! + 1) {
        adjacent = false;
        break;
      }
    }
    if (adjacent) return 2;
  }
  for (const tokens of fields) {
    if (matched.every((token) => tokens.some((candidate) => tokenMatch(token, candidate) !== undefined))) {
      return 1;
    }
  }
  return 0;
};

const bare = (text: string) => normalizeSearchText(text).replace(LEADING_ARTICLE, "");

/** A query read once, for every row it is compared with. */
export interface PreparedQuery { tokens: string[]; bare: string }
/** A row's text read once; a local index keeps it beside the entry. */
export interface PreparedFields { tokens: string[][]; bareTitles: string[]; titleWords: number }

export function prepareQuery(query: string): PreparedQuery {
  return { tokens: searchTokens(query), bare: bare(query) };
}

export function prepareFields(fields: RelevanceFields): PreparedFields {
  const tokens = [fields.title, fields.originalTitle ?? "", fields.parentTitle ?? "", fields.path ?? ""]
    .map((value) => searchTokens(value));
  const bareTitles = [bare(fields.title), bare(fields.originalTitle ?? "")];
  return { tokens, bareTitles, titleWords: bareTitles[0] === "" ? 0 : bareTitles[0]!.split(" ").length };
}

export function relevance(query: string, fields: RelevanceFields): Relevance {
  return relevancePrepared(prepareQuery(query), prepareFields(fields));
}

export function relevancePrepared(query: PreparedQuery, fields: PreparedFields): Relevance {
  const queryTokens = query.tokens;
  const total = queryTokens.length;
  if (total === 0) return { score: 0, matched: 0, total: 0, typos: 0, exact: false };

  const fieldTokens = fields.tokens;
  const matchedTokens: string[] = [];
  let matched = 0;
  let typos = 0;
  let attribute = fieldTokens.length;
  for (const token of queryTokens) {
    const match = bestMatch(token, fieldTokens);
    if (match === undefined) continue;
    matched += 1;
    typos += match.typos;
    if (match.attribute < attribute) attribute = match.attribute;
    matchedTokens.push(token);
  }
  if (matched === 0) return { score: 0, matched: 0, total, typos, exact: false };

  // A leading article is not part of what people type: "matrix" is "The Matrix" exactly.
  let exactness = 0;
  for (const title of fields.bareTitles) {
    if (title === "") continue;
    if (title === query.bare) exactness = 2;
    else if (exactness === 0 && title.startsWith(query.bare)) exactness = 1;
  }
  // Fewer words beyond the matched ones is the closer title: "Matrix" before "Matrix Reloaded".
  const brevity = Math.max(0, 9 - Math.max(0, fields.titleWords - matched));

  const proximity = proximityPoints(queryTokens, matchedTokens, fieldTokens);
  const score = matched * 1_000_000
    - typos * 100_000
    + (3 - attribute) * 10_000
    + proximity * 1_000
    + exactness * 100
    + brevity * 10;
  return { score, matched, total, typos, exact: exactness === 2 };
}

/** Whether a library row answers the query at all: every word of a short query, all but one of a
 *  longer one. A media server matches loosely ("yes" finds "Yessica"), so this is the filter. */
export function enoughMatched(result: Relevance): boolean {
  if (result.total === 0) return false;
  return result.total <= 2 ? result.matched === result.total : result.matched >= result.total - 1;
}

/** Whether a row's own name answers the whole query; a parent title or path never counts. */
export function titleAnswersAll(query: string, title: string, originalTitle?: string): boolean {
  const result = relevance(query, { title, ...(originalTitle === undefined ? {} : { originalTitle }) });
  return result.total > 0 && result.matched === result.total;
}
