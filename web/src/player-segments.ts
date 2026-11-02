import type { IntroSegments, SegmentRange, UpNextAt } from "./types";

export interface IntroQuery { imdb: string; season?: number; episode?: number }

/** `movie:tt123` → {imdb}; `series:tt123:1:2` → {imdb, season: 1, episode: 2}; anything else → undefined.
 *  The id must match /^tt\d{5,10}$/ and season/episode be non-negative integers. */
export function introQueryOf(progressKey?: string): IntroQuery | undefined {
  if (!progressKey) return undefined;
  const movie = /^movie:(tt\d{5,10})$/.exec(progressKey);
  if (movie) return { imdb: movie[1] };
  const series = /^series:(tt\d{5,10}):(\d+):(\d+)$/.exec(progressKey);
  if (!series) return undefined;
  const season = Number(series[2]);
  const episode = Number(series[3]);
  if (!Number.isSafeInteger(season) || !Number.isSafeInteger(episode)) return undefined;
  return { imdb: series[1], season, episode };
}

export type SegmentKind = "intro" | "recap" | "outro";

/** The segment `position` is inside, using [start, end - 1); intro wins over recap over outro on overlap. */
export function activeSegment(segments: IntroSegments | null, position: number): { kind: SegmentKind; range: SegmentRange } | undefined {
  if (!segments) return undefined;
  for (const kind of ["intro", "recap", "outro"] as const) {
    const range = segments[kind];
    if (range && position >= range.start && position < range.end - 1) return { kind, range };
  }
  return undefined;
}

const POINTS: Record<Exclude<UpNextAt, "end">, (duration: number) => number> = {
  pct97: (duration) => duration * 97 / 100,
  pct98: (duration) => duration * 98 / 100,
  pct99: (duration) => duration * 99 / 100,
  sec30: (duration) => duration - 30,
  sec60: (duration) => duration - 60,
  sec120: (duration) => duration - 120,
  sec180: (duration) => duration - 180,
};

/** Seconds at which Up next appears, or undefined for "end", an unknown duration or a point <= 0. */
export function upNextPoint(upNextAt: UpNextAt | undefined, duration: number, outro?: SegmentRange): number | undefined {
  if (!upNextAt || upNextAt === "end" || !Number.isFinite(duration) || duration <= 0) return undefined;
  let point = POINTS[upNextAt](duration);
  if (outro && outro.start < point) point = outro.start;
  return point > 0 ? point : undefined;
}
