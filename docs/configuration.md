# Configuration reference

Every setting is an environment variable, read from `.env` next to
`compose.yml`. Start from [`.env.example`](../.env.example), which carries the
same list with short comments.

## Paths and identity

| Variable | Default | Meaning |
| --- | --- | --- |
| `STREMIO_OFFLINE_PORT` | `8090` | Host port the UI is published on. |
| `DOWNLOAD_PATH` | `./downloads` | Host directory for downloaded media. |
| `DATA_PATH` | `./data` | Server data: account, addons, artwork, stats, queue. An ordinary folder — copy it to back it up. |
| `TZ` | `Europe/Prague` | Container timezone; affects log timestamps. |
| `PUID` / `PGID` | `1000` / `1000` | User the process runs as. Match the owner of `DOWNLOAD_PATH`. |
| `FIX_PERMISSIONS` | `0` | `1` chowns the whole download folder once at start. Slow on a large library. |

## Logging

| Variable | Default | Meaning |
| --- | --- | --- |
| `LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARN`, `ERROR`. `DEBUG` adds request and conversion detail. |
| `LOG_MAX_BYTES` | `5242880` | Size of one log file before it rotates to `app.log.1`. |
| `LOG_RETENTION_DAYS` | `7` | Age at which records are dropped. `0` disables cleanup. |

## Secure mode

Posters, backdrops, episode stills and addon logos used to be loaded by the
browser straight from the provider's CDN, which handed that provider every
viewer's address and the title they were looking at. In secure mode the server
fetches each image once, caches it under `DATA_PATH/images` and hands the page an
opaque link, so no artwork address ever reaches the machine the browser runs on.
A Content-Security-Policy enforces it: the page may load nothing but this
instance.

The switch lives in **Settings -> Privacy**, not in the environment: it is the
kind of thing worth trying both ways without recreating the container. It is on
for a new install and stays on across upgrades; turning it off makes the browser
load artwork straight from the provider again.

| Variable | Default | Meaning |
| --- | --- | --- |
| `IMAGE_CACHE_MB` | `512` | Disk the cached artwork may take before the oldest images are dropped. |
| `IMAGE_CACHE_TTL_DAYS` | `0` | Age at which a cached image is dropped even while the cache is under its limit. `0` keeps the limit as the only rule. |

The first visit to a catalogue is slower, because the server is fetching those
posters; after that they are served from the cache. Dropping an image only frees
the bytes, never the link the page already holds.

## Library artwork

A picture that sits next to the media (`poster.jpg`, `folder.jpg`) is never
touched: it belongs to the folder. What is capped here are the thumbnails the
server generates itself — a frame out of the video, or the poster of the title a
path is matched to. They live under `DATA_PATH/artwork/<library id>/`, so deleting
a library deletes its thumbnails and nothing else.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARTWORK_CACHE_MB` | `256` | Disk those thumbnails may take before the least recently used are dropped. |

A dropped thumbnail is generated again on the next visit; nothing else is lost.

## Addon access

| Variable | Default | Meaning |
| --- | --- | --- |
| `ALLOW_ADDON_HOSTS` | *(empty)* | Comma-separated hosts on the LAN that may be used as addons. |
| `ALLOW_PRIVATE_ADDONS` | `0` | `1` opens the whole private network. Prefer `ALLOW_ADDON_HOSTS`. |

## Addon guard

Details in [Troubleshooting](troubleshooting.md#when-an-addon-stops-answering).

| Variable | Default | Meaning |
| --- | --- | --- |
| `ADDON_GUARD` | `1` | `0` turns concurrency limiting and the circuit breaker off. |
| `ADDON_MAX_CONCURRENT` | `8` | Concurrent requests allowed to one host. |
| `ADDON_MAX_QUEUE` | `256` | Requests waiting for a slot on one host. |
| `ADDON_MIN_INTERVAL_MS` | `0` | Minimum gap between requests to one host. |
| `ADDON_BREAKER_FAILURES` | `5` | Consecutive failures before a host is taken out of service. |
| `ADDON_BREAKER_COOLDOWN_MS` | `30000` | First cooldown; each further outage doubles it. |
| `ADDON_BREAKER_MAX_COOLDOWN_MS` | `300000` | Ceiling for that doubling. |

## Addon manifests

A manifest is stored when the addon is added, and it decides which catalogues are
offered and which addons are asked for streams and subtitles. The server refreshes
the manifests of enabled addons in the background; how often is set in **Settings →
Addons**, where *Off* leaves it to the buttons on the Addons screen -- one per addon
and one for the whole list. A provider that does not answer keeps the manifest
already stored. The moment of the last round is remembered, so restarting the
container does not start a round that is not due yet.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ADDON_AUTO_REFRESH` | `1` | `0` stops the server refreshing manifests on its own, whatever the interval in Settings says. |

## Library metadata

The scan is described in [Library metadata](library-metadata.md).

| Variable | Default | Meaning |
| --- | --- | --- |
| `LIBRARY_SCAN_GAP_MS` | `3000` | Gap between two catalogue lookups while a scan runs. |
| `LIBRARY_AUTO_SCAN` | `1` | `0` stops the server ever scanning on its own, whatever the switch in Settings says. |
| `LIBRARY_AUTO_SCAN_INTERVAL_MS` | `21600000` | How often the automatic scan checks whether the library changed. A check on an unchanged tree asks the addons nothing. |

## Conversion

Details in [Playback](playback.md) and
[Hardware acceleration](hardware-acceleration.md).

| Variable | Default | Meaning |
| --- | --- | --- |
| `FFMPEG_READRATE` | `1.5` | How far ahead of real time conversion may run. |
| `FFMPEG_READRATE_REMUX` | `3` | The same for remux only. Lower it to `2` if the NAS chokes on write bursts. |
| `FFMPEG_PRESET` | `veryfast` | `libx264` preset. Software fallback only. |
| `FFMPEG_CRF` | `23` | `libx264` quality. Lower means better and heavier. Software fallback only. |
| `VAAPI_QP` | `23` | Hardware CQP quality. Lower means better and more bitrate. |
| `VAAPI_DEVICE` | *(unset)* | Render node, usually `/dev/dri/renderD128`. |
| `RENDER_GID` | *(unset)* | GID owning the render node. Without it the process cannot open the device. |
| `LIBVA_DRIVER_NAME` | *(auto)* | Force `iHD` (Gemini Lake and newer) or `i965` (older Braswell). |

## Restricted / demo mode

| Variable | Default | Meaning |
| --- | --- | --- |
| `RESTRICTED_MODE` | `0` | `1` locks the instance for a shared demo. Addons, settings, password and secret export become read-only. Guests can still browse, play, download to the library and save to their own device. Create the account (or inject `ADMIN_USERNAME` / `ADMIN_PASSWORD`) and confirm sign-in, then set `1` and recreate the container — not merely restart. This is not a second user. |

## Account fallback

| Variable | Default | Meaning |
| --- | --- | --- |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | *(unset)* | Emergency sign-in when the password is lost. Change the real password afterwards and unset these. |
