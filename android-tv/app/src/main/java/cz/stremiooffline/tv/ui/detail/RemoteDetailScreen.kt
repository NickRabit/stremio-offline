package cz.stremiooffline.tv.ui.detail

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import coil.compose.AsyncImage
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.catalog.ProgressKey
import cz.stremiooffline.tv.catalog.Streams
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.CatalogApi
import cz.stremiooffline.tv.data.DownloadTargetDto
import cz.stremiooffline.tv.data.LibraryDto
import cz.stremiooffline.tv.data.MediaDto
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.RemoteItemStateDto
import cz.stremiooffline.tv.data.RemoteItemStatePatch
import cz.stremiooffline.tv.data.RemoteLibraryApi
import cz.stremiooffline.tv.data.RemoteProviderIdsDto
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.playback.Progress
import cz.stremiooffline.tv.ui.catalog.BindSourceProfiles
import cz.stremiooffline.tv.ui.catalog.ActionCaption
import cz.stremiooffline.tv.ui.catalog.DetailAction
import cz.stremiooffline.tv.ui.catalog.DetailActionRow
import cz.stremiooffline.tv.ui.catalog.DownloadIcon
import cz.stremiooffline.tv.ui.catalog.EyeIcon
import cz.stremiooffline.tv.ui.catalog.EyeOffIcon
import cz.stremiooffline.tv.ui.catalog.NativeCopyRequest
import cz.stremiooffline.tv.ui.catalog.NativeQueuePanel
import cz.stremiooffline.tv.ui.catalog.NativeSourceState
import cz.stremiooffline.tv.ui.catalog.NativeSources
import cz.stremiooffline.tv.ui.catalog.NativeSourcesPanel
import cz.stremiooffline.tv.ui.catalog.ReplayIcon
import cz.stremiooffline.tv.ui.catalog.SourceFilterState
import cz.stremiooffline.tv.ui.catalog.SourceSaveRequest
import cz.stremiooffline.tv.ui.catalog.SourceSaveState
import cz.stremiooffline.tv.ui.catalog.chosenSourceCaption
import cz.stremiooffline.tv.ui.catalog.nativeAddonIdentity
import cz.stremiooffline.tv.ui.catalog.nativeCopyTitle
import cz.stremiooffline.tv.ui.catalog.nativeCopySubject
import cz.stremiooffline.tv.ui.catalog.nativeQueueTarget
import cz.stremiooffline.tv.ui.catalog.nativeRowTarget
import cz.stremiooffline.tv.ui.catalog.resolveNativeCopy
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.library.RemoteSeriesScreen
import cz.stremiooffline.tv.ui.theme.Tokens
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.android.awaitFrame
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

const val TagRemoteDetailPlay = "remote_play"
const val TagRemoteDetailStartOver = "remote_start_over"
const val TagRemoteDetailFavorite = "remote_favorite"
const val TagRemoteDetailWatched = "remote_watched"
const val TagRemoteDetailVersions = "remote_versions"
const val TagRemoteStateCaption = "remote_state_caption"
const val TagRemoteSourcesRetry = "remote_sources_retry"
const val TagRemoteStateRetry = "remote_state_retry"
const val TagRemoteDetailToLibrary = "remote_to_library"
const val TagRemoteDetailMarkWatched = "remote_detail_mark_watched"
const val TagRemoteDetailMarkUnwatched = "remote_detail_mark_unwatched"
const val TagRemoteDetailPickCaption = "remote_detail_pick_caption"
const val TagRemoteCopyNotice = "remote_copy_notice"
const val TagRemoteSourceNotice = "remote_source_notice"

/** What one native remote item's detail needs: the library and the item's opaque id. */
data class RemoteDetailData(
  val libraryId: String,
  val libraryName: String,
  val provider: String,
  val item: RemoteItemDto,
  val seriesName: String? = null,
  /** The parent series' external ids, when the caller already holds them, so an episode's copy
   *  carries the series' catalogue id without reading the parent again. */
  val seriesIds: RemoteProviderIdsDto? = null,
  /** Opened from Continue watching: Play is pressed once the item and a version have loaded. */
  val autoPlay: Boolean = false,
) {
  val isEpisode: Boolean get() = item.type == "episode"
}

/** A native item, its local state and copies, with every supplementary source group behind the
 *  Versions panel: the viewer's own copies, the other media libraries and the addon rows. */
@Composable
fun RemoteDetailScreen(
  api: RemoteLibraryApi,
  data: RemoteDetailData,
  /** The session image loader; remote artwork is same-origin and content-authorized. */
  imageUrl: (String?) -> String? = { null },
  onPlay: (PlayTarget) -> Unit,
  onBack: () -> Unit,
  backEnabled: Boolean = true,
  restoreToken: Int = 0,
  /** The destinations this account may copy into, read once when the copy action is pressed.
   *  Null keeps the action off entirely, which is what a harness with no catalogue surface passes. */
  loadDestinations: (suspend () -> List<LibraryDto>)? = null,
  /** Queues one exact version into the exact library the viewer picked. */
  onQueue: (suspend (title: String, sourceId: String, media: MediaDto, target: DownloadTargetDto?) -> Unit)? = null,
  /** The catalogue surface the explicit addon discovery needs. Null keeps the whole addon block
   *  off, which is what a harness with no catalogue surface passes. */
  catalogueApi: CatalogApi? = null,
  /** The title's own stored row, read for the item's catalogue identity when one can be derived.
   *  Null leaves the item's own remote state as the only store, which is what a harness with no
   *  progress route passes. */
  titleProgress: (suspend (String) -> ProgressDto?)? = null,
  /** Forgets the title's own row; Forget and Mark watched clear it beside the item's own state. */
  forgetTitle: (suspend (String) -> Unit)? = null,
) {
  // A series has no playable versions of its own: its card opens the episode grid instead.
  if (data.item.type == "series" || data.item.type == "season") {
    RemoteSeriesScreen(
      api = api,
      data = data,
      imageUrl = imageUrl,
      onPlay = onPlay,
      onBack = onBack,
      backEnabled = backEnabled,
      restoreToken = restoreToken,
      loadDestinations = loadDestinations,
      onQueue = onQueue,
      catalogueApi = catalogueApi,
      titleProgress = titleProgress,
      forgetTitle = forgetTitle,
    )
    return
  }

  val scope = rememberCoroutineScope()
  // Whether this detail still owns the remote: it does not while the player covers it, and nothing
  // that lands late may pull the remote into a covered screen.
  val liveBack = rememberUpdatedState(backEnabled)
  // Back over an item detail closes it; a hidden section-level handler must never take it, and the
  // versions panel installed later in this composition still closes first.
  BackHandler(enabled = backEnabled) { onBack() }
  val identity = data.libraryId to data.item.id
  val live = rememberUpdatedState(identity)
  var metadata by remember(identity) { mutableStateOf(initialRemoteMetadata(data)) }
  var metadataResolved by remember(identity) { mutableStateOf(false) }
  var titleRowReady by remember(identity) { mutableStateOf(false) }
  LaunchedEffect(identity, data.item, data.seriesName, data.seriesIds) {
    metadataResolved = false
    titleRowReady = false
    metadata = resolveRemoteMetadata(api, data)
    metadataResolved = true
  }
  val detail = data.copy(
    item = metadata.item,
    seriesName = metadata.seriesName ?: metadata.item.seriesName,
    seriesIds = metadata.seriesIds,
  )

  var sources by remember(identity) { mutableStateOf<List<StreamDto>>(emptyList()) }
  var sourcesLoading by remember(identity) { mutableStateOf(true) }
  var sourcesError by remember(identity) { mutableStateOf(false) }
  var state by remember(identity) { mutableStateOf<RemoteItemStateDto?>(null) }
  // The title's own row, when the catalogue can name this item: it outranks the item's state, so
  // every version of the title resumes the one position the title holds.
  var titleRow by remember(identity) { mutableStateOf<ProgressDto?>(null) }
  var stateLoading by remember(identity) { mutableStateOf(true) }
  var stateError by remember(identity) { mutableStateOf(false) }
  var mutationError by remember(identity) { mutableStateOf(false) }
  var favouriteBusy by remember(identity) { mutableStateOf(false) }
  var watchedBusy by remember(identity) { mutableStateOf(false) }
  var forgetBusy by remember(identity) { mutableStateOf(false) }
  var sourceListOpen by remember(identity) { mutableStateOf(false) }
  // The copy panel: nothing is read for it until the viewer presses the action.
  var copyRequest by remember(identity) { mutableStateOf<NativeCopyRequest?>(null) }
  var copyResolving by remember(identity) { mutableStateOf(false) }
  var copyBusy by remember(identity) { mutableStateOf(false) }
  var copyNotice by remember(identity) { mutableStateOf<String?>(null) }
  var copyWasOpen by remember(identity) { mutableStateOf(false) }
  // The row the viewer last picked in the panel, so reopening lands on it while the item's own
  // version keeps its own mark.
  var pickedRow by remember(identity) { mutableStateOf<StreamDto?>(null) }
  val caption = remember(identity) { ActionCaption() }

  // The unified Sources panel: a catalogue port plus a derivable identity is what puts the Versions
  // button on an item at all. The coordinator is keyed by the item -- another item never sees these
  // rows -- and its scope is dropped with it, which abandons every call it had out.
  val sourcesIdentity = remember(detail.item, detail.seriesIds, metadataResolved) {
    if (metadataResolved) nativeAddonIdentity(detail.item, detail.seriesIds) else null
  }
  val sourceGroups = remember(identity, sourcesIdentity, catalogueApi) {
    val port = catalogueApi
    val wanted = sourcesIdentity
    if (port != null && wanted != null) {
      NativeSources(
        catalogApi = port,
        remoteApi = api,
        originLibraryId = data.libraryId,
        identity = wanted,
        // A provider's name filter takes the resolved catalogue title: a series name for an
        // episode, never the episode's own, and nothing guessed when the parent is unknown.
        nameHint = if (detail.isEpisode) detail.seriesName?.takeIf { it.isNotBlank() } else detail.item.name.takeIf { it.isNotBlank() },
      )
    } else {
      null
    }
  }
  val sourceScope = remember(identity, sourcesIdentity, catalogueApi) { CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate) }
  DisposableEffect(sourceScope) { onDispose { sourceScope.cancel() } }
  // The filters the panel offers, reset with the item the way the catalogue detail resets its own.
  val sourceFilters = remember(identity) { SourceFilterState() }
  BindSourceProfiles(catalogueApi, sourceFilters)
  val groups = sourceGroups?.state
  // Every row the panel holds: the item's own versions lead, and the player is handed all of them
  // so a switch never shrinks the list to the row it landed on. One row per identity, so a copy the
  // viewer's own library answers with is not the item's own version twice.
  val loadedRows = remember(sources, groups) {
    Streams.deduped(
      sources + groups?.local.orEmpty() + groups?.remoteGroups.orEmpty().flatMap { it.streams } +
        groups?.addonRows.orEmpty(),
    )
  }
  val save = remember(identity) { SourceSaveState() }
  var saveGeneration by remember(identity) { mutableStateOf(0) }
  // A row that could not be played or saved, and the copy that landed.
  var sourceNotice by remember(identity) { mutableStateOf<String?>(null) }

  val playFocus = remember { FocusRequester() }
  val versionsFocus = remember { FocusRequester() }
  val copyFocus = remember { FocusRequester() }
  val sourcesRetryFocus = remember { FocusRequester() }
  val stateRetryFocus = remember { FocusRequester() }
  val statusFocus = remember { FocusRequester() }
  val sourcesEntry = remember { FocusRequester() }

  /** Reads with the token it was asked under; a landed answer for a replaced item is dropped. */
  suspend fun loadSources(mine: Pair<String, String>) {
    sourcesLoading = true
    sourcesError = false
    try {
      val found = api.remoteSources(detail.libraryId, detail.item.id).filter { Streams.isRemoteStream(it) }
      if (live.value != mine) return
      sources = found
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (_: ApiError) {
      if (live.value == mine) sourcesError = true
    } finally {
      if (live.value == mine) sourcesLoading = false
    }
  }

  /** The title's own row, read under the item's catalogue identity; nothing else can name it. */
  suspend fun loadTitleRow(): ProgressDto? {
    val read = titleProgress ?: return null
    val identity = sourcesIdentity ?: return null
    return try {
      read(ProgressKey.of(identity.first, identity.second))
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (_: ApiError) {
      null
    }
  }

  suspend fun loadState(mine: Pair<String, String>) {
    stateLoading = true
    stateError = false
    titleRow = null
    val loadedTitle = loadTitleRow()
    if (live.value == mine) titleRow = loadedTitle
    try {
      val loaded = api.remoteItemState(detail.libraryId, detail.item.id)
      if (live.value != mine) return
      state = loaded
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (_: ApiError) {
      if (live.value == mine) stateError = true
    } finally {
      if (live.value == mine) stateLoading = false
    }
  }

  val mine = identity
  LaunchedEffect(identity, restoreToken) {
    sourceListOpen = false
    caption.text = ""
    mutationError = false
    sourceNotice = null
    pickedRow = null
    loadSources(mine)
    loadState(mine)
  }
  LaunchedEffect(metadataResolved, sourcesIdentity) {
    if (metadataResolved) {
      titleRow = loadTitleRow()
      titleRowReady = true
    }
  }

  val stateLoaded = state != null && !stateError
  val notAllowedText = stringResource(R.string.err_download_library_not_allowed)
  val destinationsFailedText = stringResource(R.string.media_server_error)
  val torrentText = stringResource(R.string.err_torrent_not_playable)
  val canCopy = onQueue != null && loadDestinations != null && sources.any { Streams.canQueue(it, false) }
  // The Sources action is offered whenever the item has a row to show: one version is a choice too,
  // and the item's identity may still fetch supplementary rows beside it. Without the port only the
  // native versions fill the panel.
  val versionsAvailable = sources.isNotEmpty() || sourceGroups != null
  val stored = state
  val savedSourceId = stored?.mediaSourceId
  val favorite = stored?.favorite == true
  val watched = stored?.watched == true
  // The title's own row decides the position whenever it answered: whichever version stored it,
  // every version of the title resumes it.
  val title = titleRow
  // The version the viewer last watched leads, so its Resume is the one offered: the source the
  // title's own stored row names when that row names one, and otherwise the stored media source.
  val primary = title?.stableKey?.let { key -> sources.firstOrNull { it.stableKey == key } }
    ?: sources.firstOrNull { it.remoteItem?.mediaSourceId != null && it.remoteItem.mediaSourceId == savedSourceId }
    ?: sources.firstOrNull()
  // The saved position belongs to the exact version that stored it; another version shows none.
  val sameVersion = title != null || primary?.remoteItem?.mediaSourceId == savedSourceId
  // Resume is offered only for the same version that stored the position and never for an item
  // already marked watched; the title's own row resumes any version, while another version of an
  // item the title does not name, or an unknown one, starts from the beginning.
  val resuming = if (title != null) {
    stateLoaded && !watched && Progress.resumePosition(title.position, title.duration) != null
  } else {
    stateLoaded && savedSourceId != null && !watched && sameVersion &&
      Progress.resumePosition(stored?.position ?: 0.0, stored?.duration ?: 0.0) != null
  }
  /** A stored position the primary version owns, so Start over can still be offered beside Play. */
  val savedOnPrimary = if (title != null) {
    stateLoaded && title.position > 0.0
  } else {
    stateLoaded && sameVersion && (stored?.position ?: 0.0) > 0.0
  }

  fun play(source: StreamDto?, resume: Boolean) {
    val context = source?.remoteItem ?: return
    onPlay(
      PlayTarget(
        key = sourcesIdentity?.let { ProgressKey.of(it.first, it.second) } ?: context.progressKey,
        title = titleOf(detail),
        resume = resume,
        sourceId = source.sourceId.takeIf { it.isNotBlank() },
        stableKey = source.stableKey,
        poster = detail.item.poster,
        // The title's own catalogue identity travels with a native play too: a row of another kind
        // picked later in the player keeps the generic key and subtitles this identity makes.
        subtitleType = sourcesIdentity?.first,
        subtitleTarget = sourcesIdentity?.second,
        subtitleName = if (detail.isEpisode) detail.seriesName else detail.item.name,
        remoteItem = context,
        remoteSources = Streams.remoteVersionsOf(context, loadedRows),
        initialSources = loadedRows,
      ),
    )
  }

  /** The play one picked row starts, exactly as the player starts any other: Play and Start over
   *  act on the pick, on the item's leading version while there is none. */
  fun playPicked(resume: Boolean): Boolean {
    val pick = pickedRow?.takeIf { row -> loadedRows.any { it === row } } ?: return false
    val wanted = nativeRowTarget(
      pick,
      titleOf(detail),
      sourcesIdentity,
      loadedRows,
      detail.item.poster,
      identityName = if (detail.isEpisode) detail.seriesName else detail.item.name,
    ) ?: return false
    onPlay(if (resume) wanted else wanted.copy(resume = false))
    return true
  }

  val playbackMetadataReady = metadataResolved && titleRowReady
  var pendingStartOver by remember(identity) { mutableStateOf<Boolean?>(null) }

  fun playPressed() {
    if (!playbackMetadataReady) { pendingStartOver = false; return }
    // A picked row travels as nativeRowTarget makes it; the player re-checks what a resume means
    // for that exact version.
    if (playPicked(resume = true)) return
    play(primary, resume = resuming)
  }

  var autoPlayed by remember(identity) { mutableStateOf(false) }
  LaunchedEffect(stateLoaded, primary, playbackMetadataReady) {
    if (detail.autoPlay && stateLoaded && primary != null && playbackMetadataReady && pendingStartOver == null && !autoPlayed) {
      playPressed()
      autoPlayed = true
    }
  }

  fun startOverPressed() {
    if (!playbackMetadataReady) { pendingStartOver = true; return }
    if (playPicked(resume = false)) return
    play(primary, resume = false)
  }

  LaunchedEffect(playbackMetadataReady, pendingStartOver, primary) {
    if (playbackMetadataReady && primary != null) {
      val startOver = pendingStartOver ?: return@LaunchedEffect
      pendingStartOver = null
      autoPlayed = true
      if (startOver) startOverPressed() else playPressed()
    }
  }

  /** One row of the sources panel: a media-server version plays its own exact item, a library copy
   *  plays the file on disk, and an addon row plays the title through the generic identity its rows
   *  were loaded under. Choosing only picks: Play, Start over and To library act on the pick once
   *  the panel is gone. */
  fun choosePanelRow(row: StreamDto) {
    saveGeneration++
    save.resolving = false
    sourceListOpen = false
    val addon = !Streams.isRemoteStream(row) && !Streams.isLocalStream(row)
    if (addon && !row.playable) {
      sourceNotice = torrentText
      return
    }
    pickedRow = row
    sourceNotice = null
  }

  /** Whether one panel row may offer its own Save: any row but a copy that is already on disk, and
   *  only when the account may queue exactly that source. */
  fun canSaveRow(row: StreamDto): Boolean =
    onQueue != null && loadDestinations != null &&
      !Streams.isLocalStream(row) && Streams.canQueue(row, groups?.realDebridConfigured == true)

  /** The row the panel picked, while it is still one of the rows the panel holds. */
  val pickedCopy = pickedRow?.takeIf { row -> loadedRows.any { it === row } }
  /** The pick To library copies through its own row: any pick that is not one of the item's own
   *  versions. Without one, or with such a version picked, the item's own copy panel is what opens. */
  val copyPick = pickedCopy?.takeIf { row -> sources.none { it === row } }
  val copyOffered = if (copyPick == null) canCopy else canSaveRow(copyPick)
  val actionRow = pickedCopy ?: primary

  /** Reads, at the viewer's Save press, the destinations this one row may be queued into, then
   *  opens the panel with exactly that row. Nothing is queued blind and no first candidate is
   *  taken. */
  fun saveRow(row: StreamDto) {
    val load = loadDestinations ?: return
    if (save.resolving || save.busy) return
    val generation = saveGeneration
    val subject = nativeCopySubject(detail.item, detail.seriesName, detail.seriesIds)
    val kind = if (detail.isEpisode) "series" else "movie"
    save.resolving = true
    save.notice = null
    save.queued = false
    sourceNotice = null
    scope.launch {
      try {
        val destinations = load().filter { it.canWrite && (it.type == kind || it.type == "mixed") }
        if (live.value == mine && generation == saveGeneration) {
          save.request = SourceSaveRequest(
            stream = row,
            subject = subject,
            destinations = destinations,
            // Only an addon row may hand the destination back to the server's own rule; a
            // media-server version always copies into the destination it already projects.
            automatic = !Streams.isRemoteStream(row),
          )
          // The picker takes the panel's place rather than stacking over it: one panel owns the
          // remote at a time, and Back from the picker lands on the button that opened the panel.
          sourceListOpen = false
        }
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (error: ApiError) {
        if (live.value == mine && generation == saveGeneration) {
          sourceNotice = error.serverMessage
            ?: if (error.failure == ApiFailure.Forbidden) notAllowedText else destinationsFailedText
        }
      } catch (_: Exception) {
        if (live.value == mine && generation == saveGeneration) sourceNotice = destinationsFailedText
      } finally {
        if (live.value == mine && generation == saveGeneration) save.resolving = false
      }
    }
  }

  /** Queues exactly the row the panel captured. A null target hands the choice to the server,
   *  which resolves the addon's own storage rules; a picked library is an explicit override. A
   *  refusal leaves the panel and its choice up. */
  fun queueRow(target: DownloadTargetDto?) {
    val queue = onQueue ?: return
    val request = save.request ?: return
    if (save.busy) return
    val generation = saveGeneration
    save.busy = true
    save.notice = null
    scope.launch {
      try {
        queue(nativeCopyTitle(request.subject), request.stream.sourceId, request.subject.media(), target)
        if (live.value == mine && generation == saveGeneration) {
          save.request = null
          save.notice = null
          save.queued = true
        }
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (error: ApiError) {
        if (live.value == mine && generation == saveGeneration) save.notice = error.serverMessage ?: notAllowedText
      } catch (_: Exception) {
        if (live.value == mine && generation == saveGeneration) save.notice = notAllowedText
      } finally {
        if (live.value == mine && generation == saveGeneration) save.busy = false
      }
    }
  }

  fun toggleFavourite() {
    if (favouriteBusy || !stateLoaded) return
    val wanted = !favorite
    favouriteBusy = true
    mutationError = false
    scope.launch {
      try {
        val next = api.patchRemoteItemState(detail.libraryId, detail.item.id, RemoteItemStatePatch(favorite = wanted))
        if (live.value == mine) state = next
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: ApiError) {
        if (live.value == mine) mutationError = true
      } finally {
        if (live.value == mine) favouriteBusy = false
      }
    }
  }

  /** Clears the title's own row, so the item's cleared state is not outranked by a stale position. */
  suspend fun clearTitleRow() {
    val forget = forgetTitle ?: return
    val identity = sourcesIdentity ?: return
    forget(ProgressKey.of(identity.first, identity.second))
    if (live.value == mine) titleRow = null
  }

  fun toggleWatched() {
    if (watchedBusy || !stateLoaded) return
    val wanted = !watched
    watchedBusy = true
    mutationError = false
    scope.launch {
      try {
        val next = api.patchRemoteItemState(detail.libraryId, detail.item.id, RemoteItemStatePatch(watched = wanted))
        if (live.value == mine) state = next
        // A finished title keeps no position, as on the web: the title's row goes with it.
        if (wanted) clearTitleRow()
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: ApiError) {
        if (live.value == mine) mutationError = true
      } finally {
        if (live.value == mine) watchedBusy = false
      }
    }
  }

  /** Forgetting this item's stored position: the title's own row when the catalogue names it, and
   *  the item's own remote state cleared to zero, which the title's read falls back to. */
  fun forgetProgress() {
    if (forgetBusy || !stateLoaded) return
    forgetBusy = true
    mutationError = false
    scope.launch {
      try {
        clearTitleRow()
        val next = api.patchRemoteItemState(detail.libraryId, detail.item.id, RemoteItemStatePatch(position = 0.0, duration = 0.0))
        if (live.value == mine) state = next
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: ApiError) {
        if (live.value == mine) mutationError = true
      } finally {
        if (live.value == mine) forgetBusy = false
      }
    }
  }

  /** Mark as unwatched: the watched flag when it is set, and the stored position when there is one,
   *  both through the same state endpoint the two single toggles use. */
  fun markUnwatched() {
    if (watchedBusy || forgetBusy || !stateLoaded) return
    if (watched) toggleWatched()
    if ((stored?.position ?: 0.0) > 0.0) forgetProgress()
  }

  /** Reads, once the action is pressed, the parent series, the versions and the destinations the
   *  copy needs; the panel opens only once it has them, so no row ever acts on nothing. The read
   *  stays cancellable: leaving the item drops a late answer. */
  fun openCopy() {
    val load = loadDestinations ?: return
    if (copyResolving || copyBusy) return
    copyResolving = true
    copyNotice = null
    scope.launch {
      try {
        val resolved = resolveNativeCopy(
          api = api,
          libraryId = detail.libraryId,
          item = detail.item,
          seriesName = detail.seriesName,
          seriesIds = detail.seriesIds,
          sources = sources.takeIf { it.isNotEmpty() },
          loadDestinations = load,
        )
        if (live.value == mine) copyRequest = resolved
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (error: ApiError) {
        if (live.value == mine) copyNotice = error.serverMessage
          ?: if (error.failure == ApiFailure.Forbidden) notAllowedText else destinationsFailedText
      } catch (_: Exception) {
        if (live.value == mine) copyNotice = destinationsFailedText
      } finally {
        if (live.value == mine) copyResolving = false
      }
    }
  }

  /** Queues the exact version the panel captured. A refusal leaves the panel and its choice up,
   *  so another destination can be tried without picking the version again. */
  fun queueCopy(stream: StreamDto, libraryId: String) {
    val queue = onQueue ?: return
    val subject = copyRequest?.subject ?: return
    if (copyBusy) return
    copyBusy = true
    copyNotice = null
    scope.launch {
      try {
        queue(nativeCopyTitle(subject), stream.sourceId, subject.media(), nativeQueueTarget(stream, libraryId))
        if (live.value == mine) { copyRequest = null; copyNotice = null }
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (error: ApiError) {
        if (live.value == mine) copyNotice = error.serverMessage ?: notAllowedText
      } catch (_: Exception) {
        if (live.value == mine) copyNotice = notAllowedText
      } finally {
        if (live.value == mine) copyBusy = false
      }
    }
  }

  // Closing the panel, whether it queued or the viewer backed out, returns the remote to the
  // action that opened it once the panel and its focus trap are gone.
  LaunchedEffect(copyRequest) {
    if (copyRequest != null) {
      copyWasOpen = true
    } else if (copyWasOpen) {
      copyWasOpen = false
      if (!liveBack.value) return@LaunchedEffect
      runCatching { copyFocus.requestFocus() }
    }
  }

  // Opening the panel is the intent that starts the supplementary groups; the first open leaves
  // every call at once, and a reopen of the same item reuses what already answered.
  LaunchedEffect(sourceListOpen, sourceGroups) {
    if (sourceListOpen) sourceGroups?.open(sourceScope)
  }

  // The panel is gone only once the frame that removed it is applied: asking for the opener in
  // the same frame lets the removal take focus away again. Both the sources panel and the copy
  // picker hand the remote back to the button that opened them this way.
  var sourcesWasOpen by remember(identity) { mutableStateOf(false) }
  LaunchedEffect(sourceListOpen) {
    if (sourceListOpen) {
      sourcesWasOpen = true
    } else if (sourcesWasOpen) {
      sourcesWasOpen = false
      awaitFrame()
      // Choosing a row starts the player, which covers this detail: the covered detail never takes
      // the remote out of the session that owns it.
      if (!liveBack.value) return@LaunchedEffect
      runCatching { versionsFocus.requestFocus() }
    }
  }
  var saveWasOpen by remember(identity) { mutableStateOf(false) }
  LaunchedEffect(save.request) {
    if (save.request != null) {
      saveWasOpen = true
    } else if (saveWasOpen) {
      saveWasOpen = false
      awaitFrame()
      if (!liveBack.value) return@LaunchedEffect
      runCatching { versionsFocus.requestFocus() }
    }
  }

  // Focus follows what is actually actionable: the Retry on a failure, otherwise Play once a
  // version exists. Loading and empty states still hold a focusable target so the remote cannot
  // go dead over the player-less detail.
  val panelOwnsFocus = rememberUpdatedState(sourceListOpen || copyRequest != null || save.request != null)
  LaunchedEffect(identity, restoreToken, sourcesLoading, sourcesError, sources.isEmpty(), stateLoaded, stateError) {
    awaitFrame()
    if (!liveBack.value || panelOwnsFocus.value) return@LaunchedEffect
    val target = when {
      sourcesLoading -> statusFocus
      sourcesError -> sourcesRetryFocus
      sources.isEmpty() -> statusFocus
      stateError -> stateRetryFocus
      else -> playFocus
    }
    runCatching { target.requestFocus() }
  }

  Box(Modifier.fillMaxSize().background(Tokens.Bg)) {
    // The item's own artwork when the server exposed it, else the plain gradient behind it.
    val art = imageUrl(detail.item.wide ?: detail.item.poster)
    if (art != null) {
      AsyncImage(model = art, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
    }
    Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Tokens.Panel2.copy(alpha = 0.4f), Tokens.Bg, Tokens.Bg))))
    Column(
      Modifier.fillMaxSize().padding(start = 60.dp, top = Tokens.SafeY, end = 60.dp),
      verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
      Text(eyebrow(detail), color = Tokens.Accent, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.8.sp)
      Text(
        titleOf(detail),
        color = Tokens.Text,
        fontSize = 40.sp,
        fontWeight = FontWeight.ExtraBold,
        letterSpacing = (-1.2).sp,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.width(820.dp),
      )
      Text(
        listOfNotNull(detail.provider.ifBlank { null }, detail.libraryName.ifBlank { null }, stringResource(R.string.media_server_read_only))
          .joinToString(" · "),
        color = Tokens.Muted,
        fontSize = 11.5.sp,
        fontWeight = FontWeight.Medium,
      )
      // The same bar the local detail draws, from the same saved position numbers.
      if (stateLoaded && sameVersion) {
        SavedPlaybackProgress(
          // The title's own row when it answered, the item's own numbers otherwise.
          position = title?.position ?: (stored?.position ?: 0.0),
          duration = title?.duration ?: (stored?.duration ?: 0.0),
          tag = TagRemoteDetailWatched,
        )
      }
      Text(stringResource(R.string.media_server_state_local), color = Tokens.Muted, fontSize = 10.sp, modifier = Modifier.testTag(TagRemoteStateCaption))
      Spacer(Modifier.height(3.dp))

      DetailActionRow(
        primary = {
          FocusButton(
            text = stringResource(if (resuming) R.string.tv_resume else R.string.tv_play),
            onClick = { playPressed() },
            kind = FocusButtonKind.Primary,
            enabled = primary != null,
            modifier = Modifier.focusRequester(playFocus).testTag(TagRemoteDetailPlay),
          )
        },
        startOver = if (resuming || savedOnPrimary) DetailAction(
          label = stringResource(R.string.tv_start_over),
          icon = ReplayIcon,
          tag = TagRemoteDetailStartOver,
          onClick = { startOverPressed() },
        ) else null,
        sources = if (versionsAvailable) {
          {
            FocusButton(
              // One action name for the panel wherever it is opened from: the catalogue's heading.
              text = stringResource(R.string.sources_heading),
              onClick = {
                saveGeneration++
                save.resolving = false
                sourceListOpen = true
              },
              modifier = Modifier.focusRequester(versionsFocus).testTag(TagRemoteDetailVersions),
            )
          }
        } else {
          null
        },
        // The copy action is shown only when the row it would copy may be: the item's own projected
        // right while no row, or one of its own versions, is the pick, and the pick's own right for
        // any other row. A denied native right offers nothing rather than a failing button.
        toLibrary = if (copyOffered) DetailAction(
          label = stringResource(R.string.save_to_library),
          icon = DownloadIcon,
          tag = TagRemoteDetailToLibrary,
          enabled = !copyResolving && !copyBusy,
          modifier = Modifier.focusRequester(copyFocus),
          onClick = { copyPick?.let { saveRow(it) } ?: openCopy() },
        ) else null,
        favourite = DetailAction(
          label = stringResource(if (favorite) R.string.favorite_remove else R.string.favorite_add),
          icon = null,
          glyph = if (favorite) "★" else "☆",
          tag = TagRemoteDetailFavorite,
          enabled = stateLoaded && !favouriteBusy && !watchedBusy,
          onClick = { toggleFavourite() },
        ),
        // The local toggles act on the stored state; without it they would be no-ops, so they stay
        // disabled until the state is known.
        unwatched = if (stateLoaded && (watched || (stored?.position ?: 0.0) > 0.0)) DetailAction(
          label = stringResource(R.string.media_server_unwatch),
          icon = EyeOffIcon,
          tag = TagRemoteDetailMarkUnwatched,
          enabled = !favouriteBusy && !watchedBusy && !forgetBusy,
          onClick = { markUnwatched() },
        ) else null,
        watched = if (stateLoaded && !watched) DetailAction(
          label = stringResource(R.string.media_server_mark_watched),
          icon = EyeIcon,
          tag = TagRemoteDetailMarkWatched,
          enabled = !favouriteBusy && !watchedBusy,
          onClick = { toggleWatched() },
        ) else null,
        caption = caption,
      )
      actionRow?.let { row ->
        val pickedCaption = chosenSourceCaption(row).joinToString(" · ")
        if (pickedCaption.isNotEmpty()) {
          Text(
            stringResource(R.string.tv_chosen_source) + " · " + pickedCaption,
            color = Tokens.Muted,
            fontSize = 11.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.testTag(TagRemoteDetailPickCaption),
          )
        }
      }

      // A copy that never opened its panel (no readable destinations, no native right) says why
      // here instead; pressing the action again is the retry.
      if (copyNotice != null && copyRequest == null) {
        Text(copyNotice!!, color = Tokens.Red, fontSize = 11.5.sp, modifier = Modifier.testTag(TagRemoteCopyNotice))
      }
      // A row that could not be played or saved says why here; a copy that landed says so too, and
      // neither hides the row the viewer picked.
      val sourceMessage = sourceNotice ?: if (save.queued) stringResource(R.string.save_queued) else null
      if (sourceMessage != null) {
        Text(
          sourceMessage,
          color = if (sourceNotice != null) Tokens.Red else Tokens.Green,
          fontSize = 11.5.sp,
          modifier = Modifier.testTag(TagRemoteSourceNotice),
        )
      }
      if (mutationError) Text(stringResource(R.string.media_server_state_error), color = Tokens.Red, fontSize = 11.5.sp)

      Box(Modifier.weight(1f)) {
        Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
          when {
            sourcesLoading -> Text(
              stringResource(R.string.media_server_finding_versions),
              color = Tokens.Muted,
              fontSize = 11.5.sp,
              modifier = Modifier.focusRequester(statusFocus).focusable(),
            )
            sourcesError -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
              Text(stringResource(R.string.media_server_sources_error), color = Tokens.Red, fontSize = 11.5.sp)
              FocusButton(
                stringResource(R.string.tv_try_again),
                onClick = { scope.launch { loadSources(mine) } },
                modifier = Modifier.focusRequester(sourcesRetryFocus).testTag(TagRemoteSourcesRetry),
              )
            }
            sources.isEmpty() -> Box(
              Modifier.focusRequester(statusFocus).focusable(),
            ) {
              Text(stringResource(R.string.media_server_sources_empty), color = Tokens.Muted, fontSize = 11.5.sp)
            }
            else -> Text(stringResource(R.string.media_server_versions_available, sources.size.toString()), color = Tokens.Muted, fontSize = 11.sp)
          }
          if (stateError) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
              Text(stringResource(R.string.media_server_state_error), color = Tokens.Red, fontSize = 11.5.sp)
              FocusButton(
                stringResource(R.string.tv_try_again),
                onClick = { scope.launch { loadState(mine) } },
                modifier = Modifier.focusRequester(stateRetryFocus).testTag(TagRemoteStateRetry),
              )
            }
          }
        }
      }
    }

    if (sourceListOpen) {
      NativeSourcesPanel(
        state = groups ?: NativeSourceState(),
        // The item's own versions lead as this library's own group; every supplementary row the
        // groups answered sits under them, and none of them ever takes the default.
        originals = sources,
        originLibrary = Streams.RemoteGroup(
          libraryId = detail.libraryId,
          provider = detail.provider,
          libraryName = detail.libraryName,
          streams = sources,
        ),
        default = primary,
        chosen = pickedRow?.takeIf { row -> loadedRows.any { it === row } },
        filters = sourceFilters.filters(groups?.settings?.streamSort),
        profiles = sourceFilters.profiles,
        ruleNoteProfileId = sourceFilters.noteProfileId(groups?.settings?.streamSort),
        onFilterSelect = { chip, key -> sourceFilters.select(chip, key) },
        onChoose = { choosePanelRow(it) },
        // The panel only picks: To library on the action row acts on the pick, so no row carries a
        // control of its own.
        onSave = null,
        canSave = { row -> canSaveRow(row) },
        onRetry = { sourceGroups?.retry(sourceScope) },
        emptyText = stringResource(R.string.media_server_sources_empty),
        onClose = {
          saveGeneration++
          save.resolving = false
          sourceListOpen = false
        },
        initialFocus = sourcesEntry,
      )
    }

    val rowRequest = save.request
    if (rowRequest != null) {
      // Only the row the viewer pressed Save on, and every row acts on exactly it.
      NativeQueuePanel(
        versions = listOf(rowRequest.stream),
        libraries = rowRequest.destinations,
        preferred = rowRequest.stream,
        busy = save.busy,
        notice = save.notice,
        realDebridConfigured = groups?.realDebridConfigured == true,
        // An addon row may hand the destination back to the server's own rule; a media-server
        // version copies into the destination it projects, or into the library the viewer picks.
        onQueueDefault = if (rowRequest.automatic) ({ queueRow(null) }) else null,
        onQueue = { _, libraryId -> queueRow(nativeQueueTarget(rowRequest.stream, libraryId)) },
        onClose = {
          save.request = null
          save.notice = null
        },
      )
    }

    val request = copyRequest
    if (request != null) {
      val kind = if (detail.isEpisode) "series" else "movie"
      NativeQueuePanel(
        versions = request.versions,
        libraries = request.destinations.filter { it.canWrite && (it.type == kind || it.type == "mixed") },
        preferred = primary,
        busy = copyBusy,
        notice = copyNotice,
        onQueue = { stream, libraryId -> queueCopy(stream, libraryId) },
        onClose = {
          copyRequest = null
          copyNotice = null
        },
      )
    }
  }
}

@Composable
private fun eyebrow(data: RemoteDetailData): String =
  when {
    data.isEpisode && !data.seriesName.isNullOrBlank() -> stringResource(R.string.media_server_eyebrow_episode, data.seriesName)
    else -> stringResource(R.string.media_server_eyebrow)
  }.uppercase()

private fun titleOf(data: RemoteDetailData): String =
  if (data.isEpisode && (data.item.season != null || data.item.episode != null)) {
    "${data.item.name} · S${data.item.season ?: 0} · E${data.item.episode ?: 0}"
  } else {
    data.item.name
  }
