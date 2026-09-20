# Accounts

The first screen of a fresh install asks for a name and a password and creates
the **administrator**. Everything after that is one instance shared by the
people in the household: an administrator adds an account per person, and
decides which libraries and addons each of them sees.

An account is a real identity, not a second interface. Its own addon order,
preferred languages, tile settings, favourites, watch history and resume
positions are kept apart from everybody else's, and its unfinished downloads
belong to it.

## Roles

| Role | What it may do |
| --- | --- |
| **Administrator** | Everything: accounts, settings, addons, libraries, the whole media tree. Sees every library and every addon by role. |
| **User** | Browse, search, play and manage their own rows. Sees only the libraries and addons granted to them, and downloads only if allowed. |

The gate is an allow-list, not a list of denials: an endpoint nobody has decided
about is administrator-only, so a route added later is closed until somebody
opens it on purpose.

An ordinary account still has a **Settings** page and a **queue**, but a smaller
one: the personal half of the settings — interface language, preferred audio and
subtitles, tile sizes and shapes, stream sorting, the title language for
downloads — and its own downloads. The instance's half, from secure mode and the
log level to the refresh interval, the default libraries and the API tokens, is
refused.

## What an administrator grants

Everything lives in **Settings → Users**, one row per account, opened as a
dialog:

- **Libraries.** An account sees the libraries ticked for it. A library it was
  not granted answers exactly as a library that does not exist — same status,
  same body — so the interface cannot be used to discover what is on the disk.
- **Addons.** An account may use only the addons ticked for it. Its catalogue,
  search and streams are built from those, and it can arrange their priority
  order for itself without changing anyone else's.
- **Downloads.** *Download to the library* lets the account queue files onto the
  server; *Save to this device* lets it save content to the device it is using.
  An administrator has both.
- **The account itself.** The role, whether it is enabled, and a new password.

Access is an explicit list: a library or an addon is reachable only where it is
ticked, and a library or addon created later arrives administrator-only. The
create dialog opens with everything ticked so the administrator clears what that
person should not have — the ticks apply the moment the account is created —
while an account created through the API with no lists reaches nothing. Of the
two download permissions, *Save to this device* is on for a new account and
*Download to the library* is off until it is ticked.

A right that is taken away takes effect at once. Changing a role, a permission,
an enabled flag or a grant list bumps the account's permission version, which
signs its other devices out of the affected work and stops live streams that were
relying on it — a library removed from an account mid-film does not keep playing
until the session happens to expire.

## Passwords and sessions

The password is stored only as a scrypt hash, and a session is a signed ticket
with the account's id in it, so a restart signs nobody out. Signing out of all
devices rotates that account's signing secret, and previously issued tickets
stop working at once. Changing your own password does the same for your other
devices; it does not disturb anybody else.

An administrator who sets somebody's password marks it **must change**: the
account is asked for a new one at its next sign-in, and its other devices are
signed out. The administrator never has to know the new value.

After five failed sign-ins from one address, further failures pause sign-in,
doubling from a second up to a minute; a success clears the record and the count
is forgotten after fifteen minutes. The cap stays low on purpose — behind a
reverse proxy every request arrives from the same address, so a long lock would
keep the household out as effectively as an attacker.

## Disabling and deleting

- **Disable** stops the account signing in and keeps everything it has: its
  history, its settings, its grants. Its unfinished downloads pause rather than
  being thrown away, so switching it back on resumes them.
- **Delete** removes the account and its watch history, and cancels its
  unfinished downloads. Files already downloaded stay in the library.

An instance needs at least one enabled administrator, so the last one cannot be
demoted, disabled, or deleted, and an administrator cannot delete the account
they are signed in with. Both refusals come back as `409` and change nothing.

## Recovering a lockout

See [Configuration → Account fallback](configuration.md#account-fallback).
`ADMIN_USERNAME` with `ADMIN_PASSWORD` seeds the first administrator of an
install that has never had one, and `ADMIN_PASSWORD_RESET` is the recovery path
for a forgotten password. Neither is a way to sign in on its own.

## Upgrading from one account

An install that predates accounts keeps working: the account it had becomes the
administrator, its preferences, favourites, history and resume positions move
into its own `UserData`, and the libraries and addons it could reach stay
reachable. `schemaVersion` goes to 3; see
[Troubleshooting → Rolling the image back](troubleshooting.md#rolling-the-image-back).

## Restricted mode

`RESTRICTED_MODE=1` is not a second user and not a role: it locks the whole
instance for a shared demo. Addons, settings, passwords and secret export become
read-only for everybody, the account list is visible and unchangeable, and
guests can still browse, play, download to the library and save to their own
device. Real separation between people is an account.
