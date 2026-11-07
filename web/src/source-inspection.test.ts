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
    });
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
