import { useEffect, useRef, useState } from "react";
import { isRemoteStream } from "./streams";
import type { AudioFacts, Inspection, Stream, Track } from "./types";

const UNCACHED_DEBRID = /\[(?:RD|AD|PM|DL|TB|ED|OC|PD|DLS)\b[^\]]*(?:download|⏳)[^\]]*\]/i;

export function uncachedDebrid(stream: Stream): boolean {
  return [stream.name, stream.title].some((text) => Boolean(text && UNCACHED_DEBRID.test(text)));
}

export function inspectable(stream: Stream): boolean {
  return stream.playable && stream.kind === "remote" && !isRemoteStream(stream) && !uncachedDebrid(stream);
}

export interface DetectedTracks {
  audio: string[];
  audioKnown: boolean;
  subtitles: string[];
  subtitlesKnown: boolean;
  noSubtitleTracks: boolean;
  /** The file has sound tracks, but none of them names its language. */
  audioUntagged: boolean;
  /** The first sound track's codec and channels, in the form a library file's facts take. */
  audioFacts?: AudioFacts;
  /** The picture's resolution class, read from the file. */
  videoHeight?: number;
}

const READ_CODECS = new Set<string>(["aac", "ac3", "eac3", "dts", "truehd", "opus", "flac", "mp3"]);

/** The class a release would name: a 1920x800 scope picture is 1080p, not 800p. */
export function resolutionClass(width: number | undefined, height: number | undefined): number | undefined {
  if (!height || height <= 0) return undefined;
  const wide = width ?? 0;
  if (wide >= 3200 || height >= 2000) return 2160;
  if (wide >= 1800 || height >= 1000) return 1080;
  if (wide >= 1200 || height >= 700) return 720;
  return Math.round(height);
}

const languages = (tracks: Track[]): string[] =>
  [...new Set(tracks.map((track) => track.language?.trim()).filter((language): language is string => Boolean(language)))];

export function detectedTracks(inspection: Inspection): DetectedTracks {
  const audio = languages(inspection.audioTracks);
  const subtitles = languages(inspection.subtitleTracks);
  const first = inspection.audioTracks[0];
  const videoHeight = resolutionClass(inspection.video?.width, inspection.video?.height);
  return {
    audio,
    audioKnown: audio.length > 0,
    subtitles,
    subtitlesKnown: inspection.subtitleTracks.length === 0 || subtitles.length > 0,
    noSubtitleTracks: inspection.subtitleTracks.length === 0,
    audioUntagged: inspection.audioTracks.length > 0 && audio.length === 0,
    ...(first ? { audioFacts: {
      ...(first.codec && READ_CODECS.has(first.codec) ? { codec: first.codec as NonNullable<AudioFacts["codec"]> } : {}),
      ...(first.channels && first.channels > 0 ? { channels: first.channels } : {}),
    } } : {}),
    ...(videoHeight ? { videoHeight } : {}),
  };
}

export type SourceInspection = { state: "idle" } | { state: "checking" } | { state: "done"; tracks: DetectedTracks };

const IDLE: SourceInspection = { state: "idle" };

export function useSourceInspection(
  stream: Stream | null,
  inspect?: (stream: Stream, signal: AbortSignal) => Promise<Inspection>,
): SourceInspection {
  const sourceId = stream?.sourceId ?? null;
  const readable = Boolean(inspect && stream && inspectable(stream));
  const current = useRef(stream);
  const read = useRef(inspect);
  current.current = stream;
  read.current = inspect;
  const [result, setResult] = useState<{ sourceId: string | null; value: SourceInspection }>({ sourceId, value: IDLE });

  useEffect(() => {
    const wanted = current.current;
    const source = wanted?.sourceId ?? null;
    if (!readable || !wanted || !read.current) {
      setResult({ sourceId: source, value: IDLE });
      return;
    }
    const controller = new AbortController();
    setResult({ sourceId: source, value: { state: "checking" } });
    void read.current(wanted, controller.signal)
      .then((inspection) => {
        if (!controller.signal.aborted) {
          setResult({ sourceId: source, value: { state: "done", tracks: detectedTracks(inspection) } });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ sourceId: source, value: IDLE });
      });
    return () => controller.abort();
  }, [sourceId, readable]);

  return result.sourceId === sourceId && readable ? result.value : IDLE;
}
