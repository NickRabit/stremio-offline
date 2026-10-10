package cz.stremiooffline.tv.playback

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

/** One track the server lists for a file, reduced to what matching reads. */
data class DescriptorTrack(
  val language: String? = null,
  val codec: String? = null,
  val channels: Int = 0,
)

/** One track the player offers, in the player's own order. */
data class PlayerTrack(
  val language: String? = null,
  val mimeType: String? = null,
  val channels: Int = 0,
)

/** The player's tracks of one kind, grouped the way the player groups them. */
data class PlayerTrackGroup(val type: Int, val tracks: List<PlayerTrack>)

/** Where the matching track sits: the group and the track inside it. */
data class TrackMatch(val groupIndex: Int, val trackIndex: Int)

/** The server's chosen track of one descriptor list, or null when the index or the entry is gone. */
fun descriptorTrack(tracks: List<JsonObject>, index: Int): DescriptorTrack? {
  val track = tracks.getOrNull(index) ?: return null
  return DescriptorTrack(
    language = (track["language"] as? JsonPrimitive)?.contentOrNull,
    codec = (track["codec"] as? JsonPrimitive)?.contentOrNull,
    channels = (track["channels"] as? JsonPrimitive)?.intOrNull ?: 0,
  )
}

/**
 * The track the server meant, matched by language, then codec MIME, then channels. An attribute
 * the server did not state is not used. The file's ordinal is never trusted: the player drops a
 * track it cannot decode, which shifts every later one. Null means the target could not be
 * identified, so the caller leaves the player's own choice alone.
 */
fun matchTrack(target: DescriptorTrack, groups: List<PlayerTrackGroup>, type: Int): TrackMatch? {
  val wantedLanguage = normalizeLanguage(target.language)
  val wantedMime = mimeOf(target.codec)
  val wantedChannels = target.channels
  if (wantedLanguage == null && wantedMime == null && wantedChannels <= 0) return null
  for ((groupIndex, group) in groups.withIndex()) {
    if (group.type != type) continue
    for ((trackIndex, track) in group.tracks.withIndex()) {
      if (wantedLanguage != null && normalizeLanguage(track.language) != wantedLanguage) continue
      if (wantedMime != null && track.mimeType != wantedMime) continue
      if (wantedChannels > 0 && track.channels != wantedChannels) continue
      return TrackMatch(groupIndex, trackIndex)
    }
  }
  return null
}

/** ffprobe writes the ISO 639-2 code and the container tag may write it too; both are one code. */
private val LANGUAGE_CODES = mapOf(
  "cze" to "cs", "ces" to "cs",
  "slo" to "sk", "slk" to "sk",
  "eng" to "en",
  "ger" to "de", "deu" to "de",
  "fre" to "fr", "fra" to "fr",
  "spa" to "es",
  "ita" to "it",
  "rus" to "ru",
  "ukr" to "uk",
  "pol" to "pl",
  "hun" to "hu",
  "por" to "pt",
  "dut" to "nl", "nld" to "nl",
  "jpn" to "ja",
  "kor" to "ko",
  "chi" to "zh", "zho" to "zh",
  "dan" to "da",
  "swe" to "sv",
  "nor" to "no",
  "fin" to "fi",
  "gre" to "el", "ell" to "el",
  "tur" to "tr",
  "ara" to "ar",
  "heb" to "he",
  "hin" to "hi",
  "rum" to "ro", "ron" to "ro",
  "bul" to "bg",
  "hrv" to "hr",
  "srp" to "sr",
)

internal fun normalizeLanguage(value: String?): String? {
  val cleaned = value?.trim()?.lowercase()?.replace(Regex("[_-].*$"), "")?.takeIf { it.isNotEmpty() }
    ?: return null
  return LANGUAGE_CODES[cleaned] ?: cleaned
}

/** The MIME the player reports for an ffprobe codec; an unknown codec leaves MIME out of it. */
private val MIME_TYPES = mapOf(
  "aac" to "audio/mp4a-latm",
  "ac3" to "audio/ac3",
  "eac3" to "audio/eac3",
  "dts" to "audio/vnd.dts",
  "truehd" to "audio/true-hd",
  "flac" to "audio/flac",
  "opus" to "audio/opus",
  "vorbis" to "audio/vorbis",
  "mp3" to "audio/mpeg",
  "subrip" to "application/x-subrip",
  "srt" to "application/x-subrip",
  "ass" to "text/x-ssa",
  "ssa" to "text/x-ssa",
  "webvtt" to "text/vtt",
  "mov_text" to "application/x-quicktime-tx3g",
  "hdmv_pgs_subtitle" to "application/pgs",
  "dvd_subtitle" to "application/vobsub",
)

internal fun mimeOf(codec: String?): String? = codec?.let { MIME_TYPES[it.trim().lowercase()] }
