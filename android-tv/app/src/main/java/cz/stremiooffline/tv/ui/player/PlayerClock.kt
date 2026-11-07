package cz.stremiooffline.tv.ui.player

import android.text.format.DateFormat
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import cz.stremiooffline.tv.ui.theme.Tokens
import java.util.Date
import kotlinx.coroutines.delay

const val TAG_OSD_CLOCK = "osd_clock"

/** Wall-clock time in milliseconds. Tests provide a fixed one. */
val LocalWallClock = staticCompositionLocalOf<() -> Long> { System::currentTimeMillis }

/**
 * The time of day in the OSD's top-right corner, so a paused film tells the viewer how late it
 * is. It follows the TV's own 12/24-hour setting and locale, and moves on the minute.
 */
@Composable
fun PlayerClock(modifier: Modifier = Modifier) {
  val clock = LocalWallClock.current
  val context = LocalContext.current
  var now by remember { mutableLongStateOf(clock()) }
  LaunchedEffect(clock) {
    while (true) {
      now = clock()
      delay(MINUTE_MS - now % MINUTE_MS)
    }
  }
  val format = remember(context) { DateFormat.getTimeFormat(context) }
  Text(
    format.format(Date(now)),
    color = Tokens.Text,
    fontSize = 20.sp,
    fontWeight = FontWeight.Bold,
    modifier = modifier.testTag(TAG_OSD_CLOCK),
  )
}

private const val MINUTE_MS = 60_000L
