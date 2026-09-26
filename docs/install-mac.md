# Installing the macOS app

The macOS app runs Stremio Offline on your Mac, or opens a server you already
run somewhere else, such as a NAS. It needs a Mac with Apple Silicon (M1 or
newer). There is no Intel build.

## Download

Open the [latest release](https://github.com/NickRabit/stremio-offline/releases/latest)
and download `Stremio-Offline-<version>-arm64-unsigned.dmg`. Open the disk
image, then drag **Stremio Offline** into **Applications**.

## The first launch

The app is not signed with an Apple Developer ID, so macOS refuses to open it
the first time. You allow it once; after that it opens normally.

**macOS 15 Sequoia and newer**

1. Open **Stremio Offline** from Applications. macOS says it cannot verify the
   app. Choose **Done**. Do not choose **Move to Trash**.
2. Open **System Settings → Privacy & Security**, and scroll down to
   **Security**.
3. Next to the message about Stremio Offline, choose **Open Anyway**.
4. macOS asks once more. Choose **Open Anyway** again and confirm with your
   password or Touch ID.

**macOS 14 Sonoma and older**

Right-click **Stremio Offline** in Applications, choose **Open**, and then
choose **Open** again in the dialog.

**From Terminal instead**

This removes the download mark that makes macOS ask:

```bash
xattr -dr com.apple.quarantine "/Applications/Stremio Offline.app"
```

## Setting it up

The welcome screen offers two choices:

- **This Mac** runs the server in the app. It asks where downloaded films go,
  and proposes `~/Movies/Stremio Offline`. That folder becomes your first
  library. To download somewhere else later, add a library in another folder
  and make it the default.
- **A server on the network** opens a server you already run. You can switch
  between it and this Mac at any time from the **Server** menu or in
  **Settings**.

## Everyday use

- **Closing the window does not quit the app.** It stays in the Dock, and the
  server on this Mac keeps downloading and stays available to your other
  devices. Click the Dock icon to open the window again. Quit with ⌘Q; while
  something is still downloading or playing, the app asks first.
- **Your Mac stays awake while the app downloads.** It can still sleep when you
  close the lid.
- **Open at login** in **Settings → General** starts the app when you log in.
  If macOS asks for approval, allow Stremio Offline in **System Settings →
  General → Login Items**.

## Updating

The app checks GitHub for a newer release at launch and once a day, and says
so when one is out. You can turn this off in **Settings → General**. The check
sends nothing about you or your library.

To update, download the new disk image and drag the app into Applications
again, replacing the old one. Your libraries, accounts and settings stay. A new
download needs the same one-time approval as the first launch.

## Removing it

To start again with an empty server, use **Settings → Reset this Mac**. Your
films stay unless you tick the box that moves the download folder to the Trash.

To remove the app entirely:

1. Quit it.
2. Move it from Applications to the Trash.
3. Move `~/Library/Application Support/Stremio Offline` to the Trash as well.

Your download folder is not touched; delete it yourself if you want the films
gone.
