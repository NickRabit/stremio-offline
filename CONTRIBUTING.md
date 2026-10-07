# Contributing

Thanks for looking at Stremio Offline. This is a small, NAS-first project. Short,
focused changes are easier to review than large ones.

## Ground rules

- Open a pull request against `main`. Do not push to `main` directly.
- Work on a dedicated branch named after the change (`feat/…`, `fix/…`, `docs/…`).
- Write commit messages, branch names, pull request titles, and review comments
  in English.
- Keep comments in code to what the code cannot say on its own, also in English.
- Use only sources and accounts you have the right to access when testing.

## Development

You need Node.js 22 or newer. Docker is required to run the app the way it is
meant to run.

```bash
npm ci
npm test
npm run build
```

Local workspaces:

```bash
npm run dev:server
npm run dev:web
```

`npm test` runs the server (`node:test`), web (Vitest) and desktop
(`tsx --test`) unit suites. `npm run test:watch -w web` watches the client one.

End-to-end tests drive the built app in a browser against a fake addon:

```bash
npm run test:e2e:docker
```

That builds first and runs inside the same image CI uses, so it needs nothing
but Docker. With a browser installed locally (`npx playwright install
chromium`), `npm run test:e2e` is the faster loop.

A deliberate design change will fail the screenshot baselines. Regenerate them
with `npm run test:e2e:snapshots`, or run the **Update screenshot baselines**
workflow on the branch; do not regenerate them to make an unexplained diff go
away. See [docs/testing.md](docs/testing.md) for what belongs in which layer.

Docker is the primary runtime; check a change there before opening a pull
request:

```bash
cp .env.example .env
docker compose up -d --build
docker compose ps
curl -fsS http://localhost:8090/api/status
```

The health endpoint must return `{"status":"ok",…}`. Check recent logs with
`docker compose logs --tail=50 stremio-offline`.

## Pull requests

Use the pull request template. Say why the change exists, what you changed, and
how you verified it. Run `npm test` and, for anything that affects runtime
behaviour, rebuild the local container and hit `/api/status`.

User-facing features and fixes bump the patch version in the same PR
(`package.json`, `server/package.json`, `web/package.json`,
`desktop/package.json`, and `package-lock.json`). Docs and other non-shipping
work do not.

### Reviewing a high-risk change

A change that deletes or moves files, writes persistent state, checks who may
do what, reaches the network on a user's behalf, or runs a child process gets
one adversarial read after it is implemented, by someone (or an agent) who did
not write it. Ask of it, and answer in the pull request:

- **Actor and resource.** Whose rows or files does this read or write? Is the
  owner taken from the session, never from the request? Does a resource the
  caller may not see answer exactly like one that does not exist?
- **Two at once.** What happens when two requests, a request and a queued job,
  or a job and a download reach the same row or path together?
- **Before and after each side effect.** If the process stops between any two
  steps, what does the next start find, and does it finish, retry or refuse,
  never delete something it is unsure about?
- **Asked twice.** Is a repeated request or a replayed journal entry harmless?
- **Stale reads.** Is every value written inside a state update read from the
  state the write lands on, not from a read before an `await`?
- **Secrets.** Can a token, a password, a private URL or a backup payload
  reach a log line, an error answer or another account?
- **Abort and cleanup.** Who owns every process, timer, temporary file and
  placeholder this starts, and what ends it on failure, cancel and shutdown?

Each finding gets a regression test that fails before the fix. A green CI run
and agreement between reviewers are evidence, not proof.

Issues and pull requests are the right place for bugs, small features, and
documentation. Larger product questions belong in the [roadmap](docs/roadmap.md).
