import { sourceLanguages, sourceSize, titleLanguage as parseTitleLanguage } from "@stremio-offline/source-selection";
import type { StreamItem } from "./types.js";

/** The server-side twin of the interface's "Recommended" order: the preferred language, then
 *  addon priority by position, then size from largest. The download queue uses it when it has
 *  to pick a source for an episode on its own. */

export function streamSize(stream: StreamItem): number | undefined {
  return sourceSize(stream);
}

export function titleLanguage(value: unknown): string | undefined {
  return parseTitleLanguage(value);
}

export function streamLanguages(stream: StreamItem, titleLanguage?: string): string[] {
  return sourceLanguages(stream, titleLanguage);
}

export function rankStreams(streams: StreamItem[], preferredLanguage: string, priority: Map<string, number>, titleLanguage?: string): StreamItem[] {
  const size = new Map(streams.map((stream) => [stream, streamSize(stream)]));
  const rank = (stream: StreamItem) => priority.get(stream.addonKey ?? "") ?? Number.MAX_SAFE_INTEGER;
  const decorated = streams.map((stream, index) => ({ stream, index }));
  decorated.sort((a, b) => {
    const preferred = (stream: StreamItem) => streamLanguages(stream, titleLanguage).includes(preferredLanguage) ? 0 : 1;
    const byLanguage = preferred(a.stream) - preferred(b.stream);
    if (byLanguage) return byLanguage;
    const byPriority = rank(a.stream) - rank(b.stream);
    if (byPriority) return byPriority;
    const left = size.get(a.stream), right = size.get(b.stream);
    if (left === undefined || right === undefined) {
      if (left !== right) return left === undefined ? 1 : -1;
    } else if (left !== right) return right - left;
    return a.index - b.index;
  });
  return decorated.map((item) => item.stream);
}
