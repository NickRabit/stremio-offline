package cz.stremiooffline.tv.ui.components

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Border
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Glow
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import coil.compose.AsyncImage
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.ui.theme.Tokens

/** Room a focused card's scale and glow need inside a scrolling viewport, so the first one is
 *  not clipped by the row or grid it lives in. */
val CardRowInset = 24.dp

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
  fallbackImageUrl: String? = null,
  mosaic: List<String> = emptyList(),
  /** Try an image before the collage and use the collage only when every image fails. */
  imageBeforeMosaic: Boolean = false,
) {
  var focused by remember { mutableStateOf(false) }
  val candidates = remember(imageUrl, fallbackImageUrl) { listOfNotNull(imageUrl, fallbackImageUrl).distinct() }
  var artIndex by remember(imageUrl, fallbackImageUrl) { mutableIntStateOf(0) }
  val art = candidates.getOrNull(artIndex)
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
        val collage = mosaic.size >= 2
        val imageShown = art != null && (!collage || imageBeforeMosaic)
        if (imageShown) {
          AsyncImage(
            model = art,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            onError = { artIndex += 1 },
            modifier = Modifier.fillMaxSize(),
          )
        }
        // As on the web, two or more covers inside normally win over the folder's own picture.
        if (collage && (!imageBeforeMosaic || art == null)) {
          PosterMosaic(mosaic, label = stringResource(R.string.library_mosaic_alt, mosaic.size.toString()))
        }
        // The name over the artwork is the gradient fallback; with a real poster it would only
        // fight the picture.
        if (!imageShown && !collage) {
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

/** Library roots share the web tile's artwork-left, information-right layout. */
@Composable
fun LibraryRootCard(
  name: String,
  caption: String?,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
  cardTag: String? = null,
  poster: String? = null,
  composedMosaic: String? = null,
  posters: List<String> = emptyList(),
  count: Int? = null,
  fallback: @Composable () -> Unit,
) {
  val artPhases = remember(composedMosaic, poster, posters) {
    libraryRootArtPhases(composedMosaic, posters, poster)
  }
  var artIndex by remember(artPhases) { mutableIntStateOf(0) }
  val artPhase = artPhases.getOrElse(artIndex) { LibraryRootArtPhase.Fallback }
  val shape = RoundedCornerShape(11.dp)
  Surface(
    onClick = onClick,
    modifier = modifier
      .fillMaxWidth()
      .height(164.dp)
      .then(if (cardTag != null) Modifier.testTag(cardTag) else Modifier),
    shape = ClickableSurfaceDefaults.shape(shape = shape),
    scale = ClickableSurfaceDefaults.scale(focusedScale = 1.03f),
    glow = ClickableSurfaceDefaults.glow(focusedGlow = Glow(Tokens.Accent2.copy(alpha = 0.3f), 16.dp)),
    border = ClickableSurfaceDefaults.border(
      border = Border(BorderStroke(1.dp, Tokens.Line), shape = shape),
      focusedBorder = Border(BorderStroke(2.dp, Tokens.Accent2), shape = shape),
    ),
    colors = ClickableSurfaceDefaults.colors(containerColor = Tokens.Panel, focusedContainerColor = Tokens.Panel2),
  ) {
    Row(Modifier.fillMaxSize().clip(shape), verticalAlignment = Alignment.CenterVertically) {
      Box(
        Modifier
          .width(132.dp)
          .fillMaxSize()
          .background(Brush.verticalGradient(listOf(Tokens.Panel2, Tokens.Bg))),
      ) {
        when (artPhase) {
          LibraryRootArtPhase.Composed -> AsyncImage(
            model = composedMosaic,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            onError = { artIndex++ },
            modifier = Modifier.fillMaxSize(),
          )
          LibraryRootArtPhase.Collage -> PosterMosaic(
            posters = posters,
            label = stringResource(R.string.library_mosaic_alt, posters.size.toString()),
            onAllFailed = { artIndex++ },
          )
          LibraryRootArtPhase.SinglePoster -> AsyncImage(
            model = posters.firstOrNull(),
            contentDescription = null,
            contentScale = ContentScale.Crop,
            onError = { artIndex++ },
            modifier = Modifier.fillMaxSize(),
          )
          LibraryRootArtPhase.OwnPoster -> AsyncImage(
            model = poster,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            onError = { artIndex++ },
            modifier = Modifier.fillMaxSize(),
          )
          LibraryRootArtPhase.Fallback -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { fallback() }
        }
        if (count != null) {
          Box(
            Modifier
              .align(Alignment.TopEnd)
              .padding(9.dp)
              .clip(RoundedCornerShape(999.dp))
              .background(Tokens.Bg.copy(alpha = 0.86f))
              .padding(horizontal = 9.dp, vertical = 4.dp)
              .semantics(mergeDescendants = true) {}
              .then(if (cardTag != null) Modifier.testTag(libraryRootCountTag(cardTag)) else Modifier),
          ) {
            Text(count.toString(), color = Tokens.Text, fontSize = 10.sp, fontWeight = FontWeight.ExtraBold)
          }
        }

      }
      Column(
        Modifier.weight(1f).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        Text(name, color = Tokens.Text, fontSize = 16.sp, fontWeight = FontWeight.Bold, maxLines = 3, overflow = TextOverflow.Ellipsis)
        if (!caption.isNullOrBlank()) {
          Text(caption, color = Tokens.Muted, fontSize = 11.sp, maxLines = 3, overflow = TextOverflow.Ellipsis)
        }
      }
    }
  }
}

internal enum class LibraryRootArtPhase { Composed, Collage, SinglePoster, OwnPoster, Fallback }

internal fun libraryRootArtPhases(composedMosaic: String?, posters: List<String>, poster: String?): List<LibraryRootArtPhase> =
  buildList {
    if (composedMosaic != null) add(LibraryRootArtPhase.Composed)
    if (posters.size >= 2) add(LibraryRootArtPhase.Collage)
    if (posters.size == 1) add(LibraryRootArtPhase.SinglePoster)
    if (poster != null) add(LibraryRootArtPhase.OwnPoster)
    add(LibraryRootArtPhase.Fallback)
  }

fun libraryRootCountTag(cardTag: String): String = "library_count_$cardTag"

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
  fallbackImageUrl: String? = null,
) {
  var focused by remember { mutableStateOf(false) }
  val candidates = remember(imageUrl, fallbackImageUrl) { listOfNotNull(imageUrl, fallbackImageUrl).distinct() }
  var artIndex by remember(imageUrl, fallbackImageUrl) { mutableIntStateOf(0) }
  val art = candidates.getOrNull(artIndex)
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
        if (art != null) {
          AsyncImage(
            model = art,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            onError = { artIndex += 1 },
            modifier = Modifier.fillMaxSize(),
          )
        }
        // The title over the artwork is the gradient fallback; with a real still it would only
        // fight the picture.
        if (art == null) {
          Text(
            label,
            color = Tokens.Text,
            fontSize = 10.sp,
            fontWeight = FontWeight.ExtraBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.align(Alignment.BottomStart).padding(7.dp),
          )
        }
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

/** A row of grey cards with a slow shimmer, shown while a page loads. */
@Composable
fun ShimmerCards(count: Int = 6, modifier: Modifier = Modifier) {
  Row(modifier, horizontalArrangement = Arrangement.spacedBy(18.dp)) {
    repeat(count) { ShimmerCard() }
  }
}

/** One shimmering placeholder card, for example a catalogue row not revealed yet. */
@Composable
fun ShimmerCard(modifier: Modifier = Modifier, width: Dp = 110.dp, height: Dp = 165.dp) {
  Box(
    modifier
      .size(width, height)
      .clip(RoundedCornerShape(10.dp))
      .background(Brush.verticalGradient(listOf(Tokens.Panel, Tokens.Panel2)))
      .alpha(shimmerAlpha()),
  )
}

/** A shimmering bar standing in for a line of text that is still loading. */
@Composable
fun ShimmerLine(width: Dp, height: Dp = 11.dp, modifier: Modifier = Modifier) {
  Box(
    modifier
      .size(width, height)
      .clip(RoundedCornerShape(999.dp))
      .background(Tokens.Panel2)
      .alpha(shimmerAlpha()),
  )
}

/** The slow pulse both shimmering placeholders share. */
@Composable
private fun shimmerAlpha(): Float {
  val transition = rememberInfiniteTransition(label = "shimmer")
  val alpha by transition.animateFloat(
    initialValue = 0.35f,
    targetValue = 0.75f,
    animationSpec = infiniteRepeatable(tween(900), RepeatMode.Reverse),
    label = "shimmerAlpha",
  )
  return alpha
}

/** A small turning arc for a button that is waiting on the server. */
@Composable
fun TvSpinner(size: Dp = 13.dp, color: Color = Color.White, modifier: Modifier = Modifier) {
  val transition = rememberInfiniteTransition(label = "spinner")
  val angle by transition.animateFloat(
    initialValue = 0f,
    targetValue = 360f,
    animationSpec = infiniteRepeatable(tween(900, easing = LinearEasing)),
    label = "spinnerAngle",
  )
  Canvas(modifier.size(size).rotate(angle)) {
    val stroke = this.size.minDimension / 7f
    drawArc(
      color = color,
      startAngle = 0f,
      sweepAngle = 250f,
      useCenter = false,
      style = Stroke(width = stroke),
    )
  }
}

const val TagPosterMosaic = "poster_mosaic"

/** Where each of up to five covers sits in the collage, as fractions of the card: the web's
 *  `.library-preview-collage` -- a large cover on the left, four smaller ones tilted over it. */
private data class MosaicSlot(val x: Float, val y: Float, val w: Float, val h: Float, val tilt: Float)

private val MosaicSlots = listOf(
  MosaicSlot(0f, 0f, 0.70f, 1f, 0f),
  MosaicSlot(0.26f, 0.02f, 0.55f, 0.54f, -3f),
  MosaicSlot(0.61f, 0.08f, 0.42f, 0.43f, 4f),
  MosaicSlot(0.28f, 0.54f, 0.43f, 0.42f, 2f),
  MosaicSlot(0.49f, 0.47f, 0.55f, 0.51f, -3f),
)

/** A library or folder without a cover of its own shows a collage of the covers inside it. */
@Composable
fun PosterMosaic(
  posters: List<String>,
  label: String,
  modifier: Modifier = Modifier,
  onAllFailed: (() -> Unit)? = null,
) {
  BoxWithConstraints(
    modifier
      .fillMaxSize()
      .background(Tokens.Bg)
      .testTag(TagPosterMosaic)
      .semantics { contentDescription = label },
  ) {
    val slotShape = RoundedCornerShape(4.dp)
    // A cover that fails to load leaves its slot empty instead of drawing a broken frame.
    val broken = remember(posters) { mutableStateListOf<Int>() }
    LaunchedEffect(broken.size, posters) {
      if (onAllFailed != null && broken.size >= posters.take(MosaicSlots.size).size) onAllFailed()
    }
    posters.take(MosaicSlots.size).forEachIndexed { index, url ->
      if (index in broken) return@forEachIndexed
      val slot = MosaicSlots[index]
      val first = index == 0
      AsyncImage(
        model = url,
        onError = { broken.add(index) },
        contentDescription = null,
        contentScale = ContentScale.Crop,
        modifier = Modifier
          .offset(x = maxWidth * slot.x, y = maxHeight * slot.y)
          .size(maxWidth * slot.w, maxHeight * slot.h)
          .rotate(slot.tilt)
          .then(
            if (first) Modifier
            else Modifier.shadow(6.dp, slotShape).clip(slotShape).border(1.5.dp, Tokens.Line, slotShape),
          ),
      )
    }
  }
}
