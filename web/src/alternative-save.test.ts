import { describe, expect, it } from "vitest";
import { alternativeSaveRequest } from "./alternative-save";
import type { Stream } from "./types";

const stream = (over: Partial<Stream>): Stream => ({ sourceId: "s", kind: "remote", playable: true, ...over });
const media = { kind: "movie", title: "One" };

describe("alternativeSaveRequest", () => {
  it("takes the destination the server projected for the exact copy of another library", () => {
    const copy = stream({
      provider: "jellyfin",
      remoteItem: { libraryId: "rlib_b", itemId: "9", mediaSourceId: "msX", progressKey: "k" },
      downloadTarget: { libraryId: "lib_1", subfolder: "Films", layout: "structured" },
    });
    const request = alternativeSaveRequest("One", copy, media, "movie");
    expect(request.rule).toEqual({ movie: { libraryId: "lib_1", subfolder: "Films", layout: "structured" }, series: { libraryId: "lib_1", subfolder: "Films", layout: "structured" } });
    expect(request.ruleUnavailable).toBe(false);
    expect(request.stream).toBe(copy);
    expect(request.media).toBe(media);
  });

  it("leaves the destination to the viewer, loudly, when a native copy projects none", () => {
    const copy = stream({ provider: "jellyfin", remoteItem: { libraryId: "rlib_b", itemId: "9", mediaSourceId: "msX", progressKey: "k" } });
    const request = alternativeSaveRequest("One", copy, media, "movie");
    expect(request.rule).toBeUndefined();
    expect(request.ruleUnavailable).toBe(true);
  });

  it("preselects the library an older server projected without a full target", () => {
    const copy = stream({ provider: "jellyfin", remoteItem: { libraryId: "rlib_b", itemId: "9", mediaSourceId: "msX", progressKey: "k" }, downloadLibraryId: "lib_2" });
    expect(alternativeSaveRequest("One", copy, media, "movie").rule?.movie).toEqual({ subfolder: "", layout: "structured", libraryId: "lib_2" });
  });

  it("leaves an addon answer to its own addon's rule", () => {
    const addon = stream({ addonKey: "torrentio", addonName: "Torrentio", title: "💾 4 GB" });
    const request = alternativeSaveRequest("One", addon, media, "movie");
    expect(request.rule).toBeUndefined();
    expect(request.ruleUnavailable).toBe(false);
    expect(request.kind).toBe("movie");
  });
});
