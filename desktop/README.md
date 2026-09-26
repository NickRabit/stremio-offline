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
- It answers only requests addressed to `127.0.0.1:<port>` or `localhost:<port>`
  (`HOST_CHECK=loopback`) and refuses any other `Host` with 421. Binding to
  loopback alone does not stop DNS rebinding, where a page in an ordinary
  browser points a name it controls at 127.0.0.1 and reads the server as its own
  origin. A server started without `HOST_CHECK` accepts every `Host`, as before.
- State lives in `<userData>/instance`, downloads go to `<userData>/downloads`.
- **Allow addons on my home network** under the local button is off by default,
  is stored in `<userData>/local-settings.json` and applies from the next start
  of the local backend, which the shell then starts with
  `ALLOW_PRIVATE_ADDONS=1`. That opens your network to every addon, so it is
  meant for an addon on the NAS or another computer at home and for addons you
  trust.
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
executable that the local backend process can find. It looks on the `PATH` it
inherits and, on macOS, also in `/opt/homebrew/bin` and `/usr/local/bin`, which
a launch from the Finder or the Dock does not have on `PATH`. `FFMPEG_PATH` and
`FFPROBE_PATH` name an executable explicitly when it sits somewhere else.

The packaging sections below cover the packaging prototype only. It produces a
macOS arm64 `.dmg` and `.zip` from the compiled shell. It is deliberately not a
public release — see [Limits](#limits) before sharing anything built here.

## Sharing with other devices

**Share with devices on my network** on the connection screen is off by default
and is stored in the same `<userData>/local-settings.json` file. While it is on,
the local backend binds to `0.0.0.0` on a fixed, configurable port (8091 by
default, 1024–65535) instead of a remembered loopback port, and it applies from
the next start of the local backend. Nothing else about the server changes:
accounts, roles and the web interface are the same, and another device signs in
with an account from this server.

- The host check widens from `loopback` to `published`, which accepts a `Host`
  whose port is the one it listens on and whose name is an IP literal
  (`192.168.1.41:<port>`, `[fe80::1]:<port>`), `localhost` or this machine's own
  `.local` name. Any other name is refused with 421, which is what keeps a
  DNS-rebinding page from reading the server: such a page can point a name it
  controls at the Mac, but it cannot make that name an IP literal or the Mac's
  `.local` name.
- The port is fixed, so a port already taken by another program is reported and
  never silently swapped for a different one.
- macOS asks once whether to accept incoming connections the first time. If it
  was refused, allow the app in **System Settings → Network → Firewall**.
- The Mac is kept from idle sleep only while something is playing, and only
  through `powerSaveBlocker.start("prevent-app-suspension")`. Closing the lid
  still puts it to sleep.

## Choosing a library folder

In the local mode, **Choose a folder on this computer…** in the new-library
dialog opens the macOS folder dialog. The chosen folder is granted to the
local backend and selected, exactly as if its absolute path had been typed under
"My folder isn't listed". The first read from Desktop, Documents, Downloads or an
external disk may bring up the system's own access prompt.

This is the one bridge the shell gives a server page: `window.stremioDesktop`
with `version: 1` and `pickFolder()`. Only the page the local backend serves
gets it, and the main process answers only that page's top frame while it is the
page on screen. A remote server's page has no bridge, and the interface offers
the button only where the bridge is present.

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
(`build.electronFuses` in `desktop/package.json`). The shell connects to
configured servers or starts its bundled backend as an Electron Utility
Process, so it has no use for Electron's Node-as-Node mode, Node runtime option
injection or the inspector CLI switches:

| Fuse | State | Why |
| --- | --- | --- |
| `runAsNode` | off | `ELECTRON_RUN_AS_NODE` is not used. The local backend runs as an Electron Utility Process, not a forked Node process. |
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
of the flip. The unsigned pull-request package stops there; the manual release
workflow applies Developer ID signing and notarization afterwards — see
[Signed release (manual)](#signed-release-manual).

`enableCookieEncryption` stays off for now. On macOS Electron encrypts the
cookie store with an OS key that is tied to the app's signing identity. The
manual release workflow has not yet produced a signed build that has been
tested across upgrades. Turning the fuse on before confirming that behavior
could make the persistent profile's cookies unreadable and log the user out,
and it is a one-way transition for an existing store. Revisit it after a signed
release has been tested across an upgrade.

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

## Signed release (manual)

`.github/workflows/desktop-release.yml` (**Desktop release**) is the only path
that produces a signed, notarized build, and only a maintainer runs it. It is
kept out of the pull-request check so packaging on a pull request stays unsigned
and needs no Apple credentials. It is dispatched by hand and refuses to run
anywhere but `main`:

1. Cut the normal tagged release first with
   `git tag vX.Y.Z && git push origin vX.Y.Z`, which the **Release** workflow
   turns into a GitHub Release.
2. In **Actions → Desktop release → Run workflow**, pick the `main` branch and
   enter the tag, for example `v0.4.75`.

Before it packages anything the job checks that the tag matches
`vMAJOR.MINOR.PATCH`, exists, points to a commit reachable from `origin/main`,
agrees with the version in `desktop/package.json`, and already has a GitHub
Release to attach to. It then signs with the Developer ID certificate and
notarizes with an App Store Connect API key, and it fails before packaging if
any required secret is missing.

### Required repository secrets

Set these under **Settings → Secrets and variables → Actions → Repository
secrets**. They are read only by the macOS packaging job, are never printed, and
the decoded API key file is deleted even if packaging fails.

| Secret | Value |
| --- | --- |
| `MACOS_CERTIFICATE_P12_BASE64` | A **Developer ID Application** `.p12` (certificate and private key), base64-encoded. |
| `MACOS_CERTIFICATE_PASSWORD` | The password chosen when exporting that `.p12`. |
| `APPLE_API_KEY_P8_BASE64` | An App Store Connect team API key `.p8`, base64-encoded. |
| `APPLE_API_KEY_ID` | The key ID of that API key. |
| `APPLE_API_ISSUER` | The App Store Connect issuer ID. |

Only Developer ID signing and App Store Connect API-key authentication are
used; Apple ID app-specific-password authentication is deliberately not
supported. To produce the values:

- In the Apple Developer portal create a **Developer ID Application**
  certificate, install it into the login keychain, then in **Keychain Access**
  export the certificate *and* its private key as a `.p12` and base64-encode the
  file, for example `base64 -i DeveloperID.p12 -o certificate.p12.base64`.
- In **App Store Connect → Users and Access → Integrations → App Store Connect
  API**, create a team key with **App Manager** access, download the `.p8` once
  and base64-encode it, for example
  `base64 -i AuthKey_XXXXXXXXXX.p8 -o apikey.p8.base64`. Note the key ID and the
  issuer ID shown on that page.

After packaging the job runs `codesign --verify --deep --strict --verbose=2`,
Gatekeeper assessment with `spctl --assess --type execute`, and `xcrun stapler
validate` against the built `.app`, plus the same `npm run verify:fuses -w
desktop` fuse read-back as the pull-request check. Only the DMG and ZIP are
uploaded, to the existing release, and the upload fails rather than replacing an
asset that already has that name.

## Limits

This prototype exists to prove the packaging step, not to hand out an installer.
The **Desktop package** artifact is **not** a signed, notarized, auto-updating
release:

- **The pull-request package has no Developer ID signing and no
  notarization.** The bundle is only re-signed ad-hoc, so macOS Gatekeeper may
  still refuse the first launch. A user who wants to try one has to approve it
  explicitly, for example with **System Settings → Privacy & Security → Open
  Anyway**, or by right-clicking the app and choosing **Open**. Do not describe
  a build as Gatekeeper-ready. The manual **Desktop release** workflow signs and
  notarizes a tagged build, but it has not been run yet against real
  credentials and no signed release exists — see [Signed release
  (manual)](#signed-release-manual).
- **No automatic updates.** Nothing checks for or installs a newer version.
- **arm64 only.** There is no Intel or universal build, and no promise to add
  one here.
- **No bundled FFmpeg and no installer for one.** Remux and transcode need an
  `ffmpeg` the local backend can run; the app neither ships it nor installs it.
- **No data migration.** The local backend starts with an empty instance
  directory; pointing it at an existing Docker or NAS install is not part of
  this prototype.
- **No clean-install verification or support promise.** Neither the workflow nor
  a signed build has been exercised end to end, the package has not been
  verified from a clean install, and it is not a supported distribution.

Workflow support for signing and notarization exists, but an actual signed
release, update delivery, clean-install testing and support documentation are
still outstanding; see
[docs/roadmap.md](../docs/roadmap.md).
