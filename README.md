# Stremio Offline

[![CI](https://github.com/NickRabit/stremio-offline/actions/workflows/ci.yml/badge.svg)](https://github.com/NickRabit/stremio-offline/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Image](https://img.shields.io/badge/ghcr.io-stremio--offline-2496ed?logo=docker&logoColor=white)](https://github.com/NickRabit/stremio-offline/pkgs/container/stremio-offline)

Self-hosted web client for standard [Stremio](https://www.stremio.com/) addons.
It reads catalog and stream manifests, aggregates streams and subtitles, plays
HTTP sources through a compatible HLS layer, and saves direct streams into a
persistent download queue and a local library.

Built for a Docker host that is always on — a Synology NAS in particular — and
used from a browser on the home network.

> Unofficial. Not affiliated with Stremio or Smart Code Ltd.
> Use only sources and accounts you have the right to access.

## What it does

- **Catalogs and metadata** from any standard addon manifest, Cinemeta included.
- **Playback that costs what it has to.** Direct play when the browser can
  handle the file, remux when only the container is wrong, a real transcode only
  as a last resort — with Intel QuickSync when the hardware has it.
- **Audio tracks and subtitles**, both embedded in the file and from subtitle
  addons, with preferred languages picked in settings.
- **A download queue that survives a restart**, resumes partial files with HTTP
  Range, and pauses itself when the disk fills up.
- **A local library** of what you downloaded, with artwork, continue watching,
  and a list of your own.
- **Several libraries** — another disk, films and series kept apart, a friend's
  folder mounted read-only — and a metadata scan that turns a folder of files
  into titles with posters and descriptions.
- **English or Czech**, chosen on first run and changeable in Settings. The
  choice at setup also seeds the preferred audio and subtitle languages.
- **Accounts, created on first run.** No default password, no anonymous access.
  An administrator adds one per person and decides which libraries and addons
  each of them sees.
- **Diagnostics in the UI** — grouped errors, a filterable log, and what
  playback actually failed on.

Personalized addon URLs that already resolve through a debrid service work.
A raw torrent needs a Real-Debrid API token in Settings; the app never runs a
torrent engine. See [Addons and downloads](docs/downloads.md#real-debrid-and-other-debrid-services).

## Quick start

Requires Docker. Everything else — FFmpeg included — is in the image.

```bash
git clone https://github.com/NickRabit/stremio-offline.git
cd stremio-offline
cp .env.example .env
docker compose up -d --build
```

Open `http://localhost:8090`. The first screen creates the administrator; until
an account exists the server serves nothing else. Downloaded files land in the
host directory set by `DOWNLOAD_PATH`.

To run a prebuilt image instead of building locally:

```bash
docker compose -f compose.pull.yml pull
docker compose -f compose.pull.yml up -d
```

### On a Synology NAS

The usual target, and the one case with real setup work — folder ownership,
QuickSync, and Container Manager's single-compose-file limit. It works with or
without SSH: **[Install on a Synology NAS](docs/install-synology.md)**.

Nothing is built on the NAS: upload `compose.pull.yml` to the project folder as
`docker-compose.yml`, which is the name Container Manager looks for, and point
the paths at shared folders in `.env` beside it:

```dotenv
DOWNLOAD_PATH=/volume1/video/downloads
DATA_PATH=/volume1/docker/stremio-offline/data
PUID=1000
PGID=100
```

### Adding addons

In **Addons**, paste a full `manifest.json` URL. A catalog manifest supplies
titles and metadata, a source manifest supplies streams or subtitles, and one
manifest can do both. Cinemeta and OpenSubtitles v3 are installed on first
start. Manifests refresh themselves on an interval you set, and
on demand, so a catalogue the provider adds later still shows up. See
**[Addons and downloads](docs/downloads.md)**.

## Documentation

| Guide | What is in it |
| --- | --- |
| [Install on a Synology NAS](docs/install-synology.md) | Container Manager and SSH paths, `PUID`/`PGID`, backups, reverse proxy |
| [Configuration reference](docs/configuration.md) | Every environment variable, with defaults |
| [Playback](docs/playback.md) | Direct play vs. remux vs. transcode, seeking, tracks, subtitles |
| [Trailers](docs/trailers.md) | Where the trailer comes from, and how secure mode plays it |
| [Addons and downloads](docs/downloads.md) | Debrid addons, the queue, save rules, config backup |
| [Libraries](docs/libraries.md) | Several roots, types, artwork per library, splitting the download folder |
| [Library identification](docs/library-metadata.md) | How folders become titles, the scan, suggestions and Identify |
| [Accounts](docs/users.md) | Roles, per-user libraries and addons, passwords, recovery |
| [Hardware acceleration](docs/hardware-acceleration.md) | QuickSync and VAAPI, and how to tell it is really running |
| [Diagnostics and troubleshooting](docs/troubleshooting.md) | The log, the addon guard, symptom-to-page index |
| [Building and releasing](docs/building.md) | Local builds, GHCR, version tags, Windows and macOS hosts |
| [Testing](docs/testing.md) | What belongs in which test layer, and how to run each |
| [Roadmap](docs/roadmap.md) | What is done, what is next, what is out of scope |

## How playback picks its path

The browser reports which codecs it can handle, and the server takes the
cheapest route that works:

| Source | Mode | NAS load |
| --- | --- | --- |
| MP4/WebM the browser can play | direct play, FFmpeg never starts | none |
| MKV with H.264 or HEVC | remux to fMP4, video and audio copied | negligible |
| AC3, DTS, or TrueHD audio | remux, audio only converted to AAC | low |
| MPEG-4 ASP, VC-1, and similar | real transcode to H.264 | high |

Choosing a quality other than **Original** forces a real transcode, because
shrinking the picture cannot be done by copying. On a NAS without QuickSync,
stay on original quality. [More on playback](docs/playback.md).

## Security

**Do not publish the app directly to the internet.** Login exists, but over
plain HTTP the session cookie travels in the clear. Put an HTTPS reverse proxy
in front of it or use a VPN; once the server sees `X-Forwarded-Proto: https` it
marks the cookie `Secure` itself.

- The server never runs addon code; it only reads their JSON APIs.
- Secure mode (**Settings -> Privacy**, on by default) keeps the browser talking
  only to this instance: posters, backdrops and addon logos are fetched and
  cached by the server, so no provider learns who is browsing what, and no
  artwork address leaves the machine. See
  [Configuration](docs/configuration.md#secure-mode).
- Manifests and streams aimed at a private network are blocked by default. For
  your own LAN addons, set `ALLOW_ADDON_HOSTS`, or `ALLOW_PRIVATE_ADDONS=1` if
  you know why.
- Passwords are stored only as scrypt hashes, and a session carries a signed
  ticket scoped to one account. Signing out of all devices rotates that
  account's signing secret, so previously issued tickets stop working at once.
- An ordinary account reaches only the libraries and addons an administrator
  granted it, and a library it was not granted answers exactly as one that does
  not exist. Taking a right away stops the streams and devices relying on it.
- After five failed sign-ins from one address, every further failure pauses
  sign-in, doubling from a second up to a minute; a success clears the record
  and the count is forgotten after fifteen minutes. The cap stays low on
  purpose: behind a reverse proxy every request arrives from the same address,
  so a long lock would keep the household out as effectively as an attacker.
- Stream addresses are logged as scheme and host only. Tokens and passwords are
  never logged.

**Forgotten password.** Set `ADMIN_USERNAME` to the account and
`ADMIN_PASSWORD_RESET` to the new password, then restart. The server resets
that account's password on the next boot, signs its devices out and writes a
warning line naming it. Changing the value is what makes it fire again, so a
variable left in the container configuration does nothing on later restarts —
but anyone who can read the file can read the password, so clear it once you
are back in.

`ADMIN_PASSWORD` is **not** a way to sign in. It seeds the administrator of an
install that has never had an account, and nothing more: an identity with no
record cannot own a download, cannot be audited and cannot be switched off, so
recovery goes through a real account instead.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Contributing

Issues and pull requests are welcome. Node.js 22 or newer, then:

```bash
npm ci
npm test
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and
[docs/testing.md](docs/testing.md) for the test layers. Larger product questions
belong in the [roadmap](docs/roadmap.md).

## License

The code is [MIT](LICENSE). Not affiliated with Stremio.

The Docker image includes Debian's FFmpeg, which is GPL-2.0-or-later (built with
x264 and x265). The server runs it as a separate program, so the licence of the
code stays MIT. The desktop app does not include FFmpeg. What each distribution
contains, where the licence texts are and where to get FFmpeg's source is in
[docs/licensing.md](docs/licensing.md).
