package cz.stremiooffline.tv.playback

import cz.stremiooffline.tv.data.IntroSegmentsDto
import cz.stremiooffline.tv.data.SegmentRangeDto

data class IntroQuery(val imdb: String, val season: Int? = null, val episode: Int? = null)

fun introQueryOf(progressKey: String?): IntroQuery? {
  if (progressKey == null) return null
  Regex("^movie:(tt\\d{5,10})$").matchEntire(progressKey)?.let { match ->
    return IntroQuery(match.groupValues[1])
  }
  val series = Regex("^series:(tt\\d{5,10}):(\\d+):(\\d+)$").matchEntire(progressKey) ?: return null
  val season = series.groupValues[2].toIntOrNull() ?: return null
  val episode = series.groupValues[3].toIntOrNull() ?: return null
  return IntroQuery(series.groupValues[1], season, episode)
}

enum class SegmentKind { Intro, Recap, Outro }

data class ActiveSegment(val kind: SegmentKind, val range: SegmentRangeDto)

fun activeSegment(segments: IntroSegmentsDto?, position: Double): ActiveSegment? {
  if (segments == null) return null
  segments.intro?.let {
    if (position >= it.start && position < it.end - 1) return ActiveSegment(SegmentKind.Intro, it)
  }
  segments.recap?.let {
    if (position >= it.start && position < it.end - 1) return ActiveSegment(SegmentKind.Recap, it)
  }
  segments.outro?.let {
    if (position >= it.start && position < it.end - 1) return ActiveSegment(SegmentKind.Outro, it)
  }
  return null
}

private fun secondsBeforeEnd(seconds: Double): (Double) -> Double = { duration -> duration - seconds }

private val UP_NEXT_POINTS: Map<String, (Double) -> Double> = mapOf(
  "pct97" to { duration -> duration * 97 / 100 },
  "pct98" to { duration -> duration * 98 / 100 },
  "pct99" to { duration -> duration * 99 / 100 },
  "sec30" to secondsBeforeEnd(30.0),
  "sec60" to secondsBeforeEnd(60.0),
  "sec120" to secondsBeforeEnd(120.0),
  "sec180" to secondsBeforeEnd(180.0),
)

fun upNextPoint(upNextAt: String?, duration: Double, outro: SegmentRangeDto? = null): Double? {
  if (upNextAt == null || upNextAt == "end" || !duration.isFinite() || duration <= 0) return null
  val pointFor = UP_NEXT_POINTS[upNextAt] ?: return null
  var point = pointFor(duration)
  if (outro != null && outro.start < point) point = outro.start
  return point.takeIf { it > 0 }
}

class UpNextTrigger {
  private var previousPosition = 0.0
  private var shown = false
  private var dismissed = false

  fun observe(position: Double, point: Double?, playing: Boolean): Boolean {
    if (point == null) {
      previousPosition = position
      return false
    }
    val crossed = playing && previousPosition < point && position >= point && !shown && !dismissed
    if (crossed) shown = true
    if (position < point) {
      shown = false
      dismissed = false
    }
    previousPosition = position
    return crossed
  }

  fun dismiss() {
    shown = false
    dismissed = true
  }

  fun reset() {
    previousPosition = 0.0
    shown = false
    dismissed = false
  }
}
