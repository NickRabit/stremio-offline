@file:OptIn(UnstableApi::class)

package cz.stremiooffline.tv.playback

import android.content.Context
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.audio.AudioCapabilities
import cz.stremiooffline.tv.data.ClientCapabilitiesDto

/** One codec as the device advertises it, kept free of `android.media` so the rules can be tested. */
data class CodecInfo(val mime: String, val isEncoder: Boolean, val profiles: List<Int>)

private val VIDEO_MIME = mapOf(
  "video/avc" to "h264",
  "video/hevc" to "hevc",
  "video/x-vnd.on2.vp9" to "vp9",
  "video/av01" to "av1",
)

private val AUDIO_MIME = mapOf(
  "audio/mp4a-latm" to "aac",
  "audio/mpeg" to "mp3",
  "audio/ac3" to "ac3",
  "audio/eac3" to "eac3",
  "audio/opus" to "opus",
  "audio/vorbis" to "vorbis",
  "audio/flac" to "flac",
  "audio/vnd.dts" to "dts",
  "audio/true-hd" to "truehd",
)

/** The order of the lists the server receives: fixed, so a device always reports the same answer. */
private val AUDIO_ORDER = listOf("aac", "mp3", "opus", "vorbis", "flac", "ac3", "eac3", "dts", "truehd")
private val DEEP_ORDER = listOf("hevc", "vp9", "av1")

private val HEVC_DEEP = setOf(
  MediaCodecInfo.CodecProfileLevel.HEVCProfileMain10,
  MediaCodecInfo.CodecProfileLevel.HEVCProfileMain10HDR10,
  MediaCodecInfo.CodecProfileLevel.HEVCProfileMain10HDR10Plus,
)
private val VP9_DEEP = setOf(
  MediaCodecInfo.CodecProfileLevel.VP9Profile2,
  MediaCodecInfo.CodecProfileLevel.VP9Profile2HDR,
  MediaCodecInfo.CodecProfileLevel.VP9Profile2HDR10Plus,
)
private val AV1_DEEP = setOf(
  MediaCodecInfo.CodecProfileLevel.AV1ProfileMain10,
  MediaCodecInfo.CodecProfileLevel.AV1ProfileMain10HDR10,
  MediaCodecInfo.CodecProfileLevel.AV1ProfileMain10HDR10Plus,
)

private val CONTAINERS = listOf("mp4", "mkv", "webm", "ts")
private val SUBTITLES = listOf("subrip", "ass", "webvtt", "hdmv_pgs_subtitle")

/** The capability contract from the spec: decoders only, 4:2:0 in the booleans and 10-bit in
 *  `deepColor`. `h264` is never deep. */
fun capabilitiesFrom(codecs: List<CodecInfo>, passthrough: Set<String>): ClientCapabilitiesDto {
  val decoders = codecs.filterNot { it.isEncoder }
  val video = decoders.filter { it.mime in VIDEO_MIME }
  val audio = decoders.filter { it.mime in AUDIO_MIME }
  val videoNames = video.map { VIDEO_MIME.getValue(it.mime) }.toSet()
  val audioNames = audio.map { AUDIO_MIME.getValue(it.mime) }.toSet()

  val hevc10 = video.any { it.mime == "video/hevc" && it.profiles.any(HEVC_DEEP::contains) }
  val vp9Deep = video.any { it.mime == "video/x-vnd.on2.vp9" && it.profiles.any(VP9_DEEP::contains) }
  val av1Deep = video.any { it.mime == "video/av01" && it.profiles.any(AV1_DEEP::contains) }
  val deep = buildList {
    if (hevc10) add("hevc")
    if (vp9Deep) add("vp9")
    if (av1Deep) add("av1")
  }

  return ClientCapabilitiesDto(
    h264 = "h264" in videoNames,
    hevc = "hevc" in videoNames,
    hevc10 = hevc10,
    vp9 = "vp9" in videoNames,
    av1 = "av1" in videoNames,
    aac = "aac" in audioNames,
    mp3 = "mp3" in audioNames,
    opus = "opus" in audioNames,
    vorbis = "vorbis" in audioNames,
    ac3 = "ac3" in audioNames,
    eac3 = "eac3" in audioNames,
    flac = "flac" in audioNames,
    containers = CONTAINERS,
    audioDecode = AUDIO_ORDER.filter { it in audioNames },
    audioPassthrough = AUDIO_ORDER.filter { it in passthrough },
    subtitles = SUBTITLES,
    deepColor = DEEP_ORDER.filter { it in deep },
  )
}

/** What this device can decode, read from `MediaCodecList` and the audio route. */
fun detectCapabilities(context: Context): ClientCapabilitiesDto {
  val codecs = mutableListOf<CodecInfo>()
  for (info in MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos) {
    for (mime in info.supportedTypes) {
      val profiles = runCatching {
        info.getCapabilitiesForType(mime).profileLevels.map { it.profile }
      }.getOrDefault(emptyList())
      codecs += CodecInfo(mime, info.isEncoder, profiles)
    }
  }

  val audio = AudioCapabilities.getCapabilities(context)
  val passthrough = buildSet {
    if (audio.supportsEncoding(C.ENCODING_AC3)) add("ac3")
    if (audio.supportsEncoding(C.ENCODING_E_AC3)) add("eac3")
    if (audio.supportsEncoding(C.ENCODING_DTS)) add("dts")
    if (audio.supportsEncoding(C.ENCODING_DTS_HD)) add("dts")
    if (audio.supportsEncoding(C.ENCODING_DOLBY_TRUEHD)) add("truehd")
  }
  return capabilitiesFrom(codecs, passthrough)
}
