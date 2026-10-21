# Improve Offline parsing using lessons from the addon indexer

Status: implementation brief, rewritten after validation of PR #499 on 2026-10-21.
**Keep both projects' implementations separate.** The addon indexer is already
tuned; a rejected match can be preferable to a false identity or false grouping.
No addon modification, shared package, PTT dependency or index migration belongs
in this work. The existing filename remains so links to PR #499 keep working.

Goal: improve specific Offline release-name interpretations without weakening
matching thresholds or changing established library identities. Borrow verified
rules and regression cases, not the indexer's whole parser or acceptance policy.
The [validation report](shared-release-parser-validation.md) records revisions,
measurements and limitations. Disagreement counts do not measure match accuracy.

## What to take, adapt and leave behind

Source reference: addon `src/indexer/parse.js` at
`e2647d7641869b55abb1c175e6382a3ae73c0b73`. Symbol names, not line numbers,
identify the rules. Recheck the relevant source if that revision changes.

| Indexer mechanism | Decision for Offline | Reason |
| --- | --- | --- |
| NFC normalization in `parseName`; Unicode boundaries in language patterns | Adopt the technique, with local regression tests | Accented/composed spellings must not change interpretation |
| `extractLanguages`, `SUB_PAIR`, `AUDIO_PAIR`, `ROOTS`, `AMBIGUOUS` | Adapt a narrow phrase-cleaning subset | A language next to a dub/subtitle marker is stronger evidence than a standalone title word |
| `ASPECT_RATIOS`, `isAspectOrSize` | Adapt exact written-ratio guards only | `16x9` and `16x09` carry different evidence; numeric upper limits reject legitimate long-running series |
| `isChannelCodec`, `CHANNEL_CODEC` | Keep as a negative-test design pattern | Context distinguishes audio+codec from `Show 1x265`; do not broaden accepted episode syntax as part of this work |
| Head/tail separation in `parseName` and `episodeSplit` | Adapt after an accepted explicit episode marker | Series search should use the show, while episode evidence retains the tail |
| `PACK_IN_NAME`, `AMBIGUOUS_PACK`, `SERIES_CUE` | Defer to a separate season-label task | Offline already has folder-season semantics; recognizing a pack cannot fabricate an episode or alter grouping casually |
| Anchors in `camRelease` / `isAnchor` | Adapt later, only for title cleanup | `Film 2020 CAM` differs from the movie title `Cam 2018` |
| `tidyTitle`, `isJunkTitle` minimum-length and Latin-oriented rejection | Do not port | Offline preserves `V` and non-Latin titles; indexer abstention is a separate policy |
| Bare `dabing` implies Czech audio | Do not port | `ParsedMedia` has no audio-language contract and filenames do not prove tracks |
| Trailing single capitalized word after language marker is an uploader | Do not port | `Film CZ dabing Návrat` loses `Návrat` in the addon; a generic library cannot assume it is a handle |
| `PART_IN_NAME` implies season 1 | Do not port | `díl`/`část` can identify a movie installment; Offline distinguishes installments from physical segments |
| `season > 30` / `episode > 999`, breaking on the first ratio | Do not port | Executed `Show 31x02` loses structure in the addon; a ratio before `S02E03` can hide the explicit marker |
| `restoreClippedLetter`, `completeFromName`, `seriesAfterLeadingMarker`, PTT episode-range repairs | Do not port | These repair upstream-parser or source-specific behaviour Offline does not inherit |
| `nominalClass`, extension allowlists, grouping and candidate acceptance | Keep in their current projects | Measured resolution, playable types and identity acceptance are not generic title cleanup |

## Existing Offline boundaries to preserve

`parseMediaName(name: string): ParsedMedia` and
`parseMediaPath(relative: string): ParsedMedia` retain their public signatures.
`ParsedMedia` retains title/query, optional year/country/season/episode/fileTitle
and provider hints. No new language, confidence, kind or pack fields are needed
for the first three tasks below.

- Keep `extractHints` ahead of destructive cleanup and retain its current ID rules.
- Preserve `takeYear` and #498's numeric-title/multi-episode regressions. Do not
  replace the whole parser with an indexer-derived year heuristic.
- Keep `bilingualQuery`, `titleSides`, `titleVariants`, `partSignature`,
  `stripPartMarkers`, `stripSegmentMarkers`, `isPackagingFolderName` and
  `subjectName`/`parseMediaPath` folder semantics.
- Preserve `parseUnit`'s folder-first and single-sample-file fallback behaviour.
- Title evidence may improve suggestions; automatic binding still requires current
  candidate/episode evidence and thresholds. No forced rematch or weakened score.

## Task 1 — reject proven aspect-ratio episode false positives

Start here: the defect is reproduced in three paths. `Film 16x9.mkv` currently
becomes S16E9 through `parseMediaName`, `numberedEpisode` and `diskEpisodes`.
The sweep must cover every explicit `NxM` reader, not just the parser's regex.

Targets:

- `server/src/library-parse.ts`: `X_EPISODE`, `parseMediaName`.
- `server/src/library.ts`: `CROSS_EPISODE`, `episodeTag`, `numberedEpisode`.
- `server/src/library-episodes.ts`: `CROSS_EPISODE`, `episodeTitle`, `diskEpisodes`.
- Corresponding `library-parse`, `library`, `library-episodes`, `library-match`
  and `library-scan` tests; enumerate additional readers with `rg` before editing.

Define one internal pure predicate for the written `NxM` token, placed in a
small dependency-free helper if needed to avoid the existing `library-parse` →
`library` import cycle. It must preserve leading zeroes and recognize only the
exact documented ratio forms (`16x9`, `4x3`, `21x9`, `5x4`, `3x2`, `9x16`,
`3x4`, `16x10`) case-insensitively. Do not add spaces to the accepted episode
grammar merely because the indexer accepts them. Colon ratios need no `NxM` fix.
Reject the interpretation as an episode; this task need not strip the token from
the title. `60x60` remains an unresolved size/episode ambiguity, not a justification
for copying arbitrary season limits.

Required checks:

- `Film 16x9` and `Film 4x3` have no explicit episode; `diskEpisodes` must not
  recreate one through its loose-number fallback. Test both loose modes and
  a season-folder context; do not change unrelated loose numbering.
- Preserve `Show 1x03`, `Show 16x09`, `Show 31x02`, `Show 1x265`, season 0 and
  explicit `SxxExx` markers, including existing multi-episode handling.
- `Film 16x9 Show S02E03` still yields S2E3. Do not copy the addon's early break.
  A rejected ratio must not prevent considering a later valid marker.
- `Film DDP5.1 x265` and `Film AAC 2.0 x264` remain non-episodes. Do not create
  a new syntax or a number cap to fix a shape Offline already rejects correctly.
- Numeric movie title `10x10` is a separate ambiguous-title case; do not silently
  change it under the aspect-ratio fix.

## Task 2 — clean explicit Czech/Slovak language phrases

Targets: `library-parse.ts` (`parseMediaName`, `stripPhrases`,
`stripDottedQuality`, `QUALITY_PHRASES`) and parser/candidate/matcher tests.
Use a pure local phrase cleaner before punctuation collapse and token removal,
after provider-hint extraction and country-tag capture. Normalize NFC at the
parse entry without changing the original input stored outside the parser.

Initial scope: explicit combinations of Czech/Slovak language and `dabing`,
`znění`/`zneni`, `titulky`; include the verified common spellings rather than
importing every language alias, bare fence or uploader rule. Match whole Unicode
words and bounded separators, longest phrases first. Subtitle expressions are
consumed as a whole, never converted into audio facts. Existing generic token
cleanup remains under regression coverage.

Required expectations:

- `Film cesky dabing`, `Film český dabing`, `Film ČESKÉ ZNĚNÍ`,
  `Film slovenský dabing`, `Film CZ-titulky` → title/query `Film`.
- NFC and NFD forms produce equivalent outputs.
- Preserve `Český sen`, `Slovenský příběh`, `It dabing 2017` → title `It`,
  `Мишка 2019`, `V S01E03`, and title words containing language-like substrings.
- `Film CZ dabing Návrat` retains `Návrat`; do not strip a presumed uploader.
- Preserve country `(US)`/`(UK)`, provider hints, bilingual titles, year and episode
  structure on combined cases. Include negative tests where phrase-like words
  form the actual title; if inherently ambiguous, keep the text instead of guessing.
- Do not introduce audio filtering or infer Czech audio from bare `dabing`.

## Task 3 — separate show title from episode title

Targets: `library-parse.ts` (`parseMediaName`, `TAGGED_EPISODE`, `X_EPISODE`),
`library-match.ts` (`parseUnit` tests), `library-candidates.ts` (query tests), and
`library-episodes.ts` (`episodeTitle`, `diskEpisodes` regression tests), and
`library.ts` (`episodeTag`) where range-marker boundaries must agree.

Use only an episode marker accepted by the existing grammar plus Task 1 guards.
Extract its position while original separators remain available. Read year/provider
metadata without discarding it when the title tail is cut. If a nonempty show
prefix exists, use the cleaned prefix as title/query; episode title after the marker
is not part of the show search. Keep existing first-episode semantics of #498;
expanding episode membership is a separate feature, not required for cleanup.

- `Show.S02E03.Episode.Title` → title/query `Show`, S2E3.
- Consume the full existing multi-episode marker before selecting the tail.
  `Show.S01E01-E06.mkv` currently exposes the false episode title `E06`; it must
  expose no episode title. `Show.S01E01E02.mkv` currently produces no disk episode
  because `library.ts` does not accept the concatenated suffix: align its first-
  episode recognition with #498 without inventing complete episode membership.
- `diskEpisodes(['Show.S02E03.Episode.Title.mkv'])` still exposes episode title
  `Episode Title`; otherwise catalogue confirmation loses useful evidence.
- Preserve bilingual show prefixes, one-letter and Unicode show names, provider
  hints, country evidence, and `Blade.Runner.2049.2017`.
- Keep marker-leading names such as `S02E03.Episode.Title` on their existing
  fallback for this task; there is no evidence that `Episode Title` names the show.
  Do not promote this fallback to stronger automatic-match evidence or import the
  indexer's special leading-`m` rule.
- Test folder units, loose files and one-sample-file fallback through `parseUnit`.
  Movie parts/segments and names with no accepted episode marker stay unchanged.

## Later tasks requiring their own evidence

**Season labels:** study `library.ts`'s existing `parseSeason`, `seasonWordForm` and
unit grouping before adapting pack rules. `Show.S01.COMPLETE` and `Show.Season.3`
are useful leads, but `Film S3 1080p` is ambiguous. An output with a season and no
episode must not become a phantom playable episode. Verify loose-number fallback
in `diskEpisodes`, which currently reads `Show.Season.3.mkv` as episode 3 when
called in series context. This is not proof that ordinary scanning classifies it
as a series. Do not mix this change into Task 3.

**Release-source tails:** use the anchor idea from `camRelease` to distinguish
`Film 2020 CAM` from `Cam 2018`. Original positions matter because Offline removes
years before final token cleanup. Avoid unconditional CAM/TS/TC blacklist entries
and broad uploader/site stripping. Add a task only with positive and negative labels.

**Country validation and numeric-title ambiguity:** independently investigate
`COUNTRY_TAG` accepting `(HD)`/`(EN)` and year-only titles. Preserve existing
behaviour until a dedicated change has justified expectations. Do not use this
brief as authorization for a broad parser rewrite.

## Delivery and acceptance

Implement Tasks 1–3 sequentially in separate small PRs; they overlap parser code.
This PR only establishes the brief and evidence. No parsing implementation is
included. Before each implementation, write the exact local helper signature and
reviewed test cases from the target symbols; report contradictions rather than
guessing. A helper not yet present must never be described as existing.

For every shipping change:

1. Run targeted parser, library, candidate, episode, matcher and scanner tests.
   Preserve all existing fixtures unless a deliberate correction is independently
   justified. Add negative cases, not only the names that motivated the fix.
2. Compare affected real library units through `parseUnit` using a read-only
   snapshot. Replay cached catalogue responses where available; otherwise state
   that identity impact is unverified. Review false matches and abstentions
   separately; more nonempty titles are not an acceptance criterion.
3. Require zero new false automatic bindings on reviewed cases. Preserve existing
   bindings and dismissals. Normal scans skip bound units; `MATCH_RULE_VERSION`
   concerns eligible suggestion memory, not automatic reassignment of bindings.
4. Run build/unit gates, Docker e2e for affected flows, local Docker health check
   and the repository's patch-version/rebase/PR workflow. Do not modify the addon.

Share publication-safe regression examples and reasoning between projects. Keep
runtime code and acceptance policies independent. Reconsider a package only under
a separate decision supported by measured maintenance cost and identity precision.
