package cz.stremiooffline.tv.ui.player

import androidx.activity.compose.BackHandler

import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.tv.material3.Text
import cz.stremiooffline.tv.ui.theme.Tokens
import kotlinx.coroutines.delay

/** The controls hide after five seconds of playback with no input. */
const val CONTROLS_HIDE_MS = 5_000L
private const val BUBBLE_MS = 900L

/** The seek bubble, centred over the video. */
const val TAG_OVERLAY_BUBBLE = "overlay_bubble"
const val TAG_OVERLAY_ROOT = "overlay_root"

/**
 * The player overlay without an ExoPlayer: it owns the OSD visibility state, the 5 s auto-hide,
 * the seek bubble and the D-pad rules from [overlayIntent]. Whatever renders (the video, the
 * error panel, the loading spinner) is passed as [content]; this only layers the OSD and the
 * bubble above it and turns remote presses into [onSeek], [onTogglePause] and [onExit].
 */
@Composable
fun PlayerOverlayShell(
  position: Double,
  duration: Double,
  playing: Boolean,
  onSeek: (Double) -> Unit,
  onTogglePause: () -> Unit,
  onExit: () -> Unit,
  modifier: Modifier = Modifier,
  title: String,
  eyebrow: String,
  playFocus: FocusRequester,
  initiallyShown: Boolean = true,
  content: @Composable () -> Unit,
) {
  var controls by remember { mutableStateOf(initiallyShown) }
  var activity by remember { mutableIntStateOf(0) }
  var bubble by remember { mutableStateOf<String?>(null) }
  val rootFocus = remember { FocusRequester() }

  // Android 13+ hands the remote's Back to the back dispatcher, not to key listeners, so the
  // player claims it here; otherwise the detail underneath would take it and close instead.
  BackHandler {
    activity++
    val intent = playerKeyIntent(PlayerKey.Back, controls) ?: return@BackHandler
    if (intent.exit) onExit()
    if (intent.hideControls) controls = false
  }

  LaunchedEffect(controls, activity, playing) {
    if (controls && playing) {
      delay(CONTROLS_HIDE_MS)
      controls = false
    }
  }
  LaunchedEffect(bubble) {
    if (bubble != null) {
      delay(BUBBLE_MS)
      bubble = null
    }
  }

  // The hidden state needs a focus target of its own: the video is not focusable, so without this
  // the remote went dead once the OSD was gone.
  LaunchedEffect(controls) {
    if (controls) runCatching { playFocus.requestFocus() } else runCatching { rootFocus.requestFocus() }
  }

  fun seek(offsetSeconds: Double) {
    bubble = if (offsetSeconds < 0) "−10 s" else "+10 s"
    onSeek((position + offsetSeconds).coerceAtLeast(0.0))
  }

  Box(
    modifier
      .fillMaxSize()
      .testTag(TAG_OVERLAY_ROOT)
      .background(Color.Black)
      .focusRequester(rootFocus)
      .focusable()
      .onPreviewKeyEvent { event ->
        if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
        activity++
        val key = playerKeyOf(event.key) ?: return@onPreviewKeyEvent false
        val intent = playerKeyIntent(key, controls) ?: return@onPreviewKeyEvent false
        intent.seekSeconds?.let(::seek)
        if (intent.pausePlayback) onTogglePause()
        if (intent.exit) onExit()
        if (intent.showControls) controls = true
        if (intent.hideControls) controls = false
        true
      },
  ) {
    content()
    if (controls) {
      Osd(
        title = title,
        eyebrow = eyebrow,
        position = position,
        duration = duration,
        playing = playing,
        playFocus = playFocus,
        onBack10 = { seek(-SEEK_STEP_SECONDS) },
        onForward10 = { seek(SEEK_STEP_SECONDS) },
        onToggle = { activity++; onTogglePause() },
        onSeek = { fraction -> activity++; onSeek(fraction * duration) },
        onActivity = { activity++ },
      )
    }

    val bubbleText = bubble
    if (bubbleText != null) {
      Text(
        bubbleText,
        color = Tokens.Text,
        fontSize = 18.sp,
        fontWeight = FontWeight.ExtraBold,
        modifier = Modifier
          .align(Alignment.Center)
          .testTag(TAG_OVERLAY_BUBBLE)
          .background(Tokens.Bg.copy(alpha = 0.65f), RoundedCornerShape(999.dp))
          .padding(horizontal = 22.dp, vertical = 12.dp),
      )
      if (!controls) {
        MiniTimeline(fraction = if (duration > 0) (position / duration).toFloat() else 0f)
      }
    }
  }
}
