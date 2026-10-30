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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
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
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.foundation.focusGroup
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.tv.material3.Icon
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.DownloadTargetDto
import cz.stremiooffline.tv.data.GlobalSearchLibraryDto
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.LibraryDto
import cz.stremiooffline.tv.data.MediaDto
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.ui.components.CardRowInset
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.components.LibraryRootCard
import cz.stremiooffline.tv.ui.components.PosterCard
import cz.stremiooffline.tv.ui.components.ShimmerCards
import cz.stremiooffline.tv.ui.catalog.FolderIcon
import cz.stremiooffline.tv.ui.detail.DetailData
import cz.stremiooffline.tv.ui.detail.episodeLabel
import cz.stremiooffline.tv.ui.search.LibrarySearchScope
import cz.stremiooffline.tv.ui.theme.Tokens
import kotlinx.coroutines.android.awaitFrame
import kotlinx.coroutines.launch

const val TagLibraryBreadcrumb = "library_breadcrumb"
const val TagLibraryAllGrid = "library_all_grid"

/** The composed mosaic in the poster shape, as the web's `remoteMosaicArtwork` asks for it: the URL
 *  with its `shape` query parameter set to `poster` (added, or replaced if present). */
internal fun posterMosaicUrl(url: String): String {
  val base = url.substringBefore('?')
  val query = url.substringAfter('?', "")
  var shaped = false
  val kept = query.split('&').filter { it.isNotEmpty() }.map { param ->
    if (param.substringBefore('=') == "shape") {
      shaped = true
      "shape=poster"
    } else {
      param
    }
  }
  val params = if (shaped) kept else kept + "shape=poster"
  return if (params.isEmpty()) base else "$base?${params.joinToString("&")}"
}

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
  /** Whether in-library search runs on the Search everywhere engine. */
  searchEverywhereEnabled: Boolean = false,
  /** Opens the section's own search page at the level on screen. */
  onOpenSearch: (LibrarySearchScope) -> Unit = {},
  /** Bumped by the shell when Back returns from the search page. */
  searchReturnToken: Int = 0,
) {
  var segment by rememberSaveable { mutableStateOf(LibrarySegment.All) }
  // The All tile the viewer opened, so Back to All lands on it rather than on the grid's start.
  var enteredFromAll by rememberSaveable { mutableStateOf<String?>(null) }
  val viewModel = viewModel<LibraryViewModel>(factory = LibraryViewModel.factory(api, pendingDelayMs))
  val remoteViewModel = viewModel<RemoteLibraryViewModel>(factory = RemoteLibraryViewModel.factory(api))
  // A fresh entry starts at the root; a Home jump (arriving with a path) pushes its folder.
  LaunchedEffect(Unit) { if (viewModel.state.pages.isEmpty() || viewModel.needsRootReset) viewModel.start() }
  LaunchedEffect(pushPath) {
    if (pushPath.isNullOrEmpty()) return@LaunchedEffect
    val title = pushPath.substringAfterLast('/').ifEmpty { pushPath }
    // A Home or catalogue jump is a folder inside the filesystem, so the section shows Files.
    enteredFromAll = null
    segment = LibrarySegment.Files
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
  // The flag-off fallback still narrows the level in place, so it keeps its editor text and the
  // query the level is committed to.
  val committed = state.current?.search.orEmpty()
  var editorOpen by remember { mutableStateOf(false) }
  var query by remember { mutableStateOf("") }
  val searchAction = remember { FocusRequester() }
  val searchField = remember { FocusRequester() }
  val allGridFocus = remember { FocusRequester() }
  val allGridState = rememberLazyGridState()
  val allRequesters = remember { mutableMapOf<String, FocusRequester>() }
  var libraryIds by remember { mutableStateOf(emptyList<String>()) }
  LaunchedEffect(Unit) {
    libraryIds = runCatching { api.libraries().map { it.id } }.getOrDefault(emptyList())
  }
  LaunchedEffect(searchEverywhereEnabled) {
    viewModel.setSearchEngine(searchEverywhereEnabled)
  }
  LaunchedEffect(segment, state.pages.size) {
    editorOpen = false
    query = state.current?.search.orEmpty()
  }
  val knownLibraryIds = (
    libraryIds + state.pages.flatMap { page ->
      page.items.filterIsInstance<BrowseItem.Library>().map { it.libraryId.ifEmpty { it.path } }
    }
  ).distinct()
  val localScope = localSearchScope(state.current, knownLibraryIds)
  val scopeTitle = state.pages.mapNotNull { page -> page.title.takeIf { it.isNotBlank() } }
    .joinToString("  ›  ")
    .ifEmpty { fallbackTitle }
  val searchAvailable = searchEverywhereEnabled || state.current?.searchable == true
  fun openLibrarySearch() {
    onOpenSearch(LibrarySearchScope(localScope, listOf("local"), scopeTitle))
  }

  // Bumped whenever Back pops a level, so the return restores the card that opened that level.
  var backToken by remember { mutableIntStateOf(0) }
  var restoreKey by remember { mutableStateOf("") }
  var consumedSearchReturn by rememberSaveable { mutableIntStateOf(0) }
  // The card that opened each nested page, in page-stack order, so Back can focus it again.
  val openedBy = remember { mutableListOf<String>() }

  // The filesystem breadcrumb only owns Back while the files half is showing; the remote half
  // pops its own stack through RemoteLibraryRoute below.
  BackHandler(
    enabled = segment == LibrarySegment.Files && backEnabled && state.pages.size > 1,
  ) {
    restoreKey = openedBy.removeLastOrNull() ?: ""
    if (viewModel.back()) {
      // A library entered from All has no Files root above it: the pop lands back on the All grid.
      if (viewModel.state.pages.size == 1 && enteredFromAll != null) {
        segment = LibrarySegment.All
      } else {
        backToken++
      }
    }
  }

  // Returning to the All grid focuses the tile that was opened, then forgets it.
  LaunchedEffect(
    segment,
    enteredFromAll,
    state.pages.firstOrNull()?.items?.size,
    remoteViewModel.state.libraries.size,
    backEnabled,
  ) {
    if (segment != LibrarySegment.All || !backEnabled) return@LaunchedEffect
    val key = enteredFromAll ?: return@LaunchedEffect
    awaitFrame()
    val requester = allRequesters[key] ?: return@LaunchedEffect
    if (runCatching { requester.requestFocus() }.isSuccess) enteredFromAll = null
  }

  // A plain entry into All takes the first tile, or the grid itself when it holds none, so the
  // remote starts inside the half and the rail is one LEFT away. A return is left to the effect above.
  LaunchedEffect(segment, state.loading) {
    if (segment != LibrarySegment.All || state.loading || enteredFromAll != null) return@LaunchedEffect
    awaitFrame()
    runCatching { allGridFocus.requestFocus() }
  }

  // A new page focuses its own first card; a return restores the card that opened the page. An open
  // search editor and a section a detail covers both keep the remote where it is.
  LaunchedEffect(
    segment,
    state.loading,
    state.pages.size,
    items.size,
    restoreToken,
    backToken,
    backEnabled,
    searchReturnToken,
  ) {
    // Only the files half owns this grid: a late local answer, a half a detail covers and an open
    // search editor all leave the remote where it is.
    if (segment != LibrarySegment.Files || !backEnabled) return@LaunchedEffect
    if (searchReturnToken > consumedSearchReturn && searchAvailable) {
      consumedSearchReturn = searchReturnToken
      awaitFrame()
      runCatching { searchAction.requestFocus() }
      return@LaunchedEffect
    }
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
      onAll = { enteredFromAll = null; segment = LibrarySegment.All },
      onFiles = { enteredFromAll = null; segment = LibrarySegment.Files },
      onServers = { enteredFromAll = null; segment = LibrarySegment.Servers },
    )

    if (segment == LibrarySegment.All) {
      val local = state.pages.firstOrNull()?.items.orEmpty().filterIsInstance<BrowseItem.Library>()
      val remote = remoteViewModel.state.libraries
      // The All grid draws the same rows the two halves do, so it loads the root and the list itself.
      LaunchedEffect(Unit) { if (viewModel.state.pages.isEmpty()) viewModel.start() }
      LaunchedEffect(Unit) {
        if (remoteViewModel.state.libraries.isEmpty() && !remoteViewModel.state.librariesLoading) {
          remoteViewModel.loadLibraries()
        }
      }
      LibraryToolbar(
        onSearch = {},
        available = false,
        openFocus = searchAction,
      )
      Box(Modifier.weight(1f).fillMaxWidth()) {
        // The local root's loading is the only one the All grid waits for; the media-server list
        // simply contributes no tiles while it is empty, loading or failed.
        if (state.loading && local.isEmpty()) {
          ShimmerCards()
        } else {
          BoxWithConstraints(Modifier.fillMaxSize()) {
            val columns = (((maxWidth.value + 18f) / 378f).toInt()).coerceAtLeast(1)
            LazyVerticalGrid(
              columns = GridCells.Fixed(columns),
              state = allGridState,
              modifier = Modifier.focusRequester(allGridFocus).focusGroup().testTag(TagLibraryAllGrid),
              contentPadding = PaddingValues(start = CardRowInset, top = 10.dp, end = CardRowInset, bottom = 40.dp),
              horizontalArrangement = Arrangement.spacedBy(18.dp),
              verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
              itemsIndexed(local, key = { _, item -> allLocalKey(item.path) }) { _, item ->
                val key = allLocalKey(item.path)
                val requester = remember(key) { FocusRequester() }
                allRequesters[key] = requester
                LocalLibraryCard(
                  item = item,
                  api = api,
                  cardTag = allLocalTag(item.path),
                  onClick = {
                    enteredFromAll = key
                    segment = LibrarySegment.Files
                    viewModel.open(item.path, item.title)
                  },
                  modifier = Modifier
                    .focusRequester(requester)
                    .onFocusChanged { if (it.isFocused) viewModel.selectedPath = item.path },
                )
              }
              items(remote, key = { library -> allRemoteKey(library.id) }) { library ->
                val key = allRemoteKey(library.id)
                val requester = remember(key) { FocusRequester() }
                allRequesters[key] = requester
                RemoteArtTile(
                  title = library.name,
                  libraryId = library.id,
                  parentId = null,
                  mosaic = library.mosaic,
                  poster = library.poster,
                  container = true,
                  viewModel = remoteViewModel,
                  imageUrl = { path -> path?.let(api::url) },
                  cardTag = allRemoteTag(library.id),
                  caption = libraryCaption(library.provider),
                  onClick = {
                    enteredFromAll = key
                    segment = LibrarySegment.Servers
                    remoteViewModel.openLibrary(library)
                  },
                  modifier = Modifier.focusRequester(requester),
                )
              }
            }
          }
        }
      }
    } else if (segment == LibrarySegment.Files) {
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
      if (searchEverywhereEnabled) {
        LibraryToolbar(
          onSearch = { openLibrarySearch() },
          available = searchAvailable,
          openFocus = searchAction,
        )
      } else {
        LibrarySearchFallback(
          open = editorOpen && searchable,
          query = query,
          onQuery = { query = it },
          onOpen = { editorOpen = true; query = committed },
          onSubmit = { editorOpen = false; viewModel.search(query) },
          onClose = { editorOpen = false },
          available = searchable,
          openFocus = searchAction,
          fieldFocus = searchField,
        )
      }
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
            val wideRoots = items.any { it is BrowseItem.Library }
            val columns = (((maxWidth.value + 18f) / if (wideRoots) 378f else 128f).toInt()).coerceAtLeast(1)
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
                LocalLibraryCard(
                  item = item,
                  api = api,
                  cardTag = key,
                  onClick = {
                    when (item) {
                      is BrowseItem.Library -> viewModel.open(item.path, item.title)
                      is BrowseItem.Folder -> openFolder(item)
                      is BrowseItem.File -> onOpenDetail(DetailData.ofFile(item))
                    }
                  },
                  modifier = Modifier
                    .focusRequester(requester)
                    .then(
                      if (index < columns && searchAvailable) {
                        Modifier.focusProperties { up = searchAction }
                      } else {
                        Modifier
                      },
                    )
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
        api = api,
        imageUrl = { path -> path?.let(api::url) },
        segment = segment,
        onOpenItem = onOpenRemoteItem,
        onBackToFiles = { segment = LibrarySegment.Files },
        onBackToAll = if (enteredFromAll != null) ({ segment = LibrarySegment.All }) else null,
        modifier = Modifier.weight(1f),
        restoreToken = restoreToken,
        backEnabled = backEnabled,
        loadDestinations = loadDestinations,
        onQueue = onQueue,
        // The section's own header and padding are already in place above and around this half.
        embedded = true,
        searchEverywhereEnabled = searchEverywhereEnabled,
        onOpenSearch = onOpenSearch,
        searchReturnToken = searchReturnToken,
      )
    }
  }
}

/** The tag and the restore key of one All grid tile, so Back lands on the tile the viewer opened. */
private fun allLocalKey(path: String): String = "local:$path"

private fun allRemoteKey(libraryId: String): String = "remote:$libraryId"

/** The tag of one All grid card; distinct from the restore key so the two halves' tags stay apart. */
private fun allLocalTag(path: String): String = "all_local:$path"

private fun allRemoteTag(libraryId: String): String = "all_remote:$libraryId"

/** One library tile of the filesystem root, drawn the same way by the Files grid and the All grid. */
@Composable
private fun LocalLibraryCard(
  item: BrowseItem,
  api: TvApi,
  cardTag: String,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  if (item is BrowseItem.Library) {
    LibraryRootCard(
      name = item.title,
      caption = caption(item),
      poster = (item.poster ?: item.wide)?.let(api::url),
      composedMosaic = item.mosaicImage?.let(api::url)?.let(::posterMosaicUrl),
      posters = item.mosaic.map(api::url),
      count = item.fileCount,
      fallback = {
        Icon(FolderIcon, contentDescription = null, tint = Tokens.Muted, modifier = Modifier.size(46.dp))
      },
      cardTag = cardTag,
      onClick = onClick,
      modifier = modifier,
    )
  } else {
    PosterCard(
      name = item.title,
      imageUrl = (item.mosaicImage?.let(::posterMosaicUrl) ?: item.poster ?: item.wide)?.let(api::url),
      progress = progressFraction(item),
      caption = caption(item),
      cardTag = cardTag,
      mosaic = item.mosaic.map(api::url),
      imageBeforeMosaic = item.mosaicImage != null && item.mosaic.size >= 2,
      onClick = onClick,
      modifier = modifier,
    )
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

internal fun localSearchScope(page: LibraryPage?, libraryIds: List<String>): GlobalSearchLibraryDto? {
  if (page == null) return null
  val first = page.path.substringBefore('/')
  if (first.isNotEmpty() && (first in libraryIds || first.startsWith("lib_"))) {
    val relative = page.path.removePrefix(first).trim('/')
    return GlobalSearchLibraryDto(first, path = relative.ifEmpty { null })
  }
  if (page.items.any { it is BrowseItem.Library }) return null
  val only = libraryIds.singleOrNull() ?: return null
  return GlobalSearchLibraryDto(only, path = page.path.ifEmpty { null })
}
