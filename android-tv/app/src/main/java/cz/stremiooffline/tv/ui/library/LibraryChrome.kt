package cz.stremiooffline.tv.ui.library

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Icon
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.ui.catalog.MicIcon
import cz.stremiooffline.tv.ui.catalog.VoiceSearch
import cz.stremiooffline.tv.ui.catalog.voiceKey
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.components.TvTextField
import cz.stremiooffline.tv.ui.theme.Tokens
import androidx.compose.ui.text.input.ImeAction
import kotlinx.coroutines.android.awaitFrame

const val TagLibraryToolbar = "library_toolbar"
const val TagLibrarySearchAction = "library_search_action"
const val TagLibrarySearchField = "library_search_field"
const val TagLibrarySearchInput = "library_search_input"
const val TagLibrarySearchSubmit = "library_search_submit"
const val TagLibrarySearchVoice = "library_search_voice"
const val TagLibraryHeaderTitle = "library_header_title"

/**
 * The one compact page header of the Library section: the section's name and the two halves' switch
 * on the same row. Both halves are entered through it, so the page keeps a single heading however
 * it was reached, and the orange eyebrow the section used to draw above it is gone.
 */
@Composable
internal fun LibraryHeader(
  segment: LibrarySegment,
  onAll: () -> Unit,
  onFiles: () -> Unit,
  onServers: () -> Unit,
) {
  Row(
    modifier = Modifier.fillMaxWidth(),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(14.dp),
  ) {
    Text(
      stringResource(R.string.tv_library_title),
      color = Tokens.Text,
      fontSize = 25.sp,
      fontWeight = FontWeight.ExtraBold,
      letterSpacing = (-0.8).sp,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
      modifier = Modifier.weight(1f).testTag(TagLibraryHeaderTitle),
    )
    LibrarySegments(segment = segment, onAll = onAll, onFiles = onFiles, onServers = onServers)
  }
}

/**
 * The one breadcrumb line of the active half, in one font and one spacing wherever it is drawn.
 * Only the half that owns the level draws it: the filesystem's path is absent while the servers are
 * showing, and the servers' path is absent while the files are.
 */
@Composable
internal fun LibraryBreadcrumbLine(text: String, tag: String) {
  Text(
    text,
    color = Tokens.Muted,
    fontSize = 10.sp,
    fontWeight = FontWeight.Medium,
    maxLines = 1,
    overflow = TextOverflow.Ellipsis,
    modifier = Modifier.testTag(tag),
  )
}

/**
 * The one compact toolbar row of the Library section. The search is an ordinary focusable action
 * until it is opened, so a closed toolbar leaves the grid its height back; opening it shows the
 * app's own field and submit button, and submits only on the IME action or the button, never per
 * keystroke. Back closes the editor and hands the remote to the action that opened it before the
 * screen's own Back is allowed to navigate. The active half adds whatever else belongs to the row
 * through [trailing].
 */
@Composable
internal fun LibraryToolbar(
  /** True while the editor is open. */
  open: Boolean,
  query: String,
  onQuery: (String) -> Unit,
  onOpen: () -> Unit,
  onSubmit: () -> Unit,
  onClose: () -> Unit,
  /** The query the level is actually narrowed by, drawn on the closed action so a committed search
   *  never becomes invisible. */
  committed: String,
  /** False where the level cannot be searched at all: the library root lists the libraries, and the
   *  server narrows nothing there. */
  available: Boolean,
  openFocus: FocusRequester,
  fieldFocus: FocusRequester,
  /** Where DOWN leaves the field and the closed action once the result grid is on screen. */
  downFocus: FocusRequester? = null,
  /** The recognizer of the screen that owns this toolbar; null draws no mic. */
  voice: VoiceSearch? = null,
  trailing: (@Composable () -> Unit)? = null,
) {
  BackHandler(enabled = open) { onClose() }
  var wasOpen by remember { mutableStateOf(false) }
  // The opener takes the remote back once the editor and its field are gone; an editor that opens
  // hands it to the field.
  LaunchedEffect(open) {
    if (open) {
      wasOpen = true
      awaitFrame()
      runCatching { fieldFocus.requestFocus() }
    } else if (wasOpen) {
      wasOpen = false
      awaitFrame()
      runCatching { openFocus.requestFocus() }
    }
  }
  Row(
    modifier = Modifier
      .fillMaxWidth()
      .testTag(TagLibraryToolbar)
      .then(if (voice != null && available) Modifier.voiceKey(voice) else Modifier),
    verticalAlignment = Alignment.Bottom,
    horizontalArrangement = Arrangement.spacedBy(9.dp),
  ) {
    if (available) {
      if (open) {
        TvTextField(
          label = stringResource(R.string.media_server_search_label),
          value = query,
          onValueChange = onQuery,
          imeAction = ImeAction.Search,
          surfaceRequester = fieldFocus,
          testTag = TagLibrarySearchField,
          inputTestTag = TagLibrarySearchInput,
          onSubmit = onSubmit,
          modifier = Modifier
            .width(360.dp)
            .then(if (downFocus != null) Modifier.focusProperties { down = downFocus } else Modifier),
        )
        FocusButton(
          text = stringResource(R.string.media_server_search_action),
          onClick = onSubmit,
          modifier = Modifier.height(38.dp).testTag(TagLibrarySearchSubmit),
        )
        if (voice?.available == true && available) VoiceButton(voice)
      } else {
        FocusButton(
          text = committed.ifEmpty { stringResource(R.string.media_server_search_action) },
          onClick = onOpen,
          labelMaxWidth = 240.dp,
          modifier = Modifier
            .focusRequester(openFocus)
            .testTag(TagLibrarySearchAction)
            .then(if (downFocus != null) Modifier.focusProperties { down = downFocus } else Modifier),
        )
        if (voice?.available == true && available) VoiceButton(voice)
      }
    }
    trailing?.invoke()
  }
}

/** The microphone of the search row, drawn after the search action while it is not editing. */
@Composable
private fun VoiceButton(voice: VoiceSearch) {
  FocusButton(
    text = "",
    onClick = voice.start,
    kind = FocusButtonKind.Icon,
    leading = { Icon(MicIcon, contentDescription = null, modifier = Modifier.size(18.dp)) },
    contentDescription = stringResource(R.string.tv_voice_search),
    modifier = Modifier.size(38.dp).testTag(TagLibrarySearchVoice),
  )
}
