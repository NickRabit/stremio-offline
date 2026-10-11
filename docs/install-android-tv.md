# Installing the Android TV app

The Android TV app is a remote-first client for a Stremio Offline server you
already run, such as on a NAS. It browses the same Home, Catalog and Library
and plays through the same server. It needs Android TV 7.0 (API 24) or newer,
and it is not in Google Play: the APK is attached to each
[release](https://github.com/NickRabit/stremio-offline/releases), named
`stremio-offline-tv-<version>.apk`.

## Updates with Obtainium

The easiest way to install the app and keep it up to date on a television is
[Obtainium](https://github.com/ImranR98/Obtainium), which reads the GitHub
releases directly and installs each new APK over the old one.

1. Install Obtainium on the television. It is not in Google Play, so download
   its APK from [its releases](https://github.com/ImranR98/Obtainium/releases)
   with the **Downloader** app (the section below) and open it.
2. In Obtainium choose **Add app** and enter
   `https://github.com/NickRabit/stremio-offline`.
3. Open the added app's settings and set the **APK filter** to
   `stremio-offline-tv-.*\.apk$`. Every release also carries the desktop
   packages, so without the filter Obtainium would offer the wrong file.
4. Leave **Include pre-releases** off.
5. Set the update check to roughly **every hour**.

Obtainium then notifies the television about each release and installs it over
the old one, keeping the saved sign-in and settings. The short gap is harmless:
the release job attaches the APK in the same run that builds the image, the
server updates itself within ten minutes of a release, and the app only warns
about `tv.versionMismatch` when it and the server differ in major.minor, so a
patch release never warns. The first install signed with the release key
replaces a debug build only after that build has been uninstalled once (see
**Updating** below).

Then open the app and sign in with the server address, the username and the
password of an account on that server.

## With the Downloader app

Most Android TV sets and the NVIDIA Shield can install the **Downloader** app
from Google Play.

1. Allow installs from unknown sources for Downloader: **Settings → Apps →
   Security & restrictions → Unknown sources**, then enable Downloader (the
   exact path differs by set).
2. Install and open Downloader, and enter the address of the APK. Open the
   [latest release](https://github.com/NickRabit/stremio-offline/releases/latest)
   on a phone or computer, note the version, and type:

   ```text
   https://github.com/NickRabit/stremio-offline/releases/latest/download/stremio-offline-tv-<version>.apk
   ```

3. Download it, then open it and confirm the install. Stremio Offline appears
   in the launcher next to the other apps.

## With adb

If a computer shares the network with the television:

```bash
adb connect <tv-ip>:5555        # enable ADB debugging in the developer options first
adb install -r stremio-offline-tv-<version>.apk
```

## Updating

Install the newer APK the same way to update -- Obtainium does it on its own,
or download the file again or run `adb install -r` with it. Everything signed
with the project's release key replaces the previous install and keeps the
saved sign-in and settings.

An install signed with a different key -- a debug build, or a build from
another fork -- cannot be updated over. Android refuses it with a signature
mismatch, and the only way past it is to uninstall the app once and install the
new APK; the next sign-in is needed again.
