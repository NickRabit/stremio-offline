package cz.stremiooffline.tv.ui.player

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.ui.theme.Tokens
import kotlinx.coroutines.delay

const val TagNextCard = "next_card"

/** How long the offer waits before it plays the next episode on its own. */
const val NEXT_EPISODE_COUNTDOWN_S = 5

/**
 * The offer itself: it owns the countdown, so OK plays now, Back declines and the timer hands the
 * next episode over at zero. The picture keeps playing behind it.
 */
@Composable
fun NextEpisodeOffer(title: String, onPlay: () -> Unit, onDismiss: () -> Unit, focus: FocusRequester? = null) {
  var seconds by remember(title) { mutableIntStateOf(NEXT_EPISODE_COUNTDOWN_S) }
  BackHandler { onDismiss() }
  LaunchedEffect(title) {
    while (seconds > 0) {
      delay(1_000)
      seconds -= 1
    }
    onPlay()
  }
  NextEpisodeCard(title = title, seconds = seconds, onPlay = onPlay, focus = focus)
}

/**
 * The card that offers the next library episode. It appears when the player reports ENDED, counts
 * down five seconds, and OK starts it at once; Back dismisses it, which the shell owns.
 */
@Composable
fun NextEpisodeCard(title: String, seconds: Int, onPlay: () -> Unit, focus: FocusRequester? = null) {
  LaunchedEffect(focus) { focus?.let { runCatching { it.requestFocus() } } }
  Column(
    modifier = Modifier
      .width(360.dp)
      .testTag(TagNextCard)
      .focusRequester(focus ?: FocusRequester())
      .focusable()
      .onPreviewKeyEvent { event ->
        if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
        when (event.key) {
          Key.DirectionCenter, Key.Enter -> { onPlay(); true }
          else -> false
        }
      }
      .background(Brush.verticalGradient(listOf(Tokens.Panel, Color(0xFF11161E))), RoundedCornerShape(14.dp))
      .border(1.5.dp, Tokens.Accent2, RoundedCornerShape(14.dp))
      .padding(horizontal = 22.dp, vertical = 18.dp),
    verticalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    Text(stringResource(R.string.player_up_next), color = Tokens.Accent, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.8.sp)
    Text(title, color = Tokens.Text, fontSize = 18.sp, fontWeight = FontWeight.ExtraBold, maxLines = 2)
    Text(stringResource(R.string.player_up_next_countdown, seconds.toString()), color = Tokens.Muted, fontSize = 12.sp)
    Text(stringResource(R.string.player_play_now), color = Tokens.Text, fontSize = 13.sp, fontWeight = FontWeight.Bold)
  }
}
