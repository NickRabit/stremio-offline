# Trailers

A **TRAILER** pill appears beside the IMDb, TMDB and ČSFD links: under a title's
description in the catalogue, and in the three-dot menu of a matched library
folder or file. It appears only once a trailer has actually been found, so an
empty button never sits there looking broken.

## Where the trailer comes from

1. **Cinemeta**, always asked first.
2. **TMDB**, only when Cinemeta has no usable trailer *and* a TMDB API key is
   saved in **Settings → TMDB metadata**.

TMDB is the same optional key that supplies titles, descriptions and posters in
the language of the interface. Without it the catalogue addons answer alone and
trailers still work for anything Cinemeta knows.

Only a real **Trailer** is used — not a teaser, a clip or a featurette — and only
for films and series. A provider that answers with something else, or does not
answer at all, leaves the pill away; it never blocks the title, its metadata or
its sources.

The lookup is a server-side one and the answer is cached for six hours,
including the answer "there is none", so opening the same menu twice costs
nothing. The cache is cleared when the TMDB key or the interface language
changes.

## Secure mode decides how it plays

The trailer is a YouTube video, and embedding it means the browser talks to
YouTube. Secure mode promises the opposite, so the mode chooses:

| Secure mode | What **TRAILER** does |
| --- | --- |
| On (the default) | Opens `youtube.com/watch?v=…` in a new tab, the way the other external links behave. Nothing third-party loads into this page. |
| Off | Plays inside the app, in a full-screen overlay with a `youtube-nocookie.com` embed, closed with the button or Escape. |

Secure mode is not weakened to make the embedded player work. Turning it off is
what permits the frame, and the overlay says so by existing only then.

The overlay is a trailer player and nothing more: no resume position, no audio
or subtitle tracks, no download, no AirPlay, and no FFmpeg. It is not the main
player and the main player is never handed a YouTube address. Trailers are not
stored on disk, and there is no `yt-dlp` or other server-side YouTube fetching
behind it.
