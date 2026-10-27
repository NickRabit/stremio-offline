# Interactive source acquisition Stage 0 characterization

This lane characterizes the current per-hook interactive source acquisition before the shared
query-owner work in [#547](https://github.com/NickRabit/stremio-offline/pull/547). The separate
overall source-selection coverage stays with [#548](https://github.com/NickRabit/stremio-offline/pull/548);
this document does not close the overall Stage 0 gate.

Baseline: `origin/main` at `cebf6fa67633fbe0dff21ecb6e52b35b46f4f9e6`, observed on
2026-10-25.

## Named cases

- `useLibrarySources > characterizes duplicated request fan-out for two open subscribers of one subject`
- `useLibrarySources > keeps only the remaining subscriber's addon requests live when one unmounts`

Both cases mount two independent hook subscribers for the same catalogue, scope, authorized
libraries, origin library and open chooser. They use the public hook result and record the actual
`fetch` URLs and abort signals; no hook internals are mocked.

## Observed baseline

For two subscribers with two providers, the current implementation sends:

- two `GET /api/stream-sources/movie/tt5000` requests;
- four addon `GET /api/streams/...` requests, two for each provider key;
- two local-copy requests;
- two requests for the one authorized non-origin remote library.

Both subscribers receive all addon, local and remote rows. This duplication is a characterization
of today's behavior, not the desired Stage 2 contract.

When one of two subscribers unmounts while its addon lookups are unresolved, only that
subscriber's two addon signals abort. The remaining subscriber's two signals stay live, its late
addon rows arrive, and responses belonging to the unmounted subscriber do not appear in the
remaining subscriber's state.

Stage 2 should instead share the provider discovery and each provider/subject lookup, while keeping
last-subscriber cancellation: shared work should be aborted only after the final interested
subscriber leaves. A Stage 2 regression test should expect one shared request per
provider/subject rather than the duplicated counts above.

## Verification

| Command | Result |
| --- | --- |
| `npm test -w web -- src/library-sources.test.tsx` before the change | 23 tests passed |
| `npm test -w web -- src/streams.test.ts` before the change | 68 tests passed |
| `npm test -w web -- src/library-sources.test.tsx` after the change | 25 tests passed |
| `npm test -w web -- src/streams.test.ts` after restoring the mutation | 68 tests passed |
| `npm test -w web` | 88 files and 1,187 tests passed |
| `npm run build` | web and server builds passed |
| `npm test` | server, web, desktop and media-client suites passed |
| `node scripts/check-versions.mjs` | all manifests at `0.5.174` |

The focused tests were green before implementation. The initial `npm ci` in this isolated
worktree was needed because the hoisted dependencies were outside the worktree's writable root.

## Guard mutation

The existing `repickStream > leaves the source alone once the film is playing on it` test was used
for one temporary production mutation. The guard

```ts
if (state.playing) return { move: false };
```

was changed to `if (state.playing && state.pending < 0) return { move: false };` and this command
was run:

```text
npm test -w web -- src/streams.test.ts -t "leaves the source alone once the film is playing on it"
```

The test failed as intended with `expected { move: true, to: 'b' } to deeply equal { move: false }`.
The production file was then restored byte-for-byte. Its SHA-256 was
`c8ddbf1b495a890b573838e5963cb1bbb40b973d6060696ef9232c8a0e958a07` before and after the mutation,
and `git diff --exit-code -- web/src/streams.ts` reported no production diff.

## Still uncovered

- The `App.tsx` subtitle gate, which independently waits on stream and subtitle requests through
  `Promise.all` before addon rows.
- Cross-panel duplicate requests outside the two `useLibrarySources` subscribers.
- Active playback stability and playback position beyond the single `repickStream` guard mutation.
- An E2E fixture that counts acquisition requests.

Native E2E and Docker startup were not run because this lane changes tests and documentation only.
