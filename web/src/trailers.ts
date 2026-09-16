import type { Trailer } from "./types";

/** The only thing a trailer address may be built from: an id, never a URL an addon sent. */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

export const isYouTubeId = (value: unknown): value is string => typeof value === "string" && YOUTUBE_ID.test(value);

/** The privacy-enhanced embed the in-app overlay frames. */
export const trailerEmbedUrl = (youtubeId: string) => `https://www.youtube-nocookie.com/embed/${encodeURIComponent(youtubeId)}?autoplay=1&rel=0`;

/** Where Secure Mode sends the viewer instead: a new tab, never a frame. */
export const trailerWatchUrl = (youtubeId: string) => `https://www.youtube.com/watch?v=${encodeURIComponent(youtubeId)}`;

/** What the TRAILER pill does, or null when there is nothing to show. The pill is drawn from
 *  this alone, so a title without a usable trailer never leaves an empty button behind. */
export type TrailerAction = { kind: "overlay"; trailer: Trailer } | { kind: "external"; trailer: Trailer; href: string };

export function trailerAction(trailer: Trailer | null | undefined, secureMode: boolean): TrailerAction | null {
  if (!trailer || !isYouTubeId(trailer.youtubeId)) return null;
  return secureMode
    ? { kind: "external", trailer, href: trailerWatchUrl(trailer.youtubeId) }
    : { kind: "overlay", trailer };
}
