package cz.stremiooffline.tv.ui.player

import cz.stremiooffline.tv.data.PlaybackFactsDto

private val CHANNELS = mapOf(1 to "mono", 2 to "stereo", 6 to "5.1", 8 to "7.1")

private val HDR = mapOf(
  "dolbyVision" to "Dolby Vision",
  "hdr10" to "HDR10",
  "hlg" to "HLG",
)

private val CODECS = mapOf(
  "eac3" to "E-AC-3",
  "ac3" to "AC-3",
  "truehd" to "TrueHD",
  "dts" to "DTS",
  "aac" to "AAC",
  "opus" to "Opus",
  "flac" to "FLAC",
  "mp3" to "MP3",
  "vorbis" to "Vorbis",
)

fun playingBadges(facts: PlaybackFactsDto?): List<String> {
  if (facts == null) return emptyList()
  return buildList {
    facts.resolution?.let { add(if (it == 2160) "4K" else "${it}p") }
    facts.hdr?.let { add(HDR[it] ?: it) }
    facts.audioCodec?.let { codec ->
      val label = CODECS[codec.lowercase()] ?: codec.uppercase()
      val channels = facts.audioChannels?.let { CHANNELS[it] ?: "${it}ch" }
      add(if (channels == null) label else "$label $channels")
    }
  }
}
