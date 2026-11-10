# Playback

The Docker image and desktop apps include FFmpeg. The player always picks the
cheapest path: the browser reports which codecs it can handle, and the server
decides.

| Source | Mode | NAS load |
| --- | --- | --- |
| MP4/WebM the browser can play | direct play, FFmpeg never starts | none |
| MKV with H.264 or HEVC | remux to fMP4, video and audio copied | negligible |
| HLS playlist, whatever the addon names it | remux of the tallest rendition, copied | negligible |
| AC3, DTS, or TrueHD audio | remux, audio only converted to AAC | low |
| MPEG-4 ASP, VC-1, and similar | real transcode to H.264 | high |

A playlist is never handed to the browser as it is: some hosts cut segments that
neither start on a keyframe nor repeat the stream headers, and the browser can then
play from the start but not after a seek. FFmpeg reads the headers once and copies
the picture through.

The current mode is shown in the player header; the real source codecs appear
in playback settings.

Quality other than **Original** transcodes the picture when the file is taller than
the chosen quality or heavier than it allows, because neither can be reduced by
copying. A file that already fits is copied instead, which costs the CPU next to
nothing: no taller than the quality, an overall bitrate of at most three quarters
of the quality's cap (1080p 6 Mb/s, 720p 3 Mb/s, 480p 1.5 Mb/s) so its peaks above
the average stay under it, and a picture codec the player can take as it is.
When the probe found no height or bitrate, or the player refused a copy, the
picture is transcoded; the sound is converted whenever the player cannot take it
as it is. On a NAS without QuickSync, stay on original quality — the mode label
then reads *Direct Stream* and the CPU stays idle. See
[Hardware acceleration](hardware-acceleration.md).

When playback stalls repeatedly, the player offers a lower quality; a smaller
bitrate helps network drop-outs. The offer appears only when the server has
hardware acceleration, because a software transcode on a weak CPU would make
stalling worse.

## Seeking

Converted segments currently stay in `DATA_DIR/playback` for the lifetime of
their generation. The proposed [bounded playback buffer](playback-buffer-spec.md)
describes RAM storage, safe eviction, and the verification required before
changing this behavior; it is not implemented yet.

Inside an already converted stretch, seeking is instant. A jump further ahead
restarts conversion from the new position with `-ss`. HTTP Range means nothing
before that point is downloaded, so a jump anywhere in a film takes about a
second. Subtitles shift by the same amount. Direct play seeks natively in the
browser.

Because remux copies video, playback starts at the nearest keyframe before the
requested time — usually a few seconds off. Emby and Jellyfin do the same.

When restarting conversion at a new position fails twice, the session returns to
the previous generation if its conversion is still running or exited cleanly and
its `master.m3u8` remains available. A failed seek then resumes the old position;
a failed track, quality or escalation restart restores the old generation too,
but still reports the failure to the client. A dead process or incomplete output
does not qualify, so the restart failure propagates unchanged.

## A conversion that ends short

A dropped source can make FFmpeg finish its playlist with `#EXT-X-ENDLIST` and
exit successfully well before the probed duration. The server treats that as
short only when the reached position is more than `max(30 seconds, 2%)` from the
end; the tolerance absorbs normal timestamp and keyframe differences. Without a
probed duration it cannot judge the end and reports a normal completion.
A conversion that exits with an error before the end is reported as failed and
handled the same way; one that exits with an error but reached the end, or one
without a probed duration, is a normal completion.

The clients read `GET /api/playback/:id/status` when converted playback ends. A
short result restarts conversion at the reached position, at most three times
per opened source; the fourth short end is a network failure. Direct play never
makes this call.

## Player controls

The picture fills the available player area without cropping. The header and
bottom controls overlay it, so hiding the controls does not resize the video.
Subtitles move above the bottom controls while they are visible.

The close button and favorite star stay at the top right in every orientation.
Playback, seeking, subtitle visibility, settings and fullscreen are available
from the bottom controls. Playback settings contain quality, audio and subtitle
track selection, source codecs, and downloads to the library or device.
Controls stay visible while settings are open or a control has keyboard focus.
Double-click the picture to toggle fullscreen. Hovering or dragging on the
timeline shows preview frames for library files; a remote source gets none, because
each frame opens the file afresh and hosts that count connections stop answering. Volume is remembered on the current device.

For a series with a next episode available, finishing an episode offers a
five-second countdown, **Play now** and **Cancel**. The next episode carries
your audio and subtitle choices. If you picked the source by hand, it stays
with that provider while it still has a source; if the active rule picked it, the
rule picks again, and a library copy of the next episode that meets the rule
plays from the library. The library also offers previous/next-file navigation. Finishing
a movie, or the last episode there is, closes the player and returns to the title's detail.

On Android TV the countdown card plays the next episode at zero, **OK** plays it at once
and **Back** dismisses it. An episode started from a catalogue title's detail moves on
through that detail the same way: a source you picked by hand -- in the detail's
**Sources** or in the player's own -- stays with that provider (the same addon install,
not just one of the same name) while it has a source, and otherwise the detail's source
rules pick, the same way Play would there. When that episode has nothing playable, the player closes on its detail,
which shows the sources or the reason.

**Settings → Playback → Offer the next episode** can bring that offer forward: at
97–99 % of the episode, or 30 s to 3 min before its end. With either of those, a
known start of the end credits brings it forward further. **When the episode ends**
keeps the behaviour above.

### What is playing, chapters, intro and credits

Under the title the player names what actually plays: the resolution (`4K`,
`1080p`, …), HDR10, HLG or Dolby Vision, and the audio format with its channels.
A conversion is described as converted (H.264, stereo AAC, no HDR), not as the
source was.

A file with two or more chapters gets marks on the timeline, the current
chapter's name above it, its name in the timeline preview, and a chapter list in
the player settings (on the TV, the **Chapters** button) that jumps to a chapter.

For a film or an episode with an IMDb id, the server asks
[IntroDB](https://introdb.app), a community database, where the intro, the recap
and the end credits are. While one of them plays, **Skip intro**, **Skip recap** or
**Skip credits** appears (on the TV, OK skips while the controls are hidden).
Skip credits starts the next episode when there is one. **Settings → Playback →
Intro and recap → Skip automatically** skips intro and recap without asking,
once each per episode. Only the server talks to IntroDB, sends it nothing but the
IMDb id with the season and episode, and keeps its answers for a day, so secure
mode leaves it on. A library file is looked up under the title it is bound to.
IntroDB times one cut of a title and does not say which, so the players keep an
intro or a recap only when it starts in the opening fifth of the file (at most 20
minutes in) and credits only when they run to within 45 seconds of its end;
credits timed on a shorter cut are not shown a minute or more before the end.
A title IntroDB does not know, or an unavailable service, simply shows no button.

## Keyboard

| Key | Action |
| --- | --- |
| <kbd>Space</kbd> | play / pause |
| <kbd>←</kbd> <kbd>→</kbd> | ±10 s |
| <kbd>f</kbd> | fullscreen |
| <kbd>c</kbd> | hide / show subtitles |
| <kbd>,</kbd> / <kbd>.</kbd> | move subtitles earlier / later by 0.25 s |

## Audio tracks and subtitles

The player lists audio tracks and subtitles, including off. Subtitles come from
two places:

- **embedded in the file** — extracted as a WebVTT sidecar (muxing them into
  fMP4 HLS makes FFmpeg die with "timescale not set"),
- **subtitle addons** (for example OpenSubtitles) — attached in the browser.

Downloaded language-tagged `.srt` and `.vtt` sidecars are discovered beside
library videos and offered in the player as external tracks.

Audio or quality changes restart conversion at the current position. Subtitle
changes keep video playing; **Off** stops the subtitle reader. Bitmap subtitles
(PGS, VobSub) are not offered because they cannot become WebVTT.

The subtitle icon in the controls (or <kbd>c</kbd>) does not change the track: it
only stops drawing the text. Playback and conversion keep going, and turning
subtitles back on is instant, even mid-line.

**Subtitle delay** in playback settings adjusts embedded and addon subtitles
in 0.25-second steps, from −30 to +30 seconds. Positive delay makes text appear
later; **Back in step** resets it. The adjustment lasts for this playback session.

**Settings** pick preferred audio and subtitle languages. The first-run
interface language seeds both preferences. Audio selection prefers that
language, then English, then a default or first available track. Embedded
subtitles prefer a full track in the chosen language or English; if the audio
already matches your preferred audio language, only a matching forced subtitle
track is selected automatically. See [Languages](languages.md).

In the source list, language is guessed from the title the addon sent. The
selected source also shows the real languages found by probing the file.

## Remote playback

AirPlay is currently disabled in the custom player following playback and seek
regressions. There is no route picker; use the browser or desktop player.
