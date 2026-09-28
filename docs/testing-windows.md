# Checking the Windows app by hand

CI packages the Windows app and smoke-tests it on `windows-latest`. That proves:
- the app starts;
- the local server answers;
- the bundled FFmpeg is the LGPL build, and Media Foundation can encode (in
  software; the runner has no GPU).

It cannot show:
- what a person sees: installer, window, tray, dialogs;
- the firewall;
- a real graphics card encoding.

This checklist covers those. Run it on a real Windows 10 or 11 PC after a
change that touches the Windows app.

## Get the build

- **A release:** download `Stremio-Offline-<version>-x64-unsigned-setup.exe`
  from the [releases](https://github.com/NickRabit/stremio-offline/releases).
- **A pull request:** open the PR's **Desktop package** run, then download the
  `stremio-offline-windows-x64-setup` artifact. It is a zip that holds the
  installer.

## Checklist

Write down for each step: **OK**, or what happened instead. Add a screenshot
where something looks wrong.

1. **Install.**
   - SmartScreen shows "Windows protected your PC", and **More info → Run
     anyway** installs the app.
   - There is no administrator prompt.
   - A Start menu entry and a desktop shortcut appear.
2. **First run.**
   - The welcome screen says **This PC** (**Tento počítač** in Czech) and
     nothing mentions a Mac.
   - **This PC** proposes `C:\Users\<you>\Videos\Stremio Offline`, or
     `C:\Users\<you>\Stremio Offline` when your Videos folder is in OneDrive.
   - The server starts, and the library shows that folder.
3. **Download and play.**
   - Add an addon, download a film, and play it in the window.
   - Pick a lower quality to force a conversion.
   - In **Settings → Diagnostics** of the server page, the conversion line says
     **Media Foundation** and not "(software)" if the PC has a graphics card.
   - In **Task Manager → Performance → GPU**, the **Video Encode** graph moves
     during the conversion.
4. **Share to other devices.**
   - Turn on **Share with devices on my network** in Settings.
   - Windows Defender Firewall asks. Allow it on private networks.
   - A phone on the same Wi-Fi opens one of the listed addresses and can sign in.
5. **Window and tray.**
   - Close the window. A notification says the app keeps running; it appears
     only the first time.
   - A download in progress carries on.
   - Click the tray icon and the window comes back, on the same server.
   - Right-click the tray icon: the menu has Open, This PC and servers,
     Settings and Quit.
   - The main window has a menu bar (File, Edit, View, Server, Help), and
     **File → Settings…** opens Settings.
6. **Quit while busy.** Start a download and choose **Quit** from the tray.
   The app asks first. **Cancel** keeps it running, and **Quit** stops it. At
   the next start the download continues.
7. **Open at login.**
   - Turn it on in **Settings → General**, sign out and sign in again.
   - The app starts in the tray without a window, and the phone from step 4
     can reach it.
   - Turn it off and sign out and in again: the app does not start.
8. **Language.** Switch to English and back in **Settings → General**. The
   window, the menus and the tray follow.
9. **Reset this PC.**
   - **Settings → Reset this PC** asks once and returns to the welcome screen.
   - The server's data is in the Recycle Bin.
   - The films are still in the download folder, and there is no option to
     delete them.
10. **Folders.**
    - Add a library on another drive, for example `D:\Films`. It works.
    - A long series name downloads without an error.
    - In the **first-run setup step** (a fresh install, or after Reset this
      PC), choosing the drive root `D:\`, the profile folder itself or a folder
      inside the install folder as the download folder is refused. A library
      added later may sit at a drive root on purpose, for example a NAS share.
11. **Update notice.** Nothing to do unless an older build is installed. Then
    the app says a newer version is out, and **Download** opens the release page.
12. **Uninstall.**
    - **Settings → Apps** uninstalls it.
    - `%APPDATA%\@stremio-offline\desktop` and the films stay until you delete them.

## Letting Claude run it

To have Claude Code on the Windows PC go through the list, clone the
repository there, open Claude Code in it and give it this prompt:

> Read `docs/testing-windows.md` and `docs/install-windows.md`. Install the
> Windows build I downloaded to `<path>` and go through the checklist with me.
> Do what you can yourself: read the app's log in
> `%APPDATA%\@stremio-offline\desktop\instance\app.log`, check files and
> folders, run PowerShell. Ask me to
> click where a person has to: SmartScreen, the firewall, the tray, signing out.
> Never delete my own files. At the end, write a report with OK or what
> happened for every step, and save it as `windows-check-<date>.md`.

Send the report back. Every "not OK" becomes a fix.
