package cz.stremiooffline.tv.playback

import cz.stremiooffline.tv.data.ClientCapabilitiesDto

/** Where a chosen audio track is applied: inside ExoPlayer, or the server converts it. */
enum class AudioRoute { Direct, Server }

/** The four subtitle cases the panel can ask for. */
enum class SubtitleRoute { EmbeddedDirect, EmbeddedServer, Addon, Off }

/** A chosen audio track is selected in ExoPlayer only in direct play and only when its codec is
 *  one the client declared it decodes or passes through; anything else goes to `/track`. */
fun audioRoute(mode: PlaybackMode, track: DescriptorTrack?, capabilities: ClientCapabilitiesDto): AudioRoute {
  if (mode != PlaybackMode.Direct || track == null) return AudioRoute.Server
  val codec = track.codec ?: return AudioRoute.Server
  return if (codec in capabilities.audioPassthrough || codec in capabilities.audioDecode) AudioRoute.Direct else AudioRoute.Server
}

/**
 * The subtitle decision table. (a) direct play and an embedded codec the client renders itself is
 * a track selection inside ExoPlayer; (b) an embedded track the client does not render is read by
 * the server, in every mode; (c) an addon subtitle is fetched by the app; (d) Off.
 */
fun subtitleRoute(
  mode: PlaybackMode,
  embedded: DescriptorTrack?,
  addon: Boolean,
  capabilities: ClientCapabilitiesDto,
): SubtitleRoute = when {
  addon -> SubtitleRoute.Addon
  embedded == null -> SubtitleRoute.Off
  mode == PlaybackMode.Direct && embedded.codec != null && embedded.codec in capabilities.subtitles -> SubtitleRoute.EmbeddedDirect
  else -> SubtitleRoute.EmbeddedServer
}
