# Stremio Offline

**Your Stremio addons and media library, on your own server.**

Stremio Offline is a self-hosted web client for standard
[Stremio](https://www.stremio.com/) addons. Browse catalogs, play streams,
save media for later, and manage your local libraries from a browser on your
computer, phone or tablet. Run it on a Synology NAS, a home server or a Linux
machine; FFmpeg is included in the image.

This is an independent project, not affiliated with Stremio or Smart Code Ltd.
No media content is included. Connect only sources and accounts you have the
right to use.

![Stremio Offline catalog](https://raw.githubusercontent.com/NickRabit/stremio-offline/main/docs/images/v0.5/catalog.jpg)

## Features

- Standard Stremio catalog, stream and subtitle addons.
- Direct playback, remuxing and FFmpeg transcoding, with Intel QuickSync and
  VAAPI on compatible Linux hosts.
- Audio tracks, embedded subtitles and subtitle addons.
- Persistent downloads with resume support, disk-space handling and save rules.
- Download rules for seasons and whole shows: resolution, size, audio and
  subtitle language, chosen when each episode's turn comes.
- Following series and films, with a release calendar and optional automatic
  downloads.
- A personal Home page and one search across addons, libraries and media
  servers.
- Multiple local libraries, metadata, artwork, favorites and continue watching.
- Jellyfin and Emby libraries with local favorites and watch history.
- Administrator and user accounts with per-user library and addon access.
- Ten interface languages, including English and Czech.
- A browser interface for computers, phones and tablets, plus separate desktop
  and Android TV clients that can connect to your server.

## Screenshots

| Home | Library |
| --- | --- |
| ![Home with continue watching, a row from the library and an addon catalog](https://raw.githubusercontent.com/NickRabit/stremio-offline/main/docs/images/v0.5/home.jpg) | ![Downloaded films in the library, with posters and descriptions](https://raw.githubusercontent.com/NickRabit/stremio-offline/main/docs/images/v0.5/library.jpg) |

| Following with automatic downloads | Download queue |
| --- | --- |
| ![Following a series: start a few episodes ahead and pick download rules](https://raw.githubusercontent.com/NickRabit/stremio-offline/main/docs/images/v0.5/follow.jpg) | ![One film downloading, another waiting in the queue](https://raw.githubusercontent.com/NickRabit/stremio-offline/main/docs/images/v0.5/downloads.jpg) |

![The player with subtitles](https://raw.githubusercontent.com/NickRabit/stremio-offline/main/docs/images/v0.5/player.jpg)

| Android TV: Home | Android TV: title detail |
| --- | --- |
| ![The Android TV app's Home with the Tonight row](https://raw.githubusercontent.com/NickRabit/stremio-offline/main/docs/images/v0.5/tv-home.jpg) | ![A film's detail on Android TV with Play and Sources](https://raw.githubusercontent.com/NickRabit/stremio-offline/main/docs/images/v0.5/tv-detail.jpg) |

<p>
  <img src="https://raw.githubusercontent.com/NickRabit/stremio-offline/main/docs/images/v0.5/mobile-home.jpg" alt="Home on a phone" width="260">
  <img src="https://raw.githubusercontent.com/NickRabit/stremio-offline/main/docs/images/v0.5/mobile-library.jpg" alt="The library on a phone" width="260">
</p>

The films and the series shown are Blender Foundation open movies (CC BY),
*Pioneer One* (CC BY-SA) and public-domain classics, served by a small local
test addon from the Internet Archive. The app ships with no content.

## Supported platforms and tags

One image supports **linux/amd64** and **linux/arm64**. Docker selects the
matching architecture automatically. Intel QuickSync drivers are included only
in the amd64 image.

| Tag | Meaning |
| --- | --- |
| `latest` | Most recently published image |
| `X.Y.Z` | A specific release; recommended for controlled upgrades |
| `X.Y` | Most recently published patch in that release series |
| Full commit SHA | Image from a specific source commit |

The same images are also published to
[GitHub Container Registry](https://github.com/NickRabit/stremio-offline/pkgs/container/stremio-offline).
Version history is in [GitHub Releases](https://github.com/NickRabit/stremio-offline/releases).

## Quick start with Docker Compose

Save this as `compose.yml` in a new directory:

```yaml
services:
  stremio-offline:
    image: nickrabit/stremio-offline:latest
    restart: unless-stopped
    init: true
    ports:
      - "8090:8080"
    environment:
      TZ: Europe/Prague
      PUID: "1000"
      PGID: "1000"
    volumes:
      - ./data:/data
      - ./downloads:/downloads
```

Create the folders and start the server:

```bash
mkdir -p data downloads
docker compose pull
docker compose up -d
```

Open **http://localhost:8090**, or `http://<server-ip>:8090` from another
device on your network. On first run, create your administrator account; there
is no default password. Add other users and connect your addons and libraries
in the interface.

Set `PUID` and `PGID` to the user and group that own your media folders.
On Linux, `id -u` and `id -g` show the current user's IDs. On a NAS, use
absolute paths to your shared folders instead of `./data` and `./downloads`.
The selected user must be able to write to both directories.

The example works without a GPU. Every setting it leaves out has a working
default; the [configuration reference](https://github.com/NickRabit/stremio-offline/blob/main/docs/configuration.md)
lists them all.

## Synology with QuickSync and a second disk

On a Synology NAS the minimal example runs, but conversion stays in software,
which can take every core and make DSM stop responding. This variant adds
Intel QuickSync, a second shared folder as a library, addons on your own
network and a health check. In **Container Manager → Project → Create**, choose
a folder such as `/volume1/docker/stremio-offline` and paste this as the
project's `docker-compose.yml`:

```yaml
services:
  stremio-offline:
    image: nickrabit/stremio-offline:latest
    container_name: stremio-offline
    restart: unless-stopped
    init: true
    ports:
      - "8090:8080"
    environment:
      TZ: Europe/Prague
      # Owner of the download folder; see below.
      PUID: "1030"
      PGID: "100"
      # Intel QuickSync. RENDER_GID is the group that owns renderD128; see below.
      VAAPI_DEVICE: /dev/dri/renderD128
      RENDER_GID: "937"
      # The download folder must stay listed, or its library falls outside every grant.
      LIBRARY_ROOTS: /downloads,/libraries/video
      # Addons served from your own network (a host or IP, comma-separated).
      ALLOW_ADDON_HOSTS: ""
    devices:
      - /dev/dri:/dev/dri
    volumes:
      - /volume1/docker/stremio-offline/data:/data
      - /volume1/video/downloads:/downloads
      - /volume1/video:/libraries/video
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8080/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
```

Create the data and download folders in File Station first, then fill in three
numbers. After the first start, open the container's **Terminal** in Container
Manager and run:

```bash
ls -n /downloads
ls -n /dev/dri
```

The first command shows the owner of the download folder: put its two numbers
into `PUID` and `PGID` (the example's `1030` is one Synology account;
yours may differ, and the `users` group is `100`). The second shows the group of
`renderD128`: put it into `RENDER_GID`. Then use **Action → Build** on the
project, which recreates the container with the new values. The log line
`VAAPI is available` confirms QuickSync is in use; a warning in its place names
what to fix.

Without an Intel GPU, remove the `devices` block and both VAAPI lines, or the
container will refuse to start. Without a second disk, remove its volume line
and `LIBRARY_ROOTS`. The
[Synology guide](https://github.com/NickRabit/stremio-offline/blob/main/docs/install-synology.md)
covers the same setup with an `.env` file, and
[hardware acceleration](https://github.com/NickRabit/stremio-offline/blob/main/docs/hardware-acceleration.md)
explains how to tell the GPU is really working.

## Persistent data

| Container path | What to keep |
| --- | --- |
| `/data` | Accounts, settings, addon configuration, library metadata and artwork |
| `/downloads` | Downloaded media |

Back up both host folders. Recreating the container keeps your installation
when these mounts are preserved. Extra libraries require both a volume mount
and the `LIBRARY_ROOTS` configuration; see the library guide.

## Updating

Back up your data, then run:

```bash
docker compose pull
docker compose up -d
```

For a pinned version, change the image tag to the desired release before
pulling. Restarting an existing container alone does not download a new image.

## Documentation

| Guide | Covers |
| --- | --- |
| [Synology installation](https://github.com/NickRabit/stremio-offline/blob/main/docs/install-synology.md) | Container Manager, folders, ownership and QuickSync |
| [Configuration](https://github.com/NickRabit/stremio-offline/blob/main/docs/configuration.md) | Environment variables and defaults |
| [Hardware acceleration](https://github.com/NickRabit/stremio-offline/blob/main/docs/hardware-acceleration.md) | GPU configuration and verification |
| [Addons and downloads](https://github.com/NickRabit/stremio-offline/blob/main/docs/downloads.md) | Addon manifests, debrid services, downloads and save rules |
| [Libraries](https://github.com/NickRabit/stremio-offline/blob/main/docs/libraries.md) | Multiple media folders and access |
| [Jellyfin and Emby](https://github.com/NickRabit/stremio-offline/blob/main/docs/media-server-management.md) | Connecting remote media servers |
| [Accounts](https://github.com/NickRabit/stremio-offline/blob/main/docs/users.md) | Users, permissions and password recovery |
| [Phones and tablets](https://github.com/NickRabit/stremio-offline/blob/main/docs/mobile.md) | Mobile browser and Home Screen setup |
| [Backup and restore](https://github.com/NickRabit/stremio-offline/blob/main/docs/backup.md) | Preserving and restoring your installation |
| [Troubleshooting](https://github.com/NickRabit/stremio-offline/blob/main/docs/troubleshooting.md) | Logs and playback diagnostics |
| [All documentation and clients](https://github.com/NickRabit/stremio-offline#documentation) | Playback, desktop apps, Android TV and more |

## Access and troubleshooting

Use an HTTPS reverse proxy or a VPN for access outside your home network;
do not expose the plain HTTP port directly to the internet.

```bash
docker compose ps
docker compose logs --tail=100 stremio-offline
curl --fail http://localhost:8090/api/status
```

The status endpoint returns JSON with `"status":"ok"` when the server is up.

Personalized addon URLs that resolve through a debrid service are supported.
Raw torrents require a Real-Debrid token; the app does not include a torrent engine.

## Project and license

[Source code](https://github.com/NickRabit/stremio-offline) ·
[Report an issue](https://github.com/NickRabit/stremio-offline/issues) ·
[Support development](https://ko-fi.com/nickrabit)

The application code is MIT licensed. The image includes Debian's FFmpeg with
GPL components, run as a separate process. See
[licensing details](https://github.com/NickRabit/stremio-offline/blob/main/docs/licensing.md)
for licenses and source information.
