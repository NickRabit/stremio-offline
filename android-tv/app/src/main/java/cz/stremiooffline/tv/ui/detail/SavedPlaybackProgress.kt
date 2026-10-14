package cz.stremiooffline.tv.ui.detail

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.ui.theme.Tokens
import java.util.Locale

/** Where a saved position stands, judged from the stored numbers alone. */
sealed interface SavedProgress {
  /** Nothing is shown: no positive position, or a duration that makes no fraction. */
  data object None : SavedProgress

  /** A share of the duration: the bar and the localized percentage. */
  data class Fraction(val fraction: Float, val percent: Int) : SavedProgress

  /** A position with no known duration: the plain elapsed timestamp. */
  data class Elapsed(val text: String) : SavedProgress
}

/** The local detail and the native remote detail draw the same stored position the same way, so
 *  the bar and its bounds live in one place. */
fun savedProgress(position: Double, duration: Double): SavedProgress {
  if (position <= 0.0 || !position.isFinite()) return SavedProgress.None
  if (duration > 0.0 && duration.isFinite()) {
    val fraction = (position / duration).toFloat().coerceIn(0f, 1f)
    return SavedProgress.Fraction(fraction, (fraction * 100).toInt())
  }
  return SavedProgress.Elapsed(formatElapsed(position))
}

/** Noninteractive: the bar mirrors the stored position, and the remote never lands on it. */
@Composable
fun SavedPlaybackProgress(
  position: Double,
  duration: Double,
  tag: String,
  modifier: Modifier = Modifier,
) {
  when (val saved = savedProgress(position, duration)) {
    SavedProgress.None -> Unit
    is SavedProgress.Fraction -> Column(modifier, verticalArrangement = Arrangement.spacedBy(5.dp)) {
      Box(Modifier.width(140.dp).height(5.dp).clip(RoundedCornerShape(999.dp)).background(Tokens.Line)) {
        Box(
          Modifier
            .fillMaxHeight()
            .fillMaxWidth(saved.fraction)
            .background(Tokens.Accent)
        )
      }
      Text(
        stringResource(R.string.tv_detail_watched, saved.percent.toString()),
        color = Tokens.Muted,
        fontSize = 10.sp,
        modifier = Modifier.testTag(tag),
      )
    }
    is SavedProgress.Elapsed -> Text(
      saved.text,
      color = Tokens.Muted,
      fontSize = 10.sp,
      modifier = modifier.testTag(tag),
    )
  }
}

private fun formatElapsed(seconds: Double): String {
  val total = seconds.toInt().coerceAtLeast(0)
  return String.format(Locale.US, "%02d:%02d", total / 60, total % 60)
}
