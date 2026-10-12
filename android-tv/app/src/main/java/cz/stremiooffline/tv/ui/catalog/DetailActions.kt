package cz.stremiooffline.tv.ui.catalog

import androidx.compose.foundation.layout.size
import androidx.tv.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.components.outlineIcon

/**
 * The name of the icon button that holds the remote, shown beside the action row. An icon alone
 * says little from the sofa, so the focused one spells itself out; the state sits in an object of
 * its own because the detail screens are already near the size ART can verify.
 */
class ActionCaption {
  var text by mutableStateOf("")
}

/** A square icon button for a secondary action; [label] is its spoken name and its caption. */
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

val SeriesDownloadIcon: ImageVector = outlineIcon("SeriesDownload") {
  moveTo(12f, 2.5f)
  lineTo(12f, 12f)
  moveTo(8f, 8.5f)
  lineTo(12f, 12.5f)
  lineTo(16f, 8.5f)
  moveTo(4f, 16f)
  lineTo(20f, 16f)
  moveTo(6f, 20.5f)
  lineTo(18f, 20.5f)
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
