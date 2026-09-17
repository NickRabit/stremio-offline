import { log } from "./logger.js";
import type { DownloadResolution, DownloadSelection } from "./downloads.js";
import { rankStreams, streamLanguages, streamSize } from "./ranking.js";
import { pickByLanguage } from "./language.js";
import type { MediaInfo } from "./probe.js";
import type { StreamItem, SubtitleItem } from "./types.js";

/** Below this a "movie" or "episode" is almost certainly a sample, a trailer, or a fake --
 *  not worth the ffprobe round trip, and never worth downloading. */
const MIN_STREAM_DURATION_SECONDS = 60;

/** Each candidate can cost up to a minute of ffprobe before it is ruled out, and resolving a
 *  source holds one of the queue's concurrency slots the whole time. An obscure title with many
 *  dead or wrong-language sources must still give up in bounded time rather than stall the queue. */
const MAX_PROBED_CANDIDATES = 15;

interface Choice {
  stream: StreamItem;
  subtitle?: SubtitleItem;
  resolution: DownloadResolution;
}

interface RankedChoice { choice: Choice; subtitleRank: number }

const normalizedSubtitleLanguage = (subtitle: SubtitleItem) => subtitle.lang?.toLowerCase().split(/[-_]/)[0];

function subtitlesFor(info: MediaInfo, stream: StreamItem, external: SubtitleItem[], selection: DownloadSelection) {
  if (selection.subtitleMode === "off") return { rank: 0 };
  const wanted = [selection.subtitleLanguage, selection.fallbackSubtitleLanguage].filter(Boolean) as string[];
  for (const [rank, language] of wanted.entries()) {
    const embedded = info.subtitleTracks.find((track) => track.language === language);
    if (embedded) return { rank, language, track: embedded.index, source: "embedded" as const };
    const addon = [...(stream.subtitles ?? []), ...external].find((subtitle) => normalizedSubtitleLanguage(subtitle) === language);
    if (addon) return { rank, language, subtitle: addon, source: "addon" as const };
  }
  return { rank: 2 };
}

export async function selectDownloadSource(input: {
  candidates: StreamItem[];
  subtitles: SubtitleItem[];
  selection: DownloadSelection;
  tried: string[];
  inspect: (stream: StreamItem) => Promise<MediaInfo | undefined>;
}): Promise<Choice | undefined> {
  const { selection } = input;
  const priority = new Map(selection.addonKeys.map((key, index) => [key, index]));
  const available = input.candidates.filter((stream) => Boolean(stream.url) && !input.tried.includes(stream.url!));
  const selected = available.filter((stream) => priority.has(stream.addonKey ?? ""));
  // A source's real audio is only known after ffprobe reads it, which is slow over the network.
  // The addon text is a hint at best, but a stream whose name or title names the wanted language
  // is far likelier to match, so it is still worth checking first -- largest strategy included.
  const bySpokenLanguage = (stream: StreamItem) => streamLanguages(stream, selection.titleLanguage).includes(selection.audioLanguage) ? 0 : 1;
  const candidates = selection.sourceStrategy === "largest"
    ? [...selected].sort((left, right) => {
      const byLanguage = bySpokenLanguage(left) - bySpokenLanguage(right);
      if (byLanguage) return byLanguage;
      const leftSize = streamSize(left), rightSize = streamSize(right);
      if (leftSize === undefined || rightSize === undefined) {
        if (leftSize !== rightSize) return leftSize === undefined ? 1 : -1;
      } else if (leftSize !== rightSize) return rightSize - leftSize;
      return (priority.get(left.addonKey ?? "") ?? Number.MAX_SAFE_INTEGER)
        - (priority.get(right.addonKey ?? "") ?? Number.MAX_SAFE_INTEGER);
    })
    : selection.addonKeys.flatMap((addonKey) => rankStreams(
      selected.filter((stream) => stream.addonKey === addonKey), selection.audioLanguage, priority, selection.titleLanguage));
  const tiers: Array<RankedChoice | undefined> = Array.from({ length: 5 });
  let checkedCandidates = 0;

  for (const stream of candidates) {
    if (checkedCandidates >= MAX_PROBED_CANDIDATES) {
      log("WARN", "Gave up looking for a source after the probe limit", { limit: MAX_PROBED_CANDIDATES, remaining: candidates.length - checkedCandidates });
      break;
    }
    const info = await input.inspect(stream).catch(() => undefined);
    checkedCandidates += 1;
    if (!info?.video || !info.audioTracks.length) continue;
    if (info.duration !== undefined && info.duration < MIN_STREAM_DURATION_SECONDS) continue;
    const mode = selection.audioMode ?? "strict";
    // The listing may only speak for a file that names no audio language of its own. One that
    // does has already contradicted it, and picking a track out of it would put a language on
    // the job that nothing inside the file supports.
    const listed = info.audioTracks.some((track) => track.language) ? [] : streamLanguages(stream, selection.titleLanguage);
    const primary = info.audioTracks.find((track) => track.language === selection.audioLanguage);
    const secondary = selection.fallbackAudioLanguage
      ? info.audioTracks.find((track) => track.language === selection.fallbackAudioLanguage)
      : undefined;
    const listedPrimary = mode !== "strict" && listed.includes(selection.audioLanguage);
    const listedFallback = mode !== "strict" && !!selection.fallbackAudioLanguage && listed.includes(selection.fallbackAudioLanguage);
    // Five tiers, best first: a probed track naming the language, the listing naming it, the same
    // two for the fallback, then -- in `preferred` only -- the best track whatever it holds.
    let tier: number;
    let audioTrack: number;
    let audioLanguage: string | undefined = selection.audioLanguage;
    let fallbackUsed = false;
    let audioEvidence: "probe" | "listing" | "none";
    if (primary) {
      tier = 0; audioTrack = primary.index; audioEvidence = "probe";
    } else if (listedPrimary) {
      tier = 1; audioTrack = pickByLanguage(info.audioTracks, selection.audioLanguage); audioEvidence = "listing";
    } else if (secondary) {
      tier = 2; audioTrack = secondary.index; audioLanguage = selection.fallbackAudioLanguage; fallbackUsed = true; audioEvidence = "probe";
    } else if (listedFallback) {
      tier = 3; audioTrack = pickByLanguage(info.audioTracks, selection.fallbackAudioLanguage); audioLanguage = selection.fallbackAudioLanguage; fallbackUsed = true; audioEvidence = "listing";
    } else if (mode === "preferred") {
      const track = info.audioTracks[pickByLanguage(info.audioTracks, selection.audioLanguage)];
      tier = 4; audioTrack = track.index; audioLanguage = track.language; fallbackUsed = true; audioEvidence = "none";
    } else continue;

    const subtitle = subtitlesFor(info, stream, input.subtitles, selection);
    if (selection.subtitleMode === "required" && !subtitle.language) continue;
    const choice: Choice = {
      stream,
      subtitle: subtitle.subtitle,
      resolution: {
        checkedCandidates,
        audioLanguage,
        audioTrack,
        fallbackUsed,
        audioEvidence,
        subtitleLanguage: subtitle.language,
        subtitleTrack: subtitle.track,
        subtitleSource: subtitle.source,
        subtitleStatus: subtitle.language ? "ready" : selection.subtitleMode === "optional" ? "missing" : undefined,
      },
    };
    const primaryMatch = tier <= 1;
    const choiceRank = selection.subtitleMode === "required"
      ? subtitle.rank
      : primaryMatch || selection.subtitleMode === "off"
        ? 0
        : subtitle.source === "embedded"
          ? subtitle.rank
          : subtitle.language
            ? 2 + subtitle.rank
            : 4;
    if (tier === 0 && choiceRank === 0) return choice;
    const previous = tiers[tier];
    if (!previous || choiceRank < previous.subtitleRank) {
      tiers[tier] = { choice, subtitleRank: choiceRank };
    }
  }
  const chosen = tiers.find((slot) => slot);
  if (chosen) chosen.choice.resolution.checkedCandidates = checkedCandidates;
  return chosen?.choice;
}
