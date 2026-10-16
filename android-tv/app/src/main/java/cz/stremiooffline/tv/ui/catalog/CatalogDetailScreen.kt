package cz.stremiooffline.tv.ui.catalog

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
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.SemanticsPropertyKey
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import coil.compose.AsyncImage
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.catalog.Languages
import cz.stremiooffline.tv.catalog.ProgressKey
import cz.stremiooffline.tv.catalog.Resume
import cz.stremiooffline.tv.catalog.Streams
import cz.stremiooffline.tv.data.AddonDto
import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.BulkMediaDto
import cz.stremiooffline.tv.data.DownloadTargetDto
import cz.stremiooffline.tv.data.LibraryDto
import cz.stremiooffline.tv.data.MediaDto
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.ProgressDto
import cz.stremiooffline.tv.data.ProgressEntryDto
import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.RemoteItemStateDto
import cz.stremiooffline.tv.data.RemoteLibraryDto
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.data.VideoDto
import cz.stremiooffline.tv.playback.Progress
import cz.stremiooffline.tv.playback.VersionProgress
import cz.stremiooffline.tv.ui.components.CardRowInset
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.components.TvSpinner
import cz.stremiooffline.tv.ui.components.WideCard
import cz.stremiooffline.tv.ui.detail.SavedPlaybackProgress
import cz.stremiooffline.tv.ui.detail.PlayTarget
import cz.stremiooffline.tv.ui.theme.Tokens
import java.util.Locale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.android.awaitFrame
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull

const val TagCatalogPrimary = "catalog_primary"
const val TagCatalogStartOver = "catalog_start_over"
const val TagCatalogFavourite = "catalog_favourite"
const val TagCatalogToLibrary = "catalog_to_library"
const val TagCatalogSources = "catalog_sources"
const val TagCatalogMessage = "catalog_message"
const val TagCatalogEpisode = "catalog_episode"
const val TagCatalogChosenSource = "catalog_chosen_source"
const val TagCatalogWatched = "catalog_watched"
const val TagCatalogLibraryPanel = "catalog_library_panel"
const val TagCatalogShowInLibrary = "catalog_show_in_library"
const val TagCatalogForget = "catalog_forget"
const val TagCatalogMarkWatched = "catalog_mark_watched"
const val TagCatalogForgetPanel = "catalog_forget_panel"
const val TagCatalogForgetCancel = "catalog_forget_cancel"
const val TagCatalogForgetRemove = "catalog_forget_remove"
const val TagCatalogSeriesDownload = "catalog_series_download"

fun libraryOptionTag(libraryId: String): String = "catalog_library_$libraryId"

/** What the message line under the actions tells the viewer; the kind picks its colour. */
internal enum class CatalogNotice { Neutral, Success, Failure }

internal fun catalogNoticeColour(kind: CatalogNotice): Color = when (kind) {
  CatalogNotice.Success -> Tokens.Green
  CatalogNotice.Failure -> Tokens.Red
  CatalogNotice.Neutral -> Tokens.Muted
}

/** The colour is not readable from a test, so the kind behind it is exposed as a semantics
 *  property, the way the player exposes focus through its own. */
internal val CatalogNoticeKind = SemanticsPropertyKey<CatalogNotice>("CatalogNoticeKind")

/** One slow addon must not hold a play back longer once something playable has arrived. */
const val PLAY_WHEN_READY_TIMEOUT_MS = 8_000L

/** The independent remote group deadlines: listing the libraries is quick, matching one is not. */
const val REMOTE_DISCOVERY_TIMEOUT_MS = 3_000L
const val REMOTE_MATCH_TIMEOUT_MS = 8_000L

fun seasonChipTag(season: Int): String = "season_chip_$season"
fun episodeCardTag(video: VideoDto): String = "episode_card_${video.id ?: video.label}"

/** A remote source-group failure the player's panel names: the libraries that could not be
 *  reached, or a general failure when even the library list was unavailable. */
data class RemoteSourcesFailure(val labels: List<String> = emptyList(), val discovery: Boolean = false)

/** The Sources panel's rows as the loader gathered them, whether more are still owed, and any
 *  remote group that failed. */
data class OfferedSources(
  val streams: List<StreamDto> = emptyList(),
  val loading: Boolean = false,
  val remoteFailure: RemoteSourcesFailure? = null,
)

/** The catalogue title detail: the library's layout for a movie or a series, with sources. */
@Composable
fun CatalogDetailScreen(
  api: TvApi,
  args: CatalogDetailArgs,
  imageUrl: (String?) -> String?,
  onPlay: (PlayTarget) -> Unit,
  onBack: () -> Unit,
  restoreToken: Int = 0,
  /** Bumped from outside while the player is up, so its Sources panel can re-read the groups. */
  retryToken: Int = 0,
  /** The source the player was left on, if it was left on one; the caption and the next Play
   *  then name it, the way they do a row the viewer picked here. */
  playedSourceId: String? = null,
  /** The merged list the player's own Sources panel shows, kept current while addons answer. */
  onSources: (OfferedSources) -> Unit = {},
  /** Opens one local file's folder in the Library view. */
  onShowInLibrary: (String) -> Unit = {},
) {
  // An OK while the sources load waits for them; Back or a second OK drops the wait.
  var pendingPlay by remember { mutableStateOf(false) }
  var playTimeoutReached by remember { mutableStateOf(false) }
  fun cancelPendingPlay() {
    pendingPlay = false
    playTimeoutReached = false
  }
  BackHandler { if (pendingPlay) cancelPendingPlay() else onBack() }

  val scope = rememberCoroutineScope()
  var settings by remember { mutableStateOf(SettingsResponse()) }
  var meta by remember { mutableStateOf(args.meta) }
  var entries by remember { mutableStateOf<List<ProgressEntryDto>>(emptyList()) }
  var addons by remember { mutableStateOf<List<AddonDto>>(emptyList()) }
  var movieProgress by remember { mutableStateOf<ProgressDto?>(null) }
  // The source filters are not saved: they live while a title or episode is on screen and reset
  // when either changes. A null sort follows the account's `streamSort`.
  val sourceFilters = remember { SourceFilterState() }
  var favourite by remember { mutableStateOf(false) }
  var favouriteBusy by remember { mutableStateOf(false) }
  var message by remember { mutableStateOf<String?>(null) }
  var noticeKind by remember { mutableStateOf(CatalogNotice.Neutral) }
  // The sources list and its pick, and the save flow a pick feeds, in one object each so the screen
  // keeps a single local for them: this composable sits close to the limit ART can verify, and
  // every one of these used to cost a register of its own.
  val pick = remember { SourcePickState() }
  val save = remember { LibrarySaveState() }
  val remoteProgress = remember { RemoteProgressState() }
  val ui = remember { DetailUiState() }
  // The remote source groups load on their own, so a slow or offline media server cannot hold
  // back the local copy or the addons; held in one object to keep this screen's local count low.
  val remote = remember { RemoteSourcesState() }

  val context = LocalContext.current
  val texts = detailTexts()

  /** The one place the message line is set, so its kind -- which is what picks the colour --
   *  travels with the text instead of being read back off the drawn string. */
  fun notice(text: String?, kind: CatalogNotice = CatalogNotice.Neutral) {
    message = text
    noticeKind = if (text == null) CatalogNotice.Neutral else kind
  }

  val focus = remember { DetailFocus() }

  val streamType = meta.type ?: args.type
  val isSeries = streamType == "series"
  // The libraries this account may save this kind of title to. A server too old to answer
  // /api/libraries leaves the list empty and the TV keeps the addon's own destination.
  val libraryCandidates = remember(save.libraries, streamType) {
    save.libraries.filter { it.canWrite && (it.type == streamType || it.type == "mixed") }
  }
  // Streams belong to a video; a series asks for nothing until an episode is chosen.
  val streamVideoId = if (isSeries) pick.selectedVideo?.id else meta.id
  val streamsKey = streamVideoId?.let { "$streamType:$it" }
  // The key the title's own position (and the source it was played from) is stored under.
  val progressKey = ProgressKey.of(streamType, meta.id, pick.selectedVideo?.id)

  // The title's own requests do not depend on each other, so they all leave at once; only the
  // metadata waits for the settings it takes its language from.
  LaunchedEffect(args.meta.id) {
    save.queuedSourceId = null
    notice(null)
    save.libraryPanelOpen = false
    ui.series.open = false
    save.pendingLibraryStream = null
    sourceFilters.reset()
    coroutineScope {
      val settingsJob = async { runCatching { api.settings() }.getOrDefault(SettingsResponse()) }
      val addonsJob = async { runCatching { api.addons() }.getOrDefault(emptyList()) }
      val librariesJob = async { runCatching { api.libraries() }.getOrNull() }
      val entriesJob = async { runCatching { api.progressList() }.getOrDefault(emptyList()) }
      val watchlistJob = async { runCatching { api.watchlist() }.getOrDefault(emptyList()) }
      val progressJob = async {
        if (args.type == "series") null else runCatching { api.progress(ProgressKey.of(args.type, args.meta.id)) }.getOrNull()
      }
      val loadedSettings = settingsJob.await()
      settings = loadedSettings
      val metaJob = async { runCatching { api.meta(args.type, args.meta.id, loadedSettings.uiLanguage) }.getOrNull() }
      val detail = metaJob.await()
      if (detail != null) meta = mergeMeta(args.meta, detail)
      addons = addonsJob.await()
      librariesJob.await()?.let { save.libraries = it; save.librariesLoaded = true }
      entries = entriesJob.await()
      favourite = watchlistJob.await().any { it.key == "${args.type}:${args.meta.id}" }
      movieProgress = progressJob.await()
      if (args.type == "series") {
        val videos = meta.videos.orEmpty()
        val stored = seriesEntry(entries, meta.id)
        val storedEpisode = stored?.let { Resume.resumeTarget(it).episode }
        val resuming = args.episode == null && stored?.let { Progress.resumePosition(it.position, it.duration) != null } == true
        // Home names the episode it remembers; without one, the stored position decides.
        val wanted = args.episode ?: if (resuming) storedEpisode else null
        val watched = Resume.resumeVideo(videos, wanted)
        pick.selectedVideo = watched ?: nextRelevantEpisode(videos, Resume.resumeVideo(videos, storedEpisode)) ?: firstReleased(videos)
        pick.season = wanted?.season ?: defaultSeason(videos)
      }
    }
  }

  // Each source addon is asked on its own so the first answer is usable without waiting for the
  // slowest, and a change of video clears the list at once so nothing plays a stale source.
  LaunchedEffect(streamsKey, pick.sourcesRetry) {
    val request = ++pick.localRequest
    pick.streams = emptyList()
    pick.localStreams = emptyList()
    pick.localLoading = false
    pick.selectedStream = null
    pick.pickedStream = false
    pick.chosenInPanel = false
    pick.pendingSources = 0
    pick.sourcesLoaded = false
    pick.sourcesFailed = false
    save.queuedSourceId = null
    notice(null)
    val id = streamVideoId
    if (id == null) {
      pick.sourcesLoaded = true
      return@LaunchedEffect
    }
    coroutineScope {
      // The local lookup is its own child coroutine, started before the addons are asked, so a
      // failed addon discovery neither cancels it nor skips it.
      launch {
        pick.localLoading = true
        val found = try {
          api.localStreams(streamType, id)
        } catch (cancelled: CancellationException) {
          throw cancelled
        } catch (error: ApiError) {
          emptyList()
        }
        // A cancelled (stale) effect must not write state; the next run resets it anyway.
        currentCoroutineContext().ensureActive()
        if (request == pick.localRequest) {
          pick.localStreams = found
          pick.localLoading = false
        }
      }
      val sources = try {
        api.streamSources(streamType, id)
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (error: ApiError) {
        pick.sourcesFailed = true
        pick.sourcesLoaded = true
        return@coroutineScope
      }
      pick.sourcesLoaded = true
      pick.pendingSources = sources.size
      // Addon answers can resume on different threads, so their updates take a lock: a lost
      // decrement would leave the button spinning on "Finding sources…" forever.
      val updates = Mutex()
      coroutineScope {
        sources.forEach { source ->
          launch {
            val part = try {
              api.streams(streamType, id, source.key.ifEmpty { null })
            } catch (cancelled: CancellationException) {
              throw cancelled
            } catch (error: ApiError) {
              emptyList()
            }
            updates.withLock {
              if (part.isNotEmpty()) pick.streams = pick.streams + part
              pick.pendingSources -= 1
            }
          }
        }
      }
    }
  }

  // The remote groups load on their own: the authorized libraries are listed once, then each is
  // asked for its externally matched versions in its own child, and a group publishes the moment
  // it answers. This effect is separate from the local/addon one, so a slow or offline media
  // server can neither cancel a sibling nor hold a playable source back. A retry of the same
  // title (the player's own Sources Retry bumps it) keeps the groups already answered, so a healthy
  // remote row is never hidden while the failed library is asked again; a new title starts clean.
  LaunchedEffect(streamsKey, pick.sourcesRetry, retryToken) {
    val request = ++remote.request
    if (remote.key != streamsKey) remote.groups = emptyList()
    remote.key = streamsKey
    remote.pending = 0
    remote.discoveryFailed = false
    val id = streamVideoId
    if (id == null) return@LaunchedEffect
    val foundLibraries = try {
      withTimeoutOrNull(REMOTE_DISCOVERY_TIMEOUT_MS) { api.remoteLibraries() }
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (_: ApiError) {
      null
    }
    if (request != remote.request) return@LaunchedEffect
    if (foundLibraries == null) {
      remote.discoveryFailed = true
      return@LaunchedEffect
    }
    remote.libraries = foundLibraries
    remote.pending = foundLibraries.size
    if (foundLibraries.isEmpty()) return@LaunchedEffect
    val updates = Mutex()
    coroutineScope {
      foundLibraries.forEach { library ->
        launch {
          val part = try {
            // The resolved catalogue title, never the episode's own, is the provider's name filter.
            withTimeoutOrNull(REMOTE_MATCH_TIMEOUT_MS) { api.remoteMatchedStreams(library.id, streamType, id, nameHint = meta.name) }
          } catch (cancelled: CancellationException) {
            throw cancelled
          } catch (_: ApiError) {
            null
          }
          updates.withLock {
            if (request != remote.request) return@withLock
            val match = RemoteMatch(library.id, library.provider, library.name, part.orEmpty(), failed = part == null)
            // Configured order is kept whatever order the answers arrive in.
            remote.groups = (remote.groups.filterNot { it.libraryId == library.id } + match)
              .sortedBy { entry -> remote.libraries.indexOfFirst { it.id == entry.libraryId } }
            remote.pending -= 1
          }
        }
      }
    }
  }

  LaunchedEffect(meta.id) { runCatching { focus.primary.requestFocus() } }
  // The player covers this screen, so on return re-read the stored position to keep Resume honest.
  LaunchedEffect(restoreToken) {
    if (restoreToken == 0) return@LaunchedEffect
    runCatching { focus.primary.requestFocus() }
    if (isSeries) {
      entries = runCatching { api.progressList() }.getOrDefault(entries)
    } else {
      movieProgress = runCatching { api.progress(ProgressKey.of(streamType, meta.id)) }.getOrNull()
    }
  }

  val filters = sourceFilters.filters(settings.streamSort)
  // Merged, sorted and filtered once per change of the raw list or the filters, never on a
  // focus-driven recomposition: parsing hundreds of sizes and languages on every move is what
  // ground the real TV to a halt.
  val lists = remember(pick.streams, addons, settings, meta.language, filters, pick.localStreams, remote.groups) {
    Streams.sourceLists(
      streams = pick.streams,
      addons = addons,
      filters = filters,
      preferredLanguage = settings.audioLanguage ?: "en",
      showTorrents = settings.realDebridConfigured,
      metaLanguage = meta.language,
      local = pick.localStreams,
      remote = remote.groups.map { it.group() },
    )
  }
  val offered = lists.offered
  val visible = lists.visible
  val notices = lists.notices
  val titleLanguage = lists.titleLanguage
  // The list that is drawn and picked from: the library copies arranged with the addon streams the
  // way the web does (Streams.catalogSourceList); counts and notices keep using the addon streams.
  val rows = lists.rows
  // The row of the source last played leads, so Resume continues in it.
  val preferredStream = Streams.pickDefaultStream(
    rows,
    (if (isSeries) entries.firstOrNull { it.key == progressKey }?.stableKey else movieProgress?.stableKey),
  )
  val chosenStream = pick.selectedStream?.takeIf { pick.pickedStream && rows.contains(it) }
  val activeStream = chosenStream ?: pick.selectedStream?.takeIf { rows.contains(it) } ?: preferredStream
  val remoteAsking = remote.pending > 0
  val remoteStreams = remote.groups.flatMap { it.streams }
  val remoteFailedLabels = remote.groups.filter { it.failed }.map { it.label }
  val remoteFailed = remote.discoveryFailed || remoteFailedLabels.isNotEmpty()
  // Asking covers both "the addon list has not answered" and "some addon still owes a list".
  val sourcesAsking = !pick.sourcesFailed && (!pick.sourcesLoaded || pick.pendingSources > 0)
  val anyAsking = sourcesAsking || pick.localLoading || remoteAsking
  // While no playable stream has arrived the primary action is a spinner, not a promise to play.
  val findingSources = activeStream?.playable != true && anyAsking
  val canQueueActive = activeStream != null && Streams.canQueue(activeStream, settings.realDebridConfigured)
  // The tick belongs to the source that was actually queued, and only while it is still the pick.
  val queued = save.queuedSourceId != null && activeStream?.sourceId == save.queuedSourceId
  // A local pick can always be played, and keeps the "no sources" note away: a local copy is a
  // source even before the addons answered.
  val localActive = activeStream != null && Streams.isLocalStream(activeStream)
  // Nothing visible to play: no local copy, no remote match and no addon source at all. A chosen
  // remote group that matched nothing reads the same way -- no addon silently stands in for it.
  val remoteOnly = Streams.remoteFilterLibrary(filters.addon) != null
  val nothingAtAll = (offered.isEmpty() && pick.localStreams.isEmpty() && remoteStreams.isEmpty()) || remoteOnly
  val emptyText = if (nothingAtAll) texts.noSources else texts.torrent
  // The empty state is a note; a list holding only torrents is a failure.
  val emptyKind = if (nothingAtAll) CatalogNotice.Neutral else CatalogNotice.Failure
  val totalSources = offered.size + pick.localStreams.size + remoteStreams.size

  // A later addon may outrank the one already picked, but only while the viewer has not chosen.
  LaunchedEffect(rows, anyAsking) {
    val next = Streams.repickStream(
      playing = false,
      picked = pick.pickedStream,
      pending = if (anyAsking) maxOf(pick.pendingSources, 1) else 0,
      visible = rows,
      selected = pick.selectedStream,
      preferred = preferredStream,
      upgrade = preferredStream?.let(Streams::isLocalStream) == true && pick.selectedStream?.let(Streams::isLocalStream) != true,
    )
    if (next.move) pick.selectedStream = next.to
  }

  // The player's own Sources panel gets the same list, the local copies included, and it keeps
  // growing while the addons answer.
  LaunchedEffect(rows, anyAsking, remoteFailed, remote.discoveryFailed) {
    onSources(OfferedSources(rows, anyAsking, if (remoteFailed) RemoteSourcesFailure(remoteFailedLabels, remote.discoveryFailed) else null))
  }

  // A switch made inside the player has to carry back: the detail keeps naming the source the
  // viewer actually watched, and Play offers it again.
  LaunchedEffect(playedSourceId, rows) {
    val id = playedSourceId ?: return@LaunchedEffect
    val stream = rows.firstOrNull { it.sourceId == id } ?: return@LaunchedEffect
    pick.selectedStream = stream
    pick.pickedStream = true
    pick.chosenInPanel = true
  }

  val resumeEntry = if (isSeries) seriesEntry(entries, meta.id) else null
  val resumeEpisode = if (isSeries) Resume.resumeVideo(meta.videos.orEmpty(), resumeEntry?.let { Resume.resumeTarget(it).episode }) else null
  val storedPosition = if (isSeries) resumeEntry?.position ?: 0.0 else movieProgress?.position ?: 0.0
  val storedDuration = if (isSeries) resumeEntry?.duration ?: 0.0 else movieProgress?.duration ?: 0.0
  // A matched remote version carries its own row, keyed by its opaque identity and the version the
  // viewer picked: the read below fills [remoteProgress] for exactly that identity.
  val activeRemoteItem = activeStream?.remoteItem
  val remoteIdentity = activeRemoteItem?.let { listOf(it.libraryId, it.itemId, it.mediaSourceId.orEmpty()) }
  val remoteRow = remoteProgress.row.takeIf { remoteProgress.key == remoteIdentity }
  // A local file and a remote version each keep their own progress; only an addon row falls back to
  // the catalogue. A remote row still arriving, or one that failed, reads as no progress at all.
  val resuming = when {
    localActive -> pick.localProgress?.let { Progress.resumePosition(it.position, it.duration) != null } == true
    // Only the version that stored the position may resume, and never an item marked watched.
    activeRemoteItem != null -> remoteRow?.let {
      !it.watched && it.mediaSourceId != null && it.mediaSourceId == activeRemoteItem.mediaSourceId &&
        Progress.resumePosition(it.position, it.duration) != null
    } == true
    else -> Progress.resumePosition(storedPosition, storedDuration) != null &&
      (pick.selectedVideo == null || pick.selectedVideo?.id == resumeEpisode?.id)
  }

  // A local pick resumes from the file's own progress, read when it becomes the active row.
  LaunchedEffect(activeStream?.localPath, restoreToken) {
    val path = activeStream?.takeIf(Streams::isLocalStream)?.localPath
    pick.localProgress = if (path == null) null else runCatching { api.progress(Progress.libraryKey(path)) }.getOrNull()
  }

  // The active remote version's row, re-read for its identity, the chosen version and the restore
  // token. The row is cleared first, so a replaced source or a read still under way shows Play, and
  // a late answer for an earlier identity is dropped. A version the catalogue can name reads the
  // title's own key first, so every version of the title resumes the position the title holds; the
  // item's own remote state is the fallback for what was stored before.
  LaunchedEffect(remoteIdentity, restoreToken) {
    val request = ++remoteProgress.request
    remoteProgress.key = null
    remoteProgress.row = null
    val item = activeRemoteItem ?: return@LaunchedEffect
    if (item.libraryId.isBlank() || item.itemId.isBlank()) return@LaunchedEffect
    // Computed here rather than in a local of the body: this composable sits at the limit of the
    // registers Android's verifier allows.
    val titleKey = ProgressKey.of(streamType, meta.id, pick.selectedVideo?.id)
    val loaded = VersionProgress.savedState(
      titleKey,
      item,
      { key -> api.progress(key) },
      { libraryId, itemId -> api.remoteItemState(libraryId, itemId) },
    ) ?: return@LaunchedEffect
    if (request != remoteProgress.request) return@LaunchedEffect
    remoteProgress.row = loaded
    remoteProgress.key = remoteIdentity
  }

  val baseTitle = localizedTitle(args.meta, meta, settings.uiLanguage)
  val playerTitle = if (pick.selectedVideo != null) "$baseTitle · ${pick.selectedVideo!!.label}" else baseTitle
  // The stored position of what Play would play, and the one key Mark as unwatched clears: the
  // card's own keys when the detail came from Continue watching, that key otherwise.
  val forgetKeys: List<String> = if (args.forgetKeys.isNotEmpty() && !ui.forget.done) {
    args.forgetKeys
  } else {
    listOfNotNull(
      playProgress(
        local = activeStream?.takeIf(Streams::isLocalStream),
        localProgress = pick.localProgress,
        remoteItem = activeRemoteItem,
        remoteRow = remoteRow,
        seriesEpisodeMatches = pick.selectedVideo == null || pick.selectedVideo?.id == resumeEpisode?.id,
        cataloguePosition = storedPosition,
        catalogueDuration = storedDuration,
        catalogueKey = progressKey,
      )?.key,
    )
  }

  fun closeSources() {
    if (!pick.sourcesOpen) return
    pick.sourcesOpen = false
  }

  // The opener gets the remote back on the frame the panel and its focus trap are gone; a picked
  // source sends it to Play instead, so the action row is where the viewer carries on.
  LaunchedEffect(pick.sourcesOpen) {
    if (pick.sourcesOpen) {
      pick.sourcesWasOpen = true
    } else if (pick.sourcesWasOpen) {
      pick.sourcesWasOpen = false
      if (pick.closeToPlay) {
        pick.closeToPlay = false
        runCatching { focus.primary.requestFocus() }
      } else {
        runCatching { focus.sourcesOpener.requestFocus() }
      }
    }
  }

  // Back on the library panel hands the remote back to the To library button that opened it.
  LaunchedEffect(save.libraryPanelOpen) {
    if (save.libraryPanelOpen) {
      save.libraryWasOpen = true
    } else if (save.libraryWasOpen) {
      save.libraryWasOpen = false
      runCatching { focus.libraryOpener.requestFocus() }
    }
  }

  // Closing the bulk panel, whether it queued or the viewer backed out, returns the remote to
  // the button that opened it.
  LaunchedEffect(ui.series.open) {
    if (ui.series.open && activeStream?.let(Streams::isRemoteStream) != true && Streams.remoteFilterLibrary(filters.addon) == null) {
      ui.series.wasOpen = true
    } else if (ui.series.wasOpen) {
      ui.series.wasOpen = false
      runCatching { ui.series.focus.requestFocus() }
    }
  }

  fun play(stream: StreamDto) {
    pick.pickedStream = true
    pick.selectedStream = stream
    closeSources()
    notice(null)
    val path = stream.localPath
    if (Streams.isLocalStream(stream) && path != null) {
      // A local play is a library play: the file's own key, the library source minted from the
      // path and no catalogue subtitles.
      onPlay(
        PlayTarget(
          key = Progress.libraryKey(path),
          title = playerTitle,
          resume = true,
          path = path,
          sourceId = null,
          stableKey = stream.stableKey,
          poster = args.meta.poster ?: meta.poster,
          catalogue = true,
        ),
      )
    } else {
      // A remote-matched version carries its own opaque identity and its own version list; its
      // resume flag follows the remote row the detail read, and the controller re-checks it.
      val remoteItem = stream.remoteItem
      onPlay(
        PlayTarget(
          key = progressKey,
          title = playerTitle,
          resume = resuming,
          sourceId = stream.sourceId,
          stableKey = stream.stableKey,
          poster = args.meta.poster ?: meta.poster,
          addonKey = args.addonKey,
          subtitleType = streamType,
          subtitleTarget = streamVideoId,
          catalogue = true,
          remoteItem = remoteItem,
          remoteSources = Streams.remoteVersionsOf(remoteItem, remoteStreams),
        ),
      )
    }
  }

  /** Queues one source with [target], or with no target when the server should resolve its own
   *  configured destination. */
  fun queueTo(stream: StreamDto, target: DownloadTargetDto?) {
    val media = mediaFor(meta, args, pick.selectedVideo, settings)
    val title = playerTitle
    save.queueBusy = true
    scope.launch {
      try {
        val job = api.download(title, stream.sourceId, media, target)
        save.queuedSourceId = stream.sourceId
        notice(if (job.status == "waiting") texts.waiting else texts.queued, CatalogNotice.Success)
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (error: ApiError) {
        // A refusal carries the server's own explanation; the catalogue line is the fallback.
        notice(error.serverMessage ?: texts.notAllowed.takeIf { error.failure == ApiFailure.Forbidden }, CatalogNotice.Failure)
      } finally {
        save.queueBusy = false
      }
    }
  }

  fun queue(stream: StreamDto) {
    if (save.queueBusy) return
    pick.selectedStream = stream
    pick.pickedStream = true
    notice(null)
    if (!Streams.canQueue(stream, settings.realDebridConfigured)) {
      notice(texts.torrent, CatalogNotice.Failure)
      return
    }
    when {
      // A media-server original goes to the destination the server projected for it, or to the
      // server's own default for the kind. A destination list that never came back or holds no
      // writable library still refuses: nothing is queued blind, and no first candidate is taken.
      Streams.isRemoteStream(stream) -> {
        if (!save.librariesLoaded || libraryCandidates.isEmpty()) notice(texts.noLibrary, CatalogNotice.Failure)
        // With a projected destination the copy carries no target at all, so the server resolves
        // its own configured subfolder and layout. A source with no projection opens the library
        // panel instead: nothing is queued blind and no first candidate is taken.
        else if (libraryCandidates.any { it.id == (stream.downloadTarget?.libraryId ?: stream.downloadLibraryId) }) queueTo(stream, null)
        else { save.pendingLibraryStream = stream; save.libraryPanelOpen = true }
      }
      // The server that could not answer keeps the old behaviour: queue and let it pick.
      !save.librariesLoaded -> queueTo(stream, null)
      libraryCandidates.isEmpty() -> notice(texts.noLibrary, CatalogNotice.Failure)
      libraryCandidates.size == 1 -> queueTo(stream, DownloadTargetDto(libraryCandidates.first().id))
      // More than one usable library: let the viewer choose, the addon's own default preselected.
      else -> {
        save.pendingLibraryStream = stream
        save.libraryPanelOpen = true
      }
    }
  }

  /** OK in the panel picks a row; Play or To library in the action row then acts on it. */
  fun chooseSource(stream: StreamDto) {
    pick.selectedStream = stream
    pick.pickedStream = true
    pick.chosenInPanel = true
    notice(null)
    pick.closeToPlay = true
    closeSources()
  }

  /** OK while the sources are still coming; the wait ends when they all answer or the deadline passes. */
  fun armPendingPlay() {
    notice(null)
    playTimeoutReached = false
    pendingPlay = true
  }

  fun resolvePendingPlay() {
    cancelPendingPlay()
    val stream = preferredStream
    if (stream?.playable == true) {
      play(stream)
    } else if (pick.localStreams.isEmpty()) {
      notice(if (offered.isEmpty()) texts.noSources else texts.torrent, CatalogNotice.Failure)
    }
  }

  fun playPressed() {
    val stream = activeStream
    when {
      pendingPlay -> cancelPendingPlay()
      // A local copy needs no addon and no discovery, so a failed addon lookup must not block it.
      localActive && stream?.localPath != null -> play(stream)
      pick.sourcesFailed -> notice(texts.loadError, CatalogNotice.Failure)
      // Once a row is chosen, Play acts on that row alone: a playable pick plays, an unplayable
      // one says why, and the wait for another addon never overrides the pick.
      pick.pickedStream -> when {
        stream?.playable == true -> play(stream)
        stream != null -> notice(texts.torrent, CatalogNotice.Failure)
        else -> notice(emptyText, emptyKind)
      }
      stream?.playable == true -> play(stream)
      findingSources -> armPendingPlay()
      // A chosen stream that cannot be played is what the torrent message is for; queuing it is
      // the To library button's job.
      stream != null -> if (pick.localStreams.isEmpty()) notice(texts.torrent, CatalogNotice.Failure)
      else -> if (pick.localStreams.isEmpty()) notice(emptyText, emptyKind)
    }
  }

  fun startOverPressed() {
    notice(null)
    val stream = activeStream
    val path = stream?.localPath
    when {
      stream != null && Streams.isLocalStream(stream) && path != null -> {
        pick.pickedStream = true
        pick.selectedStream = stream
        onPlay(
          PlayTarget(
            key = Progress.libraryKey(path),
            title = playerTitle,
            resume = false,
            path = path,
            sourceId = null,
            stableKey = stream.stableKey,
            poster = args.meta.poster ?: meta.poster,
            catalogue = true,
          ),
        )
      }
      pick.sourcesFailed -> notice(texts.loadError, CatalogNotice.Failure)
      stream?.playable == true -> {
        pick.pickedStream = true
        pick.selectedStream = stream
        val remoteItem = stream.remoteItem
        onPlay(
          PlayTarget(
            key = progressKey,
            title = playerTitle,
            resume = false,
            sourceId = stream.sourceId,
            stableKey = stream.stableKey,
            poster = args.meta.poster ?: meta.poster,
            addonKey = args.addonKey,
            subtitleType = streamType,
            subtitleTarget = streamVideoId,
            catalogue = true,
            remoteItem = remoteItem,
            remoteSources = Streams.remoteVersionsOf(remoteItem, remoteStreams),
          ),
        )
      }
      pick.pickedStream -> notice(if (stream != null) texts.torrent else emptyText, if (stream != null) CatalogNotice.Failure else emptyKind)
      anyAsking -> Unit
      else -> if (pick.localStreams.isEmpty()) notice(emptyText, emptyKind)
    }
  }

  /** Serialised so two quick presses cannot leave the star disagreeing with the server. */
  fun toggleFavourite() {
    if (favouriteBusy) return
    favouriteBusy = true
    val wanted = !favourite
    favourite = wanted
    scope.launch {
      try {
        favourite = api.setWatchlist(args.type, meta.id, meta.name, meta.poster, wanted).favorite
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (error: ApiError) {
        favourite = !wanted
      } finally {
        favouriteBusy = false
      }
    }
  }

  /** Forgets this title's stored positions, then re-reads them so the action turns back to Play. */
  fun forgetNow() {
    if (ui.forget.busy || forgetKeys.isEmpty()) return
    ui.forget.busy = true
    ui.forget.panelOpen = false
    scope.launch {
      try {
        api.forgetProgress(forgetKeys)
        ui.forget.done = true
        if (isSeries) {
          entries = runCatching { api.progressList() }.getOrDefault(entries)
        } else {
          movieProgress = runCatching { api.progress(ProgressKey.of(streamType, meta.id)) }.getOrNull()
        }
        runCatching { focus.primary.requestFocus() }
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: ApiError) {
      } finally {
        ui.forget.busy = false
      }
    }
  }

  /** Selecting an episode drops the list, the queued state and any message at once. */
  fun selectVideo(video: VideoDto) {
    if (video.id == pick.selectedVideo?.id) return
    cancelPendingPlay()
    pick.selectedVideo = video
    pick.selectedStream = null
    pick.pickedStream = false
    pick.chosenInPanel = false
    // A new episode starts from the account's own sort and an unfiltered list.
    sourceFilters.reset()
    pick.streams = emptyList()
    pick.localStreams = emptyList()
    pick.localLoading = false
    pick.pendingSources = 0
    pick.sourcesLoaded = false
    pick.sourcesFailed = false
    remote.groups = emptyList()
    remote.pending = 0
    remote.discoveryFailed = false
    save.queuedSourceId = null
    notice(null)
  }

  // The deadline starts when OK arms the wait, not when the first stream lands.
  LaunchedEffect(pendingPlay) {
    if (!pendingPlay) return@LaunchedEffect
    delay(PLAY_WHEN_READY_TIMEOUT_MS)
    playTimeoutReached = true
  }

  // Resolves the armed play once every addon answered, or at the deadline with something playable.
  LaunchedEffect(pendingPlay, anyAsking, preferredStream, playTimeoutReached) {
    if (!pendingPlay) return@LaunchedEffect
    val playable = preferredStream?.playable == true
    if (anyAsking && !(playTimeoutReached && playable)) return@LaunchedEffect
    resolvePendingPlay()
  }

  // A button that disappears while it holds the remote hands it back to Play. The flag is read
  // during composition, before the button is dropped, so losing focus on disposal does not hide it.
  val toLibraryWasFocused = focus.toLibraryFocused
  val startOverWasFocused = focus.startOverFocused
  LaunchedEffect(canQueueActive) {
    if (!canQueueActive && toLibraryWasFocused) {
      focus.toLibraryFocused = false
      runCatching { focus.primary.requestFocus() }
    }
  }
  // A queue request in the air disables the button, so the remote it was holding goes back to Play
  // instead of being left on nothing.
  LaunchedEffect(save.queueBusy) {
    if (save.queueBusy && toLibraryWasFocused) {
      focus.toLibraryFocused = false
      runCatching { focus.primary.requestFocus() }
    }
  }
  // Start over stands beside Play while a position is stored for the row both of them act on.
  LaunchedEffect(forgetKeys.isNotEmpty()) {
    if (forgetKeys.isEmpty() && startOverWasFocused) {
      focus.startOverFocused = false
      runCatching { focus.primary.requestFocus() }
    }
  }

  Box(
    Modifier
      .fillMaxSize()
      .background(Tokens.Bg)
      .onPreviewKeyEvent { event ->
        // DOWN drops into the episode row from the action row only; inside an open panel it must
        // reach the next source instead.
        if (event.type == KeyEventType.KeyDown && event.key == Key.DirectionDown &&
          isSeries && !pick.sourcesOpen && !ui.series.open && focus.actionRowFocused
        ) {
          runCatching { focus.row.requestFocus() }.isSuccess
        } else {
          false
        }
      },
  ) {
    AsyncImage(
      model = imageUrl(meta.background ?: meta.poster),
      contentDescription = null,
      contentScale = ContentScale.Crop,
      modifier = Modifier.fillMaxSize(),
    )
    Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(listOf(Tokens.Bg, Tokens.Bg.copy(alpha = 0.8f), Tokens.Bg.copy(alpha = 0f)))))
    Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Tokens.Bg.copy(alpha = 0f), Tokens.Bg.copy(alpha = 0.7f), Tokens.Bg))))

    Column(
      modifier = Modifier.fillMaxSize().padding(start = 60.dp, top = Tokens.SafeY, end = 60.dp),
      verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
      Text(
        eyebrow(args.addonName, isSeries).uppercase(),
        color = Tokens.Accent,
        fontSize = 10.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 1.8.sp,
      )
      Text(
        meta.name,
        color = Tokens.Text,
        fontSize = 42.sp,
        fontWeight = FontWeight.ExtraBold,
        letterSpacing = (-1.2).sp,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.width(760.dp),
      )
      val selectedEpisodeLine = if (isSeries) pick.selectedVideo?.let { episodeLine(it) } else null
      if (selectedEpisodeLine != null) {
        Text(
          selectedEpisodeLine,
          color = Tokens.Muted,
          fontSize = 11.5.sp,
          fontWeight = FontWeight.Medium,
          modifier = Modifier.testTag(TagCatalogEpisode),
        )
      }
      Text(metaLine(meta), color = Tokens.Muted, fontSize = 11.5.sp, fontWeight = FontWeight.Medium)
      val description = meta.description
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
      playProgress(
        local = activeStream?.takeIf(Streams::isLocalStream),
        localProgress = pick.localProgress,
        remoteItem = activeRemoteItem,
        remoteRow = remoteRow,
        seriesEpisodeMatches = pick.selectedVideo == null || pick.selectedVideo?.id == resumeEpisode?.id,
        cataloguePosition = storedPosition,
        catalogueDuration = storedDuration,
        catalogueKey = progressKey,
      )?.let { saved ->
        SavedPlaybackProgress(position = saved.position, duration = saved.duration, tag = TagCatalogWatched)
      }
      Spacer(Modifier.height(3.dp))
      DetailActionRow(
        primary = {
          FocusButton(
            text = when {
              pendingPlay -> texts.playWhenReady
              findingSources -> texts.findingSources
              resuming -> stringResource(R.string.tv_resume)
              else -> stringResource(R.string.player_play)
            },
            onClick = { playPressed() },
            kind = FocusButtonKind.Primary,
            leading = if (pendingPlay || findingSources) ({ TvSpinner() }) else null,
            modifier = Modifier.focusRequester(focus.primary).testTag(TagCatalogPrimary),
          )
        },
        // A stored position is what offers a fresh start beside Play, for the row Play would play.
        startOver = if (forgetKeys.isNotEmpty()) catalogAction(
          TagCatalogStartOver, stringResource(R.string.tv_start_over), ReplayIcon,
          modifier = Modifier.onFocusChanged { focus.startOverFocused = it.isFocused },
        ) { startOverPressed() } else null,
        sources = {
          FocusButton(
            text = stringResource(R.string.tv_sources_count, rows.size.toString()),
            onClick = {
              cancelPendingPlay()
              pick.sourcesOpen = true
            },
            leading = if (anyAsking) ({ TvSpinner() }) else null,
            modifier = Modifier.focusRequester(focus.sourcesOpener).testTag(TagCatalogSources),
          )
        },
        toLibrary = if (canQueueActive) catalogAction(
          TagCatalogToLibrary,
          if (queued) texts.queued else texts.toLibrary,
          if (queued) CheckIcon else DownloadIcon,
          enabled = !save.queueBusy,
          modifier = Modifier
            .focusRequester(focus.libraryOpener)
            .onFocusChanged { focus.toLibraryFocused = it.isFocused },
        ) { activeStream?.let { queue(it) } } else null,
        favourite = catalogAction(
          TagCatalogFavourite,
          stringResource(if (favourite) R.string.favorite_remove else R.string.favorite_add),
          glyph = if (favourite) "★" else "☆",
        ) { toggleFavourite() },
        unwatched = if (forgetKeys.isNotEmpty()) catalogAction(
          TagCatalogForget, stringResource(R.string.media_server_unwatch), EyeOffIcon,
          enabled = !ui.forget.busy,
        ) { ui.forget.panelOpen = true } else null,
        // Anything with a row to play can be marked finished: the server then drops it from
        // Continue watching and, for an episode, moves the show on to the next one.
        watched = if (activeStream != null) catalogAction(
          TagCatalogMarkWatched,
          stringResource(R.string.media_server_mark_watched),
          EyeIcon,
        ) {
            scope.launch {
              runCatching {
                api.saveProgress(progressKey, 1.0, 1.0, playerTitle, null, args.meta.poster ?: meta.poster, null, null)
              }
              if (isSeries) {
                entries = runCatching { api.progressList() }.getOrDefault(entries)
              } else {
                movieProgress = runCatching { api.progress(ProgressKey.of(streamType, meta.id)) }.getOrNull()
              }
            }
        } else null,
        caption = ui.caption,
        modifier = Modifier.onFocusChanged { focus.actionRowFocused = it.hasFocus },
        extras = listOfNotNull(
          // The web's bulk download, for the whole batch at once: it needs no source of its own, so
          // it sits beside To library for any series with an episode selected. A native pick has no
          // bulk action at all: the batch would queue addons the viewer never chose.
          if (isSeries && pick.selectedVideo != null && !meta.videos.isNullOrEmpty()
            && activeStream?.let(Streams::isRemoteStream) != true) {
            catalogAction(
              TagCatalogSeriesDownload, stringResource(R.string.bulk_title), SeriesDownloadIcon,
              modifier = Modifier.focusRequester(ui.series.focus),
            ) {
              if (activeStream?.let(Streams::isRemoteStream) != true) {
                cancelPendingPlay()
                ui.series.open = true
              }
            }
          } else null,
          // Show in library is offered whenever the list holds a copy on disk, not only while that
          // copy is the active pick: it opens the active row's folder when that row is the copy.
          if (showInLibraryFolder(activeStream, rows) != null) {
            catalogAction(
              TagCatalogShowInLibrary,
              stringResource(R.string.library_show_in_library),
              FolderIcon,
            ) { showInLibraryFolder(activeStream, rows)?.let(onShowInLibrary) }
          } else null,
        ),
      )
      if (pick.chosenInPanel) {
        activeStream?.let { stream ->
          val caption = chosenSourceCaption(stream).joinToString(" · ")
          if (caption.isNotEmpty()) {
            Text(
              stringResource(R.string.tv_chosen_source) + " · " + caption,
              color = Tokens.Muted,
              fontSize = 11.sp,
              maxLines = 1,
              overflow = TextOverflow.Ellipsis,
              modifier = Modifier.testTag(TagCatalogChosenSource),
            )
          }
        }
      }
      val shown = message
      if (shown != null) {
        Text(
          shown,
          color = catalogNoticeColour(noticeKind),
          fontSize = 11.sp,
          modifier = Modifier
            .testTag(TagCatalogMessage)
            .semantics { this[CatalogNoticeKind] = noticeKind },
        )
      }
      val videos = meta.videos.orEmpty()
      if (isSeries && videos.isNotEmpty()) {
        SeriesRows(
          videos = videos,
          season = pick.season,
          onSeason = { pick.season = it },
          resumeEpisode = resumeEpisode,
          focusVideo = nextRelevantEpisode(videos, resumeEpisode),
          seriesPosition = storedPosition,
          seriesDuration = storedDuration,
          imageUrl = imageUrl,
          onSelect = { video ->
            selectVideo(video)
            scope.launch {
              awaitFrame()
              runCatching { focus.primary.requestFocus() }
            }
          },
          focusRequester = focus.row,
          seasonFocus = focus.season,
        )
      }
    }

    if (pick.sourcesOpen) {
      // Reopening lands on what the viewer picked; without a pick, on the default.
      val focusIndex = rows.indexOfFirst { it === (chosenStream ?: preferredStream) }.let { if (it >= 0) it else 0 }
      // Like the web, the filter bar is only worth showing once more than one source is offered.
      val chips = sourceFilterChips(filters, lists.options)
      SourcesPanel(
        streams = rows,
        focusIndex = focusIndex,
        onChoose = { chooseSource(it) },
        onClose = { closeSources() },
        default = preferredStream,
        chosen = chosenStream,
        anyChosen = chosenStream != null,
        titleLanguage = titleLanguage,
        asking = anyAsking,
        // A failure only stands in for the list when there is nothing to show: a nonempty filtered
        // list is never hidden by a group that failed, which stays a note beside the rows instead.
        failed = (pick.sourcesFailed || remoteFailed) && rows.isEmpty(),
        notices = notices,
        emptyText = emptyText,
        failureText = if (remoteFailed && rows.isEmpty()) remoteFailureText(remoteFailedLabels) else texts.loadError,
        onRetry = { pick.sourcesRetry++ },
        retryTag = TagCatalogRetry,
        filters = if (totalSources > 1) chips else emptyList(),
        onFilterSelect = { chip, key ->
          sourceFilters.select(chip, key)
        },
        countText = if (totalSources > 1) {
          stringResource(R.string.sources_of_total, rows.size, totalSources)
        } else {
          null
        },
        remoteNote = remoteNotice(remoteFailed, remoteFailedLabels),
        initialFocus = focus.sourcesPanel,
      )
    }

    if (save.libraryPanelOpen) {
      // The preselection follows the web's `ruleTarget`: the addon's own rule first, then the
      // library the account flagged as its default for this kind, then the first usable one.
      val addonDefault = addons.firstOrNull { it.key == save.pendingLibraryStream?.addonKey }?.defaultLibraryId(streamType)
      val flaggedDefault = libraryCandidates.firstOrNull { if (streamType == "series") it.defaultSeries else it.defaultMovie }?.id
      val preferredLibraryId = addonDefault?.takeIf { id -> libraryCandidates.any { it.id == id } }
        ?: flaggedDefault
        ?: libraryCandidates.firstOrNull()?.id
      val focusIndex = libraryCandidates.indexOfFirst { it.id == preferredLibraryId }.let { if (it >= 0) it else 0 }
      SidePanel(
        title = stringResource(R.string.save_to_library),
        onClose = { save.libraryPanelOpen = false },
        modifier = Modifier.testTag(TagCatalogLibraryPanel),
        initialFocus = focus.libraryPanel,
      ) {
        libraryCandidates.forEachIndexed { index, library ->
          PanelOption(
            text = library.name,
            selected = library.id == preferredLibraryId,
            onClick = {
              val stream = save.pendingLibraryStream
              save.libraryPanelOpen = false
              stream?.let { queueTo(it, DownloadTargetDto(library.id)) }
            },
            modifier = Modifier
              .testTag(libraryOptionTag(library.id))
              .then(if (index == focusIndex) Modifier.focusRequester(focus.libraryPanel) else Modifier),
          )
        }
      }
    }

    if (ui.forget.panelOpen) {
      SidePanel(
        title = stringResource(R.string.tv_forget_title),
        onClose = { ui.forget.panelOpen = false },
        modifier = Modifier.testTag(TagCatalogForgetPanel),
        initialFocus = focus.forgetPanel,
      ) {
        PanelOption(
          text = stringResource(R.string.common_cancel),
          onClick = { ui.forget.panelOpen = false },
          modifier = Modifier.testTag(TagCatalogForgetCancel).focusRequester(focus.forgetPanel),
        )
        PanelOption(
          text = stringResource(R.string.tv_forget_remove),
          onClick = { forgetNow() },
          modifier = Modifier.testTag(TagCatalogForgetRemove),
        )
      }
    }

    if (ui.series.open) {
      // The batch carries the title and its artwork, and the addon's own destination unless the
      // viewer picks another library inside the panel.
      SeriesDownloadPanel(
        api = api,
        type = streamType,
        title = baseTitle,
        videos = meta.videos.orEmpty(),
        selected = pick.selectedVideo,
        media = BulkMediaDto(
          id = meta.id,
          metaType = streamType,
          poster = args.meta.poster ?: meta.poster,
          background = args.meta.background ?: args.meta.poster ?: meta.background,
        ),
        settings = settings,
        addons = addons,
        libraries = save.libraries,
        onQueued = { added, skipped ->
          ui.series.open = false
          val addedText = context.resources.getQuantityString(R.plurals.episodes_bulk_added, added, added)
          val skippedText = if (skipped > 0) {
            " " + context.resources.getQuantityString(R.plurals.episodes_bulk_skipped, skipped, skipped)
          } else {
            ""
          }
          notice(addedText + skippedText, CatalogNotice.Success)
        },
        onClose = { ui.series.open = false },
      )
    }
  }
}

/** The type line over the title: `Movie · Cinemeta`, or just `Movie` for a title with no addon. */
@Composable
private fun eyebrow(addonName: String, series: Boolean): String =
  if (addonName.isBlank()) {
    stringResource(if (series) R.string.catalog_type_series else R.string.catalog_type_movie)
  } else {
    stringResource(if (series) R.string.tv_detail_eyebrow_series else R.string.tv_detail_eyebrow_movie, addonName)
  }

@Composable
private fun SeriesRows(
  videos: List<VideoDto>,
  season: Int?,
  onSeason: (Int) -> Unit,
  resumeEpisode: VideoDto?,
  focusVideo: VideoDto?,
  seriesPosition: Double,
  seriesDuration: Double,
  imageUrl: (String?) -> String?,
  onSelect: (VideoDto) -> Unit,
  focusRequester: FocusRequester,
  seasonFocus: FocusRequester,
) {
  val seasons = seasonsOf(videos)
  val current = season ?: seasons.firstOrNull()
  val seasonState = remember { LazyListState() }
  var focusedSeason by remember { mutableIntStateOf(seasons.indexOf(current)) }
  // A series can carry more seasons than fit; scrolling the row keeps the focused chip in view.
  LaunchedEffect(focusedSeason) {
    if (focusedSeason >= 0) seasonState.animateScrollToItem(focusedSeason)
  }
  LazyRow(
    state = seasonState,
    contentPadding = PaddingValues(horizontal = CardRowInset),
    horizontalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    itemsIndexed(seasons, key = { _, value -> value }) { index, value ->
      FocusButton(
        text = stringResource(R.string.episodes_season_number, value.toString()),
        onClick = { onSeason(value) },
        kind = if (value == current) FocusButtonKind.Primary else FocusButtonKind.Normal,
        modifier = Modifier
          .testTag(seasonChipTag(value))
          // The chip the row is scrolled to carries the requester the episode row's UP returns to.
          .then(if (index == focusedSeason) Modifier.focusRequester(seasonFocus) else Modifier)
          .onFocusChanged { if (it.hasFocus) focusedSeason = index },
      )
    }
  }
  val episodes = videos.filter { it.season == current }.ifEmpty { videos }
  LazyRow(
    contentPadding = PaddingValues(horizontal = CardRowInset),
    horizontalArrangement = Arrangement.spacedBy(18.dp),
    // UP from the episodes goes to the season chips; the chips never trap the remote.
    modifier = Modifier.onPreviewKeyEvent { event ->
      if (event.type == KeyEventType.KeyDown && event.key == Key.DirectionUp) {
        runCatching { seasonFocus.requestFocus() }.isSuccess
      } else {
        false
      }
    },
  ) {
    itemsIndexed(episodes, key = { _, video -> video.id ?: video.label }) { index, video ->
      val resumeIndex = episodes.indexOfFirst { resumeEpisode != null && it.id != null && it.id == resumeEpisode.id }
      val progress = if (video.id != null && video.id == resumeEpisode?.id && seriesDuration > 0) {
        (seriesPosition / seriesDuration).toFloat()
      } else {
        null
      }
      WideCard(
        label = video.numbered ?: video.label,
        caption = video.title ?: video.name,
        imageUrl = imageUrl(video.thumbnail),
        progress = progress,
        completed = resumeIndex >= 0 && index < resumeIndex,
        cardTag = episodeCardTag(video),
        onClick = { onSelect(video) },
        modifier = if (video.id != null && video.id == focusVideo?.id) Modifier.focusRequester(focusRequester) else Modifier,
      )
    }
  }
}

/** The selected episode under the title: the card's `S1 · E1` label and the episode's name. */
internal fun episodeLine(video: VideoDto): String {
  val name = video.title ?: video.name
  return listOfNotNull(video.numbered, name?.takeIf { it.isNotBlank() })
    .joinToString(" · ")
    .ifEmpty { video.label }
}

internal fun formatSize(size: Double?): String? = when {
  size == null -> null
  size >= 1e9 -> String.format(Locale.US, "%.1f GB", size / 1e9)
  size >= 1e6 -> String.format(Locale.US, "%.0f MB", size / 1e6)
  size > 0 -> String.format(Locale.US, "%.0f kB", size / 1e3)
  else -> null
}

internal fun metaLine(meta: MetaDto): String {
  val parts = mutableListOf<String>()
  meta.yearText?.let(parts::add)
  meta.genres?.take(3)?.let { parts.addAll(it) }
  meta.runtime?.takeIf { it.isNotBlank() }?.let(parts::add)
  meta.ratingText?.let { parts.add("★ $it") }
  return parts.joinToString(" · ")
}

internal fun mergeMeta(summary: MetaDto, detail: MetaDto): MetaDto = summary.copy(
  poster = detail.poster ?: summary.poster,
  background = detail.background ?: summary.background,
  description = detail.description ?: summary.description,
  releaseInfo = detail.releaseInfo ?: summary.releaseInfo,
  nameLanguage = detail.nameLanguage ?: summary.nameLanguage,
  year = detail.year ?: summary.year,
  genres = detail.genres ?: summary.genres,
  videos = detail.videos ?: summary.videos,
  language = detail.language ?: summary.language,
  runtime = detail.runtime ?: summary.runtime,
  imdbRating = detail.imdbRating ?: summary.imdbRating,
)

internal fun localizedTitle(summary: MetaDto, detail: MetaDto, language: String?): String =
  if (detail.nameLanguage != null && detail.nameLanguage == language) detail.name.ifEmpty { summary.name } else summary.name

internal fun mediaFor(meta: MetaDto, args: CatalogDetailArgs, video: VideoDto?, settings: SettingsResponse): MediaDto {
  val poster = args.meta.poster ?: meta.poster
  val background = args.meta.background ?: poster ?: meta.background
  val title = localizedTitle(args.meta, meta, settings.uiLanguage)
  val metaType = meta.type ?: args.type
  return if (video != null) {
    MediaDto(
      kind = "episode",
      title = title,
      id = meta.id,
      metaType = metaType,
      poster = poster,
      background = background,
      season = video.season,
      episode = video.episode,
      episodeTitle = video.title ?: video.name,
    )
  } else {
    MediaDto(
      kind = "movie",
      title = title,
      year = movieYear(args.meta, meta),
      id = meta.id,
      metaType = metaType,
      poster = poster,
      background = background,
    )
  }
}

internal fun movieYear(summary: MetaDto, detail: MetaDto): Int? {
  val raw = (summary.releaseInfo ?: summary.yearText ?: detail.releaseInfo ?: detail.yearText)?.take(4) ?: return null
  val year = raw.toIntOrNull() ?: return null
  return year.takeIf { it in 1900..2100 }
}

/** Seasons with 0 (specials) last. */
internal fun seasonsOf(videos: List<VideoDto>): List<Int> =
  videos.mapNotNull { it.season }.distinct().sortedWith(compareBy({ if (it == 0) 1 else 0 }, { it }))

internal fun defaultSeason(videos: List<VideoDto>): Int? {
  val seasons = seasonsOf(videos)
  return seasons.firstOrNull { it > 0 } ?: seasons.firstOrNull()
}

internal fun orderedEpisodes(videos: List<VideoDto>): List<VideoDto> {
  val seasons = seasonsOf(videos)
  return seasons.flatMap { value -> videos.filter { it.season == value }.sortedBy { it.episode ?: Int.MAX_VALUE } }
}

/** The release day of an episode as `yyyy-MM-dd`, comparably ordered; null when it says nothing. */
internal fun releasedDate(video: VideoDto): String? {
  val date = (video.released ?: return null).take(10)
  return date.takeIf { Regex("^\\d{4}-\\d{2}-\\d{2}$").matches(it) }
}

internal fun utcToday(): String {
  val format = java.text.SimpleDateFormat("yyyy-MM-dd", Locale.US)
  format.timeZone = java.util.TimeZone.getTimeZone("UTC")
  return format.format(java.util.Date())
}

/** The episode after the last watched one, skipping anything not released yet; else the first. */
internal fun nextRelevantEpisode(videos: List<VideoDto>, lastWatched: VideoDto?, today: String = utcToday()): VideoDto? {
  if (videos.isEmpty()) return null
  val ordered = orderedEpisodes(videos)
  val released = { video: VideoDto -> (releasedDate(video) ?: "0000-01-01") <= today }
  val index = ordered.indexOfFirst { lastWatched != null && it.id != null && it.id == lastWatched.id }
  val after = if (index >= 0) ordered.drop(index + 1) else emptyList()
  return after.firstOrNull(released) ?: ordered.firstOrNull(released)
}

internal fun firstReleased(videos: List<VideoDto>, today: String = utcToday()): VideoDto? =
  orderedEpisodes(videos).firstOrNull { (releasedDate(it) ?: "0000-01-01") <= today }

/** The stored row of one series, from the field first and from the key second. */
internal fun seriesEntry(entries: List<ProgressEntryDto>, metaId: String): ProgressEntryDto? =
  entries.firstOrNull { it.series?.id == metaId }
    ?: entries.firstOrNull { it.key.startsWith("series:") && Resume.resumeTarget(it).meta.id == metaId }

/** The Forget flow's three flags, in one object: this screen is one composable close to the
 *  limit ART can verify, so each extra local would risk a VerifyError on a real device. */
private class ForgetState {
  var panelOpen by mutableStateOf(false)
  var busy by mutableStateOf(false)
  /** The card's own keys stop counting once they have been forgotten. */
  var done by mutableStateOf(false)
}

/** The series-download panel's flags and its opener's focus, in one object: this screen is one
 *  composable close to the limit ART can verify, so every extra local risks a VerifyError. */
private class SeriesDownloadState {
  var open by mutableStateOf(false)
  var wasOpen by mutableStateOf(false)
  val focus = FocusRequester()
}

/** The screen's fixed labels, read together so the composable keeps one local instead of ten; the
 *  interface is translated, so they are resolved in composition and passed down as plain strings. */
private data class DetailTexts(
  val queued: String,
  val waiting: String,
  val notAllowed: String,
  val noLibrary: String,
  val torrent: String,
  val noSources: String,
  val loadError: String,
  val toLibrary: String,
  val findingSources: String,
  val playWhenReady: String,
)

@Composable
private fun detailTexts(): DetailTexts = DetailTexts(
  queued = stringResource(R.string.save_queued),
  waiting = stringResource(R.string.downloads_waiting_debrid),
  notAllowed = stringResource(R.string.err_download_library_not_allowed),
  noLibrary = stringResource(R.string.tv_no_library_to_save),
  torrent = stringResource(R.string.err_torrent_not_playable),
  noSources = stringResource(R.string.sources_none),
  loadError = stringResource(R.string.tv_load_error),
  toLibrary = stringResource(R.string.save_to_library),
  findingSources = stringResource(R.string.tv_finding_sources),
  playWhenReady = stringResource(R.string.tv_play_when_ready),
)

/** The focus requesters the screen hands the remote between and the three flags that say which
 *  action holds it, in one object so the screen keeps a single local for all eleven. */
private class DetailFocus {
  val primary = FocusRequester()
  val row = FocusRequester()
  val season = FocusRequester()
  val sourcesOpener = FocusRequester()
  val sourcesPanel = FocusRequester()
  val libraryOpener = FocusRequester()
  val libraryPanel = FocusRequester()
  val forgetPanel = FocusRequester()
  var actionRowFocused by mutableStateOf(false)
  var toLibraryFocused by mutableStateOf(false)
  var startOverFocused by mutableStateOf(false)
}

/** Everything the detail screen keeps besides its data, in one object so the screen holds a single
 *  local for it: the Forget flow, the series-download panel and the focused action's caption. */
private class DetailUiState {
  val forget = ForgetState()
  val series = SeriesDownloadState()
  val caption = ActionCaption()
}

/** One remote library's matched versions of the open title or episode, and whether it failed. */
data class RemoteMatch(
  val libraryId: String,
  val provider: String,
  val libraryName: String,
  val streams: List<StreamDto> = emptyList(),
  val failed: Boolean = false,
) {
  val label: String get() = listOf(provider, libraryName).filter { it.isNotBlank() }.joinToString(" · ")
  fun group(): Streams.RemoteGroup = Streams.RemoteGroup(libraryId, provider, libraryName, streams)
}

/** The remote source groups of one title or episode, in one object so the screen keeps a single
 *  local: the libraries it found, the groups that answered, whether discovery failed, how many
 *  are still owed and the request generation a late answer is checked against. */
private class RemoteSourcesState {
  var libraries by mutableStateOf<List<RemoteLibraryDto>>(emptyList())
  var groups by mutableStateOf<List<RemoteMatch>>(emptyList())
  var discoveryFailed by mutableStateOf(false)
  var pending by mutableIntStateOf(0)
  var request by mutableIntStateOf(0)
  /** The title or episode the groups belong to, so a retry of the same one can keep them. */
  var key: String? = null
}

/** The local remote-state row and the identity/generation it was read for. */
private class RemoteProgressState {
  var key: List<String>? by mutableStateOf<List<String>?>(null)
  var row: RemoteItemStateDto? by mutableStateOf<RemoteItemStateDto?>(null)
  var request by mutableIntStateOf(0)
}

/** The sources list, the pick made from it and its Sources panel, plus the episode pick that
 *  selects them, in one object so the screen keeps a single local for all of them: this composable
 *  sits close to the limit ART can verify, and every delegate here used to cost a register. */
private class SourcePickState {
  var streams by mutableStateOf<List<StreamDto>>(emptyList())
  var localStreams by mutableStateOf<List<StreamDto>>(emptyList())
  var localLoading by mutableStateOf(false)
  var localProgress by mutableStateOf<ProgressDto?>(null)
  var localRequest by mutableIntStateOf(0)
  var pendingSources by mutableIntStateOf(0)
  var sourcesLoaded by mutableStateOf(false)
  var sourcesFailed by mutableStateOf(false)
  var sourcesRetry by mutableIntStateOf(0)
  var selectedVideo by mutableStateOf<VideoDto?>(null)
  var season by mutableStateOf<Int?>(null)
  var selectedStream by mutableStateOf<StreamDto?>(null)
  var pickedStream by mutableStateOf(false)
  var chosenInPanel by mutableStateOf(false)
  var sourcesOpen by mutableStateOf(false)
  var sourcesWasOpen by mutableStateOf(false)
  var closeToPlay by mutableStateOf(false)
}

/** The save-to-library flow a pick feeds: the libraries, the panel that chooses one, the stream a
 *  queued job belongs to and the single queue slot, in one object for the same reason as above. */
private class LibrarySaveState {
  var libraries by mutableStateOf<List<LibraryDto>>(emptyList())
  var librariesLoaded by mutableStateOf(false)
  var libraryPanelOpen by mutableStateOf(false)
  var pendingLibraryStream by mutableStateOf<StreamDto?>(null)
  var libraryWasOpen by mutableStateOf(false)
  var queuedSourceId by mutableStateOf<String?>(null)
  var queueBusy by mutableStateOf(false)
}

/** The group a stream belongs to, for the caption: the library for a local copy, `provider ·
 *  library` for a remote version, the addon otherwise. */
internal fun sourceGroupName(stream: StreamDto): String? = when {
  Streams.isLocalStream(stream) -> stream.libraryName
  Streams.isRemoteStream(stream) ->
    listOfNotNull(stream.provider, stream.libraryName).filter { it.isNotBlank() }.joinToString(" · ")
  else -> stream.addonName
}.takeIf { !it.isNullOrBlank() }

/** The stored position behind what Play would play, with the one key Mark as unwatched clears. */
internal class PlayProgress(val position: Double, val duration: Double, val key: String)

/**
 * One action of the catalogue's own row. Built here rather than inline in the screen's body: that
 * composable sits at the limit of the registers Android's verifier allows.
 */
private fun catalogAction(
  tag: String,
  label: String,
  icon: ImageVector? = null,
  glyph: String = "",
  enabled: Boolean = true,
  modifier: Modifier = Modifier,
  onClick: () -> Unit,
): DetailAction = DetailAction(
  label = label,
  icon = icon,
  onClick = onClick,
  tag = tag,
  enabled = enabled,
  glyph = glyph,
  modifier = modifier,
)

/**
 * The stored position of the row Play would play, with the key it is stored under: a copy on disk
 * its own key, a media-server version the title's catalogue key, every other row that key too. Null
 * when the position the detail read belongs to another row -- another version, another episode --
 * or to nothing at all, so the watched bar, Start over and Mark as unwatched all agree.
 *
 * A function rather than a local: this screen is one composable close to the limit of the registers
 * Android's verifier allows.
 */
internal fun playProgress(
  local: StreamDto?,
  localProgress: ProgressDto?,
  remoteItem: RemoteItemContext?,
  remoteRow: RemoteItemStateDto?,
  seriesEpisodeMatches: Boolean,
  cataloguePosition: Double,
  catalogueDuration: Double,
  catalogueKey: String,
): PlayProgress? = when {
  local != null -> local.localPath?.takeIf { it.isNotBlank() }?.let { path ->
    localProgress?.takeIf { it.position > 0.0 }
      ?.let { PlayProgress(it.position, it.duration, Progress.libraryKey(path)) }
  }
  // Only the version that stored the position owns it, and never an item marked watched.
  remoteItem != null -> remoteRow
    ?.takeIf { !it.watched && it.mediaSourceId != null && it.mediaSourceId == remoteItem.mediaSourceId }
    ?.takeIf { it.position > 0.0 }
    ?.let { PlayProgress(it.position, it.duration, catalogueKey) }
  seriesEpisodeMatches -> cataloguePosition.takeIf { it > 0.0 }
    ?.let { PlayProgress(it, catalogueDuration, catalogueKey) }
  else -> null
}

/** The library folder Show in library opens: the active row's own when that row is a copy on disk,
 *  else the first copy the list holds. Null when the list holds no copy on disk at all. */
internal fun showInLibraryFolder(active: StreamDto?, rows: List<StreamDto>): String? {
  val copies = rows.filter { Streams.isLocalStream(it) && it.localPath != null }
  val chosen = active?.takeIf { Streams.isLocalStream(it) && it.localPath != null } ?: copies.firstOrNull()
  return chosen?.localPath?.substringBeforeLast('/', "")
}

/** The remote failure line: which libraries could not be reached, else a plain failure. */
@Composable
internal fun remoteNotice(failed: Boolean, labels: List<String>): String? = when {
  !failed -> null
  labels.isEmpty() -> stringResource(R.string.media_server_error)
  else -> stringResource(R.string.media_server_group_failed, labels.joinToString(", "))
}

/** The failure text for the panel's own block when only the remote groups failed. */
@Composable
internal fun remoteFailureText(labels: List<String>): String =
  if (labels.isEmpty()) stringResource(R.string.media_server_error)
  else stringResource(R.string.media_server_group_failed, labels.joinToString(", "))
