# Remote media servers from the desktop app

The desktop app carries its own copy of the server, so a desktop install can add
Jellyfin and Emby libraries with no environment setup at all. The server keeps
the provider tokens in an encrypted vault unlocked by a single key file. A
container with `MEDIA_SERVER_KEY_FILE` unset creates its key in the data
directory on first start; on the desktop the application manages a key of its
own, outside that directory. This page describes what the desktop does and what
it deliberately will not do.

## The key file

The desktop default is **`<userData>/media-server.key`** — beside the server's
`instance` directory, never inside it, so a metadata-only backup of that
directory does not carry the key. The file holds 32 random bytes and is
owner-only (`0600`) on macOS and Linux. On Windows the creation mode is not a
claim about access control: the file inherits the ACL of the user profile
directory it lives in.

`<userData>` is the app's own data folder:

| Platform | Folder |
| --- | --- |
| macOS | `~/Library/Application Support/@stremio-offline/desktop` |
| Windows | `%APPDATA%\@stremio-offline\desktop` |
| Linux | `~/.config/@stremio-offline/desktop` |

A development run uses the same folder with a `-dev` suffix. The exact path is
the one named by
[Installing the macOS app](install-mac.md), [Installing the Windows
app](install-windows.md) and [Installing the Linux app](install-linux.md) for
removal.

A non-blank `MEDIA_SERVER_KEY_FILE` in the environment still wins, on the desktop
and in a container: the given path is used and nothing is created, read or
repaired there. That is how a portable or managed install can keep the key on a
mounted volume. See [Configuration](configuration.md) for the variable itself.

## First run, and what the app will not do

The application prepares the key before it starts the bundled server, so the
very first credential a user saves has a key waiting for it.

- On a genuine first run — no key, no stored credential — it writes a new
  32-byte key to the default path, atomically and owner-only.
- If a key already exists it is left byte-identical. A short, unreadable,
  malformed, differently owned, loosely permissioned or symlinked file is **not**
  repaired and **not** replaced: the app starts, and only the operations that
  need the key fail closed with `err.mediaServerKey`.
- If the key is missing but encrypted credentials already exist — a bound
  `secretRef` in the connection list, or any file in the vault — the app does
  **not** create a key. A missing key is never silently replaced with a fresh
  one that would leave the old tokens undecryptable.

Everything else keeps working when a key is missing or corrupt: the app boots,
lists whatever it can, and reports a clear message when a remote library cannot
be opened. Only the credential handshake is refused.

## Backup and recovery

Restoring working remote connections needs three independent pieces together:

1. the state file, `<userData>/instance/state.json`;
2. the encrypted vault, `<userData>/instance/media-server-secrets/`;
3. the key, `<userData>/media-server.key`.

Whoever holds all three holds the tokens, so treat that set as a credential.
The ordinary metadata-only backups — the settings backup and
`GET /api/media-servers/export` — carry none of the three on purpose and stay
safe to keep anywhere. See [Backing up and restoring](backup.md) and
[Remote media servers](media-server-management.md#backup-and-restore).

Losing or changing the key is not recoverable from the vault alone: the stored
references simply fail to decrypt. To keep them, restore the key from backup;
otherwise re-authenticate each connection, which writes fresh tokens under the
current key. The key is **never rotated automatically**, and the app will not
generate a replacement while encrypted tokens still exist.

## Reaching the app from another device

A desktop install follows the same address policy as the web app. The bundled
server listens on loopback unless the user turns on publishing, and a remote
Jellyfin or Emby address on the local network is refused unless the address
policy explicitly allows the LAN or loopback. Nothing about the desktop key
changes that: the rule is described under [Remote media
servers](media-server-management.md#deployment).
