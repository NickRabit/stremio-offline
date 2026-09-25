# HTTP bridge protocol experiment

Executed 2026-09-24; report finalized 2026-09-25. This is supporting research for
[the implementation assignment](../../arr-integration-spec.md), not a shipped
integration or a production download client.

## Result

**Proceed with the Newznab/SABnzbd adapter design.** Unmodified Sonarr and
Radarr accepted a private NZB envelope, uploaded it to the probe, tracked an
HTTP transfer and imported the generated media. This happened for both an
interactive grab and an API-triggered automatic search from fresh containers.
Imported file hashes matched the HTTP fixture in all four cases.

| Component | Tested value |
| --- | --- |
| Host | macOS, Docker Desktop engine 29.7.2 |
| Sonarr | 4.0.20.3014, LinuxServer `4.0.20.3014-ls325` |
| Radarr | 6.4.4.10685 |
| Sonarr image | `lscr.io/linuxserver/sonarr@sha256:a5c1a5fecbef946927ab90ad68df319ac5fe644057e5fc18cd993f01ac07b2b2` |
| Radarr image | `lscr.io/linuxserver/radarr@sha256:adb6c09d6b729ea5e642c99cea35af72702ef476bf4763f153299ac5db9f0b4f` |
| Adapter | Python standard-library HTTP server, not Stremio Offline |
| SAB version response | Compatibility fixture string `4.5.5`; no actual SABnzbd instance |
| Media | Generated blue 1280×720 H.264 video, silent AAC audio, 1 fps, 1,200 seconds, 723,199 bytes |

Evidence: [assertion results](results.json) and
[deduplicated protocol transcript](transcript.json). The transcript retains
the first occurrence of each distinct event in chronological order and omits
local control polling, API keys and tickets. It is a compact observation log,
not a complete HTTP capture. `results.json` contains executable assertion
outcomes, not assertions inferred from a successful configuration test.

## What the test does

The probe runs two real *arr containers with private configuration directories,
loopback ports and a shared test-only `/data` volume. It creates a fake addon,
Newznab endpoint and SAB-compatible endpoint in one local Python process. The
addon returns the generated video's HTTP URL. The adapter fetches the addon
response and downloads that URL before exposing completed history.

Media metadata is looked up for Big Buck Bunny (TMDB 10378) and Breaking Bad
(TVDB 81189), episode S01E01. These are identity/parser fixtures only: **all media
bytes are generated locally**, not downloaded copies of either title. The
synthetic release names include known quality tokens to exercise *arr parsing.
The setup lowers quality minimum-size limits to zero because a static silent
fixture is tiny. Other import logic, including runtime/sample checks, still
runs. This does not validate ordinary quality-profile behavior or real addon
release-name accuracy.

The `complete` control deliberately holds jobs in a downloading state until
the driver releases them. Therefore queue visibility and completed import are
real client behavior, while scheduling/progress is a fixture. The adapter does
not reuse Stremio Offline's download queue, permission system or persistence.

## Verified behavior and implications

| Experiment | Observation | Implementation consequence |
| --- | --- | --- |
| Client/indexer configuration | Both validation endpoints succeeded with a real fixture result and explicit client binding | A supported compatibility configuration exists |
| Interactive selection | Both clients retrieved the envelope, uploaded multipart `name` and retained its reference | HTTP bridging through a private NZB envelope is feasible |
| Automatic search | `EpisodeSearch` and `MoviesSearch` selected and grabbed the result; both files imported | An *arr-initiated search can automate selection and download |
| Queue tracking | Both used `mode=queue`, `start=0`, `limit=0` and their category | Zero limit must mean all applicable queue entries |
| Completed history | Both consumed `bytes`, `storage`, category, name, status and `nzo_id` | Report the filesystem directory *arr can access |
| Cleanup acknowledgement | Both called history deletion with `del_files=1`, `archive=1` after import | Treat this as explicit scoped cleanup, not permission to delete arbitrary library paths |
| Invalid envelope | An `nzb` root without a `file` child failed in both apps before upload | Preserve the envelope structure; return protocol errors rather than JSON as NZB content |
| Empty feed | Both rejected indexer validation with an empty category-only response and `total=0`, even with RSS disabled | First-run setup needs a genuine cached result in each configured category |
| Missing size | Both exposed the release size as zero instead of refusing its XML | Unknown size is not a parser failure; normal profile eligibility is still unverified |
| Ticket-only download URL | Both retrieved the envelope without an integration key in its URL | Separate long-lived configuration keys from narrow download tickets |

The fixture's deletion operation only removes its in-memory job. The observed
client call and the movement of the media file are verified; secure recursive
cleanup by a production adapter is not.

### Additional failures found while developing the probe

The initial probe included its dummy indexer key in the download URL. Both
applications copied that URL into grab history. The final probe uses a separate
dummy ticket. Its constant ticket has no expiry or revocation; those are
explicit implementation requirements, not properties demonstrated here.

Reusing `ARR220-episode` as a new download ID after the first import caused
Sonarr to track the new row as already imported and delete it from the queue.
The final probe generates a new attempt ID after removal and preserves the
release GUID independently. These manual variants establish the failure mode;
the clean rerun covers successful re-downloads with distinct attempt IDs.

The directory `ARR220-episode-6a22bd82` triggered Sonarr's episode parser and
blocked import with an unexpected-episode warning. Moving the same file into
a child directory named after the selected release and reporting that child as
`storage` allowed import. The final probe always uses this nesting. This is a
reason to test path parsing, not a reason to disable the client's checks.

## Wire details observed

Sonarr searched with `imdbid=tt0903747&season=1&ep=1`. Radarr sent both
`tmdbid=10378&imdbid=1254207`. Accept IMDb IDs with and without `tt`; if multiple
IDs conflict, reject the mismatch rather than silently choosing one.

Both requested `t=caps` and a category-only `tvsearch`/`movie` request during
configuration. The response used categories 5000 and 2000 respectively. The
setup assigned `stremio-tv` and `stremio-movies` to the download clients and
bound each indexer using `downloadClientId`.

Client configuration exercised `version` and `get_config`. Absolute
`complete_dir` avoided the relative-path `fullstatus` branch; support for that
branch is still a source-derived requirement, not a tested claim. Empty server
and sorter lists worked. Queue sizes used MiB numbers and history size used
integer bytes. History polling requested 60 entries in this configuration.

The envelope is UTF-8 XML with the standard NZB namespace, a `head/meta` opaque
reference and a `file` containing a fixture group and segment. No real Usenet
server or message is involved. A production implementation must authenticate
the reference, reject foreign NZBs and never treat segment IDs as fetch URLs.

## Reproduce

Requirements: Docker Desktop on macOS, Python 3.9+ and FFmpeg on PATH, free
loopback ports 18880, 18989 and 17878, and internet access for container images
and *arr metadata lookup. This host networking recipe is tested on macOS only;
Linux needs a separate networking adaptation. The container setup follows the
[Sonarr](https://docs.linuxserver.io/images/docker-sonarr/) and
[Radarr](https://docs.linuxserver.io/images/docker-radarr/) image documentation.

From the repository root:

```sh
python3 docs/research/arr-bridge-probe/run.py
```

The script refuses occupied ports, creates a fresh temporary directory, prints
its location, starts containers with unique names and stops only those
containers and its own HTTP server in `finally`. It never attaches to existing
*arr installations or mounts the user's actual downloads. On interruption by
SIGKILL the cleanup cannot run; remove only the printed/created test containers.
The two images remain in Docker's cache.

The evidence directory is retained for inspection. It contains generated
configuration keys, fixture media and application logs; do not publish that
directory wholesale. Publish only reviewed/sanitized evidence. Matroska metadata
can change the fixture hash between runs; the assertion compares each imported
file against the fixture generated during the same run.

`bridge.py`, `api.py`, `configure.py` and `grab.py` are helpers used by the driver,
not independently deployable services. The driver sets `ARR_LAB_DIR`. The
protocol server binds loopback and intentionally has local unauthenticated
fixture/control routes, hard-coded media identities and in-memory jobs. Never
expose it publicly or copy it into the product as an implementation.

## Still required before shipping

- Connect the adapter to the actual Stremio Offline queue and destination model.
- Test real addon matching, expiring URLs, headers, unknown size/quality and
  permission-filtered initial-result preparation.
- Prove restart recovery, concurrent idempotency, interrupted writes, key
  rotation/revocation, safe cancellation and confined data deletion.
- Exercise a second unrelated indexer/client and verify routing coexistence;
  the probe only sets an explicit binding for its own indexer.
- Add real failure and pause transitions, limited history paging and retry
  behavior; this fixture covers only downloading/completed states.
- Validate shared-volume permissions with non-root containers, path remapping,
  reverse-proxy prefixes and authentication on production routes.
- Design actual ongoing release discovery. Automatic search commands are not
  a complete RSS/watch-list solution. Keep issue #220 open until its accepted
  automation scope is delivered.

The decision is **go for implementation**, not **ready to ship**.
