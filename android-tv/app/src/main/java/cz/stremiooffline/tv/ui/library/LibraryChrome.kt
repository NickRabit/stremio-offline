package cz.stremiooffline.tv.ui.library

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
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

/** The one compact toolbar row: Search opens the library search page, and a remote level's type
 *  filter sits at the row's right edge so it lines up under the section's own tabs. */
@Composable
internal fun LibraryToolbar(
  onSearch: () -> Unit,
  /** False where the level cannot be searched at all: the library root lists the libraries, and the
   *  server narrows nothing there. */
  available: Boolean,
  openFocus: FocusRequester,
  typeFilter: RemoteTypeFilter? = null,
  onTypeFilter: (RemoteTypeFilter) -> Unit = {},
) {
  val typeFocus = remember { FocusRequester() }
  Row(
    modifier = Modifier.fillMaxWidth().testTag(TagLibraryToolbar),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(9.dp),
  ) {
    if (available) {
      CatalogSearchChip(
        onClick = onSearch,
        modifier = Modifier
          .focusRequester(openFocus)
          .testTag(TagLibrarySearchAction)
          .focusProperties { if (typeFilter != null) right = typeFocus },
      )
    }
    Spacer(Modifier.weight(1f))
    if (available && typeFilter != null) {
      LibraryTypeButton(
        filter = typeFilter,
        onFilter = onTypeFilter,
        modifier = Modifier
          .focusRequester(typeFocus)
          .focusProperties { left = openFocus },
      )
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
  onTypeFilter: (RemoteTypeFilter) -> Unit = {},
) {
  val typeFocus = remember { FocusRequester() }
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
          modifier = Modifier
            .focusRequester(openFocus)
            .testTag(TagLibrarySearchAction)
            .focusProperties { if (typeFilter != null) right = typeFocus },
        )
      }
    }
    Spacer(Modifier.weight(1f))
    if (available && typeFilter != null) {
      LibraryTypeButton(
        filter = typeFilter,
        onFilter = onTypeFilter,
        modifier = Modifier
          .focusRequester(typeFocus)
          .then(if (open) Modifier else Modifier.focusProperties { left = openFocus }),
      )
    }
  }
}

@Composable
private fun LibraryTypeButton(
  filter: RemoteTypeFilter,
  onFilter: (RemoteTypeFilter) -> Unit,
  modifier: Modifier = Modifier,
) {
  SegmentButton(
    text = typeFilterLabel(filter),
    selected = filter != RemoteTypeFilter.All,
    onClick = { onFilter(nextRemoteTypeFilter(filter)) },
    modifier = modifier.testTag(TagLibraryTypeFilter),
  )
}

@Composable
private fun typeFilterLabel(filter: RemoteTypeFilter): String = stringResource(
  when (filter) {
    RemoteTypeFilter.All -> R.string.tv_library_type_all
    RemoteTypeFilter.Movies -> R.string.tv_library_type_movies
    RemoteTypeFilter.Series -> R.string.tv_library_type_series
  },
)

internal fun nextRemoteTypeFilter(filter: RemoteTypeFilter): RemoteTypeFilter = when (filter) {
  RemoteTypeFilter.All -> RemoteTypeFilter.Movies
  RemoteTypeFilter.Movies -> RemoteTypeFilter.Series
  RemoteTypeFilter.Series -> RemoteTypeFilter.All
}
