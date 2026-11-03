# Security Policy

## Supported versions

The latest code on `main` and the most recent GitHub Release are supported.
Older tags, ad-hoc images and desktop builds that did not come from a release
are not.

## Reporting a vulnerability

Do not open a public issue for a problem that could expose a NAS or a
computer running the desktop app, session cookies, or tokens stored in addon
URLs.

Use [GitHub private vulnerability reporting](https://github.com/NickRabit/stremio-offline/security/advisories/new)
instead. If that form is unavailable, contact the maintainer through GitHub.

Please include:

- the version: image tag, app version or git commit
- the deployment (Docker Compose, Synology Container Manager, macOS app, Windows app, other)
- steps to reproduce
- the impact you expect

You should hear back within a week. A fix, a workaround, or a reason it will
not be treated as a vulnerability will follow once the report is understood.

## Automated checks

- GitHub secret scanning checks for supported credential patterns and push
  protection can stop a detected secret before it enters the repository.
- GitHub CodeQL scans the JavaScript and TypeScript workspaces through the
  default code scanning setup.
- A weekly workflow builds the final runtime image and scans its operating
  system packages and bundled libraries with Trivy. Fixable `HIGH` and
  `CRITICAL` findings fail the workflow after the SARIF report has been
  uploaded to code scanning.

Review findings in **Security -> Code scanning**. Do not copy exploit details,
secret values or sensitive source excerpts into public issues, workflow
summaries or ordinary artifacts. Suppress a finding only with a narrow scanner
rule that records the reason, owner and review or expiry date. A scanner
failure or an incomplete upload is not a clean result.

The current baseline covers JavaScript and TypeScript in CodeQL and a freshly
built `linux/amd64` runtime image in Trivy. It does not cover Kotlin, Swift,
GitHub Actions, the arm64 image variant or the exact digest published by the
release workflow. The Trivy policy excludes unfixed vulnerabilities and fails
on every remaining `HIGH` or `CRITICAL` finding; it does not distinguish a new
finding from one that already existed.

To update the scanner, review the Trivy action release and its pinned setup
dependency, update the action commit and commented version, review the selected
Trivy version and its release notes, then run **Security scan** manually before
merging. The vulnerability database updates on every run. GitHub can delay a
scheduled run or disable schedules after a period without repository activity,
so maintainers should also run the workflow manually after quiet periods and
check the latest successful run.

## What this project is careful about

- Addon code never runs here. The server only reads JSON APIs.
- Manifests and streams that point at private networks are blocked unless you
  set `ALLOW_PRIVATE_ADDONS=1` or list hosts in `ALLOW_ADDON_HOSTS`.
- There is no default account. The first visitor creates one; the desktop app
  accepts that only on the computer it runs on. Passwords are stored as scrypt
  hashes.
- Session cookies become `Secure` when the server sees HTTPS
  (`X-Forwarded-Proto: https`). Do not publish the app on the open internet
  over plain HTTP.
- Logs keep stream URLs down to scheme and host. Tokens and passwords are not
  written.

Reports about SSRF, authentication bypass, cookie theft, path traversal, and
token leakage are especially useful.
