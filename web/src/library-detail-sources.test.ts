import { describe, expect, it } from "vitest";
import { defaultSource, detailSourceSize, orderSources, sourceIdentity, sourceName } from "./library-detail-sources";
import type { Stream } from "./types";

const stream = (over: Partial<Stream>): Stream => ({ sourceId: "s", kind: "library", playable: true, ...over });
const size = (bytes?: number, id = "s") => stream({ sourceId: id, behaviorHints: bytes === undefined ? undefined : { videoSize: bytes } });

describe("detailSourceSize", () => {
  it("reads the version's own reported size and treats anything else as unknown", () => {
    expect(detailSourceSize(size(500))).toBe(500);
    expect(detailSourceSize(size())).toBe(0);
    expect(detailSourceSize(stream({ behaviorHints: { videoSize: -1 } }))).toBe(0);
    expect(detailSourceSize(stream({ behaviorHints: { videoSize: Number.POSITIVE_INFINITY } }))).toBe(0);
  });
});

describe("orderSources and defaultSource", () => {
  it("puts the largest first and keeps the original order on a tie", () => {
    const list = [size(100, "a"), size(900, "b"), size(100, "c"), size(undefined, "d")];
    expect(orderSources(list).map((entry) => entry.sourceId)).toEqual(["b", "a", "c", "d"]);
  });

  it("defaults to the largest playable version", () => {
    const list = [size(100, "a"), size(900, "b"), stream({ sourceId: "c", playable: false, behaviorHints: { videoSize: 5_000 } })];
    expect(defaultSource(list)?.sourceId).toBe("b");
  });

  it("never defaults to a source that cannot play, and answers nothing when none can", () => {
    expect(defaultSource([stream({ sourceId: "a", playable: false, behaviorHints: { videoSize: 9 } })])).toBeNull();
    expect(defaultSource([])).toBeNull();
  });
});

describe("sourceIdentity", () => {
  it("names a remote version by its whole incoming context, a local copy by its file key, else the source id", () => {
    expect(sourceIdentity(stream({ sourceId: "raw", remoteItem: { libraryId: "l", itemId: "i", mediaSourceId: "ms", progressKey: "k" } }))).toBe("remote:l\u0000i\u0000ms");
    // Two libraries may hand out the same media-source id for two different copies: the id alone
    // is never an identity, so the whole context has to travel.
    expect(sourceIdentity(stream({ sourceId: "raw", remoteItem: { libraryId: "other", itemId: "i", mediaSourceId: "ms", progressKey: "k" } })))
      .not.toBe(sourceIdentity(stream({ sourceId: "raw", remoteItem: { libraryId: "l", itemId: "i", mediaSourceId: "ms", progressKey: "k" } })));
    expect(sourceIdentity(stream({ sourceId: "raw", localPath: "Films/Heat.mkv" }))).toBe("file:Films/Heat.mkv");
    expect(sourceIdentity(stream({ sourceId: "raw" }))).toBe("raw");
  });
});

describe("sourceName", () => {
  it("shows a local copy's file name and a remote version's own name", () => {
    expect(sourceName(stream({ sourceId: "s", behaviorHints: { filename: "Heat.mkv" } }))).toBe("Heat.mkv");
    expect(sourceName(stream({ sourceId: "s", name: "1080p" }))).toBe("1080p");
  });
});
