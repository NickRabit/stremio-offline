import type { PlaybackFacts } from "./types";

export const CHANNELS: Record<number, string> = { 1: "mono", 2: "stereo", 6: "5.1", 8: "7.1" };

const HDR: Record<NonNullable<PlaybackFacts["hdr"]>, string> = {
  dolbyVision: "Dolby Vision",
  hdr10: "HDR10",
  hlg: "HLG",
};

const CODECS: Record<string, string> = {
  eac3: "E-AC-3",
  ac3: "AC-3",
  truehd: "TrueHD",
  dts: "DTS",
  aac: "AAC",
  opus: "Opus",
  flac: "FLAC",
  mp3: "MP3",
  vorbis: "Vorbis",
};

export function playingBadges(facts?: PlaybackFacts): string[] {
  if (!facts) return [];
  const badges: string[] = [];
  if (facts.resolution !== undefined) badges.push(facts.resolution === 2160 ? "4K" : `${facts.resolution}p`);
  if (facts.hdr) badges.push(HDR[facts.hdr]);
  if (facts.audioCodec) {
    const codec = CODECS[facts.audioCodec.toLowerCase()] ?? facts.audioCodec.toUpperCase();
    const channels = facts.audioChannels ? CHANNELS[facts.audioChannels] ?? `${facts.audioChannels}ch` : undefined;
    badges.push(channels ? `${codec} ${channels}` : codec);
  }
  return badges;
}
