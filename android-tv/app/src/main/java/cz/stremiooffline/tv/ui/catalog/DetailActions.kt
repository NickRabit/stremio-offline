package cz.stremiooffline.tv.ui.catalog

import cz.stremiooffline.tv.R
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.remember
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Icon
import androidx.tv.material3.Text
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.components.outlineIcon
import cz.stremiooffline.tv.ui.theme.Tokens

/**
 * The name of the icon button that holds the remote. Every icon now carries its own short name
 * under it, as on the web; this keeps the full name for whoever still reads it. The state sits in an
 * object of its own because the detail screens are already near the size ART can verify.
 */
class ActionCaption {
  var text by mutableStateOf("")
}

/** The short name under the focused icon; the others carry the same line, dimmed. */
const val TagActionCaption = "detail_action_caption"

val DetailActionHeight = 44.dp

/** One secondary action of a detail's action row. */
class DetailAction(
  val label: String,
  val icon: ImageVector?,
  val onClick: () -> Unit,
  val tag: String,
  val enabled: Boolean = true,
  /** A text glyph instead of the icon (the favourite star). */
  val glyph: String = "",
  /** Extra modifiers the caller needs on the button (focus requesters, focus listeners). */
  val modifier: Modifier = Modifier,
  /** The short name under the icon; empty takes the row's name for the slot, else [label]. */
  val short: String = "",
)

/**
 * The one action row every title detail draws: Play, Sources, Start over, To library, Favourite,
 * Mark as unwatched, Mark watched, then [extras] in the order given. A null action is not drawn.
 * As on the web, every icon carries its short name under it; Play and Sources say theirs in text.
 */
@Composable
fun DetailActionRow(
  primary: @Composable () -> Unit,
  startOver: DetailAction?,
  sources: (@Composable () -> Unit)?,
  toLibrary: DetailAction?,
  favourite: DetailAction?,
  unwatched: DetailAction?,
  watched: DetailAction?,
  caption: ActionCaption,
  modifier: Modifier = Modifier,
  extras: List<DetailAction> = emptyList(),
) {
  Row(
    modifier = modifier,
    horizontalArrangement = Arrangement.spacedBy(12.dp),
    verticalAlignment = Alignment.Top,
  ) {
    primary()
    sources?.invoke()
    startOver?.let { DetailActionButton(it, stringResource(R.string.detail_action_from_start), caption) }
    toLibrary?.let { DetailActionButton(it, stringResource(R.string.save_to_library), caption) }
    favourite?.let { DetailActionButton(it, stringResource(R.string.detail_action_favorite), caption) }
    unwatched?.let { DetailActionButton(it, stringResource(R.string.detail_action_unwatched), caption) }
    watched?.let { DetailActionButton(it, stringResource(R.string.detail_action_watched), caption) }
    extras.forEach { DetailActionButton(it, extraName(it), caption) }
  }
}

/** The short name of an extra action the catalogue adds, the way the web words it. */
@Composable
private fun extraName(action: DetailAction): String = when (action.tag) {
  TagCatalogShowInLibrary -> stringResource(R.string.detail_action_folder)
  else -> action.label
}

@Composable
private fun DetailActionButton(action: DetailAction, slotName: String, caption: ActionCaption) {
  var focused by remember { mutableStateOf(false) }
  Column(
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.spacedBy(5.dp),
    modifier = Modifier.widthIn(min = 64.dp),
  ) {
    ActionIconButton(
      label = action.label,
      icon = action.icon,
      onClick = action.onClick,
      caption = caption,
      modifier = action.modifier.testTag(action.tag).onFocusChanged { focused = it.isFocused },
      enabled = action.enabled,
      glyph = action.glyph,
    )
    Text(
      action.short.ifEmpty { slotName },
      color = if (focused) Tokens.Text else Tokens.Muted,
      fontSize = 11.sp,
      // A line tall enough for the descenders, and room under it: at the font's own tight line
      // height the bottom of "Zhlédnuto" was cut off.
      lineHeight = 16.sp,
      fontWeight = if (focused) FontWeight.SemiBold else FontWeight.Normal,
      maxLines = 1,
      modifier = (if (focused) Modifier.testTag(TagActionCaption) else Modifier).padding(bottom = 3.dp),
    )
  }
}

/** A square icon button for a secondary action; [label] is its spoken name. */
@Composable
fun ActionIconButton(
  label: String,
  icon: ImageVector?,
  onClick: () -> Unit,
  caption: ActionCaption,
  modifier: Modifier = Modifier,
  enabled: Boolean = true,
  /** A text glyph standing in for the icon, such as the favourite star. */
  glyph: String = "",
) {
  FocusButton(
    text = glyph,
    onClick = onClick,
    enabled = enabled,
    kind = FocusButtonKind.Icon,
    height = DetailActionHeight,
    leading = icon?.let { vector -> { Icon(vector, contentDescription = null, modifier = Modifier.size(18.dp)) } },
    contentDescription = label,
    modifier = modifier.onFocusChanged {
      if (it.isFocused) caption.text = label else if (caption.text == label) caption.text = ""
    },
  )
}

val ReplayIcon: ImageVector = outlineIcon("Replay") {
  moveTo(1f, 4f)
  lineTo(1f, 10f)
  lineTo(7f, 10f)
  moveTo(3.51f, 15f)
  arcToRelative(9f, 9f, 0f, isMoreThanHalf = true, isPositiveArc = false, dx1 = 2.13f, dy1 = -9.36f)
  lineTo(1f, 10f)
}

/** Mark watched: the open eye, with the pupil drawn as two half circles. */
val EyeIcon: ImageVector = outlineIcon("Eye") {
  moveTo(2f, 12f)
  curveTo(4.5f, 7f, 8f, 5f, 12f, 5f)
  curveTo(16f, 5f, 19.5f, 7f, 22f, 12f)
  curveTo(19.5f, 17f, 16f, 19f, 12f, 19f)
  curveTo(8f, 19f, 4.5f, 17f, 2f, 12f)
  close()
  moveTo(15f, 12f)
  arcTo(3f, 3f, 0f, isMoreThanHalf = false, isPositiveArc = true, x1 = 9f, y1 = 12f)
  arcTo(3f, 3f, 0f, isMoreThanHalf = false, isPositiveArc = true, x1 = 15f, y1 = 12f)
}

/** Mark as unwatched: the same eye, struck through. */
val EyeOffIcon: ImageVector = outlineIcon("EyeOff") {
  moveTo(2f, 12f)
  curveTo(4.5f, 7f, 8f, 5f, 12f, 5f)
  curveTo(16f, 5f, 19.5f, 7f, 22f, 12f)
  curveTo(19.5f, 17f, 16f, 19f, 12f, 19f)
  curveTo(8f, 19f, 4.5f, 17f, 2f, 12f)
  close()
  moveTo(15f, 12f)
  arcTo(3f, 3f, 0f, isMoreThanHalf = false, isPositiveArc = true, x1 = 9f, y1 = 12f)
  arcTo(3f, 3f, 0f, isMoreThanHalf = false, isPositiveArc = true, x1 = 15f, y1 = 12f)
  moveTo(3f, 3f)
  lineTo(21f, 21f)
}

val ForgetIcon: ImageVector = outlineIcon("Forget") {
  moveTo(3f, 6f)
  lineTo(21f, 6f)
  moveTo(5f, 6f)
  lineTo(6f, 20f)
  lineTo(18f, 20f)
  lineTo(19f, 6f)
  moveTo(9f, 6f)
  lineTo(9f, 3.5f)
  lineTo(15f, 3.5f)
  lineTo(15f, 6f)
  moveTo(10f, 10.5f)
  lineTo(10f, 16f)
  moveTo(14f, 10.5f)
  lineTo(14f, 16f)
}

val DownloadIcon: ImageVector = outlineIcon("Download") {
  moveTo(12f, 3.5f)
  lineTo(12f, 15f)
  moveTo(7f, 10f)
  lineTo(12f, 15f)
  lineTo(17f, 10f)
  moveTo(4f, 20f)
  lineTo(20f, 20f)
}

val CheckIcon: ImageVector = outlineIcon("Check") {
  moveTo(5f, 12.5f)
  lineTo(10f, 17.5f)
  lineTo(19f, 7f)
}

val FolderIcon: ImageVector = outlineIcon("Folder") {
  moveTo(3f, 7f)
  lineTo(10f, 7f)
  lineTo(12f, 9.5f)
  lineTo(21f, 9.5f)
  lineTo(21f, 19f)
  lineTo(3f, 19f)
  close()
}
