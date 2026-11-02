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
  {
    version: 4,
    statements: [
      "CREATE TABLE activity (id INTEGER PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, filename TEXT, user_id TEXT, username TEXT, bytes INTEGER, partial INTEGER) STRICT",
      "CREATE TABLE traffic_events (seq INTEGER PRIMARY KEY, at TEXT NOT NULL, source TEXT NOT NULL, provider TEXT NOT NULL, addon_key TEXT, addon_name TEXT, title TEXT NOT NULL, kind TEXT NOT NULL, bytes INTEGER NOT NULL, items INTEGER NOT NULL) STRICT",
      "CREATE INDEX traffic_events_at ON traffic_events (at)",
    ],
  },
];
