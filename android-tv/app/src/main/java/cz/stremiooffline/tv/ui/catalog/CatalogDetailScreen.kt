package cz.stremiooffline.tv.ui.catalog

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
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
import cz.stremiooffline.tv.data.SettingsResponse
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.data.VideoDto
import cz.stremiooffline.tv.playback.Progress
import cz.stremiooffline.tv.ui.components.CardRowInset
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.components.TvSpinner
import cz.stremiooffline.tv.ui.components.WideCard
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

const val TagCatalogPrimary = "catalog_primary"
const val TagCatalogStartOver = "catalog_start_over"
const val TagCatalogFavourite = "catalog_favourite"
const val TagCatalogToLibrary = "catalog_to_library"
const val TagCatalogSources = "catalog_sources"
const val TagCatalogMessage = "catalog_message"
const val TagCatalogEpisode = "catalog_episode"
const val TagCatalogChosenSource = "catalog_chosen_source"
const val TagCatalogLibraryPanel = "catalog_library_panel"
const val TagCatalogShowInLibrary = "catalog_show_in_library"
const val TagCatalogForget = "catalog_forget"
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

fun seasonChipTag(season: Int): String = "season_chip_$season"
fun episodeCardTag(video: VideoDto): String = "episode_card_${video.id ?: video.label}"

/** The Sources panel's rows as the catalogue gathered them, and whether the addons still owe one. */
data class OfferedSources(val streams: List<StreamDto> = emptyList(), val loading: Boolean = false)

/** The catalogue title detail: the library's layout for a movie or a series, with sources. */
@Composable
fun CatalogDetailScreen(
  api: TvApi,
  args: CatalogDetailArgs,
  imageUrl: (String?) -> String?,
  onPlay: (PlayTarget) -> Unit,
  onBack: () -> Unit,
  restoreToken: Int = 0,
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
  var streams by remember { mutableStateOf<List<StreamDto>>(emptyList()) }
  var localStreams by remember { mutableStateOf<List<StreamDto>>(emptyList()) }
  var localLoading by remember { mutableStateOf(false) }
  // Bumped per source generation, so a late local answer that belongs to a dropped request is
  // discarded even if its coroutine cancellation has not run yet.
  var localRequest by remember { mutableIntStateOf(0) }
  var localProgress by remember { mutableStateOf<ProgressDto?>(null) }
  var pendingSources by remember { mutableIntStateOf(0) }
  var sourcesLoaded by remember { mutableStateOf(false) }
  var sourcesFailed by remember { mutableStateOf(false) }
  var sourcesRetry by remember { mutableIntStateOf(0) }
  var selectedVideo by remember { mutableStateOf<VideoDto?>(null) }
  var season by remember { mutableStateOf<Int?>(null) }
  var selectedStream by remember { mutableStateOf<StreamDto?>(null) }
  var pickedStream by remember { mutableStateOf(false) }
  // The source filters are not saved: they live while a title or episode is on screen and reset
  // when either changes. A null sort follows the account's `streamSort`.
  val sourceFilters = remember { SourceFilterState() }
  // The caption under the buttons names a source only once the viewer chose one in the panel;
  // pressing Play, Start over or To library does not turn it on.
  var chosenInPanel by remember { mutableStateOf(false) }
  var sourcesOpen by remember { mutableStateOf(false) }
  var actionRowFocused by remember { mutableStateOf(false) }
  var toLibraryFocused by remember { mutableStateOf(false) }
  var startOverFocused by remember { mutableStateOf(false) }
  var closeToPlay by remember { mutableStateOf(false) }
  var favourite by remember { mutableStateOf(false) }
  var favouriteBusy by remember { mutableStateOf(false) }
  var queuedSourceId by remember { mutableStateOf<String?>(null) }
  var message by remember { mutableStateOf<String?>(null) }
  var noticeKind by remember { mutableStateOf(CatalogNotice.Neutral) }
  // One queue request per press burst: the second OK of a burst while the first is still in the
  // air must not post the same job again.
  var queueBusy by remember { mutableStateOf(false) }
  var libraries by remember { mutableStateOf<List<LibraryDto>>(emptyList()) }
  // False when the server could not answer /api/libraries at all: the TV then queues the way it
  // did before the field existed instead of inventing a refusal.
  var librariesLoaded by remember { mutableStateOf(false) }
  var libraryPanelOpen by remember { mutableStateOf(false) }
  var pendingLibraryStream by remember { mutableStateOf<StreamDto?>(null) }
  val forget = remember { ForgetState() }
  val seriesDownload = remember { SeriesDownloadState() }

  val context = LocalContext.current
  val queuedText = stringResource(R.string.save_queued)
  val waitingText = stringResource(R.string.downloads_waiting_debrid)
  val notAllowedText = stringResource(R.string.err_download_library_not_allowed)
  val noLibraryText = stringResource(R.string.tv_no_library_to_save)
  val torrentText = stringResource(R.string.err_torrent_not_playable)
  val noSourcesText = stringResource(R.string.sources_none)
  val loadErrorText = stringResource(R.string.tv_load_error)
  val toLibraryText = stringResource(R.string.save_to_library)
  val findingSourcesText = stringResource(R.string.tv_finding_sources)
  val playWhenReadyText = stringResource(R.string.tv_play_when_ready)

  /** The one place the message line is set, so its kind -- which is what picks the colour --
   *  travels with the text instead of being read back off the drawn string. */
  fun notice(text: String?, kind: CatalogNotice = CatalogNotice.Neutral) {
    message = text
    noticeKind = if (text == null) CatalogNotice.Neutral else kind
  }

  val primaryFocus = remember { FocusRequester() }
  val rowFocus = remember { FocusRequester() }
  val seasonFocus = remember { FocusRequester() }
  val sourcesOpenerFocus = remember { FocusRequester() }
  val sourcesPanelFocus = remember { FocusRequester() }
  val libraryOpenerFocus = remember { FocusRequester() }
  val libraryPanelFocus = remember { FocusRequester() }
  val forgetPanelFocus = remember { FocusRequester() }

  val streamType = meta.type ?: args.type
  val isSeries = streamType == "series"
  // The libraries this account may save this kind of title to. A server too old to answer
  // /api/libraries leaves the list empty and the TV keeps the addon's own destination.
  val libraryCandidates = remember(libraries, streamType) {
    libraries.filter { it.canWrite && (it.type == streamType || it.type == "mixed") }
  }
  // Streams belong to a video; a series asks for nothing until an episode is chosen.
  val streamVideoId = if (isSeries) selectedVideo?.id else meta.id
  val streamsKey = streamVideoId?.let { "$streamType:$it" }

  // The title's own requests do not depend on each other, so they all leave at once; only the
  // metadata waits for the settings it takes its language from.
  LaunchedEffect(args.meta.id) {
    queuedSourceId = null
    notice(null)
    libraryPanelOpen = false
    seriesDownload.open = false
    pendingLibraryStream = null
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
      librariesJob.await()?.let { libraries = it; librariesLoaded = true }
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
        selectedVideo = watched ?: nextRelevantEpisode(videos, Resume.resumeVideo(videos, storedEpisode)) ?: firstReleased(videos)
        season = wanted?.season ?: defaultSeason(videos)
      }
    }
  }

  // Each source addon is asked on its own so the first answer is usable without waiting for the
  // slowest, and a change of video clears the list at once so nothing plays a stale source.
  LaunchedEffect(streamsKey, sourcesRetry) {
    val request = ++localRequest
    streams = emptyList()
    localStreams = emptyList()
    localLoading = false
    selectedStream = null
    pickedStream = false
    chosenInPanel = false
    pendingSources = 0
    sourcesLoaded = false
    sourcesFailed = false
    queuedSourceId = null
    notice(null)
    val id = streamVideoId
    if (id == null) {
      sourcesLoaded = true
      return@LaunchedEffect
    }
    coroutineScope {
      // The local lookup is its own child coroutine, started before the addons are asked, so a
      // failed addon discovery neither cancels it nor skips it.
      launch {
        localLoading = true
        val found = try {
          api.localStreams(streamType, id)
        } catch (cancelled: CancellationException) {
          throw cancelled
        } catch (error: ApiError) {
          emptyList()
        }
        // A cancelled (stale) effect must not write state; the next run resets it anyway.
        currentCoroutineContext().ensureActive()
        if (request == localRequest) {
          localStreams = found
          localLoading = false
        }
      }
      val sources = try {
        api.streamSources(streamType, id)
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (error: ApiError) {
        sourcesFailed = true
        sourcesLoaded = true
        return@coroutineScope
      }
      sourcesLoaded = true
      pendingSources = sources.size
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
              if (part.isNotEmpty()) streams = streams + part
              pendingSources -= 1
            }
          }
        }
      }
    }
  }

  LaunchedEffect(meta.id) { runCatching { primaryFocus.requestFocus() } }
  // The player covers this screen, so on return re-read the stored position to keep Resume honest.
  LaunchedEffect(restoreToken) {
    if (restoreToken == 0) return@LaunchedEffect
    runCatching { primaryFocus.requestFocus() }
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
  val lists = remember(streams, addons, settings, meta.language, filters) {
    Streams.sourceLists(
      streams = streams,
      addons = addons,
      filters = filters,
      preferredLanguage = settings.audioLanguage ?: "en",
      showTorrents = settings.realDebridConfigured,
      metaLanguage = meta.language,
    )
  }
  val offered = lists.offered
  val visible = lists.visible
  val notices = lists.notices
  val titleLanguage = lists.titleLanguage
  // Local copies sit above the addon streams in the list that is drawn and picked from; the
  // filters, counts and notices keep using the addon streams alone.
  val rows = remember(localStreams, visible) { Streams.catalogSourceList(localStreams, visible) }
  val preferredStream = Streams.pickDefaultStream(rows)
  val chosenStream = selectedStream?.takeIf { pickedStream && rows.contains(it) }
  val activeStream = chosenStream ?: selectedStream?.takeIf { rows.contains(it) } ?: preferredStream
  // Asking covers both "the addon list has not answered" and "some addon still owes a list".
  val sourcesAsking = !sourcesFailed && (!sourcesLoaded || pendingSources > 0)
  val anyAsking = sourcesAsking || localLoading
  // While no playable stream has arrived the primary action is a spinner, not a promise to play.
  val findingSources = activeStream?.playable != true && anyAsking
  val canQueueActive = activeStream != null && Streams.canQueue(activeStream, settings.realDebridConfigured)
  // The tick belongs to the source that was actually queued, and only while it is still the pick.
  val queued = queuedSourceId != null && activeStream?.sourceId == queuedSourceId
  // A local pick can always be played, and keeps the "no sources" note away: a local copy is a
  // source even before the addons answered.
  val localActive = activeStream != null && Streams.isLocalStream(activeStream)
  // Nothing visible to play: either no addon offers a source, or only a torrent it cannot open.
  val emptyText = if (offered.isEmpty()) noSourcesText else torrentText
  // The empty state is a note; a list holding only torrents is a failure.
  val emptyKind = if (offered.isEmpty()) CatalogNotice.Neutral else CatalogNotice.Failure

  // A later addon may outrank the one already picked, but only while the viewer has not chosen.
  LaunchedEffect(rows, anyAsking) {
    val next = Streams.repickStream(
      playing = false,
      picked = pickedStream,
      pending = if (anyAsking) maxOf(pendingSources, 1) else 0,
      visible = rows,
      selected = selectedStream,
      preferred = preferredStream,
      upgrade = preferredStream?.let(Streams::isLocalStream) == true && selectedStream?.let(Streams::isLocalStream) != true,
    )
    if (next.move) selectedStream = next.to
  }

  // The player's own Sources panel gets the same list, and it keeps growing while the addons answer.
  LaunchedEffect(rows, anyAsking) { onSources(OfferedSources(visible, anyAsking)) }

  // A switch made inside the player has to carry back: the detail keeps naming the source the
  // viewer actually watched, and Play offers it again.
  LaunchedEffect(playedSourceId, rows) {
    val id = playedSourceId ?: return@LaunchedEffect
    val stream = rows.firstOrNull { it.sourceId == id } ?: return@LaunchedEffect
    selectedStream = stream
    pickedStream = true
    chosenInPanel = true
  }

  val resumeEntry = if (isSeries) seriesEntry(entries, meta.id) else null
  val resumeEpisode = if (isSeries) Resume.resumeVideo(meta.videos.orEmpty(), resumeEntry?.let { Resume.resumeTarget(it).episode }) else null
  val storedPosition = if (isSeries) resumeEntry?.position ?: 0.0 else movieProgress?.position ?: 0.0
  val storedDuration = if (isSeries) resumeEntry?.duration ?: 0.0 else movieProgress?.duration ?: 0.0
  val progressPosition = if (localActive) localProgress?.position ?: 0.0 else storedPosition
  val progressDuration = if (localActive) localProgress?.duration ?: 0.0 else storedDuration
  // The local file has its own progress key, so a catalogue row has no bearing on its resume.
  val resuming = if (localActive) {
    localProgress?.let { Progress.resumePosition(it.position, it.duration) != null } == true
  } else {
    Progress.resumePosition(storedPosition, storedDuration) != null &&
      (selectedVideo == null || selectedVideo?.id == resumeEpisode?.id)
  }
  // Every stored key this title stands for: the card's own keys when it came from Continue
  // watching, the local file's own key for a local pick, a show's stored episode otherwise.
  val forgetKeys: List<String> = when {
    args.forgetKeys.isNotEmpty() && !forget.done -> args.forgetKeys
    localActive && localProgress?.let { it.position > 0 } == true ->
      activeStream?.localPath?.let { listOf(Progress.libraryKey(it)) }.orEmpty()
    isSeries -> entries.filter {
      it.series?.id == meta.id || (it.key.startsWith("series:") && Resume.resumeTarget(it).meta.id == meta.id)
    }.map { it.key }
    movieProgress?.let { it.position > 0 } == true -> listOf(ProgressKey.of(streamType, meta.id))
    else -> emptyList()
  }

  // A local pick resumes from the file's own progress, read when it becomes the active row.
  LaunchedEffect(activeStream?.localPath, restoreToken) {
    val path = activeStream?.takeIf(Streams::isLocalStream)?.localPath
    localProgress = if (path == null) null else runCatching { api.progress(Progress.libraryKey(path)) }.getOrNull()
  }

  val baseTitle = localizedTitle(args.meta, meta, settings.uiLanguage)
  val playerTitle = if (selectedVideo != null) "$baseTitle · ${selectedVideo!!.label}" else baseTitle
  val progressKey = ProgressKey.of(streamType, meta.id, selectedVideo?.id)

  fun closeSources() {
    if (!sourcesOpen) return
    sourcesOpen = false
  }

  var sourcesWasOpen by remember { mutableStateOf(false) }
  // The opener gets the remote back on the frame the panel and its focus trap are gone; a picked
  // source sends it to Play instead, so the action row is where the viewer carries on.
  LaunchedEffect(sourcesOpen) {
    if (sourcesOpen) {
      sourcesWasOpen = true
    } else if (sourcesWasOpen) {
      sourcesWasOpen = false
      if (closeToPlay) {
        closeToPlay = false
        runCatching { primaryFocus.requestFocus() }
      } else {
        runCatching { sourcesOpenerFocus.requestFocus() }
      }
    }
  }

  var libraryWasOpen by remember { mutableStateOf(false) }
  // Back on the library panel hands the remote back to the To library button that opened it.
  LaunchedEffect(libraryPanelOpen) {
    if (libraryPanelOpen) {
      libraryWasOpen = true
    } else if (libraryWasOpen) {
      libraryWasOpen = false
      runCatching { libraryOpenerFocus.requestFocus() }
    }
  }

  // Closing the bulk panel, whether it queued or the viewer backed out, returns the remote to
  // the button that opened it.
  LaunchedEffect(seriesDownload.open) {
    if (seriesDownload.open) {
      seriesDownload.wasOpen = true
    } else if (seriesDownload.wasOpen) {
      seriesDownload.wasOpen = false
      runCatching { seriesDownload.focus.requestFocus() }
    }
  }

  fun play(stream: StreamDto) {
    pickedStream = true
    selectedStream = stream
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
          poster = args.meta.poster ?: meta.poster,
        ),
      )
    } else {
      onPlay(
        PlayTarget(
          key = progressKey,
          title = playerTitle,
          resume = resuming,
          sourceId = stream.sourceId,
          poster = args.meta.poster ?: meta.poster,
          addonKey = args.addonKey,
          subtitleType = streamType,
          subtitleTarget = streamVideoId,
        ),
      )
    }
  }

  /** Queues one source into [libraryId], or with no target when the server never told us which
   *  libraries this account may use. */
  fun queueTo(stream: StreamDto, libraryId: String?) {
    val media = mediaFor(meta, args, selectedVideo, settings)
    val title = playerTitle
    queueBusy = true
    scope.launch {
      try {
        val job = api.download(title, stream.sourceId, media, libraryId?.let(::DownloadTargetDto))
        queuedSourceId = stream.sourceId
        notice(if (job.status == "waiting") waitingText else queuedText, CatalogNotice.Success)
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (error: ApiError) {
        // A refusal carries the server's own explanation; the catalogue line is the fallback.
        notice(error.serverMessage ?: notAllowedText.takeIf { error.failure == ApiFailure.Forbidden }, CatalogNotice.Failure)
      } finally {
        queueBusy = false
      }
    }
  }

  fun queue(stream: StreamDto) {
    if (queueBusy) return
    selectedStream = stream
    pickedStream = true
    notice(null)
    if (!Streams.canQueue(stream, settings.realDebridConfigured)) {
      notice(torrentText, CatalogNotice.Failure)
      return
    }
    when {
      // The server that could not answer keeps the old behaviour: queue and let it pick.
      !librariesLoaded -> queueTo(stream, null)
      libraryCandidates.isEmpty() -> notice(noLibraryText, CatalogNotice.Failure)
      libraryCandidates.size == 1 -> queueTo(stream, libraryCandidates.first().id)
      // More than one usable library: let the viewer choose, the addon's own default preselected.
      else -> {
        pendingLibraryStream = stream
        libraryPanelOpen = true
      }
    }
  }

  /** OK in the panel picks a row; Play or To library in the action row then acts on it. */
  fun chooseSource(stream: StreamDto) {
    selectedStream = stream
    pickedStream = true
    chosenInPanel = true
    notice(null)
    closeToPlay = true
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
    } else if (localStreams.isEmpty()) {
      notice(if (offered.isEmpty()) noSourcesText else torrentText, CatalogNotice.Failure)
    }
  }

  fun playPressed() {
    val stream = activeStream
    when {
      pendingPlay -> cancelPendingPlay()
      // A local copy needs no addon and no discovery, so a failed addon lookup must not block it.
      localActive && stream?.localPath != null -> play(stream)
      sourcesFailed -> notice(loadErrorText, CatalogNotice.Failure)
      // Once a row is chosen, Play acts on that row alone: a playable pick plays, an unplayable
      // one says why, and the wait for another addon never overrides the pick.
      pickedStream -> when {
        stream?.playable == true -> play(stream)
        stream != null -> notice(torrentText, CatalogNotice.Failure)
        else -> notice(emptyText, emptyKind)
      }
      stream?.playable == true -> play(stream)
      findingSources -> armPendingPlay()
      // A chosen stream that cannot be played is what the torrent message is for; queuing it is
      // the To library button's job.
      stream != null -> if (localStreams.isEmpty()) notice(torrentText, CatalogNotice.Failure)
      else -> if (localStreams.isEmpty()) notice(emptyText, emptyKind)
    }
  }

  fun startOverPressed() {
    notice(null)
    val stream = activeStream
    val path = stream?.localPath
    when {
      stream != null && Streams.isLocalStream(stream) && path != null -> {
        pickedStream = true
        selectedStream = stream
        onPlay(
          PlayTarget(
            key = Progress.libraryKey(path),
            title = playerTitle,
            resume = false,
            path = path,
            sourceId = null,
            poster = args.meta.poster ?: meta.poster,
          ),
        )
      }
      sourcesFailed -> notice(loadErrorText, CatalogNotice.Failure)
      stream?.playable == true -> {
        pickedStream = true
        selectedStream = stream
        onPlay(
          PlayTarget(
            progressKey,
            playerTitle,
            resume = false,
            sourceId = stream.sourceId,
            poster = args.meta.poster ?: meta.poster,
            addonKey = args.addonKey,
            subtitleType = streamType,
            subtitleTarget = streamVideoId,
          ),
        )
      }
      pickedStream -> notice(if (stream != null) torrentText else emptyText, if (stream != null) CatalogNotice.Failure else emptyKind)
      anyAsking -> Unit
      else -> if (localStreams.isEmpty()) notice(emptyText, emptyKind)
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
    if (forget.busy || forgetKeys.isEmpty()) return
    forget.busy = true
    forget.panelOpen = false
    scope.launch {
      try {
        api.forgetProgress(forgetKeys)
        forget.done = true
        if (isSeries) {
          entries = runCatching { api.progressList() }.getOrDefault(entries)
        } else {
          movieProgress = runCatching { api.progress(ProgressKey.of(streamType, meta.id)) }.getOrNull()
        }
        runCatching { primaryFocus.requestFocus() }
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: ApiError) {
      } finally {
        forget.busy = false
      }
    }
  }

  /** Selecting an episode drops the list, the queued state and any message at once. */
  fun selectVideo(video: VideoDto) {
    if (video.id == selectedVideo?.id) return
    cancelPendingPlay()
    selectedVideo = video
    selectedStream = null
    pickedStream = false
    chosenInPanel = false
    // A new episode starts from the account's own sort and an unfiltered list.
    sourceFilters.reset()
    streams = emptyList()
    localStreams = emptyList()
    localLoading = false
    pendingSources = 0
    sourcesLoaded = false
    sourcesFailed = false
    queuedSourceId = null
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
  val toLibraryWasFocused = toLibraryFocused
  val startOverWasFocused = startOverFocused
  LaunchedEffect(canQueueActive) {
    if (!canQueueActive && toLibraryWasFocused) {
      toLibraryFocused = false
      runCatching { primaryFocus.requestFocus() }
    }
  }
  // A queue request in the air disables the button, so the remote it was holding goes back to Play
  // instead of being left on nothing.
  LaunchedEffect(queueBusy) {
    if (queueBusy && toLibraryWasFocused) {
      toLibraryFocused = false
      runCatching { primaryFocus.requestFocus() }
    }
  }
  LaunchedEffect(resuming) {
    if (!resuming && startOverWasFocused) {
      startOverFocused = false
      runCatching { primaryFocus.requestFocus() }
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
          isSeries && !sourcesOpen && !seriesDownload.open && actionRowFocused
        ) {
          runCatching { rowFocus.requestFocus() }.isSuccess
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
      val selectedEpisodeLine = if (isSeries) selectedVideo?.let { episodeLine(it) } else null
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
      if (resuming && progressDuration > 0) {
        val fraction = (progressPosition / progressDuration).toFloat()
        Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
          Box(Modifier.width(140.dp).height(5.dp).clip(RoundedCornerShape(999.dp)).background(Tokens.Line)) {
            Box(Modifier.fillMaxHeight().fillMaxWidth(fraction.coerceIn(0f, 1f)).background(Tokens.Accent))
          }
          Text(stringResource(R.string.tv_detail_watched, (fraction * 100).toInt().toString()), color = Tokens.Muted, fontSize = 10.sp)
        }
      }
      Spacer(Modifier.height(3.dp))
      Row(
        modifier = Modifier.onFocusChanged { actionRowFocused = it.hasFocus },
        horizontalArrangement = Arrangement.spacedBy(11.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        FocusButton(
          text = when {
            pendingPlay -> playWhenReadyText
            findingSources -> findingSourcesText
            resuming -> stringResource(R.string.tv_resume)
            else -> stringResource(R.string.player_play)
          },
          onClick = { playPressed() },
          kind = FocusButtonKind.Primary,
          leading = if (pendingPlay || findingSources) ({ TvSpinner() }) else null,
          modifier = Modifier.focusRequester(primaryFocus).testTag(TagCatalogPrimary),
        )
        if (resuming) {
          FocusButton(
            text = stringResource(R.string.tv_start_over),
            onClick = { startOverPressed() },
            modifier = Modifier
              .testTag(TagCatalogStartOver)
              .onFocusChanged { startOverFocused = it.isFocused },
          )
        }
        if (forgetKeys.isNotEmpty()) {
          FocusButton(
            text = stringResource(R.string.tv_forget_progress),
            onClick = { forget.panelOpen = true },
            enabled = !forget.busy,
            modifier = Modifier.testTag(TagCatalogForget),
          )
        }
        FocusButton(
          text = if (favourite) "★" else "☆",
          onClick = { toggleFavourite() },
          kind = FocusButtonKind.Icon,
          contentDescription = stringResource(if (favourite) R.string.favorite_remove else R.string.favorite_add),
          modifier = Modifier.testTag(TagCatalogFavourite),
        )
        if (canQueueActive) {
          FocusButton(
            text = if (queued) "✓ $queuedText" else toLibraryText,
            onClick = { activeStream?.let { queue(it) } },
            enabled = !queueBusy,
            modifier = Modifier
              .testTag(TagCatalogToLibrary)
              .focusRequester(libraryOpenerFocus)
              .onFocusChanged { toLibraryFocused = it.isFocused },
          )
        }
        // The web's bulk download, for the whole batch at once: it needs no source of its own,
        // so it sits beside To library for any series with an episode selected.
        if (isSeries && selectedVideo != null && !meta.videos.isNullOrEmpty()) {
          FocusButton(
            text = stringResource(R.string.bulk_title),
            onClick = {
              cancelPendingPlay()
              seriesDownload.open = true
            },
            modifier = Modifier
              .testTag(TagCatalogSeriesDownload)
              .focusRequester(seriesDownload.focus),
          )
        }
        FocusButton(
          text = stringResource(R.string.tv_sources_count, rows.size.toString()),
          onClick = {
            cancelPendingPlay()
            sourcesOpen = true
          },
          leading = if (anyAsking) ({ TvSpinner() }) else null,
          modifier = Modifier.focusRequester(sourcesOpenerFocus).testTag(TagCatalogSources),
        )
        // To library is hidden for a local pick (it is already on disk); Show in library opens
        // the file's folder instead.
        if (localActive) {
          FocusButton(
            text = stringResource(R.string.library_show_in_library),
            onClick = { activeStream?.localPath?.let { onShowInLibrary(it.substringBeforeLast('/', "")) } },
            modifier = Modifier
              .testTag(TagCatalogShowInLibrary)
              .focusRequester(libraryOpenerFocus)
              .onFocusChanged { toLibraryFocused = it.isFocused },
          )
        }
      }
      if (chosenInPanel) {
        activeStream?.let { stream ->
          val local = Streams.isLocalStream(stream)
          val label = if (local) stream.behaviorHints?.filename ?: streamLabel(stream) else streamLabel(stream)
          val caption = listOfNotNull(
            (if (local) stream.libraryName else stream.addonName)?.takeIf { it.isNotBlank() },
            label.takeIf { it.isNotBlank() },
            formatSize(Streams.streamSize(stream)),
          ).joinToString(" · ")
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
          season = season,
          onSeason = { season = it },
          resumeEpisode = resumeEpisode,
          focusVideo = nextRelevantEpisode(videos, resumeEpisode),
          seriesPosition = storedPosition,
          seriesDuration = storedDuration,
          imageUrl = imageUrl,
          onSelect = { video ->
            selectVideo(video)
            scope.launch {
              awaitFrame()
              runCatching { primaryFocus.requestFocus() }
            }
          },
          focusRequester = rowFocus,
          seasonFocus = seasonFocus,
        )
      }
    }

    if (sourcesOpen) {
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
        failed = sourcesFailed,
        notices = notices,
        emptyText = emptyText,
        failureText = loadErrorText,
        onRetry = { sourcesRetry++ },
        retryTag = TagCatalogRetry,
        filters = if (offered.size > 1) chips else emptyList(),
        onFilterSelect = { chip, key ->
          sourceFilters.select(chip, key)
        },
        countText = if (offered.size > 1) {
          stringResource(R.string.sources_of_total, rows.size, offered.size + localStreams.size)
        } else {
          null
        },
        initialFocus = sourcesPanelFocus,
      )
    }

    if (libraryPanelOpen) {
      // The preselection follows the web's `ruleTarget`: the addon's own rule first, then the
      // library the account flagged as its default for this kind, then the first usable one.
      val addonDefault = addons.firstOrNull { it.key == pendingLibraryStream?.addonKey }?.defaultLibraryId(streamType)
      val flaggedDefault = libraryCandidates.firstOrNull { if (streamType == "series") it.defaultSeries else it.defaultMovie }?.id
      val preferredLibraryId = addonDefault?.takeIf { id -> libraryCandidates.any { it.id == id } }
        ?: flaggedDefault
        ?: libraryCandidates.firstOrNull()?.id
      val focusIndex = libraryCandidates.indexOfFirst { it.id == preferredLibraryId }.let { if (it >= 0) it else 0 }
      SidePanel(
        title = stringResource(R.string.save_to_library),
        onClose = { libraryPanelOpen = false },
        modifier = Modifier.testTag(TagCatalogLibraryPanel),
        initialFocus = libraryPanelFocus,
      ) {
        libraryCandidates.forEachIndexed { index, library ->
          PanelOption(
            text = library.name,
            selected = library.id == preferredLibraryId,
            onClick = {
              val stream = pendingLibraryStream
              libraryPanelOpen = false
              stream?.let { queueTo(it, library.id) }
            },
            modifier = Modifier
              .testTag(libraryOptionTag(library.id))
              .then(if (index == focusIndex) Modifier.focusRequester(libraryPanelFocus) else Modifier),
          )
        }
      }
    }

    if (forget.panelOpen) {
      SidePanel(
        title = stringResource(R.string.tv_forget_title),
        onClose = { forget.panelOpen = false },
        modifier = Modifier.testTag(TagCatalogForgetPanel),
        initialFocus = forgetPanelFocus,
      ) {
        PanelOption(
          text = stringResource(R.string.common_cancel),
          onClick = { forget.panelOpen = false },
          modifier = Modifier.testTag(TagCatalogForgetCancel).focusRequester(forgetPanelFocus),
        )
        PanelOption(
          text = stringResource(R.string.tv_forget_remove),
          onClick = { forgetNow() },
          modifier = Modifier.testTag(TagCatalogForgetRemove),
        )
      }
    }

    if (seriesDownload.open) {
      // The batch carries the title and its artwork, and the addon's own destination unless the
      // viewer picks another library inside the panel.
      SeriesDownloadPanel(
        api = api,
        type = streamType,
        title = baseTitle,
        videos = meta.videos.orEmpty(),
        selected = selectedVideo,
        media = BulkMediaDto(
          id = meta.id,
          metaType = streamType,
          poster = args.meta.poster ?: meta.poster,
          background = args.meta.background ?: args.meta.poster ?: meta.background,
        ),
        settings = settings,
        addons = addons,
        libraries = libraries,
        onQueued = { added, skipped ->
          seriesDownload.open = false
          val addedText = context.resources.getQuantityString(R.plurals.episodes_bulk_added, added, added)
          val skippedText = if (skipped > 0) {
            " " + context.resources.getQuantityString(R.plurals.episodes_bulk_skipped, skipped, skipped)
          } else {
            ""
          }
          notice(addedText + skippedText, CatalogNotice.Success)
        },
        onClose = { seriesDownload.open = false },
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
