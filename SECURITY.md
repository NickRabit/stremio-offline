# Security Policy

## Supported versions

The latest code on `main` and the most recent GitHub Release are supported.
Older tags and ad-hoc images are not.

## Reporting a vulnerability

Do not open a public issue for a problem that could expose a NAS, session
cookies, or tokens stored in addon URLs.

Use [GitHub private vulnerability reporting](https://github.com/NickRabit/stremio-offline/security/advisories/new)
instead. If that form is unavailable, contact the maintainer through GitHub.

Please include:

- the image tag or git commit
- the deployment (Docker Compose, Synology Container Manager, other)
- steps to reproduce
- the impact you expect

You should hear back within a week. A fix, a workaround, or a reason it will
not be treated as a vulnerability will follow once the report is understood.

## What this project is careful about

- Addon code never runs here. The server only reads JSON APIs.
- Manifests and streams that point at private networks are blocked unless you
  set `ALLOW_PRIVATE_ADDONS=1` or list hosts in `ALLOW_ADDON_HOSTS`.
- There is no default account. The first visitor creates one. Passwords are
  stored as scrypt hashes.
- Session cookies become `Secure` when the server sees HTTPS
  (`X-Forwarded-Proto: https`). Do not publish the app on the open internet
  over plain HTTP.
- Logs keep stream URLs down to scheme and host. Tokens and passwords are not
  written.

Reports about SSRF, authentication bypass, cookie theft, path traversal, and
token leakage are especially useful.
