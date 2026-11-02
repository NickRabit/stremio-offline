import { describe, expect, it } from "vitest";
import { playingBadges } from "./player-badges";

describe("playingBadges", () => {
  it("shows resolution, HDR and audio in order", () => {
    expect(playingBadges({ resolution: 2160, hdr: "dolbyVision", audioCodec: "eac3", audioChannels: 6 }))
      .toEqual(["4K", "Dolby Vision", "E-AC-3 5.1"]);
  });

  it("formats an SDR stereo track", () => {
    expect(playingBadges({ resolution: 1080, audioCodec: "aac", audioChannels: 2 }))
      .toEqual(["1080p", "AAC stereo"]);
  });

  it("keeps an audio badge when the channel count is unknown", () => {
    expect(playingBadges({ audioCodec: "opus" })).toEqual(["Opus"]);
  });

  it("shows no badges without playback facts", () => {
    expect(playingBadges()).toEqual([]);
  });
});
