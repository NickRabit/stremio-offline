# Project rules

The single set of rules for any coding agent working in this repository.
`CLAUDE.md` points here; do not duplicate content in it.

## Code style

- Write a minimum of comments. Only comment what is not obvious from the code
  itself; do not restate what a line already says.
- All comments, documentation and specifications must be written in English.
  Older files still contain Czech comments — translate them only when you are
  already editing that code.
- The interface is translated. Never put a user-visible string in a component:
  add it to `web/src/i18n/en.ts` and `cs.ts` and call `t("key")`. `cs.ts` is
  typed against `en.ts`, so a forgotten key fails the build. A message the
  server sends to the interface carries English text plus a catalogue key
  (`AppError`); one that only reaches the log stays plain English.

## Git workflow

- Write everything in English: commit messages, branch names, pull request
  titles and descriptions, and comments on issues or pull requests. Chat replies
  to the user stay in the language the user writes in.
- For every task, create a branch off `main`.
- Commit only into that branch. Never merge it into `main` and never push
  directly to `main`.
- After committing, push the task branch and open a pull request targeting
  `main`. Leave the merge to the user.
- Keep the pull request mergeable without the user's help. Before opening it,
  and again whenever another branch lands on `main`, `git fetch origin main`,
  rebase the task branch onto it and resolve every conflict yourself. Never
  leave a conflicting pull request behind, and never ask the user to resolve
  one. Two conflicts are routine: the version bump, where the branch takes the
  next patch after the one now on `main`, and `package-lock.json`, which is
  regenerated rather than merged by hand. Rerun the checks below on the rebased
  state -- a conflict resolved by hand is code nobody has run yet.
- When that pull request ships a user-facing feature or fix, bump the patch
  version in the same PR before opening it. Keep `package.json`,
  `server/package.json`, `web/package.json`, and `package-lock.json` in sync.
  Bump minor or major only when the user asks. Skip the bump for docs, rules,
  and other non-shipping work.

## After implementing

### Visual verification

- Defer UX and visual tests and screenshot or preview generation until implementation and functional checks are stable; run them once at the end of the task.

Deploy to the local Docker setup and verify the container comes up:

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=50 stremio-offline
```

The app listens on `http://localhost:${STREMIO_OFFLINE_PORT:-8090}`, health
endpoint `/api/status`, which must return `{"status":"ok",…}`.

## Useful commands

| Command | What it does |
| --- | --- |
| `npm run build` | Build the web and server workspaces |
| `npm test` | Server (`node:test`) and client (Vitest) unit suites |
| `npm run test:e2e:docker` | Playwright end-to-end suite in the CI image |
| `npm run dev:server` / `npm run dev:web` | Local dev servers |

## Where things are documented

| Topic | File |
| --- | --- |
| Test layers and what belongs where | [docs/testing.md](docs/testing.md) |
| Backlog and product direction | [docs/roadmap.md](docs/roadmap.md) |
| Environment variables | [docs/configuration.md](docs/configuration.md) |
| Accounts, roles and per-user access | [docs/users.md](docs/users.md) |
| Licences of what is distributed (FFmpeg, bundled packages) | [docs/licensing.md](docs/licensing.md) |
| Contributor workflow | [CONTRIBUTING.md](CONTRIBUTING.md) |

Some working documents are deliberately untracked (see `.gitignore`). Read them
if they exist locally, but do not add them to git.
