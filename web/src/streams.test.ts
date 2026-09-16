import { describe, expect, it } from "vitest";
import { arrangeStreams, canQueue, pickDefaultStream, pickNextEpisodeStream, streamBadge, streamLanguages, streamSize, streamText, visibleCatalogStreams, repickStream, type StreamFilters } from "./streams";
import type { Stream } from "./types";

const stream = (parts: Partial<Stream>): Stream => ({ sourceId: "source", kind: "remote", playable: true, ...parts });
const names = (list: Stream[]) => list.map((item) => item.name);
const filters = (overrides: Partial<StreamFilters> = {}): StreamFilters =>
  ({ addon: "", language: "", sort: "recommended", ...overrides });

describe("streamText", () => {
  it("joins every field an addon may have used", () => {
    expect(streamText(stream({ name: "A", title: "B", description: "C", behaviorHints: { filename: "D.mkv" } })))
      .toBe("A B C D.mkv");
  });

  it("skips fields the addon left out", () => {
    expect(streamText(stream({ name: "A", description: "C" }))).toBe("A C");
  });
});

describe("streamLanguages", () => {
  it("takes the language from the bingeGroup when the text says nothing", () => {
    expect(streamLanguages(stream({ name: "FullHD", behaviorHints: { bingeGroup: "Webshare|CZ|1080p|" } })))
      .toEqual(["cs"]);
  });

  it("merges what the text and the bingeGroup each say", () => {
    expect(streamLanguages(stream({ title: "CZ dabing", behaviorHints: { bingeGroup: "Webshare|CZ,SK|720p|" } })).sort())
      .toEqual(["cs", "sk"]);
  });

  it("leaves a stream without either alone", () => {
    expect(streamLanguages(stream({ name: "1080p", behaviorHints: { bingeGroup: "torrentio|1080p|x264" } }))).toEqual([]);
  });

  it("falls back to the title's language when the addon left its field blank", () => {
    expect(streamLanguages(stream({ name: "SD", behaviorHints: { bingeGroup: "Webshare||480p|" } }), "cs")).toEqual(["cs"]);
  });

  it("does not put the title's language on a torrent listing that simply says nothing", () => {
    expect(streamLanguages(stream({ name: "4K", behaviorHints: { bingeGroup: "torrentio|4k|x265|HDR" } }), "cs")).toEqual([]);
    expect(streamLanguages(stream({ name: "4K" }), "cs")).toEqual([]);
  });

  it("never overrides what the addon did say", () => {
    expect(streamLanguages(stream({ name: "FullHD", behaviorHints: { bingeGroup: "Webshare|EN|1080p|" } }), "cs")).toEqual(["en"]);
  });
});

describe("streamSize", () => {
  it("prefers the structured hint", () => {
    expect(streamSize(stream({ title: "\u{1F4BE} 1 GB", behaviorHints: { videoSize: 12345 } }))).toBe(12345);
  });

  it("ignores a zero hint and falls back to the text", () => {
    expect(streamSize(stream({ title: "500 MB", behaviorHints: { videoSize: 0 } }))).toBe(500e6);
  });

  it("parses the units addons actually write", () => {
    expect(streamSize(stream({ title: "\u{1F4BE} 35.09 GB" }))).toBe(35_090_000_000);
    expect(streamSize(stream({ title: "700 MB" }))).toBe(700e6);
    expect(streamSize(stream({ title: "1.5 TB" }))).toBe(1.5e12);
    expect(streamSize(stream({ title: "820 KB" }))).toBe(820e3);
  });

  it("accepts a decimal comma", () => {
    expect(streamSize(stream({ title: "2,5 GB" }))).toBe(2.5e9);
  });

  it("accepts the unit written straight after the number", () => {
    expect(streamSize(stream({ title: "4GB" }))).toBe(4e9);
  });

  it("uses the per-file size after a torrent pack size", () => {
    expect(streamSize(stream({ title: "Complete pack 86 GB\nEpisode 4.01 GB" }))).toBe(4.01e9);
  });

  it("is case-insensitive", () => {
    expect(streamSize(stream({ title: "3 gb" }))).toBe(3e9);
  });

  it("returns nothing when no size is mentioned", () => {
    expect(streamSize(stream({ title: "1080p WEB-DL" }))).toBeUndefined();
  });

  it("does not read a unit glued to a longer word", () => {
    expect(streamSize(stream({ title: "10 GBps link" }))).toBeUndefined();
  });
});

describe("arrangeStreams", () => {
  const czechSmall = stream({ name: "cz-small", title: "Czech 1 GB", addonName: "alpha" });
  const czechBig = stream({ name: "cz-big", title: "Czech 8 GB", addonName: "beta" });
  const englishBig = stream({ name: "en-big", title: "English 20 GB", addonName: "alpha" });
  const unknown = stream({ name: "unknown", title: "1080p", addonName: "beta" });
  const all = [englishBig, czechSmall, unknown, czechBig];

  it("filters by addon", () => {
    expect(names(arrangeStreams(all, filters({ addon: "alpha" }), "cs")))
      .toEqual(["cz-small", "en-big"]);
  });

  it("filters by language", () => {
    expect(names(arrangeStreams(all, filters({ language: "cs" }), "cs")).sort())
      .toEqual(["cz-big", "cz-small"]);
  });

  it("puts the preferred language first, then the largest", () => {
    expect(names(arrangeStreams(all, filters(), "cs")))
      .toEqual(["cz-big", "cz-small", "en-big", "unknown"]);
  });

  it("respects addon priority inside the preferred language", () => {
    const priority = new Map([["beta", 0], ["alpha", 1]]);
    expect(names(arrangeStreams([czechSmall, czechBig], filters(), "cs", priority)))
      .toEqual(["cz-big", "cz-small"]);
    expect(names(arrangeStreams([czechBig, czechSmall], filters(), "en", priority)))
      .toEqual(["cz-big", "cz-small"]);
  });

  it("sorts by size in both directions", () => {
    expect(names(arrangeStreams(all, filters({ sort: "size-desc" }), "cs")))
      .toEqual(["en-big", "cz-big", "cz-small", "unknown"]);
    expect(names(arrangeStreams(all, filters({ sort: "size-asc" }), "cs")))
      .toEqual(["cz-small", "cz-big", "en-big", "unknown"]);
  });

  it("keeps an unknown size last when sorting ascending", () => {
    expect(names(arrangeStreams([unknown, czechSmall], filters({ sort: "size-asc" }), "cs")))
      .toEqual(["cz-small", "unknown"]);
  });

  it("sorts by addon priority and keeps the addon's own order inside a group", () => {
    const priority = new Map([["beta", 0], ["alpha", 1]]);
    expect(names(arrangeStreams(all, filters({ sort: "addon" }), "cs", priority)))
      .toEqual(["unknown", "cz-big", "en-big", "cz-small"]);
  });

  it("puts addons with no priority last", () => {
    const priority = new Map([["beta", 0]]);
    expect(names(arrangeStreams(all, filters({ sort: "addon" }), "cs", priority)))
      .toEqual(["unknown", "cz-big", "en-big", "cz-small"]);
  });

  it("leaves the input array untouched", () => {
    const input = [...all];
    arrangeStreams(input, filters({ sort: "size-desc" }), "cs");
    expect(input).toEqual(all);
  });
});

describe("torrent listing", () => {
  const http = stream({ name: "http", playable: true, kind: "remote", title: "Czech 1 GB" });
  const torrent = stream({ name: "torrent", playable: false, kind: "torrent", title: "Czech 8 GB" });
  const external = stream({ name: "ext", playable: false, kind: "unsupported", title: "Czech 2 GB" });

  it("hides torrents until a debrid token is configured", () => {
    expect(names(visibleCatalogStreams([torrent, http], filters(), "cs", new Map(), false))).toEqual(["http"]);
    expect(names(visibleCatalogStreams([torrent, http], filters(), "cs", new Map(), true))).toEqual(["torrent", "http"]);
  });

  it("prefers a playable HTTP source over a torrent", () => {
    expect(pickDefaultStream([torrent, http])?.name).toBe("http");
    expect(pickDefaultStream([torrent])?.name).toBe("torrent");
  });

  it("labels torrents as RD, not as a generic external source", () => {
    expect(streamBadge(http)).toBe("HTTP");
    expect(streamBadge(torrent)).toBe("RD");
    expect(streamBadge(external)).toBe("EXT");
  });

  it("lets a torrent be queued only when Real-Debrid is configured", () => {
    expect(canQueue(torrent, false)).toBe(false);
    expect(canQueue(torrent, true)).toBe(true);
    expect(canQueue(http, false)).toBe(true);
  });

  it("does not treat a torrent as playable", () => {
    expect(http.playable).toBe(true);
    expect(torrent.playable).toBe(false);
  });
});

describe("pickNextEpisodeStream", () => {
  it("keeps the current addon and ranks its variants by the spoken language", () => {
    const current = stream({ addonKey: "same", addonName: "Same" });
    const english = stream({ name: "english", addonKey: "same", addonName: "Same", title: "English 10 GB" });
    const czech = stream({ name: "czech", addonKey: "same", addonName: "Same", title: "Czech 1 GB" });
    const other = stream({ name: "other", addonKey: "other", addonName: "Other", title: "Czech 20 GB" });
    expect(pickNextEpisodeStream([english, other, czech], current, "cs", new Map())?.name).toBe("czech");
  });

  it("falls back to the normal recommended ranking when the addon has no next episode", () => {
    const current = stream({ addonKey: "gone", addonName: "Gone" });
    const english = stream({ name: "english", addonKey: "one", addonName: "One", title: "English 20 GB" });
    const czech = stream({ name: "czech", addonKey: "two", addonName: "Two", title: "Czech 1 GB" });
    expect(pickNextEpisodeStream([english, czech], current, "cs", new Map())?.name).toBe("czech");
  });

  it("keeps a similarly sized variant once the addon and language match", () => {
    const current = stream({ addonKey: "same", addonName: "Same", title: "Czech 3 GB" });
    const close = stream({ name: "close", addonKey: "same", addonName: "Same", title: "Czech 3.2 GB" });
    const huge = stream({ name: "huge", addonKey: "same", addonName: "Same", title: "Czech 20 GB" });
    expect(pickNextEpisodeStream([huge, close], current, "cs", new Map())?.name).toBe("close");
  });
});

describe("repickStream", () => {
  const [first, second, third] = ["a", "b", "c"];
  const base = { playing: false, picked: false, pending: 0, visible: [first, second], selected: first, preferred: first };

  it("moves the pick to the first source left when a filter removed the chosen one", () => {
    expect(repickStream({ ...base, visible: [second, third], selected: first, preferred: second })).toEqual({ move: true, to: second });
  });

  it("follows a better source that arrives while the viewer is still looking at the list", () => {
    expect(repickStream({ ...base, pending: 2, preferred: second })).toEqual({ move: true, to: second });
  });

  it("never overrides a source the viewer picked themselves", () => {
    expect(repickStream({ ...base, picked: true, pending: 2, preferred: second })).toEqual({ move: false });
  });

  it("leaves the source alone once the film is playing on it", () => {
    // Moving it would take the session out from under the player, which stops it and starts again.
    expect(repickStream({ ...base, playing: true, pending: 2, preferred: second })).toEqual({ move: false });
    expect(repickStream({ ...base, playing: true, visible: [second, third], selected: first, preferred: second })).toEqual({ move: false });
    expect(repickStream({ ...base, playing: true, visible: [], selected: first, preferred: null })).toEqual({ move: false });
  });

  it("clears the pick when nothing is left to play and nobody is watching", () => {
    expect(repickStream({ ...base, visible: [], selected: first, preferred: null })).toEqual({ move: true, to: null });
    expect(repickStream({ ...base, visible: [], selected: null, preferred: null })).toEqual({ move: false });
  });
});
