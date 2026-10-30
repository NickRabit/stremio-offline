package cz.stremiooffline.tv.ui.detail

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
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
import cz.stremiooffline.tv.episodeCode
import cz.stremiooffline.tv.catalog.Streams
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.BehaviorHintsDto
import cz.stremiooffline.tv.data.DownloadTargetDto
import cz.stremiooffline.tv.data.LibraryDto
import cz.stremiooffline.tv.data.LibraryTitleDto
import cz.stremiooffline.tv.data.MediaDto
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.playback.Progress
import cz.stremiooffline.tv.ui.components.CardRowInset
import cz.stremiooffline.tv.ui.catalog.BindSourceProfiles
import cz.stremiooffline.tv.ui.catalog.ActionCaption
import cz.stremiooffline.tv.ui.catalog.DetailAction
import cz.stremiooffline.tv.ui.catalog.DetailActionRow
import cz.stremiooffline.tv.ui.catalog.DownloadIcon
import cz.stremiooffline.tv.ui.catalog.EyeIcon
import cz.stremiooffline.tv.ui.catalog.EyeOffIcon
import cz.stremiooffline.tv.ui.catalog.NativeQueuePanel
import cz.stremiooffline.tv.ui.catalog.NativeSourceState
import cz.stremiooffline.tv.ui.catalog.NativeSources
import cz.stremiooffline.tv.ui.catalog.NativeSourcesPanel
import cz.stremiooffline.tv.ui.catalog.ReplayIcon
import cz.stremiooffline.tv.ui.catalog.SourceFilterState
import cz.stremiooffline.tv.ui.catalog.SourceSaveRequest
import cz.stremiooffline.tv.ui.catalog.SourceSaveState
import cz.stremiooffline.tv.ui.catalog.chosenSourceCaption
import cz.stremiooffline.tv.ui.catalog.libraryAddonIdentity
import cz.stremiooffline.tv.ui.catalog.libraryCopySubject
import cz.stremiooffline.tv.ui.catalog.nativeCopyTitle
import cz.stremiooffline.tv.ui.catalog.nativeQueueTarget
import cz.stremiooffline.tv.ui.catalog.nativeRowTarget
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.components.WideCard
import cz.stremiooffline.tv.ui.catalog.PanelOption
import cz.stremiooffline.tv.ui.catalog.SidePanel
import cz.stremiooffline.tv.ui.theme.Tokens
import java.util.Locale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.android.awaitFrame
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

const val TagDetailPrimary = "detail_primary"
const val TagDetailStartOver = "detail_start_over"
const val TagDetailFavourite = "detail_favourite"
const val TagDetailWatched = "detail_watched"
const val TagDetailToLibrary = "detail_to_library"
const val TagDetailMarkWatched = "detail_mark_watched"
const val TagDetailForget = "detail_forget"
const val TagDetailForgetPanel = "detail_forget_panel"
const val TagDetailForgetCancel = "detail_forget_cancel"
const val TagDetailForgetRemove = "detail_forget_remove"
const val TagDetailSources = "detail_sources"
const val TagDetailSourceNotice = "detail_source_notice"
const val TagDetailPickCaption = "detail_pick_caption"

/**
 * What to play: the progress key and title, and either a library [path] to mint a source from or
 * a catalogue [sourceId] the server already handed out. The player skips `librarySource()` when a
 * source id is present.
 */
data class PlayTarget(
  val key: String,
  val title: String,
  val resume: Boolean,
  val path: String? = null,
  val sourceId: String? = null,
  /** The stable handle of the row this play starts, written with every progress save so the detail
   *  that offers it next time opens on the same source. */
  val stableKey: String? = null,
  /** The artwork and addon the catalogue title came from, saved with the progress so Home can
   *  draw a resume card; a library file leaves them empty and gets its art from the library. */
  val poster: String? = null,
  val addonKey: String? = null,
  /** A catalogue title's type and the id the addon subtitles must be asked for (the video's id
   *  for a series episode, the meta's own id for a movie); a library play leaves both null. A
   *  native detail's play carries the title's own identity here whatever kind of row started it:
   *  it is the generic key and subtitle context a switch to an addon row inside the player keeps,
   *  while the file or remote version the target itself plays keeps its own key. */
  val subtitleType: String? = null,
  val subtitleTarget: String? = null,
  /** True when the catalogue detail started this play. The player then keeps the sources that
   *  detail offers, the title's own library copy included; a library view or a Continue card
   *  leaves it false and gets no catalogue sources at all. */
  val catalogue: Boolean = false,
  /** Set only for a native media-server play: the opaque remote identity and the stable progress
   *  key the player stores state under. No path, addon or catalogue flag stands in for it. */
  val remoteItem: RemoteItemContext? = null,
  /** The versions of one remote item the player offers; empty for every other kind of play. */
  val remoteSources: List<StreamDto> = emptyList(),
  /** The exact addon rows a native detail had already loaded when one of them was played: a
   *  snapshot the player offers as its own sources. Nonnull means the player must not discover
   *  any other addon or library, and it is never set by a catalogue or library play. */
  val initialSources: List<StreamDto>? = null,
)

/** Everything the title detail draws: the artwork, the meta line and the files that sit under it. */
data class DetailData(
  val gridPath: String,
  val title: String,
  val year: String?,
  val description: String?,
  val poster: String?,
  val wide: String?,
  val size: Double,
  val fileCount: Int,
  val files: List<BrowseItem.File>,
  /** Whether the starred title itself is a favourite; the browse item carries it. */
  val favorite: Boolean = false,
  /** Every stored key this title stands for when it was opened from a Continue watching card. */
  val forgetKeys: List<String> = emptyList(),
) {
  /**
   * Re-reads the stored position of every file, so returning from the player shows the resume.
   * A successful `null` clears the old position; only a failed read keeps it, and a cancellation
   * is never swallowed.
   */
  suspend fun refresh(progress: suspend (String) -> ProgressDto?): DetailData {
    val refreshed = ArrayList<BrowseItem.File>(files.size)
    for (file in files) {
      val stored = try {
        progress(Progress.libraryKey(file.path))
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: ApiError) {
        refreshed += file
        continue
      }
      refreshed += file.copy(progress = stored)
    }
    return copy(files = refreshed)
  }

  companion object {
    fun ofFolder(folder: BrowseItem.Folder, files: List<BrowseItem.File>) = DetailData(
      gridPath = folder.path,
      title = folder.name,
      year = folder.year,
      description = folder.description,
      poster = folder.poster,
      wide = folder.wide,
      size = folder.size,
      fileCount = folder.fileCount,
      files = files,
      favorite = folder.favorite,
    )

    fun ofFile(file: BrowseItem.File) = DetailData(
      gridPath = file.path,
      title = file.label,
      year = file.year,
      description = file.description,
      poster = file.poster,
      wide = file.wide,
      size = file.size,
      fileCount = 1,
      files = listOf(file),
      favorite = file.favorite,
    )
  }
}

/** The episode label of one file: `S1 · E2` when the server numbered it, its label otherwise. */
fun episodeLabel(file: BrowseItem.File): String =
  episodeCode(file.season, file.episode) ?: file.label

@Composable
fun DetailScreen(
  detail: DetailData,
  imageUrl: (String?) -> String?,
  onPlay: (PlayTarget) -> Unit,
  onBack: () -> Unit,
  progress: suspend (String) -> ProgressDto?,
  setFavorite: suspend (String, Boolean) -> Boolean = { _, wanted -> wanted },
  /** Forgets the stored positions behind every key, the same call Home's card makes. */
  forgetProgress: suspend (List<String>) -> Unit,
  restoreToken: Int = 0,
  backEnabled: Boolean = true,
  /** The catalogue surface the Sources panel's supplementary groups need: the catalogue title the
   *  opened file is bound to, the viewer's own copies of it, every configured addon provider and
   *  every other media library. Null keeps the panel on the detail's own files, which is what a
   *  harness without a catalogue surface passes. */
  sourcesApi: TvApi? = null,
  /** The destinations this account may copy a supplementary row into, read once when that row's
   *  Save is pressed; null keeps every Save off the panel. */
  loadDestinations: (suspend () -> List<LibraryDto>)? = null,
  /** Queues exactly one supplementary row into the exact library the viewer picked. */
  onQueue: (suspend (title: String, sourceId: String, media: MediaDto, target: DownloadTargetDto?) -> Unit)? = null,
  /** Stores one file as finished; null keeps Mark watched off the action row, which is what a
   *  harness without a playback surface passes. */
  markWatched: (suspend (BrowseItem.File) -> Unit)? = null,
) {
  BackHandler(enabled = backEnabled) { onBack() }
  val scope = rememberCoroutineScope()

  // The stored positions are re-read on every entry and when the player returns, so the detail
  // never keeps a stale "Play" after a title was watched.
  var current by remember { mutableStateOf(detail) }
  // The star is optimistic and serialised the way the catalogue detail toggles the watchlist.
  var favourite by remember(detail.gridPath) { mutableStateOf(detail.favorite) }
  var favouriteBusy by remember(detail.gridPath) { mutableStateOf(false) }
  var forgetPanelOpen by remember { mutableStateOf(false) }
  var forgetting by remember { mutableStateOf(false) }
  var forgetError by remember { mutableStateOf(false) }
  val caption = remember { ActionCaption() }
  // The card's own keys stop counting once they have been forgotten.
  var forgotten by remember { mutableStateOf(false) }
  LaunchedEffect(detail.gridPath, restoreToken) {
    forgetError = false
    current = if (detail.files.isEmpty()) detail else detail.refresh(progress)
  }

  // The Sources panel: the rows the detail itself holds, plus the supplementary groups the file's
  // catalogue binding opens. Nothing is asked of any addon or media server until the action is
  // pressed, and the panel keeps the exact file it was opened on.
  var sourcesOpen by remember(detail.gridPath) { mutableStateOf(false) }
  var sourcesPath by remember(detail.gridPath) { mutableStateOf<String?>(null) }
  var pickedRow by remember(detail.gridPath) { mutableStateOf<StreamDto?>(null) }
  var pickedAtDefaultPath by remember(detail.gridPath) { mutableStateOf<String?>(null) }
  /** A panel opened from an episode's card has to play the row at once: that card is the only
   *  button the episode has. */
  var sourcesFromCard by remember(detail.gridPath) { mutableStateOf(false) }
  var markingWatched by remember(detail.gridPath) { mutableStateOf(false) }
  var sourceNotice by remember(detail.gridPath) { mutableStateOf<String?>(null) }
  /** The control the open panel must hand the remote back to: the action, or the exact card a
   *  Menu/Info press opened it from. */
  var sourcesOpener by remember(detail.gridPath) { mutableStateOf<FocusRequester?>(null) }
  /** The panel the save work belongs to. Replacing the panel (another file, another card) makes
   *  every answer still out belong to nobody, so a late one can never open over its replacement. */
  var saveGeneration by remember(detail.gridPath) { mutableIntStateOf(0) }
  /** True while the save panel is up, so its close can hand the remote back to its opener. */
  var saveWasOpen by remember(detail.gridPath) { mutableStateOf(false) }
  val sourceFilters = remember(detail.gridPath) { SourceFilterState() }
  BindSourceProfiles(sourcesApi, sourceFilters)
  val save = remember(detail.gridPath) { SourceSaveState() }

  val playIndex = current.files.indexOfFirst { !isCompleted(it) }.let { if (it < 0) 0 else it }
  val playFile = current.files.getOrNull(playIndex)
  val resuming = playFile?.let { Progress.resumePosition(positionOf(it), durationOf(it)) != null } == true
  /** A saved position that is not offered as Resume still gets a Start over beside Play. */
  val hasStoredProgress = positionOf(playFile) > 0.0
  val storedKeys = current.files.filter { positionOf(it) > 0 }.map { Progress.libraryKey(it.path) }
  val forgetKeys = (if (forgotten) emptyList() else detail.forgetKeys).ifEmpty { storedKeys }
  val notAllowedText = stringResource(R.string.err_download_library_not_allowed)
  val destinationsFailedText = stringResource(R.string.media_server_error)
  val torrentText = stringResource(R.string.err_torrent_not_playable)

  val primaryFocus = remember { FocusRequester() }
  val rowFocus = remember { FocusRequester() }
  val forgetPanelFocus = remember { FocusRequester() }
  val sourcesFocus = remember { FocusRequester() }
  val sourcesEntry = remember { FocusRequester() }
  // Whether this detail still owns the remote: it does not while the player covers it, and nothing
  // that lands late may pull the remote into a covered screen.
  val liveBack = rememberUpdatedState(backEnabled)
  // The primary action takes focus on the first entry and again when the player closes.
  LaunchedEffect(current.gridPath, restoreToken) {
    runCatching { primaryFocus.requestFocus() }
  }

  // The exact file the panel stands for: the one the action was pressed on, or the card a
  // Menu/Info press opened it from. Its binding is read once, on the open, never before it.
  val sourcesFile = sourcesPath?.let { path -> current.files.firstOrNull { it.path == path } }
  val panelPath = sourcesFile?.path.orEmpty()
  // What the detail itself contributes: every version of a film, largest reported size first the
  // way the web orders them, or exactly the one episode the panel was opened on -- a sibling
  // episode is a different video and never joins this list.
  val panelRows = remember(current.files, sourcesFile) { ownFileRows(current, sourcesFile) }
  var binding by remember(detail.gridPath, panelPath) { mutableStateOf<LibraryTitleDto?>(null) }
  var probing by remember(detail.gridPath, panelPath) { mutableStateOf(false) }
  val sourcesIdentity = remember(binding) { libraryAddonIdentity(binding) }
  // One scope per detail and panel file: another file, another detail or leaving the screen drops
  // every call this panel had out, and reopening the same file reuses what answered.
  val groupScope = remember(detail.gridPath, panelPath) {
    CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  }
  DisposableEffect(groupScope) { onDispose { groupScope.cancel() } }
  val sourceGroups = remember(groupScope, sourcesIdentity, sourcesApi) {
    val port = sourcesApi
    val wanted = sourcesIdentity
    if (port != null && wanted != null) {
      NativeSources(
        catalogApi = port,
        remoteApi = port,
        // A file on disk is no media-server library: no origin is excluded from the match, and the
        // binding's own title is the name filter a provider may take. Nothing is ever guessed.
        originLibraryId = "",
        identity = wanted,
        nameHint = binding?.name?.takeIf { it.isNotBlank() },
      )
    } else {
      null
    }
  }
  val groupState = sourceGroups?.state
  // Every row the panel holds, in the order it draws them: the player is handed all of them so a
  // switch never shrinks the list to the row it landed on.
  val loadedRows = remember(panelRows, groupState) {
    val seen = HashSet<String>()
    Streams.deduped(
      panelRows + groupState?.local.orEmpty() + groupState?.remoteGroups.orEmpty().flatMap { it.streams } +
        groupState?.addonRows.orEmpty(),
      seen,
    )
  }
  val realDebrid = groupState?.realDebridConfigured == true
  fun currentPick(): StreamDto? = pickedRow
    ?.takeIf { pickedAtDefaultPath == playFile?.path && loadedRows.any { row -> row === it } }
  val actionRow = currentPick() ?: playFile?.let(::fileRow)

  fun openSources(file: BrowseItem.File?, opener: FocusRequester?, fromCard: Boolean = false) {
    val target = file ?: sourcesFile ?: playFile ?: return
    // A panel that replaces another one owns the save work from here on: what the old panel had
    // out is dropped, and its own delete-in-progress flags go with it so a new Save is offered.
    saveGeneration++
    save.resolving = false
    save.busy = false
    save.request = null
    save.notice = null
    saveWasOpen = false
    sourcesOpener = opener ?: sourcesFocus
    sourcesFromCard = fromCard
    sourcesPath = target.path
    sourcesOpen = true
    sourceNotice = null
  }

  // The binding is read the first time the panel is opened for this exact file, and never before
  // it: a file with no binding keeps its own row and asks no addon or media server anything.
  LaunchedEffect(sourcesOpen, panelPath, sourcesApi) {
    val port = sourcesApi ?: return@LaunchedEffect
    if (!sourcesOpen || panelPath.isEmpty() || binding != null || probing) return@LaunchedEffect
    probing = true
    try {
      binding = port.libraryTitle(panelPath)
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (_: ApiError) {
      // A lookup that failed leaves the panel with its own rows, exactly like an unbound file.
    } finally {
      probing = false
    }
  }

  // Opening the panel is the intent that starts the groups; a reopen of the same file asks nothing.
  LaunchedEffect(sourcesOpen, sourceGroups) {
    if (sourcesOpen) sourceGroups?.open(groupScope)
  }

  // Closing the panel hands the remote back to the action that opened it once the panel and its own
  // focus trap are gone.
  var sourcesWasOpen by remember(detail.gridPath) { mutableStateOf(false) }
  LaunchedEffect(sourcesOpen) {
    if (sourcesOpen) {
      sourcesWasOpen = true
    } else if (sourcesWasOpen) {
      sourcesWasOpen = false
      awaitFrame()
      // Choosing a row starts the player, which covers this detail: a covered detail never pulls
      // the remote out of the session that owns it.
      if (liveBack.value) runCatching { sourcesOpener?.requestFocus() }
    }
  }
  // The save panel took the sources panel's place, so closing it (a queued copy or Back) hands the
  // remote back to the action that started the whole flow -- and only while this detail still owns
  // the remote.
  LaunchedEffect(save.request) {
    if (save.request != null) {
      saveWasOpen = true
    } else if (saveWasOpen) {
      saveWasOpen = false
      awaitFrame()
      if (liveBack.value) runCatching { sourcesOpener?.requestFocus() }
    }
  }

  /**
   * The play one row of a panel starts: a library copy plays the file on disk, a media-server
   * version plays its own exact item and an addon row plays the title under the binding's own
   * identity. Every play carries the loaded list while the player discovers any remaining groups.
   * False when the row names nothing playable.
   */
  fun playRow(row: StreamDto, resume: Boolean = true): Boolean {
    val wanted = nativeRowTarget(row, current.title, sourcesIdentity, loadedRows, current.poster) ?: return false
    onPlay(if (resume) wanted else wanted.copy(resume = false))
    return true
  }

  /**
   * One row of the panel. A row the viewer picked on the action row is only a pick: the panel
   * closes, the caption names it, and Play and Start over act on it. A row picked from an episode's
   * card has no other button, so it plays at once.
   */
  fun choosePanelRow(row: StreamDto) {
    saveGeneration++
    save.resolving = false
    sourcesOpen = false
    val addon = !Streams.isRemoteStream(row) && !Streams.isLocalStream(row)
    if (addon && !row.playable) {
      sourceNotice = torrentText
      return
    }
    pickedRow = row
    pickedAtDefaultPath = playFile?.path
    sourceNotice = null
    if (sourcesFromCard) playRow(row)
  }

  /** The file Play would play without a pick, and the row the panel picked with one. */
  fun playPressed() {
    if (currentPick()?.let { playRow(it) } == true) return
    playFile?.let { onPlay(PlayTarget(Progress.libraryKey(it.path), it.label, resume = resuming, path = it.path)) }
  }

  fun startOverPressed() {
    if (currentPick()?.let { playRow(it, resume = false) } == true) return
    playFile?.let { onPlay(PlayTarget(Progress.libraryKey(it.path), it.label, resume = false, path = it.path)) }
  }

  /** Stores one file as finished, then re-reads what the server kept, so Resume turns back to Play. */
  fun markWatchedNow(file: BrowseItem.File) {
    val store = markWatched ?: return
    if (markingWatched) return
    markingWatched = true
    forgetError = false
    scope.launch {
      try {
        store(file)
        current = current.refresh(progress)
        runCatching { primaryFocus.requestFocus() }
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: ApiError) {
        // The file keeps its old state, so the detail keeps showing it and says the store failed.
        forgetError = true
        runCatching { primaryFocus.requestFocus() }
      } finally {
        markingWatched = false
      }
    }
  }

  /** Whether one panel row may offer its own Save: never a copy that is already on disk, only when
   *  the account may queue exactly that source. */
  fun canSaveRow(row: StreamDto): Boolean =
    onQueue != null && loadDestinations != null && !Streams.isLocalStream(row) && Streams.canQueue(row, realDebrid)

  /** Reads, at the viewer's Save press, the destinations this one row may be queued into, then opens
   *  the destination picker with exactly that row. Nothing is queued blind. */
  fun saveRow(row: StreamDto) {
    val load = loadDestinations ?: return
    val bound = binding ?: return
    if (save.resolving || save.busy) return
    val kind = if (bound.type.trim() == "series") "series" else "movie"
    // Everything the answer will act on is taken now: the panel this press belongs to, and the
    // subject the viewer pressed on. Another panel opened while the read is out replaces both.
    val mine = saveGeneration
    val path = panelPath
    val subject = libraryCopySubject(bound, episodeTitleOf(current, sourcesFile))
    save.resolving = true
    save.notice = null
    save.queued = false
    sourceNotice = null
    scope.launch {
      try {
        val destinations = load().filter { it.canWrite && (it.type == kind || it.type == "mixed") }
        if (mine != saveGeneration || path != panelPath) return@launch
        save.request = SourceSaveRequest(
          stream = row,
          subject = subject,
          destinations = destinations,
          // An addon row may hand the destination back to the server's own storage rule; a
          // media-server version always copies into a destination it already projects.
          automatic = !Streams.isRemoteStream(row),
        )
        // The picker takes the panel's place rather than stacking over it: one panel owns the
        // remote at a time, and Back from the picker lands on the action that opened it.
        sourcesOpen = false
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (error: ApiError) {
        if (mine == saveGeneration && path == panelPath) {
          sourceNotice = error.serverMessage
            ?: if (error.failure == ApiFailure.Forbidden) notAllowedText else destinationsFailedText
        }
      } catch (_: Exception) {
        if (mine == saveGeneration && path == panelPath) sourceNotice = destinationsFailedText
      } finally {
        if (mine == saveGeneration) save.resolving = false
      }
    }
  }

  /** Queues exactly the row the panel captured. A null target hands the choice to the server, which
   *  resolves the addon's own storage rules; a picked library is an explicit override. */
  fun queueRow(target: DownloadTargetDto?) {
    val queue = onQueue ?: return
    val request = save.request ?: return
    if (save.busy) return
    val mine = saveGeneration
    val subject = request.subject
    save.busy = true
    save.notice = null
    scope.launch {
      try {
        // The queue call is issued whatever happens next: a request the server already took is
        // never cancelled or sent twice just because the panel around it was replaced.
        queue(nativeCopyTitle(subject), request.stream.sourceId, subject.media(), target)
        if (mine == saveGeneration) {
          save.request = null
          save.notice = null
          save.queued = true
        }
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (error: ApiError) {
        if (mine == saveGeneration) save.notice = error.serverMessage ?: notAllowedText
      } catch (_: Exception) {
        if (mine == saveGeneration) save.notice = notAllowedText
      } finally {
        if (mine == saveGeneration) save.busy = false
      }
    }
  }

  fun toggleFavourite() {
    if (favouriteBusy) return
    favouriteBusy = true
    val wanted = !favourite
    favourite = wanted
    scope.launch {
      try {
        favourite = setFavorite(detail.gridPath, wanted)
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: ApiError) {
        favourite = !wanted
      } finally {
        favouriteBusy = false
      }
    }
  }

  fun forgetNow() {
    if (forgetting || forgetKeys.isEmpty()) return
    forgetting = true
    forgetPanelOpen = false
    forgetError = false
    scope.launch {
      try {
        forgetProgress(forgetKeys)
        forgotten = true
        current = current.copy(
          files = current.files.map { file ->
            if (Progress.libraryKey(file.path) in forgetKeys) file.copy(progress = null) else file
          },
        )
        runCatching { primaryFocus.requestFocus() }
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: ApiError) {
        // The positions are still stored, so the detail keeps showing them and says the clear failed.
        forgetError = true
        runCatching { primaryFocus.requestFocus() }
      } finally {
        forgetting = false
      }
    }
  }

  Box(
    Modifier
      .fillMaxSize()
      .background(Tokens.Bg)
      // DOWN from the actions enters the episode row on the first episode that is not finished,
      // not on whatever card happens to sit below the button. An open panel keeps the remote.
      .onPreviewKeyEvent { event ->
        val panelUp = forgetPanelOpen || sourcesOpen || save.request != null
        if (event.type == KeyEventType.KeyDown && event.key == Key.DirectionDown && current.files.size > 1 && !panelUp) {
          runCatching { rowFocus.requestFocus() }
          true
        } else {
          false
        }
      },
  ) {
    AsyncImage(
      model = imageUrl(current.wide ?: current.poster),
      contentDescription = null,
      contentScale = ContentScale.Crop,
      modifier = Modifier.fillMaxSize(),
    )
    Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(listOf(Tokens.Bg, Tokens.Bg.copy(alpha = 0.8f), Tokens.Bg.copy(alpha = 0f)))))
    Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Tokens.Bg.copy(alpha = 0f), Tokens.Bg.copy(alpha = 0.6f), Tokens.Bg))))

    Column(
      modifier = Modifier.fillMaxSize().padding(start = 60.dp, top = Tokens.SafeY, end = 60.dp),
      verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
      Text(
        stringResource(R.string.tv_detail_eyebrow_library).uppercase(),
        color = Tokens.Accent,
        fontSize = 10.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 1.8.sp,
      )
      Text(
        current.title,
        color = Tokens.Text,
        fontSize = 42.sp,
        fontWeight = FontWeight.ExtraBold,
        letterSpacing = (-1.2).sp,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.width(760.dp),
      )
      Text(
        metaLine(current, stringResource(R.string.tv_library_files, current.fileCount.toString())),
        color = Tokens.Muted,
        fontSize = 11.5.sp,
        fontWeight = FontWeight.Medium,
      )
      val description = current.description
      if (description != null) {
        Text(
          description,
          color = Tokens.Text.copy(alpha = 0.82f),
          fontSize = 12.5.sp,
          lineHeight = 18.sp,
          maxLines = 3,
          overflow = TextOverflow.Ellipsis,
          modifier = Modifier.width(700.dp),
        )
      }
      SavedPlaybackProgress(
        position = positionOf(playFile),
        duration = durationOf(playFile),
        tag = TagDetailWatched,
      )
      Spacer(Modifier.height(3.dp))
      DetailActionRow(
        primary = {
          FocusButton(
            text = stringResource(if (resuming) R.string.tv_resume else R.string.tv_play),
            onClick = { playPressed() },
            kind = FocusButtonKind.Primary,
            modifier = Modifier.focusRequester(primaryFocus).testTag(TagDetailPrimary),
          )
        },
        startOver = if (resuming || hasStoredProgress) DetailAction(
          label = stringResource(R.string.tv_start_over),
          icon = ReplayIcon,
          tag = TagDetailStartOver,
          onClick = { startOverPressed() },
        ) else null,
        // One text action for the whole Sources panel, whatever the file turned out to be: the
        // detail's own rows are always there, and a supplementary group joins them only if it
        // answers. A file with no row to offer has nothing to open.
        sources = if (current.files.isNotEmpty()) {
          {
            FocusButton(
              text = stringResource(R.string.sources_heading),
              onClick = { openSources(playFile, sourcesFocus) },
              modifier = Modifier.focusRequester(sourcesFocus).testTag(TagDetailSources),
            )
          }
        } else {
          null
        },
        // The row the viewer picked is the one To library acts on; a file already on disk has no
        // copy to queue and never offers it.
        toLibrary = currentPick()?.takeIf { canSaveRow(it) }?.let {
          DetailAction(
            label = stringResource(R.string.save_to_library),
            icon = DownloadIcon,
            tag = TagDetailToLibrary,
            enabled = !save.resolving && !save.busy,
            onClick = { currentPick()?.let { row -> saveRow(row) } },
          )
        },
        favourite = DetailAction(
          label = stringResource(if (favourite) R.string.favorite_remove else R.string.favorite_add),
          icon = null,
          glyph = if (favourite) "★" else "☆",
          tag = TagDetailFavourite,
          onClick = { toggleFavourite() },
        ),
        unwatched = if (forgetKeys.isNotEmpty()) DetailAction(
          label = stringResource(R.string.media_server_unwatch),
          icon = EyeOffIcon,
          tag = TagDetailForget,
          enabled = !forgetting,
          onClick = { forgetPanelOpen = true },
        ) else null,
        watched = if (markWatched != null && playFile != null) DetailAction(
          label = stringResource(R.string.media_server_mark_watched),
          icon = EyeIcon,
          tag = TagDetailMarkWatched,
          enabled = !markingWatched,
          onClick = { playFile?.let(::markWatchedNow) },
        ) else null,
        caption = caption,
      )
      actionRow?.let { row ->
        val captionParts = chosenSourceCaption(row).joinToString(" · ")
        if (captionParts.isNotEmpty()) {
          Text(
            stringResource(R.string.tv_chosen_source) + " · " + captionParts,
            color = Tokens.Muted,
            fontSize = 11.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.testTag(TagDetailPickCaption),
          )
        }
      }
      if (forgetError) {
        Text(stringResource(R.string.tv_err_generic), color = Tokens.Red, fontSize = 11.5.sp)
      }
      // A row that could not be played or saved says why here; a copy that landed says so too, and
      // neither hides the row the viewer picked.
      val sourceMessage = sourceNotice ?: if (save.queued) stringResource(R.string.save_queued) else null
      if (sourceMessage != null) {
        Text(
          sourceMessage,
          color = if (sourceNotice != null) Tokens.Red else Tokens.Green,
          fontSize = 11.5.sp,
          modifier = Modifier.testTag(TagDetailSourceNotice),
        )
      }
      if (current.files.size > 1) {
        Spacer(Modifier.height(3.dp))
        EpisodeRow(
          detail = current,
          startIndex = playIndex,
          imageUrl = imageUrl,
          onPlay = onPlay,
          focusRequester = rowFocus,
          onSources = { file, card -> openSources(file, card, fromCard = true) },
        )
      }
    }

    if (sourcesOpen) {
      NativeSourcesPanel(
        // While the file's binding is still being read the panel is asking, so the own rows show
        // under the same spinner a supplementary group gets.
        state = (groupState ?: NativeSourceState()).copy(
          asking = groupState?.asking == true || probing,
        ),
        originals = panelRows,
        // The film's versions lead largest first; an episode is the only row of its own list.
        default = panelRows.firstOrNull(),
        chosen = currentPick(),
        filters = sourceFilters.filters(groupState?.settings?.streamSort),
        profiles = sourceFilters.profiles,
        ruleNoteProfileId = sourceFilters.noteProfileId(groupState?.settings?.streamSort),
        onFilterSelect = { chip, key -> sourceFilters.select(chip, key) },
        onChoose = { choosePanelRow(it) },
        // The panel only picks: To library on the action row acts on the pick, so no row carries
        // a control of its own.
        onSave = null,
        canSave = { row -> canSaveRow(row) },
        onRetry = { sourceGroups?.retry(groupScope) },
        emptyText = stringResource(R.string.media_server_sources_empty),
        onClose = {
          saveGeneration++
          save.resolving = false
          sourcesOpen = false
        },
        initialFocus = sourcesEntry,
      )
    }

    val rowRequest = save.request
    if (rowRequest != null) {
      // Only the row the viewer pressed Save on, and every destination row acts on exactly it.
      NativeQueuePanel(
        versions = listOf(rowRequest.stream),
        libraries = rowRequest.destinations,
        preferred = rowRequest.stream,
        busy = save.busy,
        notice = save.notice,
        realDebridConfigured = realDebrid,
        onQueueDefault = if (rowRequest.automatic) ({ queueRow(null) }) else null,
        onQueue = { _, libraryId -> queueRow(nativeQueueTarget(rowRequest.stream, libraryId)) },
        onClose = {
          save.request = null
          save.notice = null
        },
      )
    }

    if (forgetPanelOpen) {
      SidePanel(
        title = stringResource(R.string.tv_forget_title),
        onClose = { forgetPanelOpen = false },
        modifier = Modifier.testTag(TagDetailForgetPanel),
        initialFocus = forgetPanelFocus,
      ) {
        PanelOption(
          text = stringResource(R.string.common_cancel),
          onClick = { forgetPanelOpen = false },
          modifier = Modifier.testTag(TagDetailForgetCancel).focusRequester(forgetPanelFocus),
        )
        PanelOption(
          text = stringResource(R.string.tv_forget_remove),
          onClick = { forgetNow() },
          modifier = Modifier.testTag(TagDetailForgetRemove),
        )
      }
    }
  }
}

@Composable
private fun EpisodeRow(
  detail: DetailData,
  startIndex: Int,
  imageUrl: (String?) -> String?,
  onPlay: (PlayTarget) -> Unit,
  focusRequester: FocusRequester,
  /** Menu/Info on one card opens the Sources panel for exactly that file, and closing it hands the
   *  remote back to that same card; Enter still plays the file. */
  onSources: (BrowseItem.File, FocusRequester) -> Unit,
) {
  val state = rememberLazyListState()
  LaunchedEffect(detail.gridPath) {
    state.scrollToItem(startIndex.coerceAtLeast(0))
  }
  // One requester per card, so the panel opened from a card returns to that exact card.
  val cardFocuses = remember(detail.gridPath) { mutableMapOf<String, FocusRequester>() }
  LazyRow(
    state = state,
    contentPadding = PaddingValues(horizontal = CardRowInset),
    horizontalArrangement = Arrangement.spacedBy(18.dp),
  ) {
    itemsIndexed(detail.files, key = { _, file -> file.path }) { index, file ->
      // The card the actions' DOWN lands on keeps the caller's requester; every other card owns
      // one, so a panel opened from it comes back to exactly that card.
      val card = remember(file.path, startIndex, focusRequester) {
        if (index == startIndex) focusRequester else cardFocuses.getOrPut(file.path) { FocusRequester() }
      }
      WideCard(
        label = episodeLabel(file),
        imageUrl = imageUrl(file.wide ?: file.poster),
        progress = progressFraction(file),
        completed = isCompleted(file),
        cardTag = file.path,
        onClick = {
          val resume = Progress.resumePosition(positionOf(file), durationOf(file)) != null
          onPlay(PlayTarget(Progress.libraryKey(file.path), file.label, resume = resume, path = file.path))
        },
        modifier = Modifier
          .onPreviewKeyEvent { event ->
            if (event.type == KeyEventType.KeyDown && (event.key == Key.Menu || event.key == Key.Info)) {
              onSources(file, card)
              true
            } else {
              false
            }
          }
          .focusRequester(card),
      )
    }
  }
}

/** Whether the detail lists a series' episodes rather than the versions of one film. */
private fun isEpisodeDetail(detail: DetailData): Boolean =
  detail.files.any { it.season != null || it.episode != null }

/**
 * The rows the detail itself contributes to the Sources panel: every file of a film, ordered
 * largest reported size first the way the web orders its versions, or exactly the one episode the
 * panel was opened on. A sibling episode is a different video, so it never joins an episode's list.
 */
private fun ownFileRows(detail: DetailData, file: BrowseItem.File?): List<StreamDto> {
  if (file == null) return emptyList()
  val files = if (isEpisodeDetail(detail)) listOf(file) else detail.files.sortedByDescending { it.size }
  return files.map(::fileRow)
}

/** The episode title one file stands for, when the detail lists episodes: its number pair, never a
 *  filename read as a title. */
private fun episodeTitleOf(detail: DetailData, file: BrowseItem.File?): String? =
  if (file == null || !isEpisodeDetail(detail)) null else episodeLabel(file)

private fun fileRow(file: BrowseItem.File): StreamDto = StreamDto(
  sourceId = Progress.libraryKey(file.path),
  kind = "library",
  playable = true,
  name = file.label,
  localPath = file.path,
  behaviorHints = BehaviorHintsDto(
    filename = file.label,
    videoSize = file.size.takeIf { it > 0 },
  ),
)

private fun metaLine(detail: DetailData, files: String): String {
  val parts = mutableListOf<String>()
  detail.year?.takeIf { it.isNotBlank() }?.let(parts::add)
  if (detail.fileCount > 0) parts.add(files)
  formatSize(detail.size)?.let(parts::add)
  return parts.joinToString(" · ")
}

/** The web's size units: bytes into MB under a gigabyte, GB above it. */
private fun formatSize(size: Double): String? = when {
  size >= 1e9 -> String.format(Locale.US, "%.1f GB", size / 1e9)
  size >= 1e6 -> String.format(Locale.US, "%.0f MB", size / 1e6)
  size > 0 -> String.format(Locale.US, "%.0f kB", size / 1e3)
  else -> null
}

private fun positionOf(file: BrowseItem.File?): Double = file?.progress?.position ?: 0.0

private fun durationOf(file: BrowseItem.File?): Double = file?.progress?.duration ?: 0.0

private fun isCompleted(file: BrowseItem.File): Boolean = Progress.isCompleted(positionOf(file), durationOf(file))

private fun progressFraction(file: BrowseItem.File): Float? {
  val duration = durationOf(file)
  if (duration <= 0 || positionOf(file) <= 0) return null
  return (positionOf(file) / duration).toFloat()
}
