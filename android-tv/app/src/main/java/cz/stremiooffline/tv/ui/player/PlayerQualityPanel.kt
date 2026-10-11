package cz.stremiooffline.tv.ui.player

import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.playback.QualityChoice
import cz.stremiooffline.tv.ui.catalog.PanelOption
import cz.stremiooffline.tv.ui.catalog.SidePanel
import cz.stremiooffline.tv.ui.theme.Tokens

const val TagQualityPanel = "quality_panel"
const val TagQualityForceNote = "quality_force_note"

fun qualityRowTag(name: String): String = "quality_row_$name"

/** The heights the panel offers, matching the server's `QUALITY_BITRATE` keys. */
val QUALITY_HEIGHTS = listOf(1080, 720, 480)

/** The current choice as the button and the panel row name it. `1080p` is a format, not a word. */
@Composable
internal fun qualityLabel(choice: QualityChoice): String = when (choice) {
  QualityChoice.Original -> stringResource(R.string.player_quality_original)
  QualityChoice.P1080 -> "1080p"
  QualityChoice.P720 -> "720p"
  QualityChoice.P480 -> "480p"
  QualityChoice.Force -> stringResource(R.string.tv_force_conversion)
}

/**
 * The Quality panel: the server's own choice, three real transcodes, and the forced conversion
 * for when the picture or the sound plays badly. The ticked row is re-derived from the answered
 * descriptor by the caller.
 */
@Composable
fun PlayerQualityPanel(
  choice: QualityChoice,
  onOriginal: () -> Unit,
  onHeight: (Int) -> Unit,
  onForce: () -> Unit,
  onClose: () -> Unit,
  modifier: Modifier = Modifier,
  initialFocus: FocusRequester? = null,
) {
  val chosenHeight = when (choice) {
    QualityChoice.P1080 -> 1080
    QualityChoice.P720 -> 720
    QualityChoice.P480 -> 480
    else -> null
  }
  val choiceIndex = when (choice) {
    QualityChoice.Original -> 0
    QualityChoice.P1080 -> 1
    QualityChoice.P720 -> 2
    QualityChoice.P480 -> 3
    QualityChoice.Force -> 4
  }
  fun row(index: Int) = Modifier.then(if (initialFocus != null && index == choiceIndex) Modifier.focusRequester(initialFocus) else Modifier)

  SidePanel(
    title = stringResource(R.string.player_quality),
    onClose = onClose,
    modifier = modifier.testTag(TagQualityPanel),
    initialFocus = initialFocus,
  ) {
    PanelOption(
      text = stringResource(R.string.player_quality_original),
      onClick = onOriginal,
      selected = choice == QualityChoice.Original,
      modifier = row(0).testTag(qualityRowTag("original")),
    )
    QUALITY_HEIGHTS.forEachIndexed { offset, height ->
      PanelOption(
        text = "${height}p",
        onClick = { onHeight(height) },
        selected = chosenHeight == height,
        modifier = row(offset + 1).testTag(qualityRowTag(height.toString())),
      )
    }
    PanelOption(
      text = stringResource(R.string.tv_force_conversion),
      onClick = onForce,
      selected = choice == QualityChoice.Force,
      modifier = row(4).testTag(qualityRowTag("force")),
    )
    Text(
      stringResource(R.string.tv_force_conversion_note),
      color = Tokens.Muted,
      fontSize = 10.5.sp,
      lineHeight = 15.sp,
      modifier = Modifier.padding(horizontal = 12.dp).testTag(TagQualityForceNote),
    )
  }
}
