import { describe, expect, it, vi } from "vitest";
import { alternativeProgressSaved, localFileProgressKey, remoteVersionKey, sourceProgressOwner, type SourceProgressOwner } from "./source-progress";
import type { CatalogueRef } from "./title-enrichment";
import type { Stream } from "./types";

const catalogue: CatalogueRef = { type: "movie", id: "tt5000" };
const stream = (over: Partial<Stream>): Stream => ({ sourceId: "s", kind: "remote", playable: true, ...over });
const remote = (libraryId: string, itemId: string, mediaSourceId: string) =>
  stream({ kind: "remote", provider: "jellyfin", remoteItem: { libraryId, itemId, mediaSourceId, progressKey: `remote:${mediaSourceId}` } });

describe("sourceProgressOwner", () => {
  it("owns a viewer's own file by its path, whatever catalogue version it sits beside", () => {
    const owner = sourceProgressOwner(stream({ kind: "library", localPath: "Films/Heat.mkv" }), catalogue);
    expect(owner).toEqual({ kind: "file", key: localFileProgressKey("Films/Heat.mkv"), path: "Films/Heat.mkv", progressKey: "file:Films/Heat.mkv" });
  });

  it("owns a remote version by its whole incoming context, never by the media-source id alone", () => {
    const first = sourceProgressOwner(remote("rlib_a", "9", "msX"), catalogue);
    const second = sourceProgressOwner(remote("rlib_b", "9", "msX"), catalogue);
    const third = sourceProgressOwner(remote("rlib_a", "10", "msX"), catalogue);
    expect(first).toEqual({ kind: "remote", key: remoteVersionKey({ libraryId: "rlib_a", itemId: "9", mediaSourceId: "msX" }), item: { libraryId: "rlib_a", itemId: "9", mediaSourceId: "msX", progressKey: "remote:msX" } });
    // Two copies that happen to reuse one media-source id keep two separate stores.
    expect(new Set([first!.key, second!.key, third!.key]).size).toBe(3);
  });

  it("owns an addon answer by the exact catalogue key of the title it answered for", () => {
    expect(sourceProgressOwner(stream({ addonKey: "torrentio", addonName: "Torrentio" }), catalogue))
      .toEqual({ kind: "catalogue", key: "movie:tt5000", progressKey: "movie:tt5000" });
    expect(sourceProgressOwner(stream({ addonKey: "torrentio", addonName: "Torrentio" }), { type: "series", id: "tt7000:1:2" }))
      .toEqual({ kind: "catalogue", key: "series:tt7000:1:2", progressKey: "series:tt7000:1:2" });
  });

  it("owns nothing without a remote context and without a catalogue identity", () => {
    expect(sourceProgressOwner(stream({ addonKey: "torrentio", addonName: "Torrentio" }), null)).toBeNull();
  });

  it("never takes the path of a row that only carries one, and never the native item's identity", () => {
    // A row of another library's item keeps that item's own context, not this detail's identity.
    const owner = sourceProgressOwner(remote("rlib_b", "9", "msX"), catalogue);
    expect(owner?.kind).toBe("remote");
    // A non-local stream that somehow carries a path is still not a file of the viewer's library.
    expect(sourceProgressOwner(stream({ localPath: "Film.mkv" }), catalogue)).toEqual({ kind: "catalogue", key: "movie:tt5000", progressKey: "movie:tt5000" });
  });
});

describe("alternativeProgressSaved", () => {
  const run = (owner: SourceProgressOwner, key: string) => {
    const personal = vi.fn();
    const detail = vi.fn();
    const handled = alternativeProgressSaved(owner, key, { personal, detail }, { captured: 1, current: 1 });
    return { handled, personal, detail };
  };

  it("redraws the Home and personal lists for a generic addon answer exactly as for a remote copy", () => {
    const addon = sourceProgressOwner(stream({ addonKey: "torrentio", addonName: "Torrentio" }), catalogue)!;
    const copy = sourceProgressOwner(remote("rlib_b", "9", "msX"), catalogue)!;
    const file = sourceProgressOwner(stream({ kind: "library", localPath: "Films/Heat.mkv" }), catalogue)!;
    // A catalogue answer writes the very progress the shelves read, so it is redrawn like a copy.
    const answered = run(addon, addon.key);
    expect(answered.handled).toBe(true);
    expect(answered.personal).toHaveBeenCalledTimes(1);
    expect(answered.detail).toHaveBeenCalledTimes(1);
    const copied = run(copy, copy.key);
    expect(copied.handled).toBe(true);
    expect(copied.personal).toHaveBeenCalledTimes(1);
    // A file of the viewer's own library is private to the listing that offered it.
    const own = run(file, file.key);
    expect(own.handled).toBe(true);
    expect(own.personal).not.toHaveBeenCalled();
    expect(own.detail).toHaveBeenCalledTimes(1);
  });

  it("changes nothing when the write names another row, or one the viewer has moved on from", () => {
    const addon = sourceProgressOwner(stream({ addonKey: "torrentio", addonName: "Torrentio" }), catalogue)!;
    const other = sourceProgressOwner(stream({ addonKey: "torrentio", addonName: "Torrentio" }), { type: "movie", id: "tt9999" })!;
    const missed = run(addon, other.key);
    expect(missed.handled).toBe(false);
    expect(missed.personal).not.toHaveBeenCalled();
    expect(missed.detail).not.toHaveBeenCalled();
  });
});


it("rejects a held final write from an obsolete playback even when the source key still matches", async () => {
  const owner = sourceProgressOwner(stream({ addonKey: "addon" }), catalogue)!;
  const personal = vi.fn();
  const detail = vi.fn();
  const captured = 1;
  let current = captured;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const completion = held.then(() => alternativeProgressSaved(owner, owner.key, { personal, detail }, { captured, current }));
  current++;
  release();
  expect(await completion).toBe(false);
  expect(personal).not.toHaveBeenCalled();
  expect(detail).not.toHaveBeenCalled();
});
