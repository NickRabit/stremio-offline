import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { detectLanguage, normalizeLanguage } from "./language.js";
import { log } from "./logger.js";
import { ffmpegPath, ffprobePath } from "./media-tools.js";

const run = promisify(execFile);

export interface Track {
  /** The index within its own type, that is N in the mapping 0:a:N or 0:s:N. */
  index: number;
  codec: string;
  language?: string;
  title?: string;
  channels?: number;
  default?: boolean;
  forced?: boolean;
}

export interface MediaInfo {
  container: string;
  duration?: number;
  video?: { codec: string; width?: number; height?: number; profile?: string; pixelFormat?: string; dolbyVisionEnhancementLayer?: boolean };
  audio?: { codec: string; channels?: number };
  audioTracks: Track[];
  subtitleTracks: Track[];
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  channels?: number;
  disposition?: Record<string, number>;
  tags?: Record<string, string>;
  side_data_list?: Array<Record<string, unknown>>;
}

// The browser cannot show image subtitles and they cannot be converted to WebVTT.
const BITMAP_SUBTITLES = new Set(["dvd_subtitle", "hdmv_pgs_subtitle", "dvb_subtitle", "xsub"]);

const toTrack = (stream: ProbeStream, index: number): Track => ({
  index,
  codec: stream.codec_name ?? "",
  language: normalizeLanguage(stream.tags?.language) ?? detectLanguage(stream.tags?.title),
  title: stream.tags?.title,
  channels: stream.channels,
  default: stream.disposition?.default === 1,
  forced: stream.disposition?.forced === 1,
});

/** FFmpeg 7.1 does not know the hvcE Block Addition Mapping used by some Dolby Vision
 *  Matroska files. The copy path skips that enhancement layer with non-strict input
 *  handling, so this is kept only to make such sources visible in the logs. */
export const hasDolbyVisionEnhancementLayer = (stream?: Pick<ProbeStream, "side_data_list" | "tags">) => {
  const sides = stream?.side_data_list ?? [];
  if (sides.some((side) => /dolby vision enhancement-layer/i.test(String(side.name ?? side.side_data_type ?? "")))) return true;
  const dovi = sides.find((side) => String(side.side_data_type ?? "").toLowerCase() === "dovi configuration record");
  if (dovi && Number(dovi.el_present_flag) === 1) return true;
  return /dolby vision enhancement-layer/i.test(JSON.stringify(stream?.tags ?? {}));
};

// Playlists name their segments as they please, and ffmpeg refuses the unfamiliar endings by
// default -- which reads as an unplayable source. Newer ffmpeg split the old single option into
// one for the playlist file and one for its segments, and a build without either flag dies on
// the unknown option instead of ignoring it, so every probe would fail. Ask the binary once and
// leave out whichever options it does not have.
const ALLOW_ANY_SEGMENT = ["-allowed_extensions", "ALL"];

export const playlistArgsFrom = (help: string) => [
  ...ALLOW_ANY_SEGMENT,
  ...(help.includes("allowed_segment_extensions") ? ["-allowed_segment_extensions", "ALL"] : []),
  ...(help.includes("extension_picky") ? ["-extension_picky", "0"] : []),
];

const helpCache = new Map<string, Promise<string>>();

const executableFor = (binary: "ffprobe" | "ffmpeg") => binary === "ffprobe" ? ffprobePath() : ffmpegPath();

export async function playlistArgs(binary: "ffprobe" | "ffmpeg") {
  let help = helpCache.get(binary);
  if (!help) {
    help = run(executableFor(binary), ["-hide_banner", "-h", "demuxer=hls"], { timeout: 10_000 })
      .then(({ stdout }) => {
        if (!stdout.includes("extension_picky")) log("INFO", "This FFmpeg has no -extension_picky, playlists with unusual segment endings may not open", { binary });
        return stdout;
      })
      .catch((error: unknown) => {
        log("WARN", "The playlist demuxer options could not be read, segment endings stay picky", {
          binary, reason: error instanceof Error ? error.message : String(error),
        });
        return "";
      });
    helpCache.set(binary, help);
  }
  return playlistArgsFrom(await help);
}

// ffprobe folds a dead connection and a dead server into the same kind of stderr line. When one
// of these shows up, a second attempt against the same address is not going to end differently --
// it is not worth the deep probe's 45 extra seconds.
const UNREACHABLE = /connection refused|no route to host|network is unreachable|could not resolve|name or service not known|nodename nor servname|server returned 4\d\d|server returned 5\d\d|connection timed out/i;

interface Inspection { info?: MediaInfo; unreachable: boolean }

/** Finds the source's real codecs. An addon sends a non-binding hint at best; ffprobe tells the truth. */
export async function probe(input: string): Promise<MediaInfo | undefined> {
  // The default limits read only a few megabytes from a remote source, which is enough for ordinary files.
  // The deep probe (up to 100 MB) comes in only when the quick round misses something that matters.
  const fast = await inspect(input, [], 20_000, "fast");
  if (fast.info?.video && fast.info.duration && fast.info.audioTracks.length) return fast.info;
  if (fast.unreachable) {
    log("INFO", "The source refused the connection, the deeper probe was skipped");
    return undefined;
  }
  log("DEBUG", "The fast probe was not enough, reading more of the source", { found: fast.info ? { video: fast.info.video?.codec, duration: fast.info.duration, audioTracks: fast.info.audioTracks.length } : null });
  const deep = await inspect(input, ["-analyzeduration", "60M", "-probesize", "100M"], 45_000, "deep");
  return deep.info ?? fast.info;
}

export const looksUnreachable = (stderr: string) => UNREACHABLE.test(stderr);

async function inspect(input: string, limits: string[], timeout: number, stage: string): Promise<Inspection> {
  try {
    const { stdout } = await run(ffprobePath(), [
      "-v", "error", "-print_format", "json",
      ...await playlistArgs("ffprobe"),
      ...limits,
      "-show_format", "-show_streams", input,
    ], { timeout, maxBuffer: 8 * 1024 * 1024 });
    const data = JSON.parse(stdout) as { format?: { format_name?: string; duration?: string }; streams?: ProbeStream[] };
    const streams = data.streams ?? [];
    const video = streams.find((item) => item.codec_type === "video" && !item.disposition?.attached_pic);
    const audioTracks = streams.filter((item) => item.codec_type === "audio").map(toTrack);
    const subtitleTracks = streams.filter((item) => item.codec_type === "subtitle").map(toTrack)
      .filter((track) => !BITMAP_SUBTITLES.has(track.codec));
    const audio = streams.find((item) => item.codec_type === "audio");
    const duration = Number(data.format?.duration);
    return {
      unreachable: false,
      info: {
        container: data.format?.format_name ?? "",
        duration: Number.isFinite(duration) && duration > 0 ? duration : undefined,
        video: video?.codec_name ? {
          codec: video.codec_name,
          width: video.width,
          height: video.height,
          profile: video.profile,
          pixelFormat: video.pix_fmt,
          dolbyVisionEnhancementLayer: hasDolbyVisionEnhancementLayer(video),
        } : undefined,
        audio: audio?.codec_name ? { codec: audio.codec_name, channels: audio.channels } : undefined,
        audioTracks, subtitleTracks,
      },
    };
  } catch (error) {
    // Without this entry a failed probe surfaces two layers later as "the source could not be
    // parsed", with not a trace of what ffprobe actually said.
    const failure = error as { stderr?: string; killed?: boolean; code?: number };
    const reason = (failure.stderr ?? String(error)).split("\n").map((line) => line.trim()).filter(Boolean).slice(-2).join(" | ").slice(0, 300);
    log("WARN", "ffprobe did not read the source", { stage, timeout, timedOut: Boolean(failure.killed), exitCode: failure.code, reason });
    return { unreachable: looksUnreachable(failure.stderr ?? "") };
  }
}
