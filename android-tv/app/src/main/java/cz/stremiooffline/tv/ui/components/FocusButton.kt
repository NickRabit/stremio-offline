package cz.stremiooffline.tv.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Border
import androidx.tv.material3.Button
import androidx.tv.material3.ButtonDefaults
import androidx.tv.material3.Glow
import androidx.tv.material3.Text
import cz.stremiooffline.tv.ui.theme.Tokens

enum class FocusButtonKind { Primary, Normal, Icon }

/** The one button of the app: tinted when it is merely there, accent-filled while focused. */
@Composable
fun FocusButton(
  text: String,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
  kind: FocusButtonKind = FocusButtonKind.Normal,
  leading: (@Composable () -> Unit)? = null,
  contentDescription: String? = null,
) {
  val interaction = remember { MutableInteractionSource() }
  val focused by interaction.collectIsFocusedAsState()
  val shape = RoundedCornerShape(8.dp)
  val container = if (kind == FocusButtonKind.Primary) Tokens.Accent.copy(alpha = 0.15f) else Tokens.Panel2
  val content = if (kind == FocusButtonKind.Primary) Tokens.Accent2 else Tokens.Text
  val border = if (kind == FocusButtonKind.Primary) Tokens.Accent.copy(alpha = 0.44f) else Tokens.Line

  Button(
    onClick = onClick,
    modifier = modifier
      .then(if (kind == FocusButtonKind.Icon) Modifier.size(36.dp) else Modifier.height(36.dp))
      .then(if (contentDescription != null) Modifier.semantics { this.contentDescription = contentDescription } else Modifier)
      .background(if (focused) Tokens.AccentGradient else SolidColor(Color.Transparent), shape),
    scale = ButtonDefaults.scale(focusedScale = 1.06f),
    glow = ButtonDefaults.glow(focusedGlow = Glow(Tokens.Accent.copy(alpha = 0.35f), 20.dp)),
    shape = ButtonDefaults.shape(shape = shape),
    colors = ButtonDefaults.colors(
      containerColor = container,
      contentColor = content,
      focusedContainerColor = Color.Transparent,
      focusedContentColor = Color.White,
      pressedContainerColor = Color.Transparent,
      pressedContentColor = Color.White,
    ),
    border = ButtonDefaults.border(
      border = Border(BorderStroke(1.dp, border), shape = shape),
      focusedBorder = Border.None,
    ),
    contentPadding = PaddingValues(horizontal = if (kind == FocusButtonKind.Icon) 0.dp else 16.dp),
    interactionSource = interaction,
  ) {
    if (leading != null) {
      leading()
      Spacer(Modifier.width(8.dp))
    }
    Text(text, fontSize = 12.5.sp, fontWeight = FontWeight.Bold)
  }
}

/** The brand mark: the accent-to-plum gradient square with the white play circle, at any size. */
@Composable
fun BrandMark(dimension: Dp, corner: Dp, modifier: Modifier = Modifier) {
  Box(
    modifier = modifier
      .size(dimension)
      .clip(RoundedCornerShape(corner))
      .drawBehind { drawRect(brandGradient(size)) },
    contentAlignment = Alignment.Center,
  ) {
    Canvas(Modifier.fillMaxSize()) {
      val unit = size.minDimension / 24f
      drawCircle(
        color = Color.White,
        radius = 9f * unit,
        center = Offset(12f * unit, 12f * unit),
        style = Stroke(width = 2f * unit),
      )
      drawPath(
        Path().apply {
          moveTo(10f * unit, 8.5f * unit)
          lineTo(10f * unit, 15.5f * unit)
          lineTo(16f * unit, 12f * unit)
          close()
        },
        color = Color.White,
      )
    }
  }
}

/** The prototype's `linear-gradient(145deg, accent, plum)`, expressed in screen coordinates. */
private fun brandGradient(size: Size): Brush {
  val dx = 0.5736f
  val dy = 0.8192f
  val half = (size.width * dx + size.height * dy) / 2f
  val cx = size.width / 2f
  val cy = size.height / 2f
  return Brush.linearGradient(
    colors = listOf(Tokens.Accent, Tokens.Plum),
    start = Offset(cx - dx * half, cy - dy * half),
    end = Offset(cx + dx * half, cy + dy * half),
  )
}
