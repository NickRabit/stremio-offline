# Desktop shell — macOS arm64 prototype packaging

The `desktop` workspace is an Electron shell that opens an existing Stremio
Offline server. It keeps all remote-server behaviour: it renders the connection
page locally and points a second view at the server origin you configure, exactly
as running the workspace from source does. Packaging changes nothing about that.

The packaging sections below cover the packaging prototype only. It produces a
macOS arm64 `.dmg` and `.zip` from the compiled shell. It is deliberately not a
public release — see [Limits](#limits) before sharing anything built here.

## Saving to this device

**Save to this device** mints a short-lived ticket on the server and hands that
same-origin URL to Electron, so the media bytes never pass through the shell.
For such a ticket the shell keeps Electron's **native Save dialog** and only
sets its title and a safe suggested filename; it never picks a save path,
never suppresses the dialog and never downloads the file itself. Progress and
the result are shown in the 48 px bar above the server page.

- A percentage is shown only when the server reports a positive total size. An
  unknown size — a playlist being assembled, for example — stays a plain
  "saving".
- The save is **not resumable and not a background download**. Closing the
  window, losing the connection to the server, or cancelling the dialog ends
  it; an interrupted save has to be started again from the server UI.
- Logs, settings exports, addon manifests, `blob:` links and every other
  download keep Electron's own behaviour instead.

## Requirements

- macOS on Apple Silicon (arm64). Only arm64 is built and labelled; there is no
  Intel or universal artifact.
- Node.js >= 22, matching the root `engines` field.

## Build locally

Run the packaging script from the repository root so the npm workspace and its
lockfile are used as-is:

```bash
npm ci
npm run test -w desktop
npm run package:mac:arm64 -w desktop
```

`package:mac:arm64` builds the TypeScript (`dist/main.js`, the modules it
imports, and `dist/preload.js`) and then runs electron-builder for the `arm64`
target. CI uses this same script.

## Artifacts

electron-builder writes both artifacts into `desktop/release/`:

| File | What it is |
| --- | --- |
| `Stremio-Offline-<version>-arm64.dmg` | Disk image for dragging the app into Applications |
| `Stremio-Offline-<version>-arm64.zip` | The same `.app` bundle, zipped |

The bundle is `Stremio Offline.app` with identifier `com.stremiooffline.desktop`
and version taken from the workspace manifest. Inside it,
`Contents/Resources/app.asar` holds only the compiled desktop modules
(`dist/*.js`), `static/connection.html` and `package.json`. TypeScript sources,
tests, the spike files, and the root `server` and `web` workspaces are not
packaged.

## Continuous integration

The **Desktop package** workflow (`.github/workflows/desktop-package.yml`) runs
on pull requests that touch `desktop/**`, the root `package.json` /
`package-lock.json`, or the workflow itself, and can also be started by hand
with **Run workflow**. It runs `npm run build -w desktop` followed by
`npm run package:mac:arm64 -w desktop` on a `macos-14` runner and uploads the
DMG and ZIP as separate artifacts kept for seven days. It does not publish a
GitHub Release and does not touch the server image flow.

## Limits

This prototype exists to prove the packaging step, not to hand out an installer.
It is **not** a signed, notarized, auto-updating release:

- **No Developer ID signing and no notarization.** There is no stable signing
  identity and no notarization ticket. Electron's executable may carry an
  ad-hoc linker signature, but macOS Gatekeeper may still refuse the first
  launch. A user who wants to try one has to
  approve it explicitly, for example with **System Settings → Privacy &
  Security → Open Anyway**, or by right-clicking the app and choosing **Open**.
  Do not describe a build as Gatekeeper-ready.
- **No automatic updates.** Nothing checks for or installs a newer version.
- **arm64 only.** There is no Intel or universal build, and no promise to add
  one here.
- **No local backend.** The shell still expects a Stremio Offline server that is
  already running and reachable; starting one from the app is later work.
- **No clean-install verification or support promise.** The package has not been
  verified from a clean install, and it is not a supported distribution.

Signing, notarization, update delivery, clean-install testing and support
documentation are the next desktop distribution milestone; see
[docs/roadmap.md](../docs/roadmap.md).
