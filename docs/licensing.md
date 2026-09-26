# Licensing

Stremio Offline's own code — `server/`, `web/`, `desktop/` and everything else
in this repository — is released under the [MIT licence](../LICENSE).

The things we distribute also carry third-party software, and each piece keeps
its own licence. This page says what is in each distribution, under which
licence, and where its texts and source code are. Stremio Offline is not
affiliated with Stremio.

## FFmpeg

The server does not link FFmpeg. It starts `ffmpeg` and `ffprobe` as separate
programs and talks to them through arguments, pipes and files. They are two
programs that sit side by side ("mere aggregation"), so FFmpeg's licence does not
extend to Stremio Offline's code, and the MIT licence of that code does not
change FFmpeg's.

What that requires depends on who hands FFmpeg over.

### Docker image (`ghcr.io/nickrabit/stremio-offline`)

The image is built on Debian (`node:22-trixie-slim`) and installs Debian's
`ffmpeg` package. Debian builds it with `--enable-gpl` and with **x264** and
**x265**, so the FFmpeg in the image is licensed **GPL-2.0-or-later**, as are
x264 and x265. The other packages the image installs keep their Debian licences:

- `libva`, `vainfo`, and on amd64 `intel-media-va-driver` and `i965-va-driver`: MIT;
- `util-linux`: mixed GPL/LGPL/BSD;
- Node.js: MIT, with the licences of its bundled dependencies.

- **Licence texts** are inside the image, one per package, at
  `/usr/share/doc/<package>/copyright`. `ffmpeg -L` prints FFmpeg's own.
- **Exact versions** of an image are listed by
  `docker run --rm --entrypoint dpkg <image> -l ffmpeg 'libx264*' 'libx265*'`.
- **Corresponding source code** for those exact versions is published by
  Debian: `apt-get source ffmpeg=<version>` on a Debian system, the package
  pages at <https://packages.debian.org/source/trixie/ffmpeg>, and the
  permanent archive at <https://snapshot.debian.org/package/ffmpeg/>, which
  keeps every version that was ever released. The same applies to x264 and x265.

  If a version you received from us is no longer obtainable there, open an
  issue and we will provide its source.

The server's npm dependencies are MIT-licensed and carry their licence files in
`/app/server/node_modules`. The web interface's bundled packages are listed
under [Web interface](#web-interface).

### Desktop app (macOS)

The app contains:

- **FFmpeg 9.0.2 (`ffmpeg`, `ffprobe`)**, under
  `Contents/Resources/ffmpeg`, built by `desktop/scripts/build-ffmpeg.sh`. The
  build is made without `--enable-gpl`, so it contains no x264 or other GPL
  part. H.264 is encoded by VideoToolbox.
  - It is statically linked with **OpenSSL 3.5.8** (Apache-2.0) for https
    sources. FFmpeg accepts OpenSSL only with `--enable-version3`, so the
    binaries are licensed **LGPL-3.0-or-later**.
  - The LGPLv3 and GPLv3 texts, FFmpeg's `LICENSE.md`, OpenSSL's licence and a
    `BUILDINFO.txt` with the exact versions, source URLs, checksums and
    configure lines sit beside the binaries.
  - **Every release attaches the exact source archives** (`ffmpeg-*.tar.xz`,
    `openssl-*.tar.gz`) the binaries were built from. The build script in the
    tagged commit rebuilds them.
  - FFmpeg stays a separate executable. Setting `FFMPEG_PATH` and
    `FFPROBE_PATH` for the app, for example with
    `launchctl setenv FFMPEG_PATH /path/to/ffmpeg`, makes it use another build
    instead.

- **Electron**: MIT, shipped as `Contents/Resources/LICENSE.electron.txt`.
- **Chromium** and its components: many licences, listed in full in
  `Contents/Resources/LICENSES.chromium.html`.
- **The server's npm dependencies**, with their licence files under
  `runtime/server/node_modules` inside `app.asar`.
- **The web interface**, with its third-party notices (see below).

The release assets are named `…-unsigned.dmg` because they are not signed with
an Apple Developer ID. That is a Gatekeeper matter, not a licensing one.

### Why the desktop FFmpeg is LGPL and not GPL

A GPL build with x264 would be a software fallback when VideoToolbox fails.
Shipping it would put every release under the obligation to carry or offer the
complete corresponding source of FFmpeg and x264. The LGPL build avoids GPL
code altogether, and on Apple Silicon VideoToolbox is always present.

The price: with the bundled FFmpeg, a transcode has no software encoder to fall
back to. The server detects that and keeps the hardware path on, instead of
switching it off after two failures. Remux and direct play are unaffected. A
Windows build would take the same route with Media Foundation as the encoder.

## Web interface

The browser interface bundles React, React DOM and Scheduler (MIT),
lucide-react (ISC) and hls.js (Apache-2.0). The build writes their full
licence texts to `third-party-licenses.txt` next to `index.html`. It is served
by every install at `/third-party-licenses.txt`, and it is inside the image and
the desktop app.

`web/scripts/third-party-licenses.mjs` generates it from the production
dependencies as they are installed, following them transitively. It fails the
build when a package ships no licence file, so a new dependency cannot slip in
without one.

## Checking a release

Before a release that changes what is bundled:

- look at `/third-party-licenses.txt` in the build;
- run `ffmpeg -L` and `dpkg -l ffmpeg 'libx264*' 'libx265*'` in the image;
- check that the desktop `.app` has `LICENSE.electron.txt` and
  `LICENSES.chromium.html` in `Contents/Resources`;
- check that it has `ffmpeg/` with `BUILDINFO.txt` and `licenses/`, and that the
  release carries the `ffmpeg-*` and `openssl-*` source archives.

`npm run smoke:packaged -w desktop` checks the FFmpeg part: the binary is an LGPL
build, its licence files are there, and the local backend really ran it.

This page describes how the project is put together. It is not legal advice.
