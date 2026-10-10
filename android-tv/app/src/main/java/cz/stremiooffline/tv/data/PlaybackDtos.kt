package cz.stremiooffline.tv.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/** What the native client tells the server it can play: boolean codecs for a browser and the
 *  container, audio and subtitle lists that let a native client take the file untouched. */
@Serializable
data class ClientCapabilitiesDto(
  val h264: Boolean = false,
  val hevc: Boolean = false,
  val hevc10: Boolean = false,
  val vp8: Boolean = false,
  val vp9: Boolean = false,
  val av1: Boolean = false,
  val aac: Boolean = false,
  val mp3: Boolean = false,
  val opus: Boolean = false,
  val vorbis: Boolean = false,
  val ac3: Boolean = false,
  val eac3: Boolean = false,
  val flac: Boolean = false,
  val containers: List<String> = emptyList(),
  val audioDecode: List<String> = emptyList(),
  val audioPassthrough: List<String> = emptyList(),
  val subtitles: List<String> = emptyList(),
  val deepColor: List<String> = emptyList(),
)

/** `POST /api/library/source` mints one playable source for a library file. */
@Serializable
data class SourceDto(val sourceId: String = "", val kind: String? = null, val playable: Boolean = true)

/** One addon subtitle offered for a catalogue title (`GET /api/subtitles/:type/:id`). */
@Serializable
data class AddonSubtitleDto(
  val subtitleId: String = "",
  val lang: String? = null,
  val addonName: String? = null,
)

/** The library neighbour `GET /api/library/next/:sourceId` answers with, or null. */
@Serializable
data class NextFileDto(val path: String = "", val title: String = "")

/** One `POST /api/playback/:id/track` change, with the absolute position it applies at. */
sealed interface TrackChange {
  val time: Double
  data class Audio(val index: Int, override val time: Double) : TrackChange
  /** A null index asks the server for Off. */
  data class Subtitle(val index: Int?, override val time: Double) : TrackChange
}

/** One read of the progressively written sidecar: its WebVTT plus how far it reaches. */
data class SidecarFetch(val text: String, val complete: Boolean, val coverage: Double)

@Serializable
data class CopyDto(val video: Boolean = true, val audio: Boolean = true)

/** One playback session as `POST /api/playback` and its seek/escalate replies describe it. */
@Serializable
data class PlaybackDescriptorDto(
  val id: String,
  val mode: String = "direct",
  val url: String,
  val offset: Double = 0.0,
  val duration: Double? = null,
  val playlist: Boolean = false,
  /** The server kept the stream it had when a seek was refused. */
  val seekRestored: Boolean = false,
  val audioTracks: List<JsonObject> = emptyList(),
  val audioTrack: Int = 0,
  val subtitleTracks: List<JsonObject> = emptyList(),
  /** The server's chosen embedded subtitle, or null when it chose Off. */
  val subtitleTrack: Int? = null,
  /** The progressively written WebVTT the server reads beside the picture, when it renders it. */
  val sidecarUrl: String? = null,
  /** The codecs of the chosen streams, for the diagnostics panel. */
  val video: String? = null,
  val audio: String? = null,
  val copy: CopyDto? = null,
  /** `POST /api/playback` maps each offered addon subtitle id to the id this session must use. */
  val subtitleIds: Map<String, String> = emptyMap(),
)
