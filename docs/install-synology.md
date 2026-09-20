# Install on a Synology NAS

The container can run as your own user, so shared-folder permissions do not have
to be rewritten. The steps work with or without SSH.

## Without SSH, through Container Manager

The NAS only needs two files, and nothing is built there — the image comes
ready from GHCR.

1. In **File Station**, create a folder for the project, for example
   `/volume1/docker/stremio-offline`.
2. Download [`compose.pull.yml`](../compose.pull.yml) from the repository and
   upload it into that folder **renamed to `docker-compose.yml`**. Container
   Manager looks for that name; under any other one it will not find the
   project. Keep it the only compose file there.

   Do not use `compose.yml` on the NAS. It builds the image locally, which is
   slow, and Container Manager's classic builder silently leaves the VAAPI
   drivers out.
3. In the same folder, create a `.env` file (Create → Text file) with at least
   this:

   ```dotenv
   DOWNLOAD_PATH=/volume1/video/downloads
   DATA_PATH=/volume1/docker/stremio-offline/data
   ALLOW_ADDON_HOSTS=192.168.1.205
   PUID=1000
   PGID=100
   ```

   The rest is optional and defaults sensibly — the full list with comments is
   in [`.env.example`](../.env.example) and
   [Configuration reference](configuration.md).
4. In **Container Manager → Project → Create**, pick that folder. The compose
   file is detected; the wizard offers to start the project right away.

   **Container Manager accepts only one compose file**, so the
   `compose.synology.yml` override is ignored there. The pull file already maps
   `/dev/dri`; for hardware acceleration add `VAAPI_DEVICE=/dev/dri/renderD128`
   and `RENDER_GID` to `.env` — see
   [Hardware acceleration](hardware-acceleration.md).
5. After the first start, open the container **Terminal** in Container Manager
   and see who owns the download folder:

   ```bash
   ls -n /downloads
   ```

   The first two numbers are uid and gid. Write them into `.env` as `PUID` and
   `PGID` and restart the project. For this purpose the Container Manager
   terminal is a full substitute for SSH.
6. Open `http://NAS:8090`. A fresh install has no account and asks you to choose
   a name and password; until then the server serves nothing else.

To update later, use **Action → Build** on the project. With no `build:` section
in the file, that only pulls a newer image. Note that `:latest` is the last
*released* image, not the last commit; to pin a version, append a commit SHA to
the image name, for example `:a1b2c3d`.

## With SSH

```bash
cd /volume1/docker
git clone https://github.com/NickRabit/stremio-offline.git
cd stremio-offline
cp .env.example .env
# set DOWNLOAD_PATH, ALLOW_ADDON_HOSTS, and PUID/PGID from:
stat -c '%u %g' /volume1/video/downloads
docker compose -f compose.pull.yml pull
docker compose -f compose.pull.yml up -d
```

`compose.pull.yml` already maps `/dev/dri`, so hardware acceleration needs only
`VAAPI_DEVICE` and `RENDER_GID` in `.env`, no override file. Update later with
the same two commands.

To build on the NAS instead — rarely worth it, and slow — use `compose.yml`
with the Synology override, which adds the device and the render group:

```bash
docker compose -f compose.yml -f compose.synology.yml up -d --build
```

## When writes fail

The server logs at start if it cannot write to `/downloads`. Three options,
gentlest first:

- **`PUID` and `PGID`** matching the real folder owner. Nothing is rewritten.
- **In File Station**, grant read and write on the folder and apply that to
  subfolders.
- **`FIX_PERMISSIONS=1`** in `.env`. On start, once, it chowns the whole
  download folder. On a large library that takes a while, so it is not the
  default.

## Access from outside

On the home network the steps above are enough.

**Do not publish the app directly to the internet.** Login exists, but over
plain HTTP the session cookie travels in the clear. Use DSM's reverse proxy with
an HTTPS certificate; once the server sees `X-Forwarded-Proto: https`, it marks
the cookie `Secure` itself.

## Keeping the NAS responsive

Playing a large file can freeze Synology for minutes. Two causes, both fixable.

**Write burst.** During remux, FFmpeg runs faster than real time so seeking
stays snappy, and it dumps segments into `/data`. At the old 8× rate that was
over 300 MB in twenty seconds; a weaker NAS chokes pushing dirty pages to disk.
The default is therefore `FFMPEG_READRATE_REMUX=3` — seeking stays as fast,
because that is decided by the initial burst, but writes drop to a third. If
that is not enough, set it to `2`. Session segments are cleaned up when the
session ends; an idle session stops after five minutes.

**Saturated CPU.** Without acceleration, software transcode takes every core and
DSM stops responding. `compose.yml` has a commented `cpus` limit so you can
leave one core for the system. The lasting fix is QuickSync — see
[Hardware acceleration](hardware-acceleration.md). If the log says
`gpuScaling:false`, a slice of the scaling work stays on CPU; that is expected.

## Where data lives

Beside downloaded films, the server keeps its own data: the accounts, addon list,
libraries, artwork, stats, and the download queue. That lives in `/data`, and
`DATA_PATH` points at it — by default a `data` folder next to `compose.yml`.

It is an ordinary folder, not a hidden Docker volume. Copy it to back it up;
delete it to return the server to a fresh install (you lose the accounts and
addons, downloaded files stay). On Synology, put it in a shared folder so it
shows up in File Station.

Older installs kept data in a named volume `stremio-offline-data`. Move it over
SSH with one command — `docker volume ls` shows the volume name:

```bash
docker run --rm -v stremio-offline_stremio-offline-data:/from -v /volume1/docker/stremio-offline/data:/to alpine sh -c 'cp -a /from/. /to/'
```

Without SSH it is simpler to start over: addons are re-added, and downloaded
files stay because they sit outside this folder.
