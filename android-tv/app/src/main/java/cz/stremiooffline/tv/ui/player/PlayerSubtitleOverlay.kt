package cz.stremiooffline.tv.ui.player

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import cz.stremiooffline.tv.ui.theme.Tokens

const val TagSubtitleOverlay = "subtitle_overlay"

/** The web's cue clearance: above the controls while they are up, the bottom margin without them. */
val SUBTITLE_LIFTED_BOTTOM = 132.dp
val SUBTITLE_BOTTOM = 24.dp

/** The web's `clamp(16px, 2.2vw, 28px)` on a 1080p screen: about 4.5 % of the screen height. */
const val SUBTITLE_HEIGHT_FRACTION = 0.045f

/**
 * The one subtitle layer for server-delivered WebVTT. It is drawn over the picture and the OSD
 * scrim and lifted clear of the controls, styled the way the web draws its cues.
 */
@Composable
fun SubtitleOverlay(text: String, lifted: Boolean, modifier: Modifier = Modifier) {
  val size = (LocalConfiguration.current.screenHeightDp * SUBTITLE_HEIGHT_FRACTION).sp
  val stroke = with(LocalDensity.current) { (size.value * 0.08f).sp.toPx() }
  val base = TextStyle(
    fontFamily = FontFamily.SansSerif,
    fontWeight = FontWeight.SemiBold,
    fontSize = size,
    lineHeight = size * 1.3f,
    textAlign = TextAlign.Center,
  )
  val outline = base.copy(color = Color.Black, drawStyle = Stroke(stroke, cap = StrokeCap.Round, join = StrokeJoin.Round))
  val fill = base.copy(color = Color.White, shadow = Shadow(Color.Black, Offset(0f, 2f), blurRadius = 8f))

  Box(
    modifier.fillMaxSize().padding(bottom = if (lifted) SUBTITLE_LIFTED_BOTTOM else SUBTITLE_BOTTOM),
    contentAlignment = Alignment.BottomCenter,
  ) {
    Text(
      text,
      style = outline,
      modifier = Modifier.clearAndSetSemantics {}.padding(horizontal = Tokens.SafeX),
    )
    Text(
      text,
      style = fill,
      modifier = Modifier.testTag(TagSubtitleOverlay).padding(horizontal = Tokens.SafeX),
    )
  }
}
