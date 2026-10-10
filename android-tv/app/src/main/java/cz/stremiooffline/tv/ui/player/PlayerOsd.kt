package cz.stremiooffline.tv.ui.player

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.theme.Tokens
import java.util.Locale

const val TAG_OSD_SEEK_BACK = "osd_seek_back"
const val TAG_OSD_SEEK_FORWARD = "osd_seek_forward"
const val TAG_OSD_PLAY = "osd_play"
const val TAG_OSD_BUBBLE = "osd_bubble"

/** The seek icons beside the plain `10` labels. */
const val SEEK_BACK_LABEL = "↺ 10"
const val SEEK_FORWARD_LABEL = "10 ↻"

@Composable
fun LoadingOverlay(title: String) {
  Box(
    Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.6f)),
    contentAlignment = Alignment.Center,
  ) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
      Spinner()
      Text(title, color = Tokens.Muted, fontSize = 12.sp)
    }
  }
}

@Composable
fun ErrorPanel(onRetry: () -> Unit, onBack: () -> Unit) {
  val retryFocus = remember { FocusRequester() }
  androidx.compose.runtime.LaunchedEffect(Unit) { runCatching { retryFocus.requestFocus() } }
  Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.75f)), contentAlignment = Alignment.Center) {
    Column(
      modifier = Modifier
        .background(Tokens.Panel, RoundedCornerShape(12.dp))
        .padding(horizontal = 32.dp, vertical = 24.dp),
      horizontalAlignment = Alignment.CenterHorizontally,
      verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      Box(
        Modifier.size(40.dp).background(Tokens.Red.copy(alpha = 0.14f), RoundedCornerShape(10.dp)),
        contentAlignment = Alignment.Center,
      ) {
        Text("!", color = Tokens.Red, fontSize = 20.sp, fontWeight = FontWeight.ExtraBold)
      }
      Text(stringResource(R.string.tv_player_error), color = Tokens.Muted, fontSize = 12.sp)
      Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        FocusButton(
          stringResource(R.string.tv_try_again),
          onClick = onRetry,
          modifier = Modifier.focusRequester(retryFocus),
          kind = FocusButtonKind.Primary,
        )
        FocusButton(stringResource(R.string.tv_back), onClick = onBack)
      }
    }
  }
}

@Composable
fun Osd(
  title: String,
  eyebrow: String,
  position: Double,
  duration: Double,
  playing: Boolean,
  playFocus: FocusRequester,
  onBack10: () -> Unit,
  onForward10: () -> Unit,
  onToggle: () -> Unit,
  onSeek: (Float) -> Unit,
  onActivity: () -> Unit,
) {
  Box(Modifier.fillMaxSize()) {
    Column(
      Modifier
        .align(Alignment.TopStart)
        .fillMaxWidth()
        .background(Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.8f), Color.Transparent)))
        .padding(horizontal = Tokens.SafeX, vertical = Tokens.SafeY),
      verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
      Text(eyebrow, color = Tokens.Accent, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.8.sp)
      Text(title, color = Tokens.Text, fontSize = 22.sp, fontWeight = FontWeight.ExtraBold)
    }

    Column(
      Modifier
        .align(Alignment.BottomStart)
        .fillMaxWidth()
        .background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.82f))))
        .padding(horizontal = Tokens.SafeX, vertical = Tokens.SafeY),
      verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(formatTime(position), color = Tokens.Text, fontSize = 11.sp)
        Timeline(
          fraction = if (duration > 0) (position / duration).toFloat() else 0f,
          onSeek = onSeek,
          onActivity = onActivity,
          modifier = Modifier.weight(1f),
        )
        Text(formatTime(duration), color = Tokens.Text, fontSize = 11.sp)
      }
      Row(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
        RoundButton(
          label = stringResource(R.string.tv_back10),
          text = SEEK_BACK_LABEL,
          tag = TAG_OSD_SEEK_BACK,
          onClick = onBack10,
          onActivity = onActivity,
        ) { SeekIcon(forward = false) }
        PlayButton(
          playing = playing,
          contentDescription = stringResource(if (playing) R.string.tv_pause else R.string.tv_play),
          onClick = onToggle,
          onActivity = onActivity,
          focusRequester = playFocus,
        )
        RoundButton(
          label = stringResource(R.string.tv_forward10),
          text = SEEK_FORWARD_LABEL,
          tag = TAG_OSD_SEEK_FORWARD,
          onClick = onForward10,
          onActivity = onActivity,
        ) { SeekIcon(forward = true) }
      }
    }
  }
}

@Composable
private fun Timeline(
  fraction: Float,
  onSeek: (Float) -> Unit,
  onActivity: () -> Unit,
  modifier: Modifier = Modifier,
) {
  var focused by remember { mutableStateOf(false) }
  val requester = remember { FocusRequester() }
  Box(
    modifier
      .height(28.dp)
      .focusRequester(requester)
      .focusable()
      .onFocusChanged { focused = it.isFocused }
      .onPreviewKeyEvent { event ->
        if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
        when (event.key) {
          Key.DirectionLeft -> { onActivity(); onSeek((fraction - 10f / 60f).coerceAtLeast(0f)); true }
          Key.DirectionRight -> { onActivity(); onSeek((fraction + 10f / 60f).coerceAtMost(1f)); true }
          else -> false
        }
      },
    contentAlignment = Alignment.CenterStart,
  ) {
    Box(
      Modifier
        .fillMaxWidth()
        .height(if (focused) 6.dp else 4.dp)
        .clip(RoundedCornerShape(999.dp))
        .background(Color.White.copy(alpha = 0.18f)),
    ) {
      Box(Modifier.fillMaxHeight().fillMaxWidth(fraction.coerceIn(0f, 1f)).background(Tokens.Accent))
    }
    if (focused) {
      Box(
        Modifier.fillMaxWidth(fraction.coerceIn(0f, 1f)).height(28.dp),
        contentAlignment = Alignment.CenterEnd,
      ) {
        Box(Modifier.size(14.dp).clip(CircleShape).background(Color.White))
      }
    }
  }
}

@Composable
private fun PlayButton(
  playing: Boolean,
  contentDescription: String,
  onClick: () -> Unit,
  onActivity: () -> Unit,
  focusRequester: FocusRequester,
) {
  var focused by remember { mutableStateOf(false) }
  Box(
    Modifier
      .size(46.dp)
      .testTag(TAG_OSD_PLAY)
      .clip(CircleShape)
      .background(Tokens.AccentGradient)
      .semantics { this.contentDescription = contentDescription }
      .focusRequester(focusRequester)
      .focusable()
      .onFocusChanged { focused = it.isFocused }
      .clickable { onActivity(); onClick() },
    contentAlignment = Alignment.Center,
  ) {
    if (focused) Box(Modifier.fillMaxSize().clip(CircleShape).background(Color.White.copy(alpha = 0.12f)))
    if (playing) PauseIcon() else PlayIcon()
  }
}

@Composable
private fun RoundButton(
  label: String,
  text: String?,
  tag: String,
  onClick: () -> Unit,
  onActivity: () -> Unit,
  content: @Composable () -> Unit,
) {
  var focused by remember { mutableStateOf(false) }
  Box(
    Modifier
      .testTag(tag)
      .clip(CircleShape)
      .background(if (focused) Color.White else Color.White.copy(alpha = 0.14f))
      .semantics { this.contentDescription = label }
      .focusable()
      .onFocusChanged { focused = it.isFocused }
      .clickable { onActivity(); onClick() }
      .padding(horizontal = 16.dp, vertical = 9.dp),
    contentAlignment = Alignment.Center,
  ) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
      content()
      if (text != null) {
        Text(text, color = if (focused) Tokens.Bg else Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold)
      }
    }
  }
}

@Composable
fun MiniTimeline(fraction: Float) {
  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.BottomStart) {
    Box(Modifier.fillMaxWidth().height(2.5.dp).background(Color.White.copy(alpha = 0.2f))) {
      Box(Modifier.fillMaxHeight().fillMaxWidth(fraction.coerceIn(0f, 1f)).background(Tokens.Accent))
    }
  }
}

@Composable
private fun Spinner() {
  val transition = rememberInfiniteTransition(label = "spin")
  val angle by transition.animateFloat(
    initialValue = 0f,
    targetValue = 360f,
    animationSpec = infiniteRepeatable(tween(900, easing = LinearEasing)),
    label = "angle",
  )
  Canvas(Modifier.size(46.dp).rotate(angle)) {
    drawArc(
      color = Tokens.Accent,
      startAngle = 0f,
      sweepAngle = 280f,
      useCenter = false,
      style = Stroke(width = 4.dp.toPx(), cap = StrokeCap.Round),
    )
  }
}

/** The seek icon: a ring with a gap that opens on the side the seek goes to. */
@Composable
private fun SeekIcon(forward: Boolean) {
  Canvas(Modifier.size(20.dp)) {
    drawArc(
      color = Color.White,
      startAngle = if (forward) 120f else 60f,
      sweepAngle = 240f,
      useCenter = false,
      style = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round),
    )
  }
}

@Composable
private fun PlayIcon() {
  Canvas(Modifier.size(16.dp)) {
    val path = Path().apply {
      moveTo(size.width * 0.18f, 0f)
      lineTo(size.width, size.height / 2f)
      lineTo(size.width * 0.18f, size.height)
      close()
    }
    drawPath(path, Color.White)
  }
}

@Composable
private fun PauseIcon() {
  Canvas(Modifier.size(16.dp)) {
    drawRect(Color.White, topLeft = Offset(0f, 0f), size = Size(size.width * 0.28f, size.height))
    drawRect(Color.White, topLeft = Offset(size.width * 0.62f, 0f), size = Size(size.width * 0.28f, size.height))
  }
}

private fun formatTime(seconds: Double): String {
  val total = seconds.toInt().coerceAtLeast(0)
  return String.format(Locale.US, "%02d:%02d", total / 60, total % 60)
}
