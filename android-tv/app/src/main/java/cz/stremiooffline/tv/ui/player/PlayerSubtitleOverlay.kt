package cz.stremiooffline.tv.ui.player

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import cz.stremiooffline.tv.playback.VttCue
import cz.stremiooffline.tv.playback.activeCue

const val TagSubtitleOverlay = "subtitle_overlay"

/** The one subtitle layer for server-delivered WebVTT: the active cue, styled like the web's. */
@Composable
fun SubtitleOverlay(cues: List<VttCue>, position: Double, modifier: Modifier = Modifier) {
  val text = activeCue(cues, position)?.takeIf { it.isNotBlank() } ?: return
  Box(modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) {
    Text(
      text,
      color = Color.White,
      fontSize = 22.sp,
      fontWeight = FontWeight.SemiBold,
      textAlign = TextAlign.Center,
      modifier = Modifier
        .testTag(TagSubtitleOverlay)
        .padding(bottom = 64.dp, start = 96.dp, end = 96.dp)
        .background(Color.Black.copy(alpha = 0.5f), RoundedCornerShape(6.dp))
        .padding(horizontal = 14.dp, vertical = 6.dp),
    )
  }
}
