# Desktop shell — macOS arm64 prototype packaging

The `desktop` workspace is an Electron shell that opens an existing Stremio
Offline server, or runs one on this computer. It keeps all remote-server
behaviour: it renders the connection page locally and points a second view at
the server origin you configure, exactly as running the workspace from source
does.

## Running the backend on this computer

**Run on this computer** on the connection screen starts the compiled server as
a managed Electron utility process. The remote profiles stay as they were; the
local option is a second way into the same shell.

- The backend binds to `127.0.0.1` only, asks the OS for a free port the first
  time (`PORT=0`) and is opened at the port it reports back. The port it took
  last is remembered in `<userData>/local-backend.json`, tried again on the next
  start to keep the local web origin stable, and given up for a fresh port 0 if
  something else holds it. The remembered port is not a saved server profile.
- State lives in `<userData>/instance`, downloads go to `<userData>/downloads`.
- The local page uses one persistent session partition, so its cookies survive a
  reconnect even when the port changed.
- The shell opens the server only after its `/api/status` answers with this
  app's status, and stops it on **Disconnect**, on a successful connection to a
  remote profile and when the app quits. If the backend exits on its own, the
  shell returns to the connection screen with a localized message and the local
  option starts it again.
- A second launch of the app focuses the window that is already open instead of
  starting a second backend against the same instance directory.

**FFmpeg is not bundled.** Direct play and every server feature that does not
need it work as they do on a server; remux and transcode need an `ffmpeg`
executable that the local backend process can find on its `PATH`.

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
npm run verify:fuses -w desktop
npm run smoke:packaged -w desktop
```

`package:mac:arm64` builds the TypeScript (`dist/main.js`, the modules it
imports, and `dist/preload.js`), builds the root web and server workspaces,
stages them under `desktop/runtime/` (the server's compiled output, the web
bundle and the server's production dependencies) and then runs electron-builder
for the `arm64` target. CI uses this same script, and then
`npm run smoke:packaged -w desktop`, which starts the packaged app's utility
backend, waits for its ready message, reads `/api/status` and stops it again.
`verify:fuses` reads the applied Electron fuses back out of the built `.app`.
CI runs both post-package checks before uploading artifacts.

The staged tree is what the local backend runs from source as well: after
`npm run build` and `npm run stage:local-backend -w desktop`,
`npm run dev -w desktop` opens a window whose local option runs
`desktop/runtime/server/dist/index.js`.

## Artifacts

electron-builder writes both artifacts into `desktop/release/`:

| File | What it is |
| --- | --- |
| `Stremio-Offline-<version>-arm64.dmg` | Disk image for dragging the app into Applications |
| `Stremio-Offline-<version>-arm64.zip` | The same `.app` bundle, zipped |

The bundle is `Stremio Offline.app` with identifier `com.stremiooffline.desktop`
and version taken from the workspace manifest. Inside it,
`Contents/Resources/app.asar` holds the compiled desktop modules (`dist/*.js`),
`static/connection.html`, `package.json` and the staged `runtime/` tree
(`runtime/server/dist`, `runtime/server/node_modules`, `runtime/web`).
TypeScript sources, tests, the spike files, and the root `server` and `web`
workspaces are not packaged.

## Runtime hardening

The bundle is hardened at package time with Electron's Fuse V1 switches
(`build.electronFuses` in `desktop/package.json`). The shell connects to a
configured server, so it has no use for Electron's Node-as-Node mode, Node
runtime option injection or the inspector CLI switches:

| Fuse | State | Why |
| --- | --- | --- |
| `runAsNode` | off | `ELECTRON_RUN_AS_NODE` is not used. A future local backend has to be a Utility Process, not a forked Node process. |
| `enableNodeOptionsEnvironmentVariable` | off | `NODE_OPTIONS` and `NODE_EXTRA_CA_CERTS` are not needed by a shipped shell. |
| `enableNodeCliInspectArguments` | off | `--inspect` and `SIGUSR1` must not open an inspector in a shipped build. |
| `enableEmbeddedAsarIntegrityValidation` | on | `app.asar` is checked against the hash signed into the bundle. |
| `onlyLoadAppFromAsar` | on | Electron loads only `app.asar`; a stray `app/` directory next to it cannot shadow the packaged code. |
| `loadBrowserProcessSpecificV8Snapshot` | off | The shell does not ship a browser-process-specific V8 snapshot. |
| `grantFileProtocolExtraPrivileges` | on | The local `file://` connection page loads its adjacent compiled scripts from `../dist`, which needs Electron's file-to-file privileges. |
| `enableCookieEncryption` | off | Deferred, see below. |

Flipping the fuses rewrites the Electron Framework binary, which invalidates the
linker's ad-hoc signature it shipped with, and Apple Silicon refuses to run a
binary whose signature no longer matches. The config therefore also sets
`resetAdHocDarwinSignature`, so the bundle is re-signed ad-hoc as the last step
of the flip. That is still not a Developer ID signature and notarization is
still missing — see [Limits](#limits).

`enableCookieEncryption` stays off for now. On macOS Electron encrypts the
cookie store with an OS key that is tied to the app's signing identity, and the
prototype still has no stable Developer ID: the bundle is only ad-hoc signed,
so that identity can change from build to build. Turning the fuse on under a
changing identity would make the persistent profile's cookies unreadable and
log the user out, and it is a one-way transition for an existing store. Revisit
it once stable signing exists and cookie persistence across an upgrade has been
tested.

`npm run verify:fuses` reads the fuses back out of the packaged `.app`
(`desktop/scripts/verify-fuses.mjs`). It fails when a reviewed fuse is missing
or reads anything other than the value above, and it also fails when the
installed `@electron/fuses` schema gains a fuse name the verifier does not
review yet, so an unconfigured or newly-added fuse cannot ship unnoticed.

## Continuous integration

The **Desktop package** workflow (`.github/workflows/desktop-package.yml`) runs
on pull requests that touch `desktop/**`, `server/**`, `web/**`, the root
`package.json` / `package-lock.json`, or the workflow itself, and can also be
started by hand with **Run workflow**. It runs
`npm run package:mac:arm64 -w desktop`, which builds the web and server
workspaces and stages them. It then
smoke-tests the packaged app's local backend and checks the fuses before
uploading the DMG and ZIP as separate artifacts kept for seven days. It does
not publish a GitHub Release and does not touch the server image flow.

## Limits

This prototype exists to prove the packaging step, not to hand out an installer.
It is **not** a signed, notarized, auto-updating release:

- **No Developer ID signing and no notarization.** There is no stable signing
  identity and no notarization ticket. The bundle is only re-signed ad-hoc, so
  macOS Gatekeeper may still refuse the first launch. A user who wants to try
  one has to approve it explicitly, for example with **System Settings →
  Privacy & Security → Open Anyway**, or by right-clicking the app and choosing
  **Open**. Do not describe a build as Gatekeeper-ready.
- **No automatic updates.** Nothing checks for or installs a newer version.
- **arm64 only.** There is no Intel or universal build, and no promise to add
  one here.
- **No bundled FFmpeg and no installer for one.** Remux and transcode need an
  `ffmpeg` the local backend can run; the app neither ships it nor installs it.
- **No data migration.** The local backend starts with an empty instance
  directory; pointing it at an existing Docker or NAS install is not part of
  this prototype.
- **No clean-install verification or support promise.** The package has not been
  verified from a clean install, and it is not a supported distribution.

Signing, notarization, update delivery, clean-install testing and support
documentation are the next desktop distribution milestone; see
[docs/roadmap.md](../docs/roadmap.md).
