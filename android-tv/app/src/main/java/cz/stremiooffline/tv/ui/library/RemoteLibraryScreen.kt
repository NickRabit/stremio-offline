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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.tv.material3.Border
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Icon
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.CatalogApi
import cz.stremiooffline.tv.data.DownloadTargetDto
import cz.stremiooffline.tv.data.LibraryDto
import cz.stremiooffline.tv.data.MediaDto
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteLibraryApi
import cz.stremiooffline.tv.data.RemoteLibraryDto
import cz.stremiooffline.tv.data.RemoteProviderIdsDto
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.ui.catalog.NativeCopyRequest
import cz.stremiooffline.tv.ui.catalog.NativeQueuePanel
import cz.stremiooffline.tv.ui.catalog.VoiceLauncher
import cz.stremiooffline.tv.ui.catalog.nativeCopyTitle
import cz.stremiooffline.tv.ui.catalog.nativeQueueTarget
import cz.stremiooffline.tv.ui.catalog.rememberVoiceSearch
import cz.stremiooffline.tv.ui.catalog.resolveNativeCopy
import cz.stremiooffline.tv.ui.catalog.voiceSearchAvailable
import cz.stremiooffline.tv.ui.catalog.FolderIcon
import cz.stremiooffline.tv.ui.components.CardRowInset
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.components.PosterCard
import cz.stremiooffline.tv.ui.components.ShimmerCards
import cz.stremiooffline.tv.ui.components.TvSpinner
import cz.stremiooffline.tv.ui.detail.PlayTarget
import cz.stremiooffline.tv.ui.detail.RemoteDetailData
import cz.stremiooffline.tv.ui.detail.RemoteDetailScreen
import cz.stremiooffline.tv.ui.theme.Tokens
import kotlinx.coroutines.android.awaitFrame
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

const val TagLibrarySegments = "library_segments"
const val TagRemoteLoadMore = "remote_load_more"
const val TagRemoteBreadcrumb = "remote_breadcrumb"

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
  /** Set when the half was opened from the All grid: Back at the top level returns to All instead
   *  of leaving the picker on screen. */
  onBackToAll: (() -> Unit)? = null,
  modifier: Modifier = Modifier,
  restoreToken: Int = 0,
  /** False while a detail or the player covers this half, so a hidden Back never pops its stack. */
  backEnabled: Boolean = true,
  /** Whether a recognizer answers here; the mic button and the remote's mic key follow it. Overrides
   *  the device check when non-null, which is what a harness passes. */
  voiceAvailable: Boolean? = null,
  /** Test seam: answers a mic press without a device. Null asks the platform recognizer. */
  voiceLauncher: VoiceLauncher? = null,
  /** The destinations this account may copy into, read once when a card's copy action is used;
   *  null keeps the action off. */
  loadDestinations: (suspend () -> List<LibraryDto>)? = null,
  /** Queues one exact version into the exact library the viewer picked. */
  onQueue: (suspend (title: String, sourceId: String, media: MediaDto, target: DownloadTargetDto?) -> Unit)? = null,
  /** True when the Library section's own header, safe padding and heading are already in place
   *  around this half. Standalone (a harness, or a section of its own) the half draws its own. */
  embedded: Boolean = false,
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

  val searchAction = remember { FocusRequester() }
  val searchField = remember { FocusRequester() }
  val gridFocus = remember { FocusRequester() }
  val loadMoreFocus = remember { FocusRequester() }
  val errorFocus = remember { FocusRequester() }
  val requesters = remember(levelKey) { mutableMapOf<String, FocusRequester>() }

  var query by remember { mutableStateOf("") }
  var committed by remember { mutableStateOf("") }
  var editorOpen by remember { mutableStateOf(false) }
  val voice = rememberVoiceSearch(
    voiceAvailable ?: voiceSearchAvailable(),
    onVoiceResult = { spoken ->
      query = spoken
      committed = spoken
      editorOpen = false
      viewModel.search(spoken)
    },
    launcher = voiceLauncher,
  )

  // The card's copy panel: nothing is read for it until the viewer presses Menu or Info on a
  // playable card, so a listing never fans out into a source read per tile. One copy is in flight
  // at a time and its token outlives the answer, so a late one never touches another card's panel.
  var copyCard by remember { mutableStateOf<RemoteItemDto?>(null) }
  var copyRequest by remember { mutableStateOf<NativeCopyRequest?>(null) }
  var copyResolving by remember { mutableStateOf(false) }
  var copyBusy by remember { mutableStateOf(false) }
  var copyNotice by remember { mutableStateOf<String?>(null) }
  var copyToken by remember { mutableIntStateOf(0) }
  val copyScope = rememberCoroutineScope()
  val notAllowedText = stringResource(R.string.err_download_library_not_allowed)
  val destinationsFailedText = stringResource(R.string.media_server_error)

  fun openCardCopy(libraryId: String, item: RemoteItemDto) {
    val load = loadDestinations ?: return
    if (copyResolving || copyBusy) return
    val mine = ++copyToken
    copyResolving = true
    copyNotice = null
    copyCard = item
    copyScope.launch {
      try {
        val resolved = resolveNativeCopy(
          api = api, libraryId = libraryId, item = item,
          seriesName = null, seriesIds = null, sources = null, loadDestinations = load,
        )
        if (mine == copyToken) copyRequest = resolved
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (error: ApiError) {
        if (mine == copyToken) {
          copyNotice = error.serverMessage
            ?: if (error.failure == ApiFailure.Forbidden) notAllowedText else destinationsFailedText
          copyCard = null
        }
      } catch (_: Exception) {
        if (mine == copyToken) { copyNotice = destinationsFailedText; copyCard = null }
      } finally {
        if (mine == copyToken) copyResolving = false
      }
    }
  }

  fun queueCardCopy(stream: StreamDto, libraryId: String) {
    val queue = onQueue ?: return
    val subject = copyRequest?.subject ?: return
    if (copyBusy) return
    val mine = copyToken
    copyBusy = true
    copyNotice = null
    copyScope.launch {
      try {
        queue(nativeCopyTitle(subject), stream.sourceId, subject.media(), nativeQueueTarget(stream, libraryId))
        if (mine == copyToken) {
          val id = copyCard?.id
          copyRequest = null
          copyCard = null
          runCatching { id?.let { requesters[it] }?.requestFocus() }
        }
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (error: ApiError) {
        if (mine == copyToken) copyNotice = error.serverMessage ?: notAllowedText
      } catch (_: Exception) {
        if (mine == copyToken) copyNotice = notAllowedText
      } finally {
        if (mine == copyToken) copyBusy = false
      }
    }
  }

  fun closeCardCopy() {
    val id = copyCard?.id
    copyToken++
    copyRequest = null
    copyCard = null
    copyNotice = null
    copyResolving = false
    copyBusy = false
    runCatching { id?.let { requesters[it] }?.requestFocus() }
  }

  BackHandler(enabled = segment == LibrarySegment.Servers && backEnabled) {
    if (viewModel.back()) {
      if (onBackToAll != null && viewModel.state.levels.isEmpty()) onBackToAll()
    } else {
      onBackToFiles()
    }
  }

  LaunchedEffect(levelKey) {
    committed = (level as? RemoteLevel.Directory)?.state?.search.orEmpty()
    query = committed
    editorOpen = false
    // A copy that was still being resolved belongs to the card that asked for it: leaving the
    // level drops it, so a late answer never opens a panel over another listing or moves focus.
    copyToken++
    copyCard = null
    copyRequest = null
    copyNotice = null
    copyResolving = false
    copyBusy = false
  }

  // A page change focuses the card last used on this level, else the first card; Back restores the
  // card that opened the level because the selection is kept per level rather than cleared.
  LaunchedEffect(levelKey, items.map { it.id }, state.libraries.map { it.id }, segment, restoreToken, backEnabled) {
    // A late row, a hidden half and an open search editor all keep the remote where it is.
    if (segment != LibrarySegment.Servers || !backEnabled || editorOpen) return@LaunchedEffect
    awaitFrame()
    val remembered = viewModel.selectedFor(levelKey)?.let { requesters[it] }
    val requester = remembered ?: requesters.values.firstOrNull() ?: gridFocus
    runCatching { requester.requestFocus() }
  }

  // Embedded, the Library section already applied its own safe padding around this half; standalone
  // the half brings its own, so a screen entered from elsewhere is not glued to the edges.
  Box(modifier.then(if (embedded) Modifier else Modifier.padding(start = Tokens.SafeX, top = Tokens.SafeY, end = Tokens.SafeX))) {
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
      if (copyNotice != null && copyRequest == null) {
        Text(copyNotice!!, color = Tokens.Red, fontSize = 11.sp, modifier = Modifier.padding(bottom = 6.dp))
      }
      // One line for the whole path, so a nested folder is never a dead end on screen and the level's
      // own title is not repeated beside it.
      if (level != null) {
        LibraryBreadcrumbLine(state.levels.joinToString("  ›  ") { it.title }, TagRemoteBreadcrumb)
      }
      // The one compact toolbar of the section: the same search action the files half draws, with the
      // type chips of this level on the same row.
      val directory = level as? RemoteLevel.Directory
      LibraryToolbar(
        open = editorOpen && directory != null,
        query = query,
        onQuery = { query = it },
        onOpen = { editorOpen = true; query = committed },
        onSubmit = {
          editorOpen = false
          committed = query
          viewModel.search(query)
        },
        onClose = { editorOpen = false },
        committed = committed,
        available = directory != null,
        openFocus = searchAction,
        fieldFocus = searchField,
        voice = voice,
        trailing = if (directory != null) ({ TypeFilterChips(state = directory.state, onFilter = { viewModel.filter(it) }) }) else null,
      )
      Box(Modifier.weight(1f).fillMaxWidth()) {
        if (level == null) {
          LibraryPicker(state, viewModel, imageUrl, requesters, gridFocus, errorFocus)
        } else {
          ItemBrowser(
            level = level,
            items = items,
            imageUrl = imageUrl,
            viewModel = viewModel,
            committed = committed,
            requesters = requesters,
            gridFocus = gridFocus,
            loadMoreFocus = loadMoreFocus,
            errorFocus = errorFocus,
            onMenu = if (loadDestinations != null) { item -> openCardCopy(level.libraryId, item) } else null,
            onOpenItem = onOpenItem,
          )
        }
      }
    }

    val cardRequest = copyRequest
    if (cardRequest != null) {
      val kind = if (cardRequest.subject.kind == "episode") "series" else "movie"
      NativeQueuePanel(
        versions = cardRequest.versions,
        libraries = cardRequest.destinations.filter { it.canWrite && (it.type == kind || it.type == "mixed") },
        preferred = null,
        busy = copyBusy,
        notice = copyNotice,
        onQueue = { stream, libraryId -> queueCardCopy(stream, libraryId) },
        onClose = { closeCardCopy() },
      )
    }
  }
}

/**
 * One remote series opened from a Home or Favourites card. Its episodes page lazily through the
 * browse route and are drawn by the same [ItemBrowser] as the Servers half, in a view-model of
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
  loadDestinations: (suspend () -> List<LibraryDto>)? = null,
  onQueue: (suspend (title: String, sourceId: String, media: MediaDto, target: DownloadTargetDto?) -> Unit)? = null,
  /** The catalogue port the supplementary source groups need, forwarded to an episode's detail. */
  catalogueApi: CatalogApi? = null,
  /** The title's own stored row, forwarded to an episode's detail: the episode's position is the
   *  show's, exactly as it is for the same episode opened from the catalogue. */
  titleProgress: (suspend (String) -> ProgressDto?)? = null,
  forgetTitle: (suspend (String) -> Unit)? = null,
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

  // The episode grid's copy panel, opened by Menu/Info on a playable episode card.
  var copyCard by remember { mutableStateOf<RemoteItemDto?>(null) }
  var copyRequest by remember { mutableStateOf<NativeCopyRequest?>(null) }
  var copyResolving by remember { mutableStateOf(false) }
  var copyBusy by remember { mutableStateOf(false) }
  var copyNotice by remember { mutableStateOf<String?>(null) }
  var copyToken by remember { mutableIntStateOf(0) }
  val copyScope = rememberCoroutineScope()
  val notAllowedText = stringResource(R.string.err_download_library_not_allowed)
  val destinationsFailedText = stringResource(R.string.media_server_error)

  fun openCardCopy(item: RemoteItemDto) {
    val load = loadDestinations ?: return
    if (copyResolving || copyBusy) return
    val mine = ++copyToken
    copyResolving = true
    copyNotice = null
    copyCard = item
    copyScope.launch {
      try {
        val resolved = resolveNativeCopy(
          api = api, libraryId = data.libraryId, item = item,
          seriesName = data.item.name, seriesIds = data.item.providerIds, sources = null, loadDestinations = load,
        )
        if (mine == copyToken) copyRequest = resolved
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (error: ApiError) {
        if (mine == copyToken) {
          copyNotice = error.serverMessage
            ?: if (error.failure == ApiFailure.Forbidden) notAllowedText else destinationsFailedText
          copyCard = null
        }
      } catch (_: Exception) {
        if (mine == copyToken) { copyNotice = destinationsFailedText; copyCard = null }
      } finally {
        if (mine == copyToken) copyResolving = false
      }
    }
  }

  fun queueCardCopy(stream: StreamDto, libraryId: String) {
    val queue = onQueue ?: return
    val subject = copyRequest?.subject ?: return
    if (copyBusy) return
    val mine = copyToken
    copyBusy = true
    copyNotice = null
    copyScope.launch {
      try {
        queue(nativeCopyTitle(subject), stream.sourceId, subject.media(), nativeQueueTarget(stream, libraryId))
        if (mine == copyToken) {
          val id = copyCard?.id
          copyRequest = null
          copyCard = null
          runCatching { id?.let { requesters[it] }?.requestFocus() }
        }
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (error: ApiError) {
        if (mine == copyToken) copyNotice = error.serverMessage ?: notAllowedText
      } catch (_: Exception) {
        if (mine == copyToken) copyNotice = notAllowedText
      } finally {
        if (mine == copyToken) copyBusy = false
      }
    }
  }

  fun closeCardCopy() {
    val id = copyCard?.id
    copyToken++
    copyRequest = null
    copyCard = null
    copyNotice = null
    copyResolving = false
    copyBusy = false
    runCatching { id?.let { requesters[it] }?.requestFocus() }
  }

  // A page change focuses the card last used; coming back from an episode restores the card that
  // opened it, so the viewer lands where they left rather than on the first card.
  LaunchedEffect(levelKey, items.map { it.id }, restoreToken, returnToken, episode) {
    if (episode != null) return@LaunchedEffect
    awaitFrame()
    val remembered = viewModel.selectedFor(levelKey)?.let { requesters[it] }
    val requester = remembered ?: requesters.values.firstOrNull() ?: gridFocus
    runCatching { requester.requestFocus() }
  }

  // A copy still being resolved belongs to the card that asked for it: leaving the level or
  // opening an episode drops it, so a late answer never opens a panel over another screen.
  LaunchedEffect(levelKey, episode) {
    copyToken++
    copyCard = null
    copyRequest = null
    copyNotice = null
    copyResolving = false
    copyBusy = false
  }

  Box(Modifier.fillMaxSize()) {
    if (episode == null) Column(Modifier.fillMaxSize().padding(start = Tokens.SafeX, top = Tokens.SafeY, end = Tokens.SafeX)) {
      if (copyNotice != null && copyRequest == null) {
        Text(copyNotice!!, color = Tokens.Red, fontSize = 11.sp, modifier = Modifier.padding(bottom = 6.dp))
      }
      // This screen is opened on its own from a Home or Favourites card, so it names the series once
      // and nothing above it carries that name.
      Text(
        level?.title.orEmpty(),
        color = Tokens.Text,
        fontSize = 25.sp,
        fontWeight = FontWeight.ExtraBold,
        letterSpacing = (-0.8).sp,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
      Box(Modifier.weight(1f).fillMaxWidth()) {
        if (level == null) {
          ShimmerCards()
        } else {
          ItemBrowser(
            level = level,
            items = items,
            imageUrl = imageUrl,
            viewModel = viewModel,
            committed = "",
            requesters = requesters,
            gridFocus = gridFocus,
            loadMoreFocus = loadMoreFocus,
            errorFocus = errorFocus,
            onMenu = if (loadDestinations != null) { item -> openCardCopy(item) } else null,
            onOpenItem = { libraryId, libraryName, provider, item ->
              episode = RemoteDetailData(
                libraryId = libraryId,
                libraryName = libraryName,
                provider = provider,
                item = item,
                seriesName = data.item.name,
                seriesIds = data.item.providerIds,
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
        loadDestinations = loadDestinations,
        onQueue = onQueue,
        catalogueApi = catalogueApi,
        titleProgress = titleProgress,
        forgetTitle = forgetTitle,
      )
    }

    val cardRequest = copyRequest
    if (cardRequest != null) {
      val kind = if (cardRequest.subject.kind == "episode") "series" else "movie"
      NativeQueuePanel(
        versions = cardRequest.versions,
        libraries = cardRequest.destinations.filter { it.canWrite && (it.type == kind || it.type == "mixed") },
        preferred = null,
        busy = copyBusy,
        notice = copyNotice,
        onQueue = { stream, libraryId -> queueCardCopy(stream, libraryId) },
        onClose = { closeCardCopy() },
      )
    }
  }
}

/** The Files/Media servers switch at the top of the section. */
@Composable
internal fun LibrarySegments(segment: LibrarySegment, onAll: () -> Unit, onFiles: () -> Unit, onServers: () -> Unit) {
  val allFocus = remember { FocusRequester() }
  val filesFocus = remember { FocusRequester() }
  val serversFocus = remember { FocusRequester() }
  Row(
    modifier = Modifier.testTag(TagLibrarySegments).focusGroup(),
    horizontalArrangement = Arrangement.spacedBy(11.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    SegmentButton(
      text = stringResource(R.string.media_server_filter_all),
      selected = segment == LibrarySegment.All,
      onClick = onAll,
      modifier = Modifier.focusRequester(allFocus),
    )
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
  imageUrl: (String?) -> String?,
  requesters: MutableMap<String, FocusRequester>,
  gridFocus: FocusRequester,
  errorFocus: FocusRequester,
) {
  // The picker is the root of the servers half: the section's own heading already names the page, so
  // the library cards start straight away rather than under a second large heading.
  Box(Modifier.fillMaxSize()) {
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
              DisposableEffect(key, requester) {
                requesters[key] = requester
                onDispose { if (requesters[key] === requester) requesters.remove(key) }
              }
              RemoteArtTile(
                title = library.name,
                libraryId = library.id,
                parentId = null,
                mosaic = library.mosaic,
                poster = library.poster,
                container = true,
                viewModel = viewModel,
                imageUrl = imageUrl,
                cardTag = remoteLibraryTag(library.id),
                caption = libraryCaption(library.provider),
                onClick = { viewModel.openLibrary(library) },
                modifier = Modifier
                  .focusRequester(requester)
                  .onFocusChanged { if (it.isFocused) viewModel.select(REMOTE_PICKER_KEY, key) },
              )
            }
          }
        }
    }
  }
}

/**
 * One library root or folder tile, drawn exactly like an ordinary library card: the same
 * [PosterCard] with the preview mosaic and shape. A container without artwork falls back to the
 * plain folder/drive icon; the provider and read-only note stay as the secondary caption.
 */
@Composable
internal fun RemoteArtTile(
  title: String,
  libraryId: String,
  parentId: String?,
  mosaic: Boolean,
  container: Boolean,
  viewModel: RemoteLibraryViewModel,
  imageUrl: (String?) -> String?,
  cardTag: String,
  caption: String,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
  poster: String? = null,
  wide: String? = null,
) {
  val key = RemoteLibraryViewModel.previewKey(libraryId, parentId)
  // Only a composed tile asks, so an off-screen folder never fetches; the cache dedupes repeats.
  // A tile that already carries its own poster asks for nothing: the own picture wins.
  LaunchedEffect(key, mosaic, poster, viewModel.preview(key) == null) {
    viewModel.loadPreview(key, libraryId, parentId, mosaic, poster)
  }
  val posters = if (mosaic && poster.isNullOrEmpty()) (viewModel.preview(key) as? RemotePreviewState.Ready)?.posters.orEmpty() else emptyList()
  val art = posters.mapNotNull(imageUrl)
  Box {
    PosterCard(
      name = title,
      imageUrl = imageUrl(poster) ?: art.firstOrNull(),
      fallbackImageUrl = imageUrl(wide),
      progress = null,
      caption = caption,
      cardTag = cardTag,
      mosaic = art,
      onClick = onClick,
      modifier = modifier,
    )
    if (container && art.isEmpty() && poster == null && wide == null) {
      Box(Modifier.size(110.dp, 165.dp), contentAlignment = Alignment.Center) {
        Icon(FolderIcon, contentDescription = null, tint = Tokens.Muted, modifier = Modifier.size(46.dp))
      }
    }
  }
}

@Composable
private fun ItemBrowser(
  level: RemoteLevel,
  items: List<RemoteItemDto>,
  imageUrl: (String?) -> String?,
  viewModel: RemoteLibraryViewModel,
  /** The query this level is narrowed by, so an empty listing says which one matched nothing. */
  committed: String,
  requesters: MutableMap<String, FocusRequester>,
  gridFocus: FocusRequester,
  loadMoreFocus: FocusRequester,
  errorFocus: FocusRequester,
  onMenu: ((RemoteItemDto) -> Unit)? = null,
  onOpenItem: (libraryId: String, libraryName: String, provider: String, item: RemoteItemDto) -> Unit,
) {
  val search = level.state
  val appendRetryFocus = remember { FocusRequester() }

  // The level's own name and its search live in the section's header and toolbar above this grid;
  // the browser is only the rows themselves.
  Column(Modifier.fillMaxSize()) {
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
            search.loading -> ShimmerCards(modifier = Modifier.focusRequester(gridFocus).focusable().testTag("remote-loading"))
            search.error != null -> RemoteErrorPanel(search.error, { viewModel.retry() }, errorFocus)
            // Rows may be filtered out entirely while a cursor still holds more: keep the Load more.
            items.isEmpty() && !search.hasMore -> Text(
              if (committed.isNotEmpty()) stringResource(R.string.media_server_no_matches) else stringResource(R.string.media_server_empty_items),
              color = Tokens.Muted,
              fontSize = 12.sp,
            )
            else -> ItemGrid(
              level = level,
              items = items,
              imageUrl = imageUrl,
              viewModel = viewModel,
              requesters = requesters,
              gridFocus = gridFocus,
              loadMoreFocus = loadMoreFocus,
              onMenu = onMenu,
              onOpen = { item ->
                // A folder opens one directory level deeper; it is never playable, so it never
                // reaches the shell's item detail.
                if (item.type == "folder" || item.type == "season") viewModel.openFolder(item)
                else onOpenItem(level.libraryId, level.libraryName, level.provider, item)
              },
            )
          }
        }
      }
    }
  }
}

@Composable
private fun ItemGrid(
  level: RemoteLevel,
  items: List<RemoteItemDto>,
  imageUrl: (String?) -> String?,
  viewModel: RemoteLibraryViewModel,
  requesters: MutableMap<String, FocusRequester>,
  gridFocus: FocusRequester,
  loadMoreFocus: FocusRequester,
  /** Invoked for a playable card when the viewer presses Menu or Info on it; null disables it. */
  onMenu: ((RemoteItemDto) -> Unit)? = null,
  onOpen: (RemoteItemDto) -> Unit,
) {
  val isEpisodes = level is RemoteLevel.Episodes
  val hasMore = level.state.hasMore
  val loadingMore = level.state.loadingMore
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
        DisposableEffect(item.id, requester) {
          requesters[item.id] = requester
          onDispose { if (requesters[item.id] === requester) requesters.remove(item.id) }
        }
        val focus = Modifier
          .focusRequester(requester)
          .onFocusChanged {
            if (it.isFocused) {
              viewModel.select(level.key, item.id)
              if (index >= items.size - columns) viewModel.loadMore()
            }
          }
          // A playable item's copy action lives behind Menu/Info, the way a TV remote offers a
          // context action without a long press; a folder or a series has nothing to copy.
          .then(
            if (onMenu != null && item.type != "folder" && item.type != "season" && item.type != "series") {
              Modifier.onPreviewKeyEvent { event ->
                if (event.type == KeyEventType.KeyDown && (event.key == Key.Menu || event.key == Key.Info)) {
                  onMenu(item)
                  true
                } else {
                  false
                }
              }
            } else Modifier,
          )
        if (item.type == "folder" || item.type == "season") {
          RemoteArtTile(
            title = item.name,
            libraryId = level.libraryId,
            parentId = item.id,
            // A season never previews: the collage would be its episodes, which says nothing of it.
            mosaic = level.mosaic && item.type != "season",
            container = true,
            viewModel = viewModel,
            imageUrl = imageUrl,
            cardTag = remoteItemTag(item.id),
            poster = item.poster,
            wide = item.wide,
            caption = stringResource(R.string.media_server_read_only),
            onClick = { onOpen(item) },
            modifier = focus,
          )
        } else {
          PosterCard(
            name = item.name,
            imageUrl = imageUrl(item.poster),
            fallbackImageUrl = imageUrl(item.wide),
            progress = null,
            caption = if (isEpisodes) episodeCaption(item) else null,
            cardTag = remoteItemTag(item.id),
            onClick = { onOpen(item) },
            modifier = focus,
          )
        }
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

@Composable
internal fun libraryCaption(provider: String): String =
  listOfNotNull(providerLabel(provider).takeIf { it.isNotBlank() }, stringResource(R.string.media_server_read_only))
    .joinToString(" · ")

private fun providerLabel(provider: String): String = when (provider.lowercase()) {
  "jellyfin" -> "Jellyfin"
  "emby" -> "Emby"
  else -> provider
}

private fun episodeCaption(item: RemoteItemDto): String =
  if (item.season != null || item.episode != null) "S${item.season ?: 0} · E${item.episode ?: 0}" else ""
