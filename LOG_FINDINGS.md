# Three things a real session log turned up

| Field | Value |
| --- | --- |
| Date | 2026-09-15 |
| Source | Server log from a Synology instance, ~45 minutes of ordinary use while the owner reorganised a library into six |
| `main` | `8c444fb` · released `v0.4.6` (which predates #137) |

In order of what it costs the user. The first one loses downloads.

---

## 1. A source that answers `200` to a range request loses the download

Two films never finished. Both failed the same way, repeatedly:

```
06:18:32 INFO The file will be downloaded in segments {"segments":2,"total":1219991933}
06:18:32 WARN The transfer broke off, it will be retried
  {"reason":"The source answered HTTP 200 to a range request.","retry":1,"waitMs":2000}
06:18:34 WARN … {"retry":2,"waitMs":8000}
```

`Nespoutaný Django` and `Hotel Transylvánie` both died here. `Jurassic Park` and
`Django Unchained`, from a different source, downloaded at 60 MB/s without a
murmur — so this is the source, not the network.

### Why it happens

`probeRanges` asks for `bytes=0-0`. If the answer is not `206` it already does
the right thing:

> `INFO The source does not serve ranges, one stream will be used`

But this source answers **206 to the one-byte probe and 200 to a real range**.
So the probe passes, a two-segment plan is made, and then every
`transferSegment` gets a `200`, throws `HttpSourceError`, and is classified
`transient` — which retries **the same segmented plan** three times and then
gives up.

### The fix, and the precedent for it

`HttpSourceError` with `416` is already handled exactly right in the retry
branch:

```ts
if (error instanceof HttpSourceError && error.httpStatus === 416 && job.target) {
  await unlink(`${this.jobPath(job)}.part`).catch(() => undefined);
  job.received = 0; job.total = undefined; job.segments = undefined;
}
```

A `200` to a range request means the same thing `416` does — *this source will
not serve me ranges* — and deserves the same recovery: drop the segment plan and
retry as a single stream. That is the one case where retrying is certain to
work, because a `200` with the whole body is exactly what an unsegmented
download wants.

Two details worth getting right:

- **Do not keep the `.part` file.** The segments wrote at offsets a single
  stream will not reproduce, so the partial file has to go, as it does for `416`.
- **Do not count it against the three retries.** It is not a flaky connection,
  it is a plan that cannot work; the first unsegmented attempt should start with
  a clean count.

### Test

A fake source that answers `206` to `bytes=0-0` and `200` to anything else. The
job must finish, unsegmented, without exhausting its retries. That combination is
what the current probe cannot see, so it is the case worth pinning down.

---

## 2. Every download fetches its poster twice

Every single download logs the same line twice:

```
06:18:32.337 INFO Poster from the catalog saved {"key":"lib_aabc253d/Nespoutaný Django"}
06:18:32.354 INFO Poster from the catalog saved {"key":"lib_aabc253d/Nespoutaný Django"}
```

`POST /api/downloads` calls `rememberTitle`, which ends by saving the poster —
and then saves it again itself:

```ts
await rememberTitle(job.target, media, targetSettings.layout === "flat");
const posterKey = titleKey(job.target, media, targetSettings.layout === "flat");
if (posterKey && posterKey !== ".") saveCatalogPoster(libraryKey(posterKey), media?.poster);
```

Two fetches of the same image, two writes to the same path, on every queued item.

**The second call is not simply redundant, so do not just delete it.**
`rememberTitle` returns early when `media?.id` is missing, and the second call is
what covers a download with no catalogue id. Make it conditional on that instead:
save here only when `rememberTitle` did not — which is exactly when there is no
id to remember.

---

## 3. A stale tab produces a wall of errors and does not recover

At 06:59, after the library had been reorganised into six, an unrefreshed Safari
tab holding paths from the single-library era produced twenty-odd failures in two
seconds:

```
GET /api/library/browse → 400 Invalid path.
GET /api/library/thumb  → 400 An unqualified path needs exactly one library, 6 are configured   ×20
```

**The message is already fixed** — #137 makes `singleLibrary()` raise an
`AppError` with `err.invalidPath`, so the interface can translate it instead of
showing a developer's sentence. That fix is on `main` and has not been released;
`v0.4.6` predates it.

What #137 does **not** do is help the client recover. The page keeps asking with
the same stale path and keeps failing, twenty times over, and the user sees a
broken library with no way forward but a manual refresh.

Worth adding on the client: when a browse request is refused as an invalid path,
drop the remembered browse path and reload at the root. The path is remembered in
`localStorage` precisely so it survives a restart, which is also what makes it
outlive the library layout it was written for. One recovery, at the one place
that can tell the difference.

The related `GET /api/media/… 404 "Media resource expired or unavailable"` at
06:23 is the same stale tab clicking an old media token. That one is correct
behaviour and needs nothing.

---

## Not ours

`My Pleasure Vol. 1` answers **HTTP 500** to a search for `Cocaine Bear` on the
`mpa-xhamster` catalog, twice. A catalog with no hits should answer `200` with
`{"metas":[]}`; a 500 tells the caller nothing and, repeated, trips our outbound
circuit breaker for that host. Written up separately in
`MY_PLEASURE_ADDON.md` — it is a different project.
