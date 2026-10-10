package cz.stremiooffline.tv.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.darkColorScheme

object Tokens {
  val Bg = Color(0xFF0B0E13)
  val Panel = Color(0xFF141922)
  val Panel2 = Color(0xFF1B222D)
  val Line = Color(0xFF29313E)
  val Text = Color(0xFFF1F4F8)
  val Muted = Color(0xFF929EAE)
  val Accent = Color(0xFFFF5B38)
  val Accent2 = Color(0xFFFF795C)
  val Plum = Color(0xFFA83C79)
  val Green = Color(0xFF42CE91)
  val Red = Color(0xFFF06A76)
  val Gold = Color(0xFFE9B560)
  val AccentGradient = Brush.linearGradient(listOf(Accent, Accent2))
  val SafeX = 48.dp
  val SafeY = 27.dp
}

/** The page behind everything: the plum glow of the web app over the background token. */
fun Modifier.appBackground(): Modifier = drawBehind {
  drawRect(Tokens.Bg)
  drawRect(
    Brush.radialGradient(
      0f to Color(0xFF252031),
      0.33f to Color.Transparent,
      center = Offset(size.width * 0.78f, -size.height * 0.1f),
      radius = size.width * 0.45f,
    )
  )
}

@Composable
fun StremioTheme(content: @Composable () -> Unit) {
  MaterialTheme(
    colorScheme = darkColorScheme(
      primary = Tokens.Accent,
      onPrimary = Color.White,
      background = Tokens.Bg,
      onBackground = Tokens.Text,
      surface = Tokens.Panel,
      onSurface = Tokens.Text,
      surfaceVariant = Tokens.Panel2,
      onSurfaceVariant = Tokens.Muted,
      error = Tokens.Red,
      onError = Color.White,
      border = Tokens.Line,
    ),
    content = content,
  )
}
