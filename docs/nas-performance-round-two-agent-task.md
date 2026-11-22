# NAS performance follow-up, round two

Start with the image cache and the active downloads poll. Deliver each as a separate PR so the effects can be measured independently. The next two tasks cover large favourites pages and web subtitle polling. The starting revision is `e94e7f13`. Check current main and open PRs before implementing, especially [#898](https://github.com/NickRabit/stremio-offline/pull/898) for subtitle recovery.

Follow [the project rules](../AGENTS.md) and [the testing guide](testing.md). For each PR, record the baseline commit, fixture size, cache state, storage backend and hardware. Compare the same public operation before and after. Assert work counts and output correctness in tests. Report latency separately, identifying measurements from a developer machine or a real NAS.

## 1. Reduce index scans while storing catalogue images

In [ImageProxy](../server/src/images.ts), each new image calls `evictOnce(bytes)` inside the serialized cache commit. Even below the cap, it sums the bytes of every entry. With expiration enabled it also copies and filters the index. An issued image ID can exist for months without holding a file.

- Maintain the stored-byte total across load, successful publication and eviction. Initialize it from the reconciled index for both SQLite and file-backed storage. Account for each published or removed file exactly once, including after a failed rename, failed removal, cancellation or retry.
- Give the expiry check a cheap path when nothing can have expired. Preserve the configured age limit, the eviction floor, recency updates and protection of in-flight entries. Keep the download slot through the temporary write as introduced in #894.
- Measure 50 new posters against 60,000 issued IDs with a mix of stored files and URL-only entries. Count index entries visited and measure time in the commit lock. Repeat below the cap with expiration enabled and no entries due, then with expired entries and a cap crossing.
- **Acceptance.** The 50 below-cap commits perform zero full index scans after initialization when nothing is due. Check the running byte total against a full recount after eviction, a failed write, a retry and restart. Previously issued IDs must still fetch correctly after their bytes are evicted.

## 2. Filter active downloads before building public jobs

The [downloads route](../server/src/routes/downloads.ts) calls `queue.snapshot()` before checking `active=1` or viewer ownership. In [DownloadQueue](../server/src/downloads.ts), that snapshot calls `list()`, which builds a public object for every historical job.

- Apply the route's existing active-status and ownership rules while iterating the queue, before calling `publicJob`. A single pass over raw jobs is sufficient. Preserve the original queue index in `order` and use the existing owner resolution for jobs created before per-user ownership.
- Exercise the HTTP route with an ordinary account and an administrator. Compare the whole response with the baseline, including halt, window, speed limit, device transfers and the viewer's drain summary. Cover the ordinary unfiltered request and a queue with zero active jobs.
- **Acceptance.** With 5,000 completed jobs, two visible active jobs and an active job owned by somebody else, an ordinary user's active poll materializes exactly two public jobs. An administrator sees all three active jobs at their original positions. Report allocation or elapsed-time measurements for repeated polls over the same history.

## 3. Reuse folder aggregates on favourites and resume pages

In [the server composition root](../server/src/index.ts), the stale-read folder path in `describeLibraryPath` filters the global walk for each described folder. [describePath](../server/src/library.ts) then totals those files and sorts timestamps. The existing per-library `HeldTree` already exposes count, size and newest modification for complete folders.

- Reuse that aggregate when a read-only view describes a known complete folder. Keep real-path containment, exclusion, visibility and the on-disk existence/type checks. Preserve disk fallback for a subtree cut by the depth limit and existing missing-folder and empty-folder behavior. Keep the aggregate tied to the walk that produced it.
- Compare a warm page describing 50 favourite folders over 20,000 videos across several libraries. Record full-array visits, filesystem calls and page time. Include equal relative paths in different libraries, a nested library exclusion, a deleted folder and a folder containing videos below the walk depth cap.
- **Acceptance.** After building the per-walk index, describing 50 complete folders performs zero per-folder scans of the global file array. Compare the returned paths, counts, bytes and modification times with the baseline. After invalidating the walk, the next fresh read must reflect a changed file.

## 4. Read subtitle readiness without generating a WebVTT body for every poll

Start this task on a base containing the refused-seek recovery from #898. Today [the web watcher](../web/src/player-sidecar.ts) inspects readiness headers and cancels the successful poll body. The browser's track element subsequently requests the VTT when it needs a new pass. [The playback route](../server/src/routes/playback.ts) and [subtitle reader](../server/src/player-sidecars.ts) can already have read and transformed the file by the time the client cancels.

- Trace one long embedded track with a growing VTT file. Measure poll count, bytes read from disk, full VTT transformations, response bytes, and time to the first correctly timed cue after a forward and a backward seek.
- Provide a lightweight readiness query for the web watcher, or equivalent reuse of published reader state. Its answer must describe the data actually ready for the current revision. Preserve the playhead update that keeps extraction ahead, coverage and completion semantics, ownership checks and the replacement URL for retired revisions. The track element still needs the full VTT with the correct offset and delay. Keep existing TV clients able to read it.
- **Acceptance.** Repeated readiness polls with an unchanged reader produce zero full-file reads and zero VTT body transformations after the first observation. Verify partial writes, sparse cues, completion, revision replacement, and a refused seek followed by continued playback on the old track. Compare cue content and timing as well as byte counts. A HEAD response that still prepares the whole body fails the work-count criterion.

## Handoff

Include the before/after counts, relevant test results and any remaining unverified NAS measurements in each PR. Follow the repository's release, Docker verification and merge workflow for the implementation changes.
