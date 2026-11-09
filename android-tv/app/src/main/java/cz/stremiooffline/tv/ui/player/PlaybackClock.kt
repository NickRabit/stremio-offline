package cz.stremiooffline.tv.ui.player

import java.util.Locale

/**
 * A playback time as `MM:SS`, or `H:MM:SS` once it reaches an hour, the way the web player
 * writes it. `withHours` keeps a position aligned with a length of an hour or more (`0:05:12`).
 */
fun playbackClock(seconds: Double, withHours: Boolean = false): String {
  val total = if (seconds.isFinite()) seconds.toLong().coerceAtLeast(0) else 0L
  val hours = total / 3600
  val minutes = total % 3600 / 60
  val rest = total % 60
  return if (hours > 0 || withHours) String.format(Locale.US, "%d:%02d:%02d", hours, minutes, rest)
  else String.format(Locale.US, "%02d:%02d", minutes, rest)
}
