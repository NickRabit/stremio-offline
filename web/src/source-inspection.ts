import { useEffect, useRef, useState } from "react";
import { isRemoteStream } from "./streams";
import type { Inspection, Stream, Track } from "./types";

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
}

const languages = (tracks: Track[]): string[] =>
  [...new Set(tracks.map((track) => track.language?.trim()).filter((language): language is string => Boolean(language)))];

export function detectedTracks(inspection: Inspection): DetectedTracks {
  const audio = languages(inspection.audioTracks);
  const subtitles = languages(inspection.subtitleTracks);
  return {
    audio,
    audioKnown: audio.length > 0,
    subtitles,
    subtitlesKnown: inspection.subtitleTracks.length === 0 || subtitles.length > 0,
    noSubtitleTracks: inspection.subtitleTracks.length === 0,
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
