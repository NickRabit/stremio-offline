package cz.stremiooffline.tv.playback

import java.util.Locale
import kotlin.math.roundToInt

/** The web's subtitle correction: a quarter of a second a press, at most half a minute, two
 *  decimals in the read-out (`SUBTITLE_DELAY_STEP_S`, `SUBTITLE_DELAY_LIMIT_S`). */
object SubtitleDelay {
  const val STEP_S = 0.25
  const val LIMIT_S = 30.0

  /** A press of LEFT or RIGHT: `by` is ±[STEP_S], and the result is rounded before it is clamped. */
  fun nudge(value: Double, by: Double): Double =
    ((value + by) * 100).roundToInt().div(100.0).coerceIn(-LIMIT_S, LIMIT_S)

  /** `+0.25 s` / `-0.25 s`; zero is the caller's own "in step" wording. */
  fun format(value: Double): String = String.format(Locale.US, "%+.2f s", value)
}
