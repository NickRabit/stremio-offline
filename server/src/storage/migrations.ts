export interface Migration {
  version: number;
  statements: string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT",
    ],
  },
  {
    version: 2,
    statements: [
      "CREATE TABLE image_sources (id TEXT PRIMARY KEY, url TEXT NOT NULL, width INTEGER, ext TEXT, bytes INTEGER, at INTEGER NOT NULL) STRICT",
    ],
  },
  {
    version: 3,
    statements: [
      "CREATE TABLE hourly_counts (domain TEXT NOT NULL, hour TEXT NOT NULL, key TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (domain, hour, key)) STRICT, WITHOUT ROWID",
    ],
  },
];
