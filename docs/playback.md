# Playback

The Docker image and desktop apps include FFmpeg. The player always picks the
cheapest path: the browser reports which codecs it can handle, and the server
decides.

| Source | Mode | NAS load |
| --- | --- | --- |
| MP4/WebM the browser can play | direct play, FFmpeg never starts | none |
| MKV with H.264 or HEVC | remux to fMP4, video and audio copied | negligible |
| AC3, DTS, or TrueHD audio | remux, audio only converted to AAC | low |
| MPEG-4 ASP, VC-1, and similar | real transcode to H.264 | high |

The current mode is shown in the player header; the real source codecs appear
in playback settings.

Quality other than **Original** forces a real transcode, because shrinking the
picture cannot be done by copying. On a NAS without QuickSync, stay on original
quality — the mode label then reads *remuxed* and the CPU stays idle. See
[Hardware acceleration](hardware-acceleration.md).

When playback stalls repeatedly, the player offers a lower quality; a smaller
bitrate helps network drop-outs. The offer appears only when the server has
hardware acceleration, because a software transcode on a weak CPU would make
stalling worse.

## Seeking

Inside an already converted stretch, seeking is instant. A jump further ahead
restarts conversion from the new position with `-ss`. HTTP Range means nothing
before that point is downloaded, so a jump anywhere in a film takes about a
second. Subtitles shift by the same amount. Direct play seeks natively in the
browser.

Because remux copies video, playback starts at the nearest keyframe before the
requested time — usually a few seconds off. Emby and Jellyfin do the same.

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
your audio and subtitle choices and prefers the current provider while it still
has a source. The library also offers previous/next-file navigation. Finishing
a movie leaves the player open.

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
