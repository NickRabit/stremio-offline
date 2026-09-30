# Installing the Linux app

The Linux app runs Stremio Offline on your computer, or opens a server you
already run somewhere else, such as a NAS. It needs a 64-bit x86 PC with
glibc 2.35 or newer. That means Ubuntu 22.04+, Debian 12+, Fedora 38+, or a
current Arch, openSUSE Tumbleweed or Linux Mint 21+.

## Download

Open the [latest release](https://github.com/NickRabit/stremio-offline/releases/latest)
and pick one file:

- **`stremio-offline_<version>_amd64-unsigned.deb`** for Ubuntu, Debian and
  their relatives. Install it with:

  ```bash
  sudo apt install ./stremio-offline_<version>_amd64-unsigned.deb
  ```

  apt pulls in what the app needs (VA-API and GTK libraries, `gio` for the
  Trash). The app then appears in your applications menu.

- **`Stremio-Offline-<version>-x86_64-unsigned.AppImage`** for every other
  distribution. It is one file and needs no install:

  ```bash
  chmod +x Stremio-Offline-*.AppImage
  ./Stremio-Offline-*.AppImage
  ```

  - The AppImage uses the system's VA-API libraries, which most desktop
    distributions already have (browsers and video players use them). If
    films will not play or convert, install them: `libva2 libva-drm2` on
    Debian and Ubuntu, `libva` on Fedora, Arch and openSUSE.
  - On Ubuntu 24.04 and newer, install `libfuse2t64` first:
    `sudo apt install libfuse2t64`. On other distributions the package is
    usually `fuse2` or `fuse-libs`.
  - Ubuntu 24.04 also restricts the user namespaces Electron's sandbox is
    built on. Where they are unavailable, the AppImage's launcher starts the
    app without the sandbox rather than not at all; everywhere else the
    sandbox stays on. The `.deb` sets the sandbox up properly on every
    distribution, so prefer it on Ubuntu 24.04. If the AppImage does not
    open, start it once with `--appimage-extract-and-run` to see the error.
    Do not run the app as root.

## Setting it up

The welcome screen offers two choices:

- **This computer** runs the server in the app. It asks where downloaded
  films go, and proposes `~/Videos/Stremio Offline` (or your localized Videos
  folder). That folder becomes your first library. To download somewhere else
  later, add a library in another folder and make it the default.
- **A server on the network** opens a server you already run.

Settings are in the menu bar, under **File → Settings…**, or `Ctrl+,`.

## Everyday use

- **Closing the window quits the app.** While something is still downloading
  or playing, it asks first. Unfinished downloads carry on at the next start.
- **Tray icon.** Where your desktop shows tray icons (KDE, Cinnamon, XFCE,
  MATE, or GNOME with the AppIndicator extension), the app also has one, with
  quick access to the window, the servers and Settings.
- **Open at login** in **Settings → General** adds an entry to
  `~/.config/autostart`. The app then starts minimized when you log in.
- **Your computer stays awake while the server downloads**, and while it
  streams to another device with sharing on.
- **Sharing with other devices.** When you turn on **Share with devices on my
  network**, other devices open one of the addresses shown in Settings. If a
  firewall is active, allow that port: `sudo ufw allow 8091/tcp`, or with
  firewalld, `sudo firewall-cmd --add-port=8091/tcp --permanent && sudo
  firewall-cmd --reload`.

## Converting video

When a device cannot play a film as it is, the app converts it, using your
graphics card:

- **Intel and AMD:** VA-API. Install your distribution's VA-API driver
  (`intel-media-va-driver` or `mesa-va-drivers` on Ubuntu and Debian), and
  make sure you are in the `render` group: `sudo usermod -aG render $USER`,
  then log out and in.
- **NVIDIA:** NVENC, through the proprietary NVIDIA driver, version 530 or
  newer.

The app's own FFmpeg has no software encoder. **Without a working graphics
card it cannot convert**, but direct play and remux still work. If your
distribution's `ffmpeg` is built with libx264, which most are, Settings
offers **Use the system's FFmpeg**, and conversion then works without a
graphics card. See [Hardware acceleration](hardware-acceleration.md) for how
to tell which path runs.

## Updating

The app checks GitHub for a newer release at launch and once a day, and says
so when one is out. You can turn this off in **Settings → General**. To
update:
- **`.deb`:** install the new file the same way.
- **AppImage:** replace the file. The login entry follows the new file
  automatically.

## Removing it

To start again with an empty server, use **Settings → Reset this computer**.
The server's data goes to the Trash. Your films stay unless you tick the box
for the download folder, and that box appears only for a folder the app
created itself. If the Trash cannot take the data (some mounted drives have
none), the reset says so and deletes nothing.

To remove the app entirely:

1. Quit it.
2. Remove it: `sudo apt remove stremio-offline` for the `.deb`, or delete the
   AppImage file.
3. Delete `~/.config/@stremio-offline/desktop` as well, and
   `~/.config/autostart/stremio-offline.desktop` if it is there.

Your download folder is not touched; delete it yourself if you want the films
gone.
