# Desktop end-to-end scenarios

Playwright drives the development app through `_electron`: the real main process, the real
renderer bundles and the real staged backend. No dialog, folder picker or Trash is touched --
the tests monkeypatch `dialog.showOpenDialog`, `dialog.showMessageBox` and `shell.trashItem`
inside the main process, and each test gets its own `--user-data-dir` under a temp folder.

## Running

The tests need the workspace built and the backend staged first:

```bash
npm run build            # web and server
npm run build -w desktop
npm run build:renderer -w desktop
npm run stage:local-backend -w desktop
npm run test:e2e -w desktop
```

Run one file with `npm run test:e2e -w desktop -- close.spec.ts`.

## In CI

`.github/workflows/desktop-package.yml` runs the same suite on `ubuntu-latest` under
`xvfb-run`, with `ELECTRON_DISABLE_SANDBOX=1` for the runner's user-namespace restriction.
Only the Linux close behaviour runs there; the macOS and Windows branches are skipped by the
tests themselves.
