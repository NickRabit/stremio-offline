# Backing up and restoring

There are two different things called a backup, and they protect different data.

| | Settings export | Instance backup |
| --- | --- | --- |
| How | **Settings → Export** in the app | A copy of the `DATA_PATH` folder |
| Holds | App settings, addons and their order, save rules, library names and roots | Everything the server remembers |
| Accounts, favourites, resume positions | No | Yes |
| Match history, followed series, queue | No | Yes |
| Media | No | No — back the library folders up separately |
| Use it for | Moving the configuration to a new instance | Getting this instance back after a disk failure |

Both contain secrets in the clear: personalized addon URLs, the Real-Debrid token
and the TMDB key, and the instance backup also holds the account password
hashes. Store them like passwords. The settings export is described in
[Backing up the configuration](downloads.md#backing-up-the-configuration).

## What lives in `DATA_PATH`

| Path | Holds | Back it up? |
| --- | --- | --- |
| `application.sqlite` (with `-wal`/`-shm`) | The image link registry, hourly picture and provider-call counts, activity history, traffic events, library match history and episode metadata, library file facts, `file_fingerprints`, artwork recency, first-seen library file dates, external id links, followed series and automatic-download decisions, the download queue and history, TMDB id mappings, and each account's favourites, resume positions, watchlist, watched-series markers and remote-media state | **Yes** — copy it with the rest of `DATA_PATH` while the server is stopped |
| `state.json` | Accounts, grants, libraries, settings, addons, and each account's preferences, addon order, browse and search history, and follow defaults. When `application.sqlite` exists, the hot personal collections live in the database instead | **Yes** — cannot be rebuilt |
| `media-server.key` | Key that decrypts saved Jellyfin and Emby logins. Present only when the server created it; a deployment that sets `MEDIA_SERVER_KEY_FILE` keeps the key at that path instead | **Yes** — without it those logins cannot be read |
| `media-server-secrets/` | Encrypted provider tokens | **Yes** — together with the key and `state.json` |
| `library/<library id>.json`, `library/episodes.json`, `follows.json`, `downloads.json` | Library match history and episode metadata, followed series and automatic-download decisions, and the download queue and history, from before the move to `application.sqlite`. Once their one-time import has run they are moved to `migration-backup/` | **Yes** while there is no `application.sqlite`: a first start that could not open SQLite keeps running on these files, and they are then the only copy. **No** once they have been moved to `migration-backup/` — the current data is in `application.sqlite` |
| `library-ops.json` | Queued and recent library operations, and the record of a move in progress | Yes |
| `library-scan.json` | Progress of an interrupted library scan | Optional — a scan can run again |
| `artwork/index.json`, `library-seen.json`, `external-ids.json` | Old indexes for artwork recency, first-seen dates and cached catalogue identifier links; only present while there is no `application.sqlite`, or until their one-time import moves them to `migration-backup/` | **Yes** while there is no `application.sqlite`; no once they have moved. First-seen dates cannot be rebuilt exactly, while artwork recency and external ids can be lost |
| `library/file-facts.json`, `tmdb-ids.json` | Old cache files; only present until their one-time import moves them to `migration-backup/` | No — both caches now live in `application.sqlite` and are safe to lose |
| `title-extras/` | Cached cast, similar titles and ratings of opened titles | **No** — refetched on demand |
| `artwork/` | Thumbnails the server generated from the media | Optional — regenerated, which takes ffmpeg time |
| `images/*.jpg`, `images/*.png`, and other image files | Cached posters and backgrounds from the catalogues | Optional — the links are in `application.sqlite`; the bytes are refetched on demand |
| `migration-backup/` | The pre-migration `state-*.json`, `images/index.json`, `image-stats.json`, `provider-stats.json`, `stats.json`, `activity.json`, `follows.json`, `downloads.json`, `artwork/index.json`, `library-seen.json`, `external-ids.json` and library metadata files | Optional — safe to delete once the migration is satisfactory |
| `remote-images/` | Cached Jellyfin and Emby posters | **No** — refetched on demand |
| `app.log` | The log | No |
| `*.damaged-*` | A state file that could not be read at start, kept aside | Keep until you have looked at it |
| `state.json.v1.bak` and other `*.bak` | Copies taken before a migration | Keep while a rollback is possible |

The media folders behind your libraries and the download directory are not in
`DATA_PATH`. `state.json` stores each library's root as a path, so restore the
media to the same paths, or point the libraries at their new folders afterwards
([Libraries → Re-root](libraries.md#re-root)).

## Taking an instance backup

The files are written independently while the server runs, so a copy taken
while it is busy can catch one file before a change and another after it.
Take the copy with the server stopped:

```sh
docker compose stop
cp -a data /backup/stremio-offline-data-$(date +%Y%m%d)
docker compose start
```

On a Synology, stop the project in Container Manager, let Hyper Backup (or a
scheduled task) copy the data folder, then start the project again. Give the
server the few seconds it takes to stop: on the way out it writes the accounts,
the library metadata and the library operations that are still waiting in
memory. A graceful shutdown also flushes pending database-backed statistics;
an abrupt termination can lose updates that had not yet been flushed.

The picture and provider-call statistics, traffic events, activity history,
library file facts, TMDB id mappings, artwork recency, first-seen library file
dates, external id links and each account's hot personal collections live in
`application.sqlite`. The first personal-data import leaves a copy of the
state file, with every personal collection still in it, in
`migration-backup/state-*.json`. For an install from before accounts it is the
file after its account was created, so putting it back keeps the account id the
rows belong to. The file facts
and TMDB id mappings are caches and safe to lose. Copy `application.sqlite` and
its `-wal` or `-shm` files whenever they are present, together with the rest of
`DATA_PATH`, while the server is stopped. The image files under `images/` remain
optional to back up and can be left out to keep the backup small.

If `application.sqlite` exists but cannot be opened, the server refuses to start
instead of falling back to JSON. Do not delete it to work around that failure:
migrations may already have moved authoritative data into the database. Restore
the whole data folder from a backup, including `application.sqlite` and its
`-wal` and `-shm` files when present.

## Restoring

1. Stop the server.
2. Put the media back at the paths the libraries had, if it was lost too.
3. Replace `DATA_PATH` with the backup (keep the broken folder aside until the
   restored instance works).
4. Start the server. A move or copy that was in progress when the backup was
   taken is finished from its record, an interrupted scan resumes, and queued
   downloads continue from their `.part` files where those survived.

A backup restored onto a newer version is migrated on start. Restoring a backup
onto an *older* version than the one that wrote it is not supported; see
[Rolling the image back](troubleshooting.md#rolling-the-image-back).

If a state file turns out to be damaged after a restore, see
[When a state file is damaged](troubleshooting.md#when-a-state-file-is-damaged).
