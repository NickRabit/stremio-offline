package cz.stremiooffline.tv.playback

/** One WebVTT cue. The server rebases what it delivers to the conversion stream, so cues are not
 *  in the player's absolute timeline until [absoluteCues] has brought them back. */
data class VttCue(val start: Double, val end: Double, val text: String)

/** The text of the cue (or cues) covering [position], joined by a newline, or null. */
fun activeCue(cues: List<VttCue>, position: Double): String? {
  val lines = cues.filter { position >= it.start && position < it.end }.map { it.text }
  return if (lines.isEmpty()) null else lines.joinToString("\n")
}

/**
 * The sidecar route and `/api/subtitle/:subtitleId` both subtract the session's `offset` from every
 * cue they send -- a conversion seeks to the offset and plays from zero -- while the player's
 * position, seek target and delay are all in the file's timeline. Shift the cues back so
 * [activeCue] can compare them with the absolute position. A direct-play sidecar has no offset and
 * is already absolute.
 */
fun absoluteCues(cues: List<VttCue>, offset: Double): List<VttCue> =
  if (offset == 0.0) cues else cues.map { VttCue(it.start + offset, it.end + offset, it.text) }

/**
 * A WebVTT document into cues, with the timestamps the document carries. The blocks that carry no
 * timing (WEBVTT, NOTE, STYLE, REGION) are skipped, as are the optional cue numbers; only the
 * timestamp line and the lines under it count.
 */
fun parseVtt(text: String): List<VttCue> {
  val cues = mutableListOf<VttCue>()
  for (block in text.replace("\r\n", "\n").replace('\r', '\n').split(Regex("\n{2,}"))) {
    val lines = block.lines().map { it.trimEnd() }.dropWhile { it.isBlank() }
    val first = lines.firstOrNull() ?: continue
    if (first.startsWith("WEBVTT") || first.startsWith("NOTE") || first.startsWith("STYLE") || first.startsWith("REGION")) continue
    val timingIndex = lines.indexOfFirst { it.contains("-->") }
    if (timingIndex < 0) continue
    val timing = lines[timingIndex]
    val arrow = timing.indexOf("-->")
    val start = parseTimestamp(timing.substring(0, arrow).trim()) ?: continue
    val end = parseTimestamp(timing.substring(arrow + 3).trim().substringBefore(' ').trim()) ?: continue
    val body = lines.drop(timingIndex + 1).joinToString("\n")
    if (body.isNotBlank()) cues += VttCue(start, end, body)
  }
  return cues
}

/** `hh:mm:ss.mmm` or `mm:ss.mmm`, with a dot or a comma before the milliseconds. */
internal fun parseTimestamp(value: String): Double? {
  val parts = value.split(":")
  if (parts.size < 2) return null
  val seconds = parts.last().replace(',', '.').toDoubleOrNull() ?: return null
  val minutes = parts[parts.size - 2].toIntOrNull() ?: return null
  val hours = if (parts.size >= 3) parts[parts.size - 3].toIntOrNull() ?: return null else 0
  return hours * 3600.0 + minutes * 60.0 + seconds
}
