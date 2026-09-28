# Installing the Windows app (experimental)

The Windows app runs Stremio Offline on your PC, or opens a server you already
run somewhere else, such as a NAS. It needs 64-bit Windows 10 or 11. On a
Windows on ARM laptop the x64 build runs under emulation.

**Experimental.** The Windows build is packaged and tested automatically, but
not yet on many real machines. Tell us what does not work.

## Download

Open the [latest release](https://github.com/NickRabit/stremio-offline/releases/latest)
and download either file:

- `Stremio-Offline-<version>-x64-unsigned-setup.exe`, the installer. Most
  people want this one.
- `Stremio-Offline-<version>-x64-unsigned.zip`, a portable copy. Unpack it
  anywhere and run `Stremio Offline.exe`. The portable copy shows no Windows
  notifications, because Windows only shows them for installed apps.

## The first launch

The app is not signed with a code-signing certificate, so Microsoft Defender
SmartScreen stops it the first time:

1. Run the installer. When **Windows protected your PC** appears, choose
   **More info**.
2. Choose **Run anyway**.

The installer needs no administrator rights. It installs for your account
only, into `%LOCALAPPDATA%\Programs\@stremio-offlinedesktop`, adds a Start menu entry and a desktop shortcut, and opens the app. Each
new version shows the SmartScreen warning again.

## Setting it up

The welcome screen offers two choices:

- **This PC** runs the server in the app. It asks where downloaded films go,
  and proposes `Videos\Stremio Offline` in your user folder. If your Videos
  folder is synced by OneDrive, it proposes `Stremio Offline` in your user
  folder instead, so the films do not fill your OneDrive. That folder becomes
  your first library. To download somewhere else later, add a library in
  another folder and make it the default.
- **A server on the network** opens a server you already run. You can switch
  between it and this PC at any time from the **Server** menu, from the icon in the notification area, or in
  **Settings**.

## Everyday use

- **Closing the window does not quit the app.** It keeps running in the
  notification area, next to the clock, and the server on this PC keeps
  downloading. When sharing is on, it also stays available to your other
  devices. Click the icon to open the window again. The first time you close
  the window, a notification says so.
- **Settings** are under **File → Settings…** in the window's menu bar, or
  `Ctrl+,`, or in the icon's menu.
- **Quit** from the icon's menu, or with **File → Exit**. While the server on
  this PC is downloading or playing something, on this PC or on another
  device, the app asks first. The question also holds up signing out or
  shutting down until you answer it. Unfinished downloads carry on at the next
  start.
- **Your PC stays awake while the server on it downloads**, and while it streams to another device with sharing on. It can still sleep when you close a laptop's lid.
- **Open at login** in **Settings → General** starts the app in the
  notification area when you sign in to Windows.
- **Sharing with other devices.** When you turn on **Share with devices on my
  network**, Windows Defender Firewall asks whether to allow Stremio Offline.
  Allow it on **private networks**. Other devices then open one of the
  addresses shown in Settings.

## Converting video

When a device cannot play a film as it is, the app converts it with Windows'
own Media Foundation encoder. With a graphics card, that uses the card's
encoder (NVIDIA, Intel or AMD). Without one it uses Microsoft's software
encoder, which works but is slow. See [Hardware
acceleration](hardware-acceleration.md) for how to tell which one runs.

Some sources check their HTTPS certificates online for revocation on Windows.
A source whose certificate cannot be checked can fail on Windows while it works
on a Mac.

## Long paths

Windows and several of its tools do not handle paths longer than about 260
characters. The app keeps the names of new downloads short enough. A library
root that is itself deeply nested can still run into the limit, so prefer a
short one such as `D:\Films`.

## Updating

The app checks GitHub for a newer release at launch and once a day, and says
so when one is out. You can turn this off in **Settings → General**. The check
is a plain request to GitHub's release feed that names the app and its
version; like any request, it shows GitHub your IP address. Nothing about you
or your library is sent.

To update, download the new installer and run it. Your libraries, accounts and
settings stay.

## Removing it

To start again with an empty server, use **Settings → Reset this PC**. The
server's data goes to the Recycle Bin. Your films always stay: on Windows a
reset never moves the download folder, because the Recycle Bin may have no
room for it and Windows would delete it instead.

To remove the app entirely:

1. Quit it.
2. Uninstall it in **Settings → Apps → Installed apps**.
3. Delete `%APPDATA%\@stremio-offline\desktop` as well. Paste that into the File Explorer
   address bar.

Your download folder is not touched; delete it yourself if you want the films
gone.
