package cz.stremiooffline.tv.ui.components

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Border
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Glow
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import coil.compose.AsyncImage
import cz.stremiooffline.tv.ui.theme.Tokens

/** A 110x165 poster card: the image or a gradient, a title in the lower part, an optional bar. */
@Composable
fun PosterCard(
  name: String,
  imageUrl: String?,
  progress: Float?,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
  caption: String? = null,
  cardTag: String? = null,
) {
  var focused by remember { mutableStateOf(false) }
  var imageFailed by remember(imageUrl) { mutableStateOf(false) }
  val shape = RoundedCornerShape(10.dp)
  Column(modifier) {
    Surface(
      onClick = onClick,
      modifier = Modifier
        .size(110.dp, 165.dp)
        .then(if (cardTag != null) Modifier.testTag(cardTag) else Modifier)
        .onFocusChanged { focused = it.isFocused },
      shape = ClickableSurfaceDefaults.shape(shape = shape),
      scale = ClickableSurfaceDefaults.scale(focusedScale = 1.08f),
      glow = ClickableSurfaceDefaults.glow(focusedGlow = Glow(Tokens.Accent2.copy(alpha = 0.35f), 18.dp)),
      border = ClickableSurfaceDefaults.border(
        border = Border.None,
        focusedBorder = Border(BorderStroke(2.dp, Tokens.Accent2), shape = shape),
      ),
      colors = ClickableSurfaceDefaults.colors(
        containerColor = Color.Transparent,
        focusedContainerColor = Color.Transparent,
      ),
    ) {
      Box(
        Modifier
          .fillMaxSize()
          .clip(shape)
          .background(Brush.verticalGradient(listOf(Tokens.Panel2, Tokens.Bg))),
      ) {
        if (imageUrl != null) {
          AsyncImage(
            model = imageUrl,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            onSuccess = { imageFailed = false },
            onError = { imageFailed = true },
            modifier = Modifier.fillMaxSize(),
          )
        }
        // The name over the artwork is the gradient fallback; with a real poster it would only
        // fight the picture.
        if (imageUrl == null || imageFailed) {
          Text(
            name,
            color = Tokens.Text,
            fontSize = 12.sp,
            fontWeight = FontWeight.ExtraBold,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.align(Alignment.BottomStart).padding(8.dp),
          )
        }
        if (progress != null) {
          Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(3.5.dp).background(Tokens.Line)) {
            Box(Modifier.fillMaxWidth(progress.coerceIn(0f, 1f)).height(3.5.dp).background(Tokens.Accent))
          }
        }
      }
    }
    Spacer(Modifier.height(6.dp))
    Text(
      name,
      color = Tokens.Text,
      fontSize = 11.sp,
      fontWeight = FontWeight.SemiBold,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
      modifier = Modifier.width(110.dp).alpha(if (focused) 1f else 0.7f),
    )
    if (caption != null) {
      Text(
        caption,
        color = Tokens.Muted,
        fontSize = 9.5.sp,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.width(110.dp).alpha(if (focused) 1f else 0.7f),
      )
    }
  }
}

/** A 190x107 wide card for one file of a title, with its episode label and watch state. */
@Composable
fun WideCard(
  label: String,
  imageUrl: String?,
  progress: Float?,
  completed: Boolean,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
  cardTag: String? = null,
  caption: String? = null,
) {
  var focused by remember { mutableStateOf(false) }
  val shape = RoundedCornerShape(10.dp)
  Column(modifier) {
    Surface(
      onClick = onClick,
      modifier = Modifier
        .size(190.dp, 107.dp)
        .then(if (cardTag != null) Modifier.testTag(cardTag) else Modifier)
        .onFocusChanged { focused = it.isFocused },
      shape = ClickableSurfaceDefaults.shape(shape = shape),
      scale = ClickableSurfaceDefaults.scale(focusedScale = 1.06f),
      glow = ClickableSurfaceDefaults.glow(focusedGlow = Glow(Tokens.Accent2.copy(alpha = 0.35f), 18.dp)),
      border = ClickableSurfaceDefaults.border(
        border = Border.None,
        focusedBorder = Border(BorderStroke(2.dp, Tokens.Accent2), shape = shape),
      ),
      colors = ClickableSurfaceDefaults.colors(
        containerColor = Color.Transparent,
        focusedContainerColor = Color.Transparent,
      ),
    ) {
      Box(
        Modifier
          .fillMaxSize()
          .clip(shape)
          .background(Brush.verticalGradient(listOf(Tokens.Panel2, Tokens.Bg))),
      ) {
        if (imageUrl != null) {
          AsyncImage(
            model = imageUrl,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxSize(),
          )
        }
        Text(
          label,
          color = Tokens.Text,
          fontSize = 10.sp,
          fontWeight = FontWeight.ExtraBold,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
          modifier = Modifier.align(Alignment.BottomStart).padding(7.dp),
        )
        if (progress != null) {
          Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(3.dp).background(Tokens.Line)) {
            Box(Modifier.fillMaxWidth(progress.coerceIn(0f, 1f)).height(3.dp).background(Tokens.Accent))
          }
        }
        if (completed) {
          Box(
            Modifier
              .align(Alignment.TopEnd)
              .padding(6.dp)
              .size(18.dp)
              .clip(RoundedCornerShape(999.dp))
              .background(Tokens.Bg.copy(alpha = 0.7f)),
            contentAlignment = Alignment.Center,
          ) {
            Text("✓", color = Tokens.Green, fontSize = 10.sp, fontWeight = FontWeight.ExtraBold)
          }
        }
      }
    }
    Spacer(Modifier.height(5.dp))
    Text(
      label,
      color = Tokens.Text,
      fontSize = 10.sp,
      fontWeight = FontWeight.SemiBold,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
      modifier = Modifier.width(190.dp).alpha(if (focused) 1f else 0.75f),
    )
    if (caption != null) {
      Text(
        caption,
        color = Tokens.Muted,
        fontSize = 9.5.sp,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.width(190.dp).alpha(if (focused) 1f else 0.75f),
      )
    }
  }
}

/** Six grey cards with a slow shimmer, shown while a page loads. */
@Composable
fun ShimmerCards(count: Int = 6, modifier: Modifier = Modifier) {
  val transition = rememberInfiniteTransition(label = "shimmer")
  val alpha by transition.animateFloat(
    initialValue = 0.35f,
    targetValue = 0.75f,
    animationSpec = infiniteRepeatable(tween(900), RepeatMode.Reverse),
    label = "shimmerAlpha",
  )
  Row(modifier, horizontalArrangement = Arrangement.spacedBy(18.dp)) {
    repeat(count) {
      Box(
        Modifier
          .size(110.dp, 165.dp)
          .clip(RoundedCornerShape(10.dp))
          .background(Brush.verticalGradient(listOf(Tokens.Panel, Tokens.Panel2)))
          .alpha(alpha),
      )
    }
  }
}
