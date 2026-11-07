import { describe, expect, it } from "vitest";
import { detectedTracks, inspectable, uncachedDebrid } from "./source-inspection";
import type { Inspection, Stream, Track } from "./types";

const stream = (over: Partial<Stream> = {}): Stream => ({
  sourceId: "source",
  kind: "remote",
  playable: true,
  ...over,
});

const track = (language?: string): Track => ({ index: 0, codec: "aac", ...(language === undefined ? {} : { language }) });
const inspection = (audioTracks: Track[], subtitleTracks: Track[]): Inspection => ({ audioTracks, subtitleTracks });

describe("source inspection eligibility", () => {
  it("recognises the addon's uncached debrid labels", () => {
    expect(uncachedDebrid(stream({ name: "[RD download] Torrentio" }))).toBe(true);
    expect(uncachedDebrid(stream({ title: "[RD ⏳] Torrentio" }))).toBe(true);
    expect(uncachedDebrid(stream({ name: "[RD+] Torrentio" }))).toBe(false);
  });

  it("reads only playable addon HTTP sources without an uncached debrid link", () => {
    expect(inspectable(stream({ kind: "library" }))).toBe(false);
    expect(inspectable(stream({ kind: "torrent" }))).toBe(false);
    expect(inspectable(stream({ playable: false }))).toBe(false);
    expect(inspectable(stream({ provider: "jellyfin" }))).toBe(false);
    expect(inspectable(stream({
      remoteItem: { libraryId: "library", itemId: "item", mediaSourceId: "source", progressKey: "key" },
    }))).toBe(false);
    expect(inspectable(stream({ name: "[RD download] Torrentio" }))).toBe(false);
    expect(inspectable(stream())).toBe(true);
  });
});

describe("detectedTracks", () => {
  it("keeps distinct language codes in track order", () => {
    expect(detectedTracks(inspection(
      [track("en"), track("cs"), track("en"), track()],
      [track("de"), track("fr"), track("de")],
    ))).toEqual({
      audio: ["en", "cs"],
      audioKnown: true,
      subtitles: ["de", "fr"],
      subtitlesKnown: true,
      noSubtitleTracks: false,
      audioUntagged: false,
      audioFacts: { codec: "aac" },
    });
  });

  it("reads the sound's codec and channels, untagged audio and the picture's class", () => {
    const read = detectedTracks({
      video: { codec: "h264", width: 1920, height: 800 },
      audioTracks: [{ index: 0, codec: "eac3", channels: 6 }, { index: 1, codec: "aac", channels: 2 }],
      subtitleTracks: [],
    });
    expect(read.audioUntagged).toBe(true);
    expect(read.audioFacts).toEqual({ codec: "eac3", channels: 6 });
    expect(read.videoHeight).toBe(1080);
    expect(detectedTracks({ video: { codec: "mpeg4", width: 720, height: 576 }, audioTracks: [{ index: 0, codec: "pcm_s16le" }], subtitleTracks: [] }))
      .toMatchObject({ videoHeight: 576, audioFacts: {} });
    expect(detectedTracks({ audioTracks: [], subtitleTracks: [] }).audioUntagged).toBe(false);
  });

  it("treats untagged audio as unknown", () => {
    expect(detectedTracks(inspection([track()], [])).audioKnown).toBe(false);
  });

  it("treats no subtitle tracks as a known empty answer", () => {
    const tracks = detectedTracks(inspection([], []));
    expect(tracks.subtitlesKnown).toBe(true);
    expect(tracks.noSubtitleTracks).toBe(true);
  });

  it("treats only untagged subtitle tracks as unknown", () => {
    const tracks = detectedTracks(inspection([], [track(), track()]));
    expect(tracks.subtitlesKnown).toBe(false);
    expect(tracks.noSubtitleTracks).toBe(false);
  });
});
