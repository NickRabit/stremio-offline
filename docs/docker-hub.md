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

![Stremio Offline catalog](https://raw.githubusercontent.com/NickRabit/stremio-offline/main/docs/images/catalog.jpg)

## Features

- Standard Stremio catalog, stream and subtitle addons.
- Direct playback, remuxing and FFmpeg transcoding, with Intel QuickSync and
  VAAPI on compatible Linux hosts.
- Audio tracks, embedded subtitles and subtitle addons.
- Persistent downloads with resume support, disk-space handling and save rules.
- Multiple local libraries, metadata, artwork, favorites and continue watching.
- Jellyfin and Emby libraries with local favorites and watch history.
- Administrator and user accounts with per-user library and addon access.
- Ten interface languages, including English and Czech.
- A browser interface for computers, phones and tablets, plus separate desktop
  and Android TV clients that can connect to your server.

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

The example works without a GPU. Hardware acceleration requires compatible
hardware, permissions and device configuration; see the guides below.

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
