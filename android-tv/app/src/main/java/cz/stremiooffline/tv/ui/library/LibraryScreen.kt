package cz.stremiooffline.tv.ui.library

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.foundation.focusGroup
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.DownloadTargetDto
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.LibraryDto
import cz.stremiooffline.tv.data.MediaDto
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.data.RemoteLibraryApi
import cz.stremiooffline.tv.ui.components.CardRowInset
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.components.PosterCard
import cz.stremiooffline.tv.ui.components.ShimmerCards
import cz.stremiooffline.tv.ui.detail.DetailData
import cz.stremiooffline.tv.ui.detail.episodeLabel
import cz.stremiooffline.tv.ui.theme.Tokens
import kotlinx.coroutines.launch

const val TagLibraryBreadcrumb = "library_breadcrumb"

@Composable
fun LibraryRoute(
  api: TvApi,
  onOpenDetail: (DetailData) -> Unit,
  /** A native remote item was opened; the shell shows its detail and plays its versions. */
  onOpenRemoteItem: (libraryId: String, libraryName: String, provider: String, item: RemoteItemDto) -> Unit = { _, _, _, _ -> throw UnsupportedOperationException("Remote item opened without a handler") },
  /** Bumped when a remote detail or its player closes, so the remote grid restores its focus. */
  modifier: Modifier = Modifier,
  restoreToken: Int = 0,
  refreshToken: Int = 0,
  /** A folder a Home card asked to reveal; opened once and then cleared by the caller. */
  pushPath: String? = null,
  onPushConsumed: () -> Unit = {},
  /** False while a detail or the player covers this section, so a hidden Back never pops it. */
  backEnabled: Boolean = true,
  pendingDelayMs: Long = 1_500L,
  /** The destinations this account may copy into, read once when a card's copy action is used.
   *  Null keeps the remote copy action off, which is what a harness without the catalogue passes. */
  loadDestinations: (suspend () -> List<LibraryDto>)? = null,
  /** Queues one exact native version into the chosen library. */
  onQueue: (suspend (title: String, sourceId: String, media: MediaDto, target: DownloadTargetDto?) -> Unit)? = null,
) {
  var segment by rememberSaveable { mutableStateOf(LibrarySegment.Files) }
  val remoteApi: RemoteLibraryApi = api
  val viewModel = viewModel<LibraryViewModel>(factory = LibraryViewModel.factory(api, pendingDelayMs))
  // A fresh entry starts at the root; a Home jump (arriving with a path) pushes its folder.
  LaunchedEffect(Unit) { if (viewModel.state.pages.isEmpty() || viewModel.needsRootReset) viewModel.start() }
  LaunchedEffect(pushPath) {
    if (pushPath.isNullOrEmpty()) return@LaunchedEffect
    val title = pushPath.substringAfterLast('/').ifEmpty { pushPath }
    viewModel.openHere(pushPath, title)
    onPushConsumed()
  }
  // Re-entering the section asks the server again; the grid keeps the old rows until the answer.
  // The shell only raises the token after the first mount, so a fresh mount just starts.
  LaunchedEffect(refreshToken) { if (refreshToken > 0) viewModel.refresh() }
  // A detail may have starred its title; re-read the level so the card and the root's Favourites
  // entry match the server again, without dropping the remote off the card the viewer came from.
  LaunchedEffect(restoreToken) { if (restoreToken > 0) viewModel.refresh() }

  val state = viewModel.state
  val items = state.current?.items.orEmpty()
  val scope = rememberCoroutineScope()
  val selectedPath = viewModel.selectedPath
  val requesters = remember { mutableMapOf<String, FocusRequester>() }
  val gridFocus = remember { FocusRequester() }
  val fallbackTitle = stringResource(R.string.tv_library_title)
  // The query the level on screen is narrowed by, and the editor's own text while it is open. A
  // level carries its own search, so Back from a title lands on the parent's list, not on all of it.
  val committed = state.current?.search.orEmpty()
  var editorOpen by remember { mutableStateOf(false) }
  var query by remember { mutableStateOf("") }
  val searchAction = remember { FocusRequester() }
  val searchField = remember { FocusRequester() }
  LaunchedEffect(segment, state.pages.size) {
    editorOpen = false
    query = state.current?.search.orEmpty()
  }

  // Bumped whenever Back pops a level, so the return restores the card that opened that level.
  var backToken by remember { mutableIntStateOf(0) }
  var restoreKey by remember { mutableStateOf("") }
  // The card that opened each nested page, in page-stack order, so Back can focus it again.
  val openedBy = remember { mutableListOf<String>() }

  // The filesystem breadcrumb only owns Back while the files half is showing; the remote half
  // pops its own stack through RemoteLibraryRoute below.
  BackHandler(enabled = segment == LibrarySegment.Files && state.pages.size > 1 && backEnabled) {
    restoreKey = openedBy.removeLastOrNull() ?: ""
    if (viewModel.back()) backToken++
  }

  // A new page focuses its own first card; a return restores the card that opened the page. An open
  // search editor and a section a detail covers both keep the remote where it is.
  LaunchedEffect(segment, state.loading, state.pages.size, items.size, restoreToken, backToken, backEnabled) {
    // Only the files half owns this grid: a late local answer, a half a detail covers and an open
    // search editor all leave the remote where it is.
    if (segment != LibrarySegment.Files || !backEnabled) return@LaunchedEffect
    val keys = items.map { it.path.ifEmpty { it.title } }
    if (!state.loading && !editorOpen && keys.isNotEmpty()) {
      val target = restoreKey.takeIf { key -> key.isNotEmpty() && key in keys }
      restoreKey = ""
      val kept = selectedPath.takeIf { key -> key.isNotEmpty() && key in keys }
      val requester = target?.let { requesters[it] } ?: kept?.let { requesters[it] } ?: gridFocus
      runCatching { requester.requestFocus() }
    }
  }

  fun openFolder(folder: BrowseItem.Folder) {
    restoreKey = ""
    scope.launch {
      val result = runCatching { api.browse(folder.path, limit = LibraryViewModel.PAGE, skip = 0) }.getOrNull()
      if (result == null) {
        viewModel.open(folder.path, folder.title)
        return@launch
      }
      val files = result.items.filterIsInstance<BrowseItem.File>()
      if (files.isNotEmpty() && files.size == result.items.size) {
        onOpenDetail(DetailData.ofFolder(folder, files))
      } else {
        // Only a pushed level is consumed by Back, so the key is recorded only when it is pushed.
        openedBy.add(folder.path.ifEmpty { folder.title })
        viewModel.push(result.path.ifEmpty { folder.path }, folder.title, result.items, result.total)
      }
    }
  }

  Column(
    modifier = modifier.fillMaxSize().padding(start = Tokens.SafeX, top = Tokens.SafeY, end = Tokens.SafeX),
    verticalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    LibraryHeader(
      segment = segment,
      onFiles = { segment = LibrarySegment.Files },
      onServers = { segment = LibrarySegment.Servers },
    )

    if (segment == LibrarySegment.Files) {
      // The filesystem's own path, and only while the files half is the one on screen.
      if (state.pages.size > 1) {
        LibraryBreadcrumbLine(
          state.pages.joinToString("  ›  ") { it.title.ifEmpty { fallbackTitle } },
          TagLibraryBreadcrumb,
        )
      }
      // The root that lists the libraries themselves is the one level the server cannot narrow; a
      // real directory stays searchable while it loads, answers nothing or fails, so a committed
      // query can always be reopened and cleared.
      val searchable = state.current?.searchable == true
      LibraryToolbar(
        open = editorOpen && searchable,
        query = query,
        onQuery = { query = it },
        onOpen = { editorOpen = true; query = committed },
        onSubmit = { editorOpen = false; viewModel.search(query) },
        onClose = { editorOpen = false },
        committed = committed,
        available = searchable,
        openFocus = searchAction,
        fieldFocus = searchField,
      )
      Box(Modifier.weight(1f).fillMaxWidth()) {
        when {
          state.loading -> ShimmerCards()
          state.error -> ErrorPanel { viewModel.retry() }
          items.isEmpty() -> Text(
            // A level that was narrowed and matched nothing says so rather than reading as empty.
            stringResource(if (committed.isNotEmpty()) R.string.media_server_no_matches else R.string.tv_library_empty),
            color = Tokens.Muted,
            fontSize = 12.sp,
          )
          else -> BoxWithConstraints(Modifier.fillMaxSize()) {
            val columns = (((maxWidth.value + 18f) / 128f).toInt()).coerceAtLeast(1)
            LazyVerticalGrid(
              columns = GridCells.Fixed(columns),
              modifier = Modifier.focusRequester(gridFocus).focusGroup(),
              // Room for the focused card's scale and ring so the first row is not clipped.
              contentPadding = PaddingValues(start = CardRowInset, top = 10.dp, end = CardRowInset, bottom = 40.dp),
              horizontalArrangement = Arrangement.spacedBy(18.dp),
              verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
              itemsIndexed(items, key = { _, item -> item.path.ifEmpty { item.title } }) { index, item ->
                val key = item.path.ifEmpty { item.title }
                val requester = remember(key) { FocusRequester() }
                requesters[key] = requester
                PosterCard(
                  name = item.title,
                  imageUrl = (item.poster ?: item.wide)?.let(api::url),
                  progress = progressFraction(item),
                  caption = caption(item),
                  cardTag = key,
                  mosaic = item.mosaic.map(api::url),
                  onClick = {
                    when (item) {
                      is BrowseItem.Library -> viewModel.open(item.path, item.title)
                      is BrowseItem.Folder -> openFolder(item)
                      is BrowseItem.File -> onOpenDetail(DetailData.ofFile(item))
                    }
                  },
                  modifier = Modifier
                    .focusRequester(requester)
                    .onFocusChanged {
                      if (it.isFocused) {
                        viewModel.selectedPath = key
                        requesters[key] = requester
                        if (index >= items.size - columns) viewModel.loadMore()
                      }
                    },
                )
              }
            }
          }
        }
      }
    } else {
      RemoteLibraryRoute(
        api = remoteApi,
        imageUrl = { path -> path?.let(api::url) },
        segment = segment,
        onOpenItem = onOpenRemoteItem,
        onBackToFiles = { segment = LibrarySegment.Files },
        modifier = Modifier.weight(1f),
        restoreToken = restoreToken,
        backEnabled = backEnabled,
        loadDestinations = loadDestinations,
        onQueue = onQueue,
        // The section's own header and padding are already in place above and around this half.
        embedded = true,
      )
    }
  }
}

@Composable
private fun ErrorPanel(onRetry: () -> Unit) {
  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    Column(verticalArrangement = Arrangement.spacedBy(11.dp), horizontalAlignment = Alignment.CenterHorizontally) {
      Text(stringResource(R.string.tv_load_error), color = Tokens.Muted, fontSize = 12.sp)
      FocusButton(stringResource(R.string.tv_try_again), onClick = onRetry, kind = FocusButtonKind.Primary)
    }
  }
}

@Composable
private fun caption(item: BrowseItem): String =
  when (item) {
    is BrowseItem.Library -> stringResource(R.string.tv_library_files, item.fileCount.toString())
    is BrowseItem.Folder -> listOfNotNull(
      item.year?.takeIf { it.isNotBlank() },
      stringResource(R.string.tv_library_files, item.fileCount.toString()),
    ).joinToString(" · ")
    is BrowseItem.File -> item.year?.takeIf { it.isNotBlank() } ?: episodeLabel(item)
  }

private fun progressFraction(item: BrowseItem): Float? {
  val file = item as? BrowseItem.File ?: return null
  val duration = file.progress?.duration ?: 0.0
  val position = file.progress?.position ?: 0.0
  if (duration <= 0 || position <= 0) return null
  return (position / duration).toFloat()
}
