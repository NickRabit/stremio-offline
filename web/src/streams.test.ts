import { describe, expect, it } from "vitest";
import { addonNotices, arrangeStreams, canQueue, catalogPlaybackChoice, catalogSourceRows, compareRuleRank, filmHasNoSource, isLocalStream, LOCAL_SOURCE, noticeText, offeredStreams, pickDefaultStream, pickNextEpisodeStream, remoteSourceFilter, streamBadge, streamLanguages, streamSize, streamText, visibleCatalogStreams, repickStream, type StreamFilters } from "./streams";
import type { SourceRuleVerdict, Stream } from "./types";

const stream = (parts: Partial<Stream>): Stream => ({ sourceId: "source", kind: "remote", playable: true, ...parts });
const verdict = (rank: number[], status: SourceRuleVerdict["status"] = "meets"): SourceRuleVerdict =>
  ({ profileId: "balanced", status, reasons: [], rank });
const names = (list: Stream[]) => list.map((item) => item.name);
const filters = (overrides: Partial<StreamFilters> = {}): StreamFilters =>
  ({ addon: "", language: "", sort: "rule:balanced", ...overrides });

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

  it("uses listed track languages ahead of a name guess", () => {
    expect(streamLanguages(stream({ name: "Czech release", audioLanguages: ["en"] }), "cs")).toEqual(["en"]);
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

  it("reads the size Luna abbreviates and not the bitrate beside it", () => {
    expect(streamSize(stream({ title: "2 Mb/s \u00b7 2:22:00 \u00b7 2.2G" }))).toBe(2.2e9);
    expect(streamSize(stream({ title: "6 Mb/s \u00b7 2:22:33 \u00b7 6.3G" }))).toBe(6.3e9);
    expect(streamSize(stream({ title: "1.4T" }))).toBe(1.4e12);
  });

  it("does not read a bitrate as a size", () => {
    expect(streamSize(stream({ title: "2 Mb/s" }))).toBeUndefined();
    expect(streamSize(stream({ title: "1500 kbps" }))).toBeUndefined();
    expect(streamSize(stream({ title: "2 Mbit/s" }))).toBeUndefined();
  });

  it("does not read a resolution as a size", () => {
    expect(streamSize(stream({ title: "Movie 4K HDR" }))).toBeUndefined();
    expect(streamSize(stream({ title: "The Matrix 2K remaster" }))).toBeUndefined();
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

  it("filters a remote row by the languages the server listed", () => {
    const remote = stream({ name: "Remote Rules Fixture S01E01", audioLanguages: ["cs"] });
    expect(names(arrangeStreams([remote], filters({ language: "cs" }), "en"))).toEqual([remote.name]);
  });

  it("puts the preferred language first, then the largest", () => {
    expect(names(arrangeStreams(all, filters(), "cs")))
      .toEqual(["cz-big", "cz-small", "en-big", "unknown"]);
  });

  it("ranks sources by the active rule verdict instead of language and size", () => {
    const czechSmall = stream({ name: "czech-small", title: "Czech 1 GB", rules: { balanced: verdict([0, 1]) } });
    const englishBig = stream({ name: "english-big", title: "English 20 GB", rules: { balanced: verdict([0, 2]) } });
    expect(names(arrangeStreams([englishBig, czechSmall], filters(), "en")))
      .toEqual(["czech-small", "english-big"]);
  });

  it("reorders the same rows when the active rule changes", () => {
    const first = stream({
      name: "first",
      rules: {
        balanced: verdict([0]),
        best: { ...verdict([1]), profileId: "best" },
      },
    });
    const second = stream({
      name: "second",
      rules: {
        balanced: verdict([1]),
        best: { ...verdict([0]), profileId: "best" },
      },
    });
    expect(names(arrangeStreams([first, second], filters(), "en"))).toEqual(["first", "second"]);
    expect(names(arrangeStreams([first, second], filters({ sort: "rule:best" }), "en"))).toEqual(["second", "first"]);
  });

  it("puts a breaking verdict after one that meets the rules", () => {
    const breaks = stream({ name: "breaks", rules: { balanced: verdict([2], "breaks") } });
    const meets = stream({ name: "meets", rules: { balanced: verdict([1], "meets") } });
    expect(names(arrangeStreams([breaks, meets], filters(), "cs")))
      .toEqual(["meets", "breaks"]);
  });

  it("compares ranks lexicographically and keeps an unruled source after ruled ones", () => {
    const prefix = stream({ rules: { balanced: verdict([1]) } });
    const longer = stream({ rules: { balanced: verdict([1, 0]) } });
    const unruled = stream({});
    expect(compareRuleRank(prefix, longer, "balanced")).toBeLessThan(0);
    expect(compareRuleRank(longer, unruled, "balanced")).toBeLessThan(0);
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

  it("keeps size and addon sorting independent of rule ranks", () => {
    const small = stream({ name: "small", title: "1 GB", addonName: "alpha", rules: { balanced: verdict([0]) } });
    const large = stream({ name: "large", title: "20 GB", addonName: "beta", rules: { balanced: verdict([1]) } });
    const priority = new Map([["alpha", 0], ["beta", 1]]);
    // The ranked order proves the feature is active while the explicit sorts still use size and priority.
    expect(names(arrangeStreams([large, small], filters(), "en"))).toEqual(["small", "large"]);
    expect(names(arrangeStreams([small, large], filters({ sort: "size-desc" }), "en"))).toEqual(["large", "small"]);
    expect(names(arrangeStreams([large, small], filters({ sort: "addon" }), "en", priority))).toEqual(["small", "large"]);
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

  it("picks the first playable source from the rule-ranked order", () => {
    const lower = stream({ name: "lower", rules: { balanced: verdict([2]) } });
    const best = stream({ name: "best", rules: { balanced: verdict([0]) } });
    expect(pickDefaultStream(arrangeStreams([lower, best], filters(), "en"), "balanced")?.name).toBe("best");
  });

  it("picks meets before unverified and never a rule-breaking source automatically", () => {
    const breaks = stream({ name: "breaks", rules: { balanced: verdict([2], "breaks") } });
    const unverified = stream({ name: "unverified", rules: { balanced: verdict([1], "unverified") } });
    const meets = stream({ name: "meets", rules: { balanced: verdict([0]) } });

    expect(pickDefaultStream([unverified, meets], "balanced")?.name).toBe("meets");
    expect(pickDefaultStream([unverified], "balanced")?.name).toBe("unverified");
    expect(pickDefaultStream([breaks], "balanced")).toBeUndefined();
  });

  it("keeps the old fallback when the listing carries no verdicts", () => {
    const unplayable = stream({ name: "unplayable", playable: false });
    const playable = stream({ name: "playable" });
    expect(pickDefaultStream([unplayable, playable], "balanced")?.name).toBe("playable");
    expect(pickDefaultStream([unplayable], "balanced")?.name).toBe("unplayable");
  });

  it("asks the catalogue panel to choose when playable rows exist but none may start automatically", () => {
    const breaking = stream({ name: "breaking", rules: { balanced: verdict([1], "breaks") } });
    const unplayable = stream({ name: "unplayable", playable: false });
    expect(catalogPlaybackChoice(null, [breaking, unplayable])).toEqual({ kind: "choose" });
    expect(catalogPlaybackChoice(null, [unplayable])).toBeNull();
    expect(catalogPlaybackChoice(breaking, [breaking])).toEqual({ kind: "play", stream: breaking });
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

describe("local copies", () => {
  const local = stream({ kind: "library", playable: true, localPath: "lib_1/Heat.mkv", libraryName: "Filmy", behaviorHints: { filename: "Heat.mkv" } });
  const addon = stream({ name: "FullHD", addonName: "Luna", title: "Czech 2 GB" });

  it("recognises a library stream", () => {
    expect(isLocalStream(local)).toBe(true);
    expect(isLocalStream(addon)).toBe(false);
  });

  it("badges a local copy as LOCAL, ahead of playable", () => {
    expect(streamBadge(local)).toBe("LOCAL");
    expect(streamBadge(stream({ kind: "library", playable: false }))).toBe("LOCAL");
  });

  it("never queues a copy that is already on disk", () => {
    expect(canQueue(local, true)).toBe(false);
  });

  it("puts local copies first in All with rule sorting, and keeps named-addon/local filters exclusive", () => {
    expect(catalogSourceRows([local], [addon], "", "rule:balanced")).toEqual([local, addon]);
    expect(catalogSourceRows([local], [addon], "Luna", "rule:balanced")).toEqual([addon]);
    expect(catalogSourceRows([local], [addon], LOCAL_SOURCE, "rule:balanced")).toEqual([local]);
  });

  it("ranks local copies with addon sources for size sorts and first for addon priority", () => {
    const small = stream({ kind: "library", name: "Local small", localPath: "lib/Small.mkv", behaviorHints: { videoSize: 500 } });
    const large = stream({ kind: "library", name: "Local large", localPath: "lib/Large.mkv", behaviorHints: { videoSize: 3000 } });
    const medium = stream({ name: "Addon medium", addonName: "Luna", behaviorHints: { videoSize: 1500 } });
    expect(catalogSourceRows([small, large], [medium], "", "size-desc").map((item) => item.name)).toEqual(["Local large", "Addon medium", "Local small"]);
    expect(catalogSourceRows([small, large], [medium], "", "size-asc").map((item) => item.name)).toEqual(["Local small", "Addon medium", "Local large"]);
    expect(catalogSourceRows([small, large], [medium], "", "addon").map((item) => item.name)).toEqual(["Local small", "Local large", "Addon medium"]);
  });

  it("keeps local, remote, addon input order for equal sizes", () => {
    const local = stream({ kind: "library", name: "Local", localPath: "lib/Film.mkv", behaviorHints: { videoSize: 1000 } });
    const remote = stream({ name: "Remote", provider: "emby", libraryId: "lib_1", behaviorHints: { videoSize: 1000 } });
    const addon = stream({ name: "Addon", addonName: "Luna", behaviorHints: { videoSize: 1000 } });
    const priority = new Map([["Luna", 0]]);
    expect(names(catalogSourceRows([local], [addon], "", "size-desc", "en", priority, undefined, [remote])))
      .toEqual(["Local", "Remote", "Addon"]);
    expect(names(catalogSourceRows([local], [addon], "", "size-asc", "en", priority, undefined, [remote])))
      .toEqual(["Local", "Remote", "Addon"]);
  });

  it("picks the local copy when the local entry is the chosen source", () => {
    expect(pickDefaultStream(catalogSourceRows([local], [addon], LOCAL_SOURCE, "rule:balanced"))).toBe(local);
  });

  it("keeps local copies out of named addon filters while allowing All to include them", () => {
    const visible = visibleCatalogStreams([addon], filters({ addon: "Nope" }), "cs", new Map(), true);
    expect(visible).toEqual([]);
    expect(catalogSourceRows([local], visible, LOCAL_SOURCE, "rule:balanced")).toEqual([local]);
    expect(catalogSourceRows([local], visible, "", "rule:balanced")).toEqual([local]);
  });

  it("keeps the local rows in their own order, untouched by the addon sort", () => {
    const first = stream({ kind: "library", name: "First", localPath: "lib/1.mkv" });
    const second = stream({ kind: "library", name: "Second", localPath: "lib/2.mkv" });
    const sorted = arrangeStreams([addon], filters({ sort: "size-desc" }), "cs");
    expect(catalogSourceRows([first, second], sorted, LOCAL_SOURCE, "rule:balanced").map((item) => item.name)).toEqual(["First", "Second"]);
  });

  it("keeps local copies ineligible for downloads when All includes them", () => {
    const rows = catalogSourceRows([local], visibleCatalogStreams([addon], filters(), "cs", new Map(), true), "", "rule:balanced");
    expect(rows[0]).toBe(local);
    expect(canQueue(rows[0], true)).toBe(false);
  });
});

describe("pickNextEpisodeStream", () => {
  it("keeps the current addon and ranks its variants by the spoken language", () => {
    const current = stream({ addonKey: "same", addonName: "Same" });
    const english = stream({ name: "english", addonKey: "same", addonName: "Same", title: "English 10 GB" });
    const czech = stream({ name: "czech", addonKey: "same", addonName: "Same", title: "Czech 1 GB" });
    const other = stream({ name: "other", addonKey: "other", addonName: "Other", title: "Czech 20 GB" });
    expect(pickNextEpisodeStream([english, other, czech], current, "cs", new Map(), undefined, "rule:balanced")?.name).toBe("czech");
  });

  it("falls back to the normal rule ranking when the addon has no next episode", () => {
    const current = stream({ addonKey: "gone", addonName: "Gone" });
    const english = stream({ name: "english", addonKey: "one", addonName: "One", title: "English 20 GB" });
    const czech = stream({ name: "czech", addonKey: "two", addonName: "Two", title: "Czech 1 GB" });
    expect(pickNextEpisodeStream([english, czech], current, "cs", new Map(), undefined, "rule:balanced")?.name).toBe("czech");
  });

  it("keeps a similarly sized variant once the addon and language match", () => {
    const current = stream({ addonKey: "same", addonName: "Same", title: "Czech 3 GB" });
    const close = stream({ name: "close", addonKey: "same", addonName: "Same", title: "Czech 3.2 GB" });
    const huge = stream({ name: "huge", addonKey: "same", addonName: "Same", title: "Czech 20 GB" });
    expect(pickNextEpisodeStream([huge, close], current, "cs", new Map(), undefined, "rule:balanced")?.name).toBe("close");
  });

  it("picks the next episode by the active rule instead of by the current addon", () => {
    const current = stream({ addonKey: "same", addonName: "Same" });
    const breaking = stream({ name: "same breaking", addonKey: "same", addonName: "Same", rules: { balanced: verdict([0], "breaks") } });
    const unverified = stream({ name: "other unverified", addonKey: "other", addonName: "Other", rules: { balanced: verdict([1], "unverified") } });
    const meets = stream({ name: "remote meets", provider: "emby", rules: { balanced: verdict([2], "meets") } });
    expect(pickNextEpisodeStream([breaking, unverified, meets], current, "cs", new Map(), undefined, "rule:balanced")?.name).toBe("remote meets");
    expect(pickNextEpisodeStream([breaking], current, "cs", new Map(), undefined, "rule:balanced")).toBeUndefined();
  });

  it("keeps the current addon and nearest size under explicit sorts even when verdicts exist", () => {
    const current = stream({ addonKey: "same", addonName: "Same", title: "3 GB" });
    const close = stream({ name: "close", addonKey: "same", addonName: "Same", title: "3.2 GB", rules: { balanced: verdict([2], "breaks") } });
    const betterRule = stream({ name: "better rule", addonKey: "other", addonName: "Other", title: "20 GB", rules: { balanced: verdict([0], "meets") } });
    expect(pickNextEpisodeStream([betterRule, close], current, "cs", new Map(), undefined, "size-desc")?.name).toBe("close");
    expect(pickNextEpisodeStream([betterRule, close], current, "cs", new Map(), undefined, "addon")?.name).toBe("close");
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

  it("moves an automatic addon pick to a local copy that lands once every addon finished", () => {
    expect(repickStream({ ...base, upgrade: true, preferred: second })).toEqual({ move: true, to: second });
  });

  it("never moves a source the viewer picked themselves for a local copy", () => {
    expect(repickStream({ ...base, picked: true, upgrade: true, preferred: second })).toEqual({ move: false });
  });

  it("never interrupts playback for a local copy that lands", () => {
    expect(repickStream({ ...base, playing: true, upgrade: true, preferred: second })).toEqual({ move: false });
  });

  it("leaves a non-upgrade arrival alone when nothing is pending", () => {
    expect(repickStream({ ...base, upgrade: false, preferred: second })).toEqual({ move: false });
  });
});

describe("addon notices", () => {
  const notice = stream({ sourceId: "n1", kind: "unsupported", playable: false, name: "⚠ Luna", title: "VIP expires in 4 days.", addonName: "Luna" });
  const playable = stream({ sourceId: "s1", name: "FullHD" });

  it("keeps a source the server cannot play out of the list", () => {
    expect(offeredStreams([notice, playable]).map((item) => item.sourceId)).toEqual(["s1"]);
  });

  it("reads the message from the field the addon used", () => {
    expect(noticeText(notice)).toBe("VIP expires in 4 days.");
    expect(noticeText(stream({ kind: "unsupported", playable: false, name: "Only a name" }))).toBe("Only a name");
    expect(noticeText(stream({ kind: "unsupported", playable: false, title: "Two\n lines" }))).toBe("Two lines");
  });

  it("shows a message repeated by several addons once", () => {
    const other = stream({ sourceId: "n2", kind: "unsupported", playable: false, title: "VIP expires in 4 days.", addonName: "Luna: Search" });
    expect(addonNotices([notice, other, playable]).map((item) => item.sourceId)).toEqual(["n1"]);
  });

  it("drops a notice with nothing to say", () => {
    expect(addonNotices([stream({ kind: "unsupported", playable: false })])).toEqual([]);
  });

  it("never picks a notice as the default source", () => {
    expect(pickDefaultStream(offeredStreams([notice]))).toBeUndefined();
  });
});

describe("filmHasNoSource", () => {
  it("stays quiet while sources are loading or an addon is still asking", () => {
    expect(filmHasNoSource({ loaded: false, pending: 0, playable: false })).toBe(false);
    expect(filmHasNoSource({ loaded: true, pending: 2, playable: false })).toBe(false);
  });

  it("is true only when every addon answered and nothing is playable", () => {
    expect(filmHasNoSource({ loaded: true, pending: 0, playable: false })).toBe(true);
    expect(filmHasNoSource({ loaded: true, pending: 0, playable: true })).toBe(false);
  });
});

describe("remote media-server sources", () => {
  const addon = stream({ sourceId: "a1", name: "FullHD", addonName: "Luna", title: "Czech 2 GB" });
  const local = stream({ kind: "library", name: "Local", localPath: "lib/Heat.mkv" });
  const remoteItem = { libraryId: "lib_1", itemId: "i1", mediaSourceId: "m1", progressKey: "p1" };
  const remote = stream({ sourceId: "r1", name: "Remote 1080p", provider: "jellyfin", libraryId: "lib_1", remoteItem });

  it("keeps an ordinary HTTP addon source queueable and badged HTTP", () => {
    const http = stream({ sourceId: "h1", name: "HTTP", kind: "remote", playable: true });
    expect(streamBadge(http)).toBe("HTTP");
    expect(canQueue(http, false)).toBe(true);
    expect(canQueue(http, true)).toBe(true);
  });

  it("queues a remote original only when the server proved the copy capability", () => {
    const bare = stream({ sourceId: "r2", provider: "emby", libraryId: "lib_2" });
    expect(bare.capabilities).toBeUndefined();
    expect(canQueue(bare, true)).toBe(false);
    // The remote context alone is enough: no addon path may pick a remote item up.
    const contextOnly = stream({ sourceId: "r3", remoteItem });
    expect(contextOnly.provider).toBeUndefined();
    expect(canQueue(contextOnly, true)).toBe(false);
    // A source the server projected as copyable is queueable; a non-playable one never is.
    const granted = stream({ sourceId: "r4", provider: "jellyfin", remoteItem, capabilities: { rename: false, move: false, delete: false, identify: false, writeArtwork: false, downloadToLibrary: true, downloadToDevice: false } });
    expect(canQueue(granted, false)).toBe(true);
    expect(canQueue({ ...granted, playable: false }, false)).toBe(false);
  });

  it("orders local, then remote, then addon sources in the rule All list", () => {
    expect(catalogSourceRows([local], [addon], "", "rule:balanced", "en", new Map(), undefined, [remote]))
      .toEqual([local, remote, addon]);
  });

  it("interleaves remote and addon sources by rule rank while local copies stay first", () => {
    const rankedLocal = { ...local, rules: { balanced: verdict([0, 2, 0], "breaks") } };
    const firstAddon = stream({ sourceId: "a2", name: "Addon best", addonName: "Luna", rules: { balanced: verdict([1, 0, 0]) } });
    const rankedRemote = { ...remote, rules: { balanced: verdict([1, 0, 1]) } };
    const lastAddon = stream({ sourceId: "a3", name: "Addon last", addonName: "Luna", rules: { balanced: verdict([1, 2, 0]) } });
    expect(catalogSourceRows([rankedLocal], [lastAddon, firstAddon], "", "rule:balanced", "en", new Map(), undefined, [rankedRemote]).map((item) => item.name))
      .toEqual(["Local", "Addon best", "Remote 1080p", "Addon last"]);
    // Without any verdicts the old class order remains the fallback for an older server.
    expect(catalogSourceRows([local], [addon], "", "rule:balanced", "en", new Map(), undefined, [remote]))
      .toEqual([local, remote, addon]);
  });

  it("lets an explicit rule order move local copies among every class", () => {
    const rankedLocal = { ...local, rules: { balanced: verdict([0, 0, 2]) } };
    const rankedRemote = { ...remote, rules: { balanced: verdict([0, 0, 1]) } };
    const rankedAddon = { ...addon, rules: { balanced: verdict([0, 0, 0]) } };
    expect(catalogSourceRows([rankedLocal], [rankedAddon], "", "rule:balanced", "en", new Map(), undefined, [rankedRemote]))
      .toEqual([rankedAddon, rankedRemote, rankedLocal]);
  });

  it("keeps a remote library out of a named addon filter", () => {
    expect(catalogSourceRows([local], [addon], "Luna", "rule:balanced", "en", new Map(), undefined, [remote]))
      .toEqual([addon]);
  });

  it("shows a remote library only under its own filter, even against an addon of the same name", () => {
    const collision = stream({ sourceId: "c1", name: "Collision", addonName: "lib_1" });
    expect(catalogSourceRows([], [collision], remoteSourceFilter("lib_1"), "rule:balanced", "en", new Map(), undefined, [remote]))
      .toEqual([remote]);
    expect(catalogSourceRows([], [collision], "lib_1", "rule:balanced", "en", new Map(), undefined, [remote]))
      .toEqual([collision]);
    expect(catalogSourceRows([], [collision], remoteSourceFilter("lib_2"), "rule:balanced", "en", new Map(), undefined, [remote]))
      .toEqual([]);
  });

  it("never moves the viewer's own pick or a playing source for a late remote arrival", () => {
    const base = { playing: false, picked: false, pending: 0, upgrade: true, visible: [addon, remote], selected: addon, preferred: remote };
    // A remote copy landing late only replaces an automatic pick the viewer has not touched.
    expect(repickStream(base)).toEqual({ move: true, to: remote });
    expect(repickStream({ ...base, playing: true })).toEqual({ move: false });
    expect(repickStream({ ...base, picked: true })).toEqual({ move: false });
  });
});
