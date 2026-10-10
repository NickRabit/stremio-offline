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
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
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
import androidx.compose.ui.res.stringResource
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.playback.PlaybackController
import cz.stremiooffline.tv.ui.theme.Tokens
import java.util.Locale
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** The controls hide after five seconds of playback with no input. */
const val CONTROLS_HIDE_MS = 5_000L
private const val BUBBLE_MS = 900L

/** How long the refused-seek message stays up, as the web shows it. */
const val SEEK_KEPT_MS = 3_000L

/** The seek bubble, centred over the video. */
const val TAG_OVERLAY_BUBBLE = "overlay_bubble"
const val TAG_OVERLAY_ROOT = "overlay_root"
const val TAG_OVERLAY_SEEK_KEPT = "overlay_seek_kept"

/**
 * The player overlay without an ExoPlayer: it owns the OSD visibility state, the 5 s auto-hide,
 * the seek bubble and the D-pad rules from [playerKeyIntent]. Whatever renders (the video, the
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
  /** Bumped when the controls have to come back, as they do after the background. */
  showControls: Int = 0,
  /** Bumped when the server refused a seek; the message shows for [SEEK_KEPT_MS]. */
  seekKept: Int = 0,
  /** A panel or the next-episode card is up: it owns the D-pad, Back and the auto-hide timer. */
  modal: Boolean = false,
  onTracks: () -> Unit = {},
  tracksText: String = "",
  tracksLabel: String = "",
  tracksFocus: FocusRequester? = null,
  onNext: (() -> Unit)? = null,
  nextLabel: String = "",
  onDiagnostics: () -> Unit = {},
  diagnosticsLabel: String = "",
  diagnosticsFocus: FocusRequester? = null,
  content: @Composable () -> Unit,
) {
  var controls by remember { mutableStateOf(initiallyShown) }
  var activity by remember { mutableIntStateOf(0) }
  var bubble by remember { mutableStateOf<String?>(null) }
  var kept by remember { mutableStateOf(false) }
  val rootFocus = remember { FocusRequester() }
  val scope = rememberCoroutineScope()

  // The accumulated target of the held seek key. Nothing is sent until the presses stop, so a
  // held key becomes one seek instead of a dozen.
  var preview by remember { mutableDoubleStateOf(Double.NaN) }
  var previewStart by remember { mutableDoubleStateOf(0.0) }
  var previewDirection by remember { mutableIntStateOf(0) }
  var holdStart by remember { mutableLongStateOf(0L) }
  var seekTimer by remember { mutableStateOf<Job?>(null) }
  val previewing = !preview.isNaN()

  fun commitSeek() {
    seekTimer?.cancel()
    seekTimer = null
    if (preview.isNaN()) return
    val target = preview
    preview = Double.NaN
    previewDirection = 0
    onSeek(target)
    bubble = seekBubble((target - previewStart).toLong())
  }

  fun pressSeek(direction: Int, eventTime: Long) {
    val base = if (preview.isNaN()) position else preview
    if (preview.isNaN()) previewStart = position
    if (previewDirection != direction) {
      previewDirection = direction
      holdStart = eventTime
    }
    val limit = if (duration > 0) duration else Double.MAX_VALUE
    preview = (base + direction * seekStep(eventTime - holdStart)).coerceIn(0.0, limit)
    seekTimer?.cancel()
    seekTimer = scope.launch {
      delay(PlaybackController.SEEK_DEBOUNCE_MS)
      commitSeek()
    }
  }

  // Android 13+ hands the remote's Back to the back dispatcher, not to key listeners, so the
  // player claims it here; otherwise the detail underneath would take it and close instead.
  BackHandler {
    activity++
    val intent = playerKeyIntent(PlayerKey.Back, controls) ?: return@BackHandler
    if (intent.exit) onExit()
    if (intent.hideControls) controls = false
  }

  LaunchedEffect(controls, activity, playing, modal) {
    if (controls && playing && !modal) {
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
  LaunchedEffect(showControls) {
    if (showControls > 0) controls = true
  }
  LaunchedEffect(seekKept) {
    if (seekKept > 0) {
      kept = true
      delay(SEEK_KEPT_MS)
      kept = false
    }
  }

  // The hidden state needs a focus target of its own: the video is not focusable, so without this
  // the remote went dead once the OSD was gone.
  LaunchedEffect(controls) {
    if (controls) runCatching { playFocus.requestFocus() } else runCatching { rootFocus.requestFocus() }
  }

  fun seekBy(offsetSeconds: Double) {
    val from = if (!preview.isNaN()) preview else position
    // A button press inside a held burst takes the burst over, so its pending commit never follows.
    seekTimer?.cancel()
    seekTimer = null
    preview = Double.NaN
    previewDirection = 0
    val target = (from + offsetSeconds).coerceAtLeast(0.0)
    bubble = seekBubble(offsetSeconds.toLong())
    onSeek(target)
  }

  val shownPosition = if (previewing) preview else position
  val bubbleText = if (previewing) seekBubble((preview - previewStart).toLong()) else bubble

  Box(
    modifier
      .fillMaxSize()
      .testTag(TAG_OVERLAY_ROOT)
      .background(Color.Black)
      .focusRequester(rootFocus)
      .focusable()
      .onPreviewKeyEvent { event ->
        if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
        // A panel or the card has the remote: it traps focus itself, so the shell steps aside.
        if (modal) return@onPreviewKeyEvent false
        activity++
        // The media keys seek like the pad, held or not.
        when (event.key) {
          Key.MediaFastForward -> { pressSeek(1, event.nativeKeyEvent.eventTime); return@onPreviewKeyEvent true }
          Key.MediaRewind -> { pressSeek(-1, event.nativeKeyEvent.eventTime); return@onPreviewKeyEvent true }
        }
        val key = playerKeyOf(event.key) ?: return@onPreviewKeyEvent false
        val intent = playerKeyIntent(key, controls) ?: return@onPreviewKeyEvent false
        intent.seekDirection?.let { pressSeek(it, event.nativeKeyEvent.eventTime) }
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
        position = shownPosition,
        duration = duration,
        playing = playing,
        playFocus = playFocus,
        onBack10 = { seekBy(-SEEK_STEP_SECONDS) },
        onForward10 = { seekBy(SEEK_STEP_SECONDS) },
        onToggle = { activity++; onTogglePause() },
        onSeekStep = { direction, eventTime -> pressSeek(direction, eventTime) },
        onActivity = { activity++ },
        onTracks = onTracks,
        tracksText = tracksText,
        tracksLabel = tracksLabel,
        tracksFocus = tracksFocus,
        onNext = onNext,
        nextLabel = nextLabel,
        onDiagnostics = onDiagnostics,
        diagnosticsLabel = diagnosticsLabel,
        diagnosticsFocus = diagnosticsFocus,
      )
    }

    val text = bubbleText
    if (text != null) {
      Text(
        text,
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
        MiniTimeline(fraction = if (duration > 0) (shownPosition / duration).toFloat() else 0f)
      }
    }

    if (kept) {
      Text(
        stringResource(R.string.player_seek_restored),
        color = Tokens.Text,
        fontSize = 16.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier
          .align(Alignment.TopCenter)
          .testTag(TAG_OVERLAY_SEEK_KEPT)
          .background(Tokens.Bg.copy(alpha = 0.7f), RoundedCornerShape(999.dp))
          .padding(horizontal = 22.dp, vertical = 10.dp),
      )
    }
  }
}

/** The bubble's `+1:30` / `−0:10`. */
internal fun seekBubble(deltaSeconds: Long): String {
  val total = kotlin.math.abs(deltaSeconds)
  return String.format(Locale.US, "%s%d:%02d", if (deltaSeconds < 0) "\u2212" else "+", total / 60, total % 60)
}
