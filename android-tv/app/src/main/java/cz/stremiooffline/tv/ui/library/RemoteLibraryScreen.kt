package cz.stremiooffline.tv.ui.library

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.tv.material3.Border
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteLibraryApi
import cz.stremiooffline.tv.data.RemoteLibraryDto
import cz.stremiooffline.tv.ui.components.CardRowInset
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.components.PosterCard
import cz.stremiooffline.tv.ui.components.ShimmerCards
import cz.stremiooffline.tv.ui.components.TvSpinner
import cz.stremiooffline.tv.ui.components.TvTextField
import cz.stremiooffline.tv.ui.detail.PlayTarget
import cz.stremiooffline.tv.ui.detail.RemoteDetailData
import cz.stremiooffline.tv.ui.detail.RemoteDetailScreen
import cz.stremiooffline.tv.ui.theme.Tokens
import kotlinx.coroutines.android.awaitFrame

const val TagLibrarySegments = "library_segments"
const val TagRemoteLoadMore = "remote_load_more"
const val TagRemoteSearchField = "remote_search_field"
const val TagRemoteSearchSubmit = "remote_search_submit"

fun remoteSearchTag(key: String): String = "remote_search_$key"
fun remoteFilterTag(key: String): String = "remote_filter_$key"
fun remoteLibraryTag(id: String): String = "remote_library_$id"
fun remoteItemTag(id: String): String = "remote_item_$id"

/**
 * The Media servers half of the Library section. It loads on its own, so a failing remote server
 * never blocks Files; the segment switch itself lives in [LibraryRoute].
 */
@Composable
fun RemoteLibraryRoute(
  api: RemoteLibraryApi,
  /** The session image loader; remote artwork is same-origin and content-authorized. */
  imageUrl: (String?) -> String? = { null },
  segment: LibrarySegment,
  onOpenItem: (libraryId: String, libraryName: String, provider: String, item: RemoteItemDto) -> Unit,
  /** Back at the library picker hands the remote to Files; a deeper level pops its own stack. */
  onBackToFiles: () -> Unit = {},
  modifier: Modifier = Modifier,
  restoreToken: Int = 0,
  /** False while a detail or the player covers this half, so a hidden Back never pops its stack. */
  backEnabled: Boolean = true,
) {
  val viewModel = viewModel<RemoteLibraryViewModel>(factory = RemoteLibraryViewModel.factory(api))
  LaunchedEffect(segment) {
    if (segment == LibrarySegment.Servers) viewModel.onShown()
  }
  // Leaving the half cancels every in-flight load, so no late answer lands on a hidden grid.
  DisposableEffect(Unit) { onDispose { viewModel.onHidden() } }

  val state = viewModel.state
  val level = state.current
  val items = level?.state?.items ?: emptyList()
  val levelKey = level?.key ?: REMOTE_PICKER_KEY

  val searchSurface = remember { FocusRequester() }
  val gridFocus = remember { FocusRequester() }
  val loadMoreFocus = remember { FocusRequester() }
  val errorFocus = remember { FocusRequester() }
  val requesters = remember(levelKey) { mutableMapOf<String, FocusRequester>() }

  var query by remember { mutableStateOf("") }
  var committed by remember { mutableStateOf("") }

  BackHandler(enabled = segment == LibrarySegment.Servers && backEnabled) {
    if (!viewModel.back()) onBackToFiles()
  }

  LaunchedEffect(levelKey) {
    committed = (level as? RemoteLevel.Items)?.state?.search.orEmpty()
    query = committed
  }

  // A page change focuses the card last used on this level, else the first card; Back restores the
  // card that opened the level because the selection is kept per level rather than cleared.
  LaunchedEffect(levelKey, items.size, state.libraries.size, segment, restoreToken) {
    if (segment != LibrarySegment.Servers) return@LaunchedEffect
    awaitFrame()
    val remembered = viewModel.selectedFor(levelKey)?.let { requesters[it] }
    val requester = remembered ?: requesters.values.firstOrNull() ?: gridFocus
    runCatching { requester.requestFocus() }
  }

  Column(
    modifier = modifier.fillMaxSize().padding(start = Tokens.SafeX, top = Tokens.SafeY, end = Tokens.SafeX),
  ) {
    Box(Modifier.weight(1f).fillMaxWidth()) {
      if (level == null) {
        LibraryPicker(state, viewModel, requesters, gridFocus, errorFocus)
      } else {
        ItemBrowser(
          level = level,
          items = items,
          imageUrl = imageUrl,
          viewModel = viewModel,
          query = query,
          committed = committed,
          onQuery = { query = it },
          onSubmit = { committed = query; viewModel.search(query) },
          requesters = requesters,
          searchSurface = searchSurface,
          gridFocus = gridFocus,
          loadMoreFocus = loadMoreFocus,
          errorFocus = errorFocus,
          onOpenItem = onOpenItem,
        )
      }
    }
  }
}

/**
 * One remote series opened from a Home or Favourites card. Its episodes come from the library's
 * episodes route and are drawn by the same [ItemBrowser] as the Servers half, in a view-model of
 * its own so the Library section never loses its own. An episode opens the playable detail as a
 * nested child; Back returns to the grid with the card that opened it focused, then closes this.
 */
@Composable
internal fun RemoteSeriesScreen(
  api: RemoteLibraryApi,
  data: RemoteDetailData,
  imageUrl: (String?) -> String?,
  onPlay: (PlayTarget) -> Unit,
  onBack: () -> Unit,
  backEnabled: Boolean = true,
  restoreToken: Int = 0,
) {
  val viewModel = viewModel<RemoteLibraryViewModel>(
    key = "remote-series:${data.libraryId}:${data.item.id}",
    factory = RemoteLibraryViewModel.factory(api),
  )
  LaunchedEffect(data.libraryId, data.item.id) {
    viewModel.openSeries(data.libraryId, data.libraryName, data.provider, data.item)
  }
  DisposableEffect(Unit) { onDispose { viewModel.onHidden() } }

  var episode by remember { mutableStateOf<RemoteDetailData?>(null) }
  var returnToken by remember { mutableIntStateOf(0) }

  BackHandler(enabled = backEnabled) { onBack() }

  val state = viewModel.state
  val level = state.current
  val items = level?.state?.items ?: emptyList()
  val levelKey = level?.key.orEmpty()

  val gridFocus = remember { FocusRequester() }
  val loadMoreFocus = remember { FocusRequester() }
  val errorFocus = remember { FocusRequester() }
  val searchSurface = remember { FocusRequester() }
  val requesters = remember(levelKey) { mutableMapOf<String, FocusRequester>() }

  // A page change focuses the card last used; coming back from an episode restores the card that
  // opened it, so the viewer lands where they left rather than on the first card.
  LaunchedEffect(levelKey, items.size, restoreToken, returnToken, episode) {
    if (episode != null) return@LaunchedEffect
    awaitFrame()
    val remembered = viewModel.selectedFor(levelKey)?.let { requesters[it] }
    val requester = remembered ?: requesters.values.firstOrNull() ?: gridFocus
    runCatching { requester.requestFocus() }
  }

  Box(Modifier.fillMaxSize()) {
    if (episode == null) Column(Modifier.fillMaxSize().padding(start = Tokens.SafeX, top = Tokens.SafeY, end = Tokens.SafeX)) {
      Box(Modifier.weight(1f).fillMaxWidth()) {
        if (level == null) {
          ShimmerCards()
        } else {
          ItemBrowser(
            level = level,
            items = items,
            imageUrl = imageUrl,
            viewModel = viewModel,
            query = "",
            committed = "",
            onQuery = {},
            onSubmit = {},
            requesters = requesters,
            searchSurface = searchSurface,
            gridFocus = gridFocus,
            loadMoreFocus = loadMoreFocus,
            errorFocus = errorFocus,
            onOpenItem = { libraryId, libraryName, provider, item ->
              episode = RemoteDetailData(
                libraryId = libraryId,
                libraryName = libraryName,
                provider = provider,
                item = item,
                seriesName = data.item.name,
              )
            },
          )
        }
      }
    }

    val openEpisode = episode
    if (openEpisode != null) {
      RemoteDetailScreen(
        api = api,
        data = openEpisode,
        imageUrl = imageUrl,
        onPlay = onPlay,
        onBack = {
          episode = null
          returnToken++
        },
        backEnabled = backEnabled,
        restoreToken = returnToken + restoreToken,
      )
    }
  }
}

/** The Files/Media servers switch at the top of the section. */
@Composable
internal fun LibrarySegments(segment: LibrarySegment, onFiles: () -> Unit, onServers: () -> Unit) {
  val filesFocus = remember { FocusRequester() }
  val serversFocus = remember { FocusRequester() }
  Row(
    modifier = Modifier.testTag(TagLibrarySegments).focusGroup(),
    horizontalArrangement = Arrangement.spacedBy(11.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    SegmentButton(
      text = stringResource(R.string.media_server_tab_files),
      selected = segment == LibrarySegment.Files,
      onClick = onFiles,
      modifier = Modifier.focusRequester(filesFocus),
    )
    SegmentButton(
      text = stringResource(R.string.media_server_tab_servers),
      selected = segment == LibrarySegment.Servers,
      onClick = onServers,
      modifier = Modifier.focusRequester(serversFocus),
    )
  }
}

@Composable
private fun SegmentButton(text: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
  var focused by remember { mutableStateOf(false) }
  val shape = RoundedCornerShape(8.dp)
  Surface(
    onClick = onClick,
    modifier = modifier.onFocusChanged { focused = it.isFocused },
    shape = ClickableSurfaceDefaults.shape(shape = shape),
    scale = ClickableSurfaceDefaults.scale(focusedScale = 1f),
    border = ClickableSurfaceDefaults.border(
      border = Border(BorderStroke(1.dp, if (selected) Tokens.Accent else Tokens.Line), shape = shape),
      focusedBorder = Border(BorderStroke(1.5.dp, Tokens.Accent2), shape = shape),
    ),
    colors = ClickableSurfaceDefaults.colors(
      containerColor = if (selected) Tokens.Accent.copy(alpha = 0.15f) else Tokens.Panel2,
      contentColor = if (selected) Tokens.Accent2 else Tokens.Text,
      focusedContainerColor = Tokens.Panel2,
      focusedContentColor = Tokens.Text,
    ),
  ) {
    Text(text, fontSize = 12.5.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(horizontal = 16.dp, vertical = 9.dp))
  }
}

@Composable
private fun LibraryPicker(
  state: RemoteLibraryState,
  viewModel: RemoteLibraryViewModel,
  requesters: MutableMap<String, FocusRequester>,
  gridFocus: FocusRequester,
  errorFocus: FocusRequester,
) {
  Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(9.dp)) {
    Text(
      stringResource(R.string.media_server_pick_title),
      color = Tokens.Text,
      fontSize = 22.sp,
      fontWeight = FontWeight.ExtraBold,
    )
    Box(Modifier.weight(1f).fillMaxWidth()) {
      when {
        state.librariesLoading -> ShimmerCards()
        state.librariesError != null -> RemoteErrorPanel(state.librariesError, { viewModel.loadLibraries() }, errorFocus)
        state.libraries.isEmpty() -> Text(stringResource(R.string.media_server_empty_shared), color = Tokens.Muted, fontSize = 12.sp)
        else -> BoxWithConstraints(Modifier.fillMaxSize()) {
          val columns = (((maxWidth.value + 18f) / 128f).toInt()).coerceAtLeast(1)
          LazyVerticalGrid(
            columns = GridCells.Fixed(columns),
            modifier = Modifier.focusRequester(gridFocus).focusGroup(),
            contentPadding = PaddingValues(start = CardRowInset, top = 10.dp, end = CardRowInset, bottom = 40.dp),
            horizontalArrangement = Arrangement.spacedBy(18.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
          ) {
            itemsIndexed(state.libraries, key = { _, library -> library.id }) { _, library ->
              val key = "library:${library.id}"
              val requester = remember(key) { FocusRequester() }
              requesters[key] = requester
              RemoteLibraryCard(
                library = library,
                onClick = { viewModel.openLibrary(library) },
                modifier = Modifier
                  .testTag(remoteLibraryTag(library.id))
                  .focusRequester(requester)
                  .onFocusChanged { if (it.isFocused) viewModel.select(REMOTE_PICKER_KEY, key) },
              )
            }
          }
        }
      }
    }
  }
}

@Composable
private fun RemoteLibraryCard(library: RemoteLibraryDto, onClick: () -> Unit, modifier: Modifier = Modifier) {
  val shape = RoundedCornerShape(10.dp)
  Surface(
    onClick = onClick,
    modifier = modifier.size(150.dp, 150.dp),
    shape = ClickableSurfaceDefaults.shape(shape = shape),
    scale = ClickableSurfaceDefaults.scale(focusedScale = 1.06f),
    border = ClickableSurfaceDefaults.border(
      border = Border(BorderStroke(1.dp, Tokens.Line), shape = shape),
      focusedBorder = Border(BorderStroke(2.dp, Tokens.Accent2), shape = shape),
    ),
    colors = ClickableSurfaceDefaults.colors(
      containerColor = Tokens.Panel,
      contentColor = Tokens.Text,
      focusedContainerColor = Tokens.Panel2,
      focusedContentColor = Tokens.Text,
    ),
  ) {
    Column(Modifier.fillMaxSize().padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
      Text(providerLabel(library.provider), color = Tokens.Accent2, fontSize = 10.sp, fontWeight = FontWeight.Bold)
      Text(library.name, color = Tokens.Text, fontSize = 15.sp, fontWeight = FontWeight.ExtraBold, maxLines = 3, overflow = TextOverflow.Ellipsis)
      Spacer(Modifier.weight(1f))
      Text(stringResource(R.string.media_server_read_only), color = Tokens.Muted, fontSize = 10.sp)
    }
  }
}

@Composable
private fun ItemBrowser(
  level: RemoteLevel,
  items: List<RemoteItemDto>,
  imageUrl: (String?) -> String?,
  viewModel: RemoteLibraryViewModel,
  query: String,
  committed: String,
  onQuery: (String) -> Unit,
  onSubmit: () -> Unit,
  requesters: MutableMap<String, FocusRequester>,
  searchSurface: FocusRequester,
  gridFocus: FocusRequester,
  loadMoreFocus: FocusRequester,
  errorFocus: FocusRequester,
  onOpenItem: (libraryId: String, libraryName: String, provider: String, item: RemoteItemDto) -> Unit,
) {
  val search = level.state
  val isSearchable = level is RemoteLevel.Items
  val appendRetryFocus = remember { FocusRequester() }

  Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(9.dp)) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
      Text(
        level.title(),
        color = Tokens.Text,
        fontSize = 22.sp,
        fontWeight = FontWeight.ExtraBold,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.weight(1f),
      )
      if (isSearchable) TypeFilterChips(state = search, onFilter = { viewModel.filter(it) })
    }

    if (isSearchable) {
      SearchBar(
        label = stringResource(R.string.media_server_search_label),
        value = query,
        onValueChange = onQuery,
        onSubmit = onSubmit,
        surfaceRequester = searchSurface,
      )
    }

    Box(Modifier.weight(1f).fillMaxWidth()) {
      Column(Modifier.fillMaxSize()) {
        // A page that failed or a cursor the server rejected never replaces the loaded rows: the
        // notice and its Retry sit above the grid, which stays focusable underneath.
        if ((search.appendError != null || search.staleCursor) && items.isNotEmpty()) {
          Row(
            Modifier.fillMaxWidth().padding(bottom = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(11.dp),
          ) {
            Text(
              stringResource(R.string.media_server_error),
              color = Tokens.Red,
              fontSize = 11.sp,
              maxLines = 1,
              modifier = Modifier.weight(1f),
            )
            FocusButton(
              stringResource(R.string.tv_try_again),
              onClick = { if (search.staleCursor) viewModel.retry() else viewModel.retryAppend() },
              modifier = Modifier.focusRequester(appendRetryFocus),
            )
          }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
          when {
            search.loading -> ShimmerCards()
            search.error != null -> RemoteErrorPanel(search.error, { viewModel.retry() }, errorFocus)
            // Rows may be filtered out entirely while a cursor still holds more: keep the Load more.
            items.isEmpty() && !search.hasMore -> Text(
              if (committed.isNotEmpty()) stringResource(R.string.media_server_no_matches) else stringResource(R.string.media_server_empty_items),
              color = Tokens.Muted,
              fontSize = 12.sp,
            )
            else -> ItemGrid(
              items = items,
              imageUrl = imageUrl,
              isEpisodes = level is RemoteLevel.Episodes,
              hasMore = search.hasMore,
              loadingMore = search.loadingMore,
              levelKey = level.key,
              viewModel = viewModel,
              requesters = requesters,
              gridFocus = gridFocus,
              loadMoreFocus = loadMoreFocus,
              onOpen = { onOpenItem(level.libraryId, level.libraryName, level.provider, it) },
            )
          }
        }
      }
    }
  }
}

@Composable
private fun ItemGrid(
  items: List<RemoteItemDto>,
  imageUrl: (String?) -> String?,
  isEpisodes: Boolean,
  hasMore: Boolean,
  loadingMore: Boolean,
  levelKey: String,
  viewModel: RemoteLibraryViewModel,
  requesters: MutableMap<String, FocusRequester>,
  gridFocus: FocusRequester,
  loadMoreFocus: FocusRequester,
  onOpen: (RemoteItemDto) -> Unit,
) {
  BoxWithConstraints(Modifier.fillMaxSize()) {
    val columns = (((maxWidth.value + 18f) / 128f).toInt()).coerceAtLeast(1)
    LazyVerticalGrid(
      columns = GridCells.Fixed(columns),
      modifier = Modifier.focusRequester(gridFocus).focusGroup(),
      contentPadding = PaddingValues(start = CardRowInset, top = 10.dp, end = CardRowInset, bottom = 40.dp),
      horizontalArrangement = Arrangement.spacedBy(18.dp),
      verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
      itemsIndexed(items, key = { _, item -> item.id }) { index, item ->
        val requester = remember(item.id) { FocusRequester() }
        requesters[item.id] = requester
        PosterCard(
          name = item.name,
          imageUrl = imageUrl(item.poster),
          fallbackImageUrl = imageUrl(item.wide),
          progress = null,
          caption = if (isEpisodes) episodeCaption(item) else null,
          cardTag = remoteItemTag(item.id),
          onClick = { onOpen(item) },
          modifier = Modifier
            .focusRequester(requester)
            .onFocusChanged {
              if (it.isFocused) {
                viewModel.select(levelKey, item.id)
                if (index >= items.size - columns) viewModel.loadMore()
              }
            },
        )
      }
      if (hasMore) {
        item(key = "load_more") {
          LoadMoreCard(loading = loadingMore, onClick = { viewModel.loadMore() }, focus = loadMoreFocus)
        }
      }
    }
  }
}

@Composable
private fun LoadMoreCard(loading: Boolean, onClick: () -> Unit, focus: FocusRequester) {
  val shape = RoundedCornerShape(10.dp)
  Surface(
    onClick = onClick,
    modifier = Modifier.fillMaxWidth().testTag(TagRemoteLoadMore).focusRequester(focus).focusable(),
    shape = ClickableSurfaceDefaults.shape(shape = shape),
    colors = ClickableSurfaceDefaults.colors(
      containerColor = Tokens.Panel,
      contentColor = Tokens.Text,
      focusedContainerColor = Tokens.Panel2,
      focusedContentColor = Tokens.Text,
    ),
    border = ClickableSurfaceDefaults.border(
      border = Border(BorderStroke(1.dp, Tokens.Line), shape = shape),
      focusedBorder = Border(BorderStroke(1.5.dp, Tokens.Accent2), shape = shape),
    ),
  ) {
    Row(
      Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      if (loading) TvSpinner(color = Tokens.Accent2)
      Text(stringResource(R.string.media_server_load_more), fontSize = 12.5.sp, fontWeight = FontWeight.Bold)
    }
  }
}

@Composable
private fun TypeFilterChips(state: RemoteItemsState, onFilter: (RemoteTypeFilter) -> Unit) {
  Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
    TypeChip(stringResource(R.string.media_server_filter_all), state.type == RemoteTypeFilter.All) { onFilter(RemoteTypeFilter.All) }
    TypeChip(stringResource(R.string.media_server_filter_movies), state.type == RemoteTypeFilter.Movies) { onFilter(RemoteTypeFilter.Movies) }
    TypeChip(stringResource(R.string.media_server_filter_series), state.type == RemoteTypeFilter.Series) { onFilter(RemoteTypeFilter.Series) }
  }
}

@Composable
private fun TypeChip(text: String, selected: Boolean, onClick: () -> Unit) {
  val shape = RoundedCornerShape(999.dp)
  Surface(
    onClick = onClick,
    modifier = Modifier.testTag(remoteFilterTag(text)),
    shape = ClickableSurfaceDefaults.shape(shape = shape),
    scale = ClickableSurfaceDefaults.scale(focusedScale = 1f),
    border = ClickableSurfaceDefaults.border(
      border = Border(BorderStroke(1.dp, if (selected) Tokens.Accent else Tokens.Line), shape = shape),
      focusedBorder = Border(BorderStroke(1.5.dp, Tokens.Accent2), shape = shape),
    ),
    colors = ClickableSurfaceDefaults.colors(
      containerColor = if (selected) Tokens.Accent.copy(alpha = 0.15f) else Tokens.Panel2,
      contentColor = if (selected) Tokens.Accent2 else Tokens.Muted,
      focusedContainerColor = Tokens.Panel2,
      focusedContentColor = Tokens.Text,
    ),
  ) {
    Text(text, fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp))
  }
}

/** A TV-focusable field that submits its query on the IME action, never per keystroke. */
@Composable
private fun SearchBar(label: String, value: String, onValueChange: (String) -> Unit, onSubmit: () -> Unit, surfaceRequester: FocusRequester) {
  Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
    TvTextField(
      label = label,
      value = value,
      onValueChange = onValueChange,
      imeAction = ImeAction.Search,
      surfaceRequester = surfaceRequester,
      testTag = TagRemoteSearchField,
      onSubmit = onSubmit,
      modifier = Modifier.width(360.dp),
    )
    FocusButton(
      text = stringResource(R.string.media_server_search_action),
      onClick = onSubmit,
      modifier = Modifier.testTag(TagRemoteSearchSubmit),
    )
  }
}

@Composable
private fun RemoteErrorPanel(kind: RemoteErrorKind?, onRetry: () -> Unit, focus: FocusRequester) {
  val message = when (kind) {
    RemoteErrorKind.Offline -> stringResource(R.string.media_server_offline)
    else -> stringResource(R.string.media_server_error)
  }
  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    Column(verticalArrangement = Arrangement.spacedBy(11.dp), horizontalAlignment = Alignment.CenterHorizontally) {
      Text(message, color = Tokens.Muted, fontSize = 12.sp)
      FocusButton(
        stringResource(R.string.tv_try_again),
        onClick = onRetry,
        kind = FocusButtonKind.Primary,
        modifier = Modifier.focusRequester(focus),
      )
    }
  }
}

private fun providerLabel(provider: String): String = when (provider.lowercase()) {
  "jellyfin" -> "Jellyfin"
  "emby" -> "Emby"
  else -> provider
}

private fun RemoteLevel.title(): String = when (this) {
  is RemoteLevel.Items -> title
  is RemoteLevel.Episodes -> title
}

private fun episodeCaption(item: RemoteItemDto): String =
  if (item.season != null || item.episode != null) "S${item.season ?: 0} · E${item.episode ?: 0}" else ""
