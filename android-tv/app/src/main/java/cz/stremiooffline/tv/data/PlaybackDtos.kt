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
  val audioTracks: List<JsonObject> = emptyList(),
  val audioTrack: Int = 0,
  val copy: CopyDto? = null,
)
