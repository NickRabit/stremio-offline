package cz.stremiooffline.tv.ui.library

import cz.stremiooffline.tv.ui.components.leftToNeighbour
import cz.stremiooffline.tv.ui.catalog.PanelOption
import cz.stremiooffline.tv.ui.catalog.SidePanel
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
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
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.ui.catalog.CatalogSearchChip
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.TvTextField
import cz.stremiooffline.tv.ui.theme.Tokens
import androidx.compose.ui.text.input.ImeAction
import kotlinx.coroutines.android.awaitFrame

const val TagLibraryToolbar = "library_toolbar"
const val TagLibrarySearchAction = "library_search_action"
const val TagLibrarySearchField = "library_search_field"
const val TagLibrarySearchInput = "library_search_input"
const val TagLibrarySearchSubmit = "library_search_submit"
const val TagLibraryTypeFilter = "library_type_filter"
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

/** The one compact toolbar row, drawn exactly like the Catalog's: the same Search chip first, then a
 *  remote level's type chip, which opens a side panel the way the Catalog's genre chip does. */
@Composable
internal fun LibraryToolbar(
  onSearch: () -> Unit,
  /** False where the level cannot be searched at all: the library root lists the libraries, and the
   *  server narrows nothing there. */
  available: Boolean,
  openFocus: FocusRequester,
  typeFilter: RemoteTypeFilter? = null,
  typeFocus: FocusRequester = remember { FocusRequester() },
  onOpenType: () -> Unit = {},
) {
  Row(
    modifier = Modifier.fillMaxWidth().testTag(TagLibraryToolbar),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(9.dp),
  ) {
    if (available) {
      CatalogSearchChip(
        onClick = onSearch,
        modifier = Modifier.focusRequester(openFocus).testTag(TagLibrarySearchAction),
      )
    }
    if (available && typeFilter != null) {
      LibraryTypeChip(filter = typeFilter, onClick = onOpenType, modifier = Modifier.focusRequester(typeFocus).leftToNeighbour(openFocus))
    }
  }
}

/**
 * The flag-off toolbar keeps today's inline narrowing. It lives apart from [LibraryToolbar] so the
 * engine-backed path never carries an editor it cannot use.
 */
@Composable
internal fun LibrarySearchFallback(
  open: Boolean,
  query: String,
  onQuery: (String) -> Unit,
  onOpen: () -> Unit,
  onSubmit: () -> Unit,
  onClose: () -> Unit,
  available: Boolean,
  openFocus: FocusRequester,
  fieldFocus: FocusRequester,
  typeFilter: RemoteTypeFilter? = null,
  typeFocus: FocusRequester = remember { FocusRequester() },
  onOpenType: () -> Unit = {},
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
    modifier = Modifier.fillMaxWidth().testTag(TagLibraryToolbar),
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
          modifier = Modifier.width(360.dp),
        )
        FocusButton(
          text = stringResource(R.string.media_server_search_action),
          onClick = onSubmit,
          modifier = Modifier.height(38.dp).testTag(TagLibrarySearchSubmit),
        )
      } else {
        CatalogSearchChip(
          onClick = onOpen,
          modifier = Modifier.focusRequester(openFocus).testTag(TagLibrarySearchAction),
        )
      }
    }
    if (available && typeFilter != null && !open) {
      LibraryTypeChip(filter = typeFilter, onClick = onOpenType, modifier = Modifier.focusRequester(typeFocus).leftToNeighbour(openFocus))
    }
  }
}

/** The type chip: the same button the Catalog's chips are, naming the current choice. */
@Composable
private fun LibraryTypeChip(filter: RemoteTypeFilter, onClick: () -> Unit, modifier: Modifier = Modifier) {
  FocusButton(text = typeFilterLabel(filter), onClick = onClick, modifier = modifier.testTag(TagLibraryTypeFilter))
}

@Composable
internal fun typeFilterLabel(filter: RemoteTypeFilter): String = stringResource(
  when (filter) {
    RemoteTypeFilter.All -> R.string.media_server_filter_all
    RemoteTypeFilter.Movies -> R.string.media_server_filter_movies
    RemoteTypeFilter.Series -> R.string.media_server_filter_series
  },
)

/** The type choices in the Catalog's side panel, focus starting on the current one. */
@Composable
internal fun LibraryTypePanel(filter: RemoteTypeFilter, onFilter: (RemoteTypeFilter) -> Unit, onClose: () -> Unit) {
  val entry = remember { FocusRequester() }
  SidePanel(
    title = stringResource(R.string.tv_library_type_panel),
    onClose = onClose,
    modifier = Modifier.testTag(TagLibraryTypePanel),
    initialFocus = entry,
  ) {
    for (option in RemoteTypeFilter.entries) {
      PanelOption(
        text = typeFilterLabel(option),
        selected = option == filter,
        onClick = { onFilter(option); onClose() },
        modifier = Modifier
          .testTag(libraryTypeOptionTag(option))
          .then(if (option == filter) Modifier.focusRequester(entry) else Modifier),
      )
    }
  }
}

internal fun libraryTypeOptionTag(filter: RemoteTypeFilter) = "library_type_option_${filter.name.lowercase()}"
const val TagLibraryTypePanel = "library_type_panel"

