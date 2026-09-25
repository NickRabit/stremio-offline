# Agent task: implement the first HTTP bridge for Sonarr and Radarr

Read `AGENTS.md`, [the specification](arr-integration-spec.md), and
[the experiment report](research/arr-bridge-probe/README.md) before editing.
The specification is the design contract; this file is its execution order.
Related to [issue #220](https://github.com/NickRabit/stremio-offline/issues/220).

## Goal

Make unmodified Sonarr and Radarr search supported HTTP sources from installed
Stremio addons, select one, queue it through Stremio Offline, and import the
completed media through a Newznab/SABnzbd compatibility adapter. Deliver a
usable, opt-in integration with clear setup and documented limitations.

The protocol path already works in the supplied disposable probe. Extend that
evidence to the real application. Do not mistake the probe's hard-coded source
matching, fake credentials, in-memory queue or control endpoints for reusable
production components. Do not implement unrelated SAB administration features.

## Execute in this order

1. **Inspect and establish the baseline.** Work in an isolated task branch from
   current `main`, preserve existing local changes, and identify changes since
   the specification's baseline. Run the probe on its documented host setup or
   explicitly adapt its networking. Record exact versions/image digests. Keep
   all test metadata and media isolated from live installations.
2. **Extract application seams.** Add external download destinations without
   changing normal library placement, completion or permissions. Persist
   integration/category/release identity within accepted queue jobs. Define
   attempts, terminal history and deduplication recovery together; do not add
   an independently committed mapping that can diverge after a crash.
3. **Implement narrow authentication and release records.** Add administrator
   integration setup, key creation/rotation and revocation. Bind access to an
   existing account and addon allow-list. Implement expiring envelope tickets
   and an authenticated private envelope; all provider URLs stay server-side.
   Re-check current grants on search, retrieval, upload and resumed work.
4. **Implement search and first-run preparation.** Resolve supported movie and
   numbered-episode IDs to eligible addon sources. Advertise only capabilities
   that really work. Create parseable releases with honest metadata and stable
   identities. Prepare genuine cached results in setup so category-only
   indexer validation can succeed without a fictional RSS feed. Document what
   happens when the chosen addon has no usable result.
5. **Implement the client lifecycle.** Support the tested SAB validation,
   multipart upload, queue/history polling and scoped removal operations.
   Include the zero-limit queue behavior, safe retries and terminal failures.
   Publish completion only after finalization and report a release-named
   directory below the attempt directory. Never replace the chosen source with
   another quality/language without *arr making a new selection.
6. **Prove the real integration.** Replace the probe adapter with Stremio
   Offline in the harness. Assert a movie and episode through both interactive
   grabs and automatic search commands, HTTP transfer and import, with file
   hashes. Add restart, duplicate requests, re-download, stale source, permission
   withdrawal, failed transfer and deletion-boundary scenarios. Add a second
   unrelated indexer/client to test routing coexistence.
7. **Finish setup UX and documentation.** Translate all visible strings in
   English and Czech, show connection values and explicit client binding,
   explain shared mounts and staging, and state supported media types and
   versions. Keep RSS disabled until release discovery exists. Run visual
   checks once after functional stability.
8. **Deliver under repository rules.** Run applicable build/unit/end-to-end
   checks, deploy the implementation to local Docker and verify health/logs,
   bump the synchronized patch version, rebase onto current `origin/main`,
   rerun affected checks and open a mergeable PR. Do not merge or close #220 on
   the strength of search support alone.

## Mandatory review points

- A cached release ID is not a download attempt ID. A later intentional
  re-download gets a new attempt; transport retries of accepted work do not.
- The client retains download URLs in history. Do not place a long-lived key,
  provider address or headers in them. Test expiry and key rotation.
- Sonarr parses directory names. Random attempt identifiers belong above the
  release-named directory reported as completed `storage`.
- Empty results can prevent initial configuration even with RSS disabled.
  Test preparation, changed grants, source expiry and retrying that setup.
- Missing size becomes zero in the tested clients. Prove behavior under normal
  quality profiles rather than inheriting the probe's zero minimum-size limits.
- Removing history is not permission to delete a final media library. Filesystem
  containment must survive symlinks, moved files, retries and cancellation races.
- Exported app configuration, request logs and evidence must not accidentally
  disclose integration secrets. Authentication must not bypass ordinary routes.

## Boundaries and final report

The first release covers direct HTTP(S) movie files and single standard
numbered episodes. Native torrent resolution, Real-Debrid `infoHash` handoff,
season packs, anime/daily numbering, HLS/DASH and continuous release discovery
are follow-ups unless an explicit scope change is made. An already-resolved
HTTP URL from a debrid addon is an ordinary HTTP candidate.

If a production compatibility assumption fails, report the observed request,
response and smallest design correction. Do not hide it by disabling *arr
validation or silently widening scope. Routine implementation decisions do not
require another approval.

The delivery report must list implemented behavior, exact tested versions,
results of the acceptance scenarios, remaining limitations and the PR link.
Distinguish an automatic search command from continuous unattended monitoring,
and distinguish the disposable protocol evidence from application tests.
