# Shared parser validation — 2026-10-21

Decision: **retain separate implementations and defer the shared package**.
The owner prioritizes preserving the tuned addon indexer, where abstention may be
preferable to a false match. Validation found useful ideas for isolated Offline
fixes, but no measured identity-precision benefit that justifies a shared migration.
This review is not a production accuracy claim.

## Reproducible measurement

Inputs: Stremio Offline `9af1ac10523813d2f2dd95f7f149ce39f88035ee`, addon
`e2647d7641869b55abb1c175e6382a3ae73c0b73`, installed PTT `0.9.1`, Node
`22.23.3`. Original proposal: PR #499 at
`b03e37649c6eeca4ccd898b3b058de8d1694b042`.

After installing each repository's locked dependencies, run from this checkout:

```sh
node --import tsx scripts/compare-release-parsers.mts /path/to/my-pleassure-addon
```

The script reads string literals containing a video extension in four addon tests
(`indexer-parse`, `release`, `filename`, `indexer-episode-name`), normalizes NFC
and deduplicates. It compares Offline `parseMediaPath` (which removes extensions)
with addon `parseNameWithLibrary` using the real installed PTT. Title comparison
folds case/diacritics and punctuation to spaces while retaining Unicode letters.
Missing numbers compare as null. It emits aggregates only, never private names.
The extraction deliberately has a narrow definition: literals may include expected
values and synthetic cases; dynamic inputs, extensionless names and non-video
inputs are not comprehensively covered. It is not the future labelled corpus.

| Measurement | Result |
| --- | ---: |
| Video-shaped string occurrences | 292 |
| Unique names after NFC | 262 |
| Duplicate occurrences | 30 |
| Agreement on title, year, season and first episode | 99 |
| Disagreement on any of those fields | 163 |
| Title disagreement | 157 |
| Year disagreement | 3 |
| Season disagreement | 23 |
| First episode disagreement | 18 |
| Season or episode disagreement | 23 |
| Empty normalized title, Offline / addon | 9 / 17 |

Field counts overlap. Empty titles are not scored errors: the indexer may correctly
abstain when the alternative is a false identity. No match-precision comparison
was performed here. The original 259/160 figures are not reproduced under this
explicit extraction; do not silently replace them with an accuracy percentage.
DeepSeek independently produced the same 262/99/163 totals using Babel AST
extraction. The checked-in runner uses the repository's existing TypeScript
compiler dependency and was rerun by the lead reviewer.

## Executed counterexamples

These minimal examples illustrate specific behaviour, not corpus-wide correctness.
Offline here means `parseMediaName` on extensionless release labels; the aggregate
runner above uses the extension-stripping path adapter.

| Input | Offline | Addon | Consequence |
| --- | --- | --- | --- |
| `Film cesky dabing` | title `Film cesky` | title `Film`, audio `cs` | Useful language cleaning |
| `Example.S02E03.Episode.Title` | title retains episode title | title `Example` | Useful series cleaning |
| `Film 16x9` | S16E9 | no episode | Useful false-positive guard |
| `Example.S01.COMPLETE` | season text remains in title | S1, season pack | Useful pack recognition |
| `Мишка 2019` | title preserved | empty title | Lost lexical evidence; index rejection may be intentional |
| `V S01E03` | title `V` | empty title | Lost lexical evidence; index rejection may be intentional |
| `Blade.Runner.2049.2017` | title `Blade Runner 2049`, year 2017 | title `Blade Runner`, year 2017 | Numeric title regression |
| `2012 cz dabing` | empty title, year 2012 | title `2012` | Year-shaped titles need explicit labels |
| `Example S01E01E03` | first episode 1 only | first 1, count 3 | Neither exposes correct explicit membership |
| `The Office (US)` | country `US` | no country field | Adapter/core must retain evidence |

## Local data check

A read-only pass over the keys of the three local `data/library/lib_*.json`
metadata maps found 22 rows and 19 distinct basenames. Comparing the basename with
both parsers changed one normalized title and no year/season/episode. No data was
written or sent to a catalogue. Private paths and names are intentionally omitted.
The procedure reads each map's `meta` keys, takes the final slash-delimited component,
and compares `parseMediaName` with `parseNameWithLibrary`; title normalization folds
case/diacritics and removes non-letter/non-number characters.
This sample consists of stored bindings; it is not an inventory of current files,
a `parseUnit` replay, or an independently labelled holdout. Its limited coverage
is why the specification requires a proper adapter/identity replay before rollout.

## Material corrections

1. **High — binding migration.** `scanSkipReason` and
   `LibraryScanner.processUnit` skip existing bindings on normal scans. The
   proposal's automatic-rematch statement was false. Preserve bindings and make
   future rechecks explicit. `needsReevaluation` uses `MATCH_RULE_VERSION` for
   suggestion memory and preserves dismissals.
2. **High — information loss.** A first episode and a count cannot represent
   non-contiguous membership. Any future common contract would need explicit episodes and conservative
   treatment of multi-season/invalid ranges; no indexer change is planned.
3. **High — consumer contracts.** The addon has two distinct parsing paths:
   `src/indexer/parse.js` and `src/release.js`. `sources/nas.js` and
   `sources/webshare.js` use the latter; WebShare also uses `searchQuery`.
   A one-line import replacement would discard fallback/query semantics. Keep
   wrappers and enumerate all helper consumers before extraction.
4. **Medium — evidence and policy.** A missing season is not evidence of a movie;
   a year-sized token is not always a release year. Preserve unknown evidence,
   Unicode, numeric titles, country and provider IDs. Keep catalogue search policy
   in adapters. Addon's CAM classifier is a separate helper, not currently a
   field returned by `parseNameWithLibrary`.
5. **Medium — reproducibility.** Disagreement counts need pinned revisions and
   extraction rules. Independently reviewed labels, ambiguity denominators and a
   separate holdout are required to claim correctness improvements.

The user clarified that the addon originates in an indexer where abstention may
be preferable to a false match. The final decision keeps implementations separate and preserves the tuned indexer.
Any reconsideration must measure identity precision/abstention in addition to
lexical behaviour. Restoring a title must not automatically make a file indexable.

The pure parsing boundary, keeping identity matching in consumers, and preserving
Offline's folder/part/title-variant helpers are sound. Public package delivery
would avoid credentials in anonymous builds. Synchronous CJS consumption still
needs a real packed-artifact smoke test because installed PTT exposes ESM imports.

## Verification and limits

- Offline: 206 passing tests across `library-parse`, `library-match`,
  `library-candidates`, `library-episodes`, and `library-scan`:

  ```sh
  node --import tsx --test server/src/library-parse.test.ts server/src/library-match.test.ts server/src/library-candidates.test.ts server/src/library-episodes.test.ts server/src/library-scan.test.ts
  ```

- Addon: 85 passing tests across the four extraction source files (DeepSeek run, independently rerun by the lead):

  ```sh
  node --test test/indexer-parse.test.js test/release.test.js test/filename.test.js test/indexer-episode-name.test.js
  ```

- Both counts validate current implementations, not a shared parser that does not
  exist yet. No new package, production adapter, index migration, public corpus,
  or labelled holdout was built in this task. These would be prerequisites only if sharing is reconsidered.

- DeepSeek also ran `node --test test/indexer-golden-night.test.js`: one test passed.
  This confirms the existing replay, not a migration.

## Transfer investigation after the scope decision

The owner requested an Offline-only brief based on indexer lessons. DeepSeek
inspected the source again; the lead narrowed its recommendations and reproduced
the relevant cases on the pinned current-main worktree. The follow-up worker had
read the older main checkout (`afaa7508`), so its conclusions were not accepted
without current-main checks, especially around #498's multi-episode changes.

Run the public synthetic matrix (28 names) with:

```sh
node --import tsx scripts/probe-release-parser-transfer.mts /path/to/my-pleassure-addon
```

It emits parser outputs plus `numberedEpisode`, `diskEpisodes` and `partSignature`
results. These are observations, not assertions that either parser is the oracle.
Key independently reproduced findings:

- `Film 16x9` becomes S16E9 through all three Offline number-reading paths;
  guarding only `parseMediaName` would leave the class partly unfixed.
- `Show 16x09`, `Show 31x02` and `Show 1x265` retain valid explicit structure
  in Offline. The addon rejects `31x02`, so its upper bound is not transferable.
- `Film 16x9 Show S02E03` is S2E3 in Offline but has no season/episode in the
  addon. Do not port its early break after a ratio.
- `Film CZ dabing Návrat` retains `Návrat` in Offline and loses it in the addon.
  The upload-handle heuristic is inappropriate for general library cleanup.
- `Film 2.díl` receives S1E2 in the addon; Offline does not infer that structure.
  Neither filename alone proves whether this is an episode or a movie installment.
- `Show.S01E01-E06.mkv` currently produces episode title `E06` in Offline's
  `diskEpisodes`; the range endpoint must not be mistaken for an episode name.
  `Show.S01E01E02.mkv` yields no disk episode even though the current title parser
  accepts its first episode. The brief explicitly covers both readers.
- `Show.S01E03.Pilot.TVRip.mkv` retains `TVRip` in episode-title evidence. This
  is a later, separately labelled tail-cleanup candidate, not permission to strip
  arbitrary words after episode markers.

Rejected recommendations: arbitrary season/episode caps, a broad language-hint
API, bare-dubbing language inference, global `díl` conversion, upstream-specific
repairs and an immediate CAM hint field. The final brief keeps current Offline
interfaces and sequences three bounded tasks before season/source-tail research.

Docker verification was attempted with an isolated container and empty scratch
volumes on port 18094. The build stalled resolving the pinned base image for over
four minutes and was cancelled; no validation container was started. Existing
running installations and their data were not redeployed. This documentation/tool
change has no application runtime or version bump.
