export interface ResumeRow {
  /** The library-qualified path of the file. */
  path: string;
  /** The folder key that carries the series binding, when there is one. */
  seriesKey?: string;
  /** Sort key: the entry's updatedAt. */
  modified: string;
}

/** One row per series, newest first within each group; rows with no seriesKey pass
 *  through. The returned array keeps the input's own order otherwise — the caller
 *  sorts afterwards. */
export function groupResumeRows<T extends ResumeRow>(rows: T[]): T[] {
  const newest = new Map<string, T>();
  for (const row of rows) {
    if (!row.seriesKey) continue;
    const current = newest.get(row.seriesKey);
    if (!current || row.modified.localeCompare(current.modified) > 0) newest.set(row.seriesKey, row);
  }
  return rows.filter((row) => !row.seriesKey || newest.get(row.seriesKey) === row);
}
