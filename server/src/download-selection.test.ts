import assert from "node:assert/strict";
import test from "node:test";
import { selectDownloadSource } from "./download-selection.js";
import type { DownloadSelection } from "./downloads.js";
import type { MediaInfo } from "./probe.js";
import type { StreamItem } from "./types.js";

const selection = (overrides: Partial<DownloadSelection> = {}): DownloadSelection => ({
  addonKeys: ["first", "second"], sourceStrategy: "priority", audioLanguage: "cs", fallbackAudioLanguage: "en",
  subtitleMode: "off", targetSettings: { subfolder: "", layout: "structured" }, ...overrides,
});
const stream = (url: string, addonKey: string, size?: number): StreamItem => ({ url, addonKey, behaviorHints: { filename: "episode.mkv", videoSize: size } });
const info = (languages: Array<string | undefined>, subtitleLanguages: Array<string | undefined> = []): MediaInfo => ({
  container: "matroska", video: { codec: "h264" },
  audioTracks: languages.map((language, index) => ({ index, codec: "aac", language })),
  subtitleTracks: subtitleLanguages.map((language, index) => ({ index, codec: "subrip", language })),
});

test("primary audio wins even when an earlier source contains the fallback", async () => {
  const candidates = [stream("https://one.test/episode.mkv", "first"), stream("https://two.test/episode.mkv", "second")];
  const checked: string[] = [];
  const chosen = await selectDownloadSource({
    candidates, subtitles: [], selection: selection(), tried: [],
    inspect: async (item) => { checked.push(item.url!); return item.addonKey === "first" ? info(["en"]) : info(["cs"]); },
  });
  assert.equal(chosen?.stream.addonKey, "second");
  assert.equal(chosen?.resolution.audioLanguage, "cs");
  assert.equal(chosen?.resolution.fallbackUsed, false);
  assert.equal(checked.length, 2);
});

test("fallback audio is used only after every candidate was checked", async () => {
  const candidates = [stream("https://one.test/episode.mkv", "first"), stream("https://two.test/episode.mkv", "second")];
  let checked = 0;
  const chosen = await selectDownloadSource({ candidates, subtitles: [], selection: selection(), tried: [], inspect: async () => { checked += 1; return info(["en"]); } });
  assert.equal(chosen?.stream.addonKey, "first");
  assert.equal(chosen?.resolution.fallbackUsed, true);
  assert.equal(chosen?.resolution.checkedCandidates, 2);
  assert.equal(checked, 2);
});

test("addon priority decides between equally suitable sources", async () => {
  const candidates = [stream("https://second.test/episode.mkv", "second"), stream("https://first.test/episode.mkv", "first")];
  const chosen = await selectDownloadSource({ candidates, subtitles: [], selection: selection(), tried: [], inspect: async () => info(["cs"]) });
  assert.equal(chosen?.stream.addonKey, "first");
  assert.equal(chosen?.resolution.checkedCandidates, 1);
});

test("largest strategy ignores addon priority", async () => {
  const candidates = [stream("https://one.test/episode.mkv", "first", 300e6), stream("https://two.test/episode.mkv", "second", 1e9)];
  const chosen = await selectDownloadSource({ candidates, subtitles: [], selection: selection({ sourceStrategy: "largest" }), tried: [], inspect: async () => info(["cs"]) });
  assert.equal(chosen?.stream.addonKey, "second");
  assert.equal(chosen?.resolution.checkedCandidates, 1);
});

test("largest strategy compares an episode size instead of its torrent pack size", async () => {
  const pack = { ...stream("https://pack.test/episode.mkv", "first"), title: "Complete pack 86 GB\nEpisode 4.01 GB" };
  const single = { ...stream("https://single.test/episode.mkv", "second"), title: "Episode 5 GB" };
  const chosen = await selectDownloadSource({ candidates: [pack, single], subtitles: [], selection: selection({ sourceStrategy: "largest" }), tried: [], inspect: async () => info(["cs"]) });
  assert.equal(chosen?.stream.url, "https://single.test/episode.mkv");
});

test("largest strategy still checks a source named in the wanted language before a bigger, untagged one", async () => {
  const untagged = stream("https://big.test/episode.mkv", "first", 5e9);
  const tagged = { ...stream("https://tagged.test/episode.mkv", "second", 1e9), title: "Episode CZ dabing" };
  const checked: string[] = [];
  const chosen = await selectDownloadSource({
    candidates: [untagged, tagged], subtitles: [], selection: selection({ sourceStrategy: "largest" }), tried: [],
    inspect: async (item) => { checked.push(item.url!); return info(["cs"]); },
  });
  assert.equal(checked[0], "https://tagged.test/episode.mkv");
  assert.equal(chosen?.stream.url, "https://tagged.test/episode.mkv");
});

test("a suspiciously short source is rejected even when its audio matches", async () => {
  const candidates = [stream("https://sample.test/episode.mkv", "first"), stream("https://full.test/episode.mkv", "second")];
  const chosen = await selectDownloadSource({
    candidates, subtitles: [], selection: selection(), tried: [],
    inspect: async (item) => ({ ...info(["cs"]), duration: item.addonKey === "first" ? 12 : 1320 }),
  });
  assert.equal(chosen?.stream.addonKey, "second");
});

test("a source with no known duration is not rejected", async () => {
  const candidates = [stream("https://one.test/episode.mkv", "first")];
  const chosen = await selectDownloadSource({ candidates, subtitles: [], selection: selection(), tried: [], inspect: async () => info(["cs"]) });
  assert.equal(chosen?.stream.addonKey, "first");
});

test("probing gives up after a bounded number of candidates instead of checking every source", async () => {
  const candidates = Array.from({ length: 25 }, (_, index) => stream(`https://source-${index}.test/episode.mkv`, "first"));
  let checked = 0;
  const chosen = await selectDownloadSource({
    candidates, subtitles: [], selection: selection(), tried: [],
    inspect: async () => { checked += 1; return info(["de"]); },
  });
  assert.equal(chosen, undefined);
  assert.equal(checked, 15);
});

test("required subtitles reject a source while optional subtitles do not", async () => {
  const candidates = [stream("https://one.test/episode.mkv", "first")];
  const inspect = async () => info(["cs"]);
  const required = await selectDownloadSource({ candidates, subtitles: [], selection: selection({ subtitleMode: "required", subtitleLanguage: "cs" }), tried: [], inspect });
  assert.equal(required, undefined);
  const optional = await selectDownloadSource({ candidates, subtitles: [], selection: selection({ subtitleMode: "optional", subtitleLanguage: "cs" }), tried: [], inspect });
  assert.equal(optional?.resolution.subtitleStatus, "missing");
});

test("optional subtitles never displace a larger source with primary audio", async () => {
  const candidates = [stream("https://large.test/episode.mkv", "first", 1e9), stream("https://small.test/episode.mkv", "first", 300e6)];
  const chosen = await selectDownloadSource({
    candidates, subtitles: [], selection: selection({ sourceStrategy: "largest", subtitleMode: "optional", subtitleLanguage: "cs" }), tried: [],
    inspect: async (item) => item.url!.includes("small") ? info(["cs"], ["cs"]) : info(["cs"]),
  });
  assert.equal(chosen?.stream.url, "https://large.test/episode.mkv");
  assert.equal(chosen?.resolution.subtitleStatus, "missing");
});

test("embedded subtitles break ties only when fallback audio is needed", async () => {
  const candidates = [stream("https://one.test/episode.mkv", "first"), stream("https://two.test/episode.mkv", "second")];
  const chosen = await selectDownloadSource({
    candidates, subtitles: [], selection: selection({ subtitleMode: "optional", subtitleLanguage: "cs" }), tried: [],
    inspect: async (item) => item.addonKey === "first" ? info(["en"]) : info(["en"], ["cs"]),
  });
  assert.equal(chosen?.stream.addonKey, "second");
  assert.equal(chosen?.resolution.fallbackUsed, true);
  assert.equal(chosen?.resolution.subtitleSource, "embedded");
});

test("primary audio without subtitles beats fallback audio with embedded subtitles", async () => {
  const candidates = [stream("https://one.test/episode.mkv", "first"), stream("https://two.test/episode.mkv", "second")];
  const chosen = await selectDownloadSource({
    candidates, subtitles: [], selection: selection({ subtitleMode: "optional", subtitleLanguage: "cs" }), tried: [],
    inspect: async (item) => item.addonKey === "first" ? info(["en"], ["cs"]) : info(["cs"]),
  });
  assert.equal(chosen?.stream.addonKey, "second");
  assert.equal(chosen?.resolution.fallbackUsed, false);
  assert.equal(chosen?.resolution.subtitleStatus, "missing");
});

test("an addon subtitle can satisfy the required language", async () => {
  const candidates = [stream("https://one.test/episode.mkv", "first")];
  const chosen = await selectDownloadSource({
    candidates, subtitles: [{ url: "https://subs.test/episode.srt", lang: "cs" }],
    selection: selection({ subtitleMode: "required", subtitleLanguage: "cs" }), tried: [], inspect: async () => info(["cs"]),
  });
  assert.equal(chosen?.resolution.subtitleSource, "addon");
  assert.equal(chosen?.subtitle?.url, "https://subs.test/episode.srt");
});

test("primary subtitles win over an earlier subtitle fallback", async () => {
  const candidates = [stream("https://one.test/episode.mkv", "first"), stream("https://two.test/episode.mkv", "second")];
  const chosen = await selectDownloadSource({
    candidates, subtitles: [],
    selection: selection({ subtitleMode: "required", subtitleLanguage: "cs", fallbackSubtitleLanguage: "en" }),
    tried: [], inspect: async (item) => item.addonKey === "first" ? info(["cs"], ["en"]) : info(["cs"], ["cs"]),
  });
  assert.equal(chosen?.stream.addonKey, "second");
  assert.equal(chosen?.resolution.subtitleLanguage, "cs");
});

test("listed takes a source the listing names even though the probe finds no language", async () => {
  const candidates = [{ ...stream("https://one.test/episode.mkv", "first"), title: "Film CZ dabing" }];
  const chosen = await selectDownloadSource({
    candidates, subtitles: [], selection: selection({ audioMode: "listed" }), tried: [],
    inspect: async () => info([undefined]),
  });
  assert.equal(chosen?.stream.url, "https://one.test/episode.mkv");
  assert.equal(chosen?.resolution.audioLanguage, "cs");
  assert.equal(chosen?.resolution.audioEvidence, "listing");
  assert.equal(chosen?.resolution.fallbackUsed, false);
});

test("strict rejects a source whose only evidence is the listing", async () => {
  const candidates = [{ ...stream("https://one.test/episode.mkv", "first"), title: "Film CZ dabing" }];
  const chosen = await selectDownloadSource({
    candidates, subtitles: [], selection: selection({ audioMode: "strict" }), tried: [],
    inspect: async () => info([undefined]),
  });
  assert.equal(chosen, undefined);
});

test("how the language was proven never outranks the order the strategy put the candidates in", async () => {
  const listed = { ...stream("https://listed.test/episode.mkv", "first", 2e9), title: "Film CZ dabing" };
  const probed = stream("https://probed.test/episode.mkv", "second", 300e6);
  const inspect = async (item: StreamItem) => item.addonKey === "first" ? info([undefined]) : info(["cs"]);
  for (const audioMode of ["listed", "preferred"] as const) {
    const largest = await selectDownloadSource({
      candidates: [listed, probed], subtitles: [], selection: selection({ audioMode, sourceStrategy: "largest" }), tried: [], inspect,
    });
    assert.equal(largest?.stream.url, "https://listed.test/episode.mkv");
    assert.equal(largest?.resolution.audioEvidence, "listing");
    const byPriority = await selectDownloadSource({
      candidates: [probed, listed], subtitles: [], selection: selection({ audioMode, addonKeys: ["second", "first"] }), tried: [], inspect,
    });
    assert.equal(byPriority?.stream.url, "https://probed.test/episode.mkv");
  }
});

/** The reported defect: two English sources, Czech asked for, `largest` picked. The probe named
 *  the small one's track and left the large one's untagged, and the evidence tier handed the
 *  season to the 62 MB file. */
test("the largest fallback source wins even when only a smaller one has a tagged track", async () => {
  const large = { ...stream("https://large.test/episode.mkv", "first", 286e6), title: "Episode (en 1080p)" };
  const small = { ...stream("https://small.test/episode.mkv", "first", 62e6), title: "Episode 1080p EN" };
  const inspect = async (item: StreamItem) => item.url!.includes("large") ? info([undefined]) : info(["en"]);
  const chosen = await selectDownloadSource({
    candidates: [large, small], subtitles: [],
    selection: selection({ audioMode: "preferred", sourceStrategy: "largest" }), tried: [], inspect,
  });
  assert.equal(chosen?.stream.url, "https://large.test/episode.mkv");
  assert.equal(chosen?.resolution.audioLanguage, "en");
  assert.equal(chosen?.resolution.fallbackUsed, true);
});

test("preferred downloads a source that matches nothing when no better one is offered", async () => {
  const candidates = [stream("https://one.test/episode.mkv", "first")];
  const inspect = async () => info(["de"]);
  const preferred = await selectDownloadSource({ candidates, subtitles: [], selection: selection({ audioMode: "preferred" }), tried: [], inspect });
  assert.equal(preferred?.stream.url, "https://one.test/episode.mkv");
  assert.equal(preferred?.resolution.audioLanguage, "de");
  assert.equal(preferred?.resolution.audioTrack, 0);
  assert.equal(preferred?.resolution.audioEvidence, "none");
  assert.equal(preferred?.resolution.fallbackUsed, true);
  assert.equal(await selectDownloadSource({ candidates, subtitles: [], selection: selection({ audioMode: "strict" }), tried: [], inspect }), undefined);
  assert.equal(await selectDownloadSource({ candidates, subtitles: [], selection: selection({ audioMode: "listed" }), tried: [], inspect }), undefined);
});

test("preferred still prefers the fallback language over no match in either order", async () => {
  const fallback = stream("https://fallback.test/episode.mkv", "first");
  const other = stream("https://other.test/episode.mkv", "first");
  const inspect = async (item: StreamItem) => item.url!.includes("fallback") ? info(["en"]) : info(["de"]);
  for (const candidates of [[other, fallback], [fallback, other]]) {
    const chosen = await selectDownloadSource({ candidates, subtitles: [], selection: selection({ audioMode: "preferred" }), tried: [], inspect });
    assert.equal(chosen?.stream.url, "https://fallback.test/episode.mkv");
    assert.equal(chosen?.resolution.audioLanguage, "en");
    assert.equal(chosen?.resolution.audioEvidence, "probe");
    assert.equal(chosen?.resolution.fallbackUsed, true);
  }
});

test("listed honours the title language when the addon admitted it found none", async () => {
  const candidate = { ...stream("https://one.test/episode.mkv", "first"), behaviorHints: { filename: "episode.mkv", bingeGroup: "Webshare||1080p|" } };
  const chosen = await selectDownloadSource({
    candidates: [candidate], subtitles: [], selection: selection({ audioMode: "listed", titleLanguage: "cs" }), tried: [],
    inspect: async () => info([undefined]),
  });
  assert.equal(chosen?.resolution.audioLanguage, "cs");
  assert.equal(chosen?.resolution.audioEvidence, "listing");
});

test("the listing cannot speak for a file that names its own audio languages", async () => {
  const candidates = [{ ...stream("https://one.test/episode.mkv", "first"), title: "Film CZ dabing" }];
  const inspect = async () => info(["de", "en"]);
  const listed = await selectDownloadSource({ candidates, subtitles: [], selection: selection({ audioMode: "listed" }), tried: [], inspect });
  assert.equal(listed?.resolution.audioLanguage, "en");
  assert.equal(listed?.resolution.audioEvidence, "probe");
  assert.equal(listed?.resolution.fallbackUsed, true);
  const noFallback = await selectDownloadSource({
    candidates, subtitles: [], selection: selection({ audioMode: "listed", fallbackAudioLanguage: undefined }), tried: [], inspect,
  });
  assert.equal(noFallback, undefined);
});
