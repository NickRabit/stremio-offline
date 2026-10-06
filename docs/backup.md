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
| `state.json` | Accounts, grants, libraries, settings, addons, each account's favourites, resume positions, watchlist and search history | **Yes** — cannot be rebuilt |
| `library/<library id>.json` | Match history of one library: manual matches, skipped lookups, suggestions | **Yes** — manual work |
| `library/episodes.json` | Episode titles and stills shared by all libraries | Yes — refetched slowly otherwise |
| `follows.json` | Followed series, discovered episodes, automatic-download decisions | **Yes** |
| `downloads.json` | The download queue and its history | Yes |
| `library-ops.json` | Queued and recent library operations, and the record of a move in progress | Yes |
| `library-scan.json` | Progress of an interrupted library scan | Optional — a scan can run again |
| `stats.json`, `activity.json` | Traffic statistics and the activity history | Optional — lost history only |
| `external-ids.json` | Cached links between catalogue identifiers | Optional — rebuilt on demand |
| `artwork/` | Thumbnails the server generated from the media | Optional — regenerated, which takes ffmpeg time |
| `images/` | Cached posters and backgrounds from the catalogues | **No** — refetched on demand; often the largest folder |
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
memory. Statistics collected in the last minute before the stop are not kept.

Leave `images/` out to keep the backup small.

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
