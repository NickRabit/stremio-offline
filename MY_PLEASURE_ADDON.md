# `My Pleasure Vol. 1` — search answers HTTP 500

| Field | Value |
| --- | --- |
| Date | 2026-09-15 |
| Reported from | Stremio Offline server log, a real session against a Synology instance |
| Addon | `My Pleasure Vol. 1` |
| Catalog | `mpa-xhamster` |
| Symptom | `GET .../catalog/…/mpa-xhamster/search=…` answers **HTTP 500** |

## What the log shows

Two identical failures, six seconds apart, during a library scan that was
looking up a film title:

```
06:23:30.168 WARN Addon request failed
  {"operation":"search","addon":"My Pleasure Vol. 1","catalog":"mpa-xhamster",
   "query":"Cocaine Bear","reason":"The addon answered HTTP 500."}

06:23:36.043 WARN Addon request failed   (same fields)
```

Nothing else in the session failed: the other installed addons answered the same
query without complaint, and the scan went on to match the title through one of
them.

## Why it is worth fixing rather than ignoring

The query is a mainstream film title arriving at an adult-content catalog, so
**finding nothing is the expected outcome**. The Stremio addon protocol has an
answer for that, and it is not a 500:

```json
{ "metas": [] }
```

returned with `200`. A 500 says *the addon broke*, and the difference matters to
whatever is calling it:

- **A client cannot tell "no results" from "this addon is unwell".** Stremio
  Offline logs it as a failure, which is noise on every search that happens to
  reach this catalog — and this catalog is reached by every global search.
- **Repeated 500s trip the outbound circuit breaker.** Stremio Offline guards
  each addon host: consecutive failures take the host out of service for a
  cooldown that doubles each time. An addon that 500s on ordinary
  no-result searches can end up suspended for searches it *would* have answered.
- It happens twice per search here, because the scan and the user-facing search
  both reach it.

## What to look at

Without the addon's source I can only say where the shape of the bug usually is,
so treat this as a list to check rather than a diagnosis:

1. **The no-results path in the `catalog` handler for `mpa-xhamster`.** The most
   common cause is an upstream response that is empty, or shaped differently when
   there are no hits, being passed to something that assumes an array — a
   `.map`, a destructure, a `results.length`. Return `{ metas: [] }` explicitly.
2. **The query itself.** `Cocaine Bear` is two plain ASCII words, so encoding is
   unlikely to be the trigger — but check what the handler does with a query that
   the upstream rejects or answers with an error page rather than JSON.
3. **Whether the upstream was simply down.** Two failures six seconds apart do
   not distinguish a handler bug from a bad minute upstream. If the upstream can
   fail, the handler should still answer `200` with an empty list, or at worst a
   `4xx` that says something specific — a 500 is the one answer that tells the
   caller nothing and trips the breaker.
4. **The other `mpa-…` catalogs.** `mpa-sosac`, `mpa-aniwaves`, `mpa-anikoto`
   and `mpa-nyaa` appear in the same install and share the prefix, which suggests
   a shared codebase. If the no-results path is common to them, the fix is one
   place; if not, this is worth checking per catalog. I have not verified they
   are the same addon — the prefix is the only evidence.

## How to reproduce

```
curl -s -o /dev/null -w '%{http_code}\n' \
  'https://<addon-host>/catalog/movie/mpa-xhamster/search=Cocaine%20Bear.json'
```

Expect `200` with `{"metas":[]}`. A `500` reproduces the report.

Worth trying alongside: a query that *does* have results, and an empty query, to
see which paths differ.

## What "fixed" looks like

Every search answers `200`. A search with no hits answers `{ "metas": [] }`. The
addon never returns 500 for an ordinary query, whatever the upstream did — if the
upstream is unavailable, an empty list is a better answer than an error, because
the caller is asking several addons at once and only needs to know this one had
nothing to add.
