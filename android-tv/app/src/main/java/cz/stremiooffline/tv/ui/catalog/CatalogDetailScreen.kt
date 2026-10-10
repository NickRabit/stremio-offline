package cz.stremiooffline.tv.ui.catalog

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Border
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Surface
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
import kotlinx.coroutines.delay
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
const val TagSourcesPanel = "catalog_sources_panel"
const val TagSourcesEmpty = "catalog_sources_empty"

/** One slow addon must not hold a play back longer once something playable has arrived. */
const val PLAY_WHEN_READY_TIMEOUT_MS = 8_000L

fun sourceRowTag(index: Int): String = "source_row_$index"
fun seasonChipTag(season: Int): String = "season_chip_$season"
fun episodeCardTag(video: VideoDto): String = "episode_card_${video.id ?: video.label}"

/** The catalogue title detail: the library's layout for a movie or a series, with sources. */
@Composable
fun CatalogDetailScreen(
  api: TvApi,
  args: CatalogDetailArgs,
  imageUrl: (String?) -> String?,
  onPlay: (PlayTarget) -> Unit,
  onBack: () -> Unit,
  restoreToken: Int = 0,
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
  var pendingSources by remember { mutableIntStateOf(0) }
  var sourcesLoaded by remember { mutableStateOf(false) }
  var sourcesFailed by remember { mutableStateOf(false) }
  var sourcesRetry by remember { mutableIntStateOf(0) }
  var selectedVideo by remember { mutableStateOf<VideoDto?>(null) }
  var season by remember { mutableStateOf<Int?>(null) }
  var selectedStream by remember { mutableStateOf<StreamDto?>(null) }
  var pickedStream by remember { mutableStateOf(false) }
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

  val queuedText = stringResource(R.string.save_queued)
  val waitingText = stringResource(R.string.downloads_waiting_debrid)
  val notAllowedText = stringResource(R.string.err_download_library_not_allowed)
  val torrentText = stringResource(R.string.err_torrent_not_playable)
  val noSourcesText = stringResource(R.string.sources_none)
  val loadErrorText = stringResource(R.string.tv_load_error)
  val tryAgainText = stringResource(R.string.tv_try_again)
  val defaultText = stringResource(R.string.tv_default)
  val toLibraryText = stringResource(R.string.save_to_library)
  val findingSourcesText = stringResource(R.string.tv_finding_sources)
  val playWhenReadyText = stringResource(R.string.tv_play_when_ready)

  val primaryFocus = remember { FocusRequester() }
  val rowFocus = remember { FocusRequester() }
  val seasonFocus = remember { FocusRequester() }
  val sourcesOpenerFocus = remember { FocusRequester() }
  val sourcesPanelFocus = remember { FocusRequester() }

  val streamType = meta.type ?: args.type
  val isSeries = streamType == "series"
  // Streams belong to a video; a series asks for nothing until an episode is chosen.
  val streamVideoId = if (isSeries) selectedVideo?.id else meta.id
  val streamsKey = streamVideoId?.let { "$streamType:$it" }

  // The title's own requests do not depend on each other, so they all leave at once; only the
  // metadata waits for the settings it takes its language from.
  LaunchedEffect(args.meta.id) {
    queuedSourceId = null
    message = null
    coroutineScope {
      val settingsJob = async { runCatching { api.settings() }.getOrDefault(SettingsResponse()) }
      val addonsJob = async { runCatching { api.addons() }.getOrDefault(emptyList()) }
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
    streams = emptyList()
    selectedStream = null
    pickedStream = false
    chosenInPanel = false
    pendingSources = 0
    sourcesLoaded = false
    sourcesFailed = false
    queuedSourceId = null
    message = null
    val id = streamVideoId
    if (id == null) {
      sourcesLoaded = true
      return@LaunchedEffect
    }
    val sources = try {
      api.streamSources(streamType, id)
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (error: ApiError) {
      sourcesFailed = true
      sourcesLoaded = true
      return@LaunchedEffect
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

  val offered = Streams.offeredStreams(streams)
  val priority = addons.mapIndexed { index, addon -> addon.manifest.name to index }.toMap()
  val titleLanguage = Languages.titleLanguage(meta.language)
  val visible = Streams.visibleCatalogStreams(
    offered,
    Streams.StreamFilters(sort = Streams.StreamSort.of(settings.streamSort)),
    settings.audioLanguage ?: "en",
    priority,
    settings.realDebridConfigured,
    titleLanguage,
  )
  val notices = Streams.addonNotices(streams)
  val preferredStream = Streams.pickDefaultStream(visible)
  val chosenStream = selectedStream?.takeIf { pickedStream && visible.contains(it) }
  val activeStream = chosenStream ?: selectedStream?.takeIf { visible.contains(it) } ?: preferredStream
  // Asking covers both "the addon list has not answered" and "some addon still owes a list".
  val sourcesAsking = !sourcesFailed && (!sourcesLoaded || pendingSources > 0)
  // While no playable stream has arrived the primary action is a spinner, not a promise to play.
  val findingSources = activeStream?.playable != true && sourcesAsking
  val canQueueActive = activeStream != null && Streams.canQueue(activeStream, settings.realDebridConfigured)
  // The tick belongs to the source that was actually queued, and only while it is still the pick.
  val queued = queuedSourceId != null && activeStream?.sourceId == queuedSourceId
  // Nothing visible to play: either no addon offers a source, or only a torrent it cannot open.
  val emptyText = if (offered.isEmpty()) noSourcesText else torrentText

  // A later addon may outrank the one already picked, but only while the viewer has not chosen.
  LaunchedEffect(visible, sourcesAsking) {
    val next = Streams.repickStream(
      playing = false,
      picked = pickedStream,
      pending = if (sourcesAsking) maxOf(pendingSources, 1) else 0,
      visible = visible,
      selected = selectedStream,
      preferred = preferredStream,
    )
    if (next.move) selectedStream = next.to
  }

  // The default row may only appear after the panel is already up (sources still arriving).
  LaunchedEffect(sourcesOpen, visible.isEmpty(), sourcesFailed) {
    if (!sourcesOpen) return@LaunchedEffect
    awaitFrame()
    runCatching { sourcesPanelFocus.requestFocus() }
  }

  val resumeEntry = if (isSeries) seriesEntry(entries, meta.id) else null
  val resumeEpisode = if (isSeries) Resume.resumeVideo(meta.videos.orEmpty(), resumeEntry?.let { Resume.resumeTarget(it).episode }) else null
  val storedPosition = if (isSeries) resumeEntry?.position ?: 0.0 else movieProgress?.position ?: 0.0
  val storedDuration = if (isSeries) resumeEntry?.duration ?: 0.0 else movieProgress?.duration ?: 0.0
  val resuming = Progress.resumePosition(storedPosition, storedDuration) != null &&
    (selectedVideo == null || selectedVideo?.id == resumeEpisode?.id)

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

  fun play(stream: StreamDto) {
    pickedStream = true
    selectedStream = stream
    closeSources()
    message = null
    onPlay(PlayTarget(key = progressKey, title = playerTitle, resume = resuming, sourceId = stream.sourceId))
  }

  fun queue(stream: StreamDto) {
    selectedStream = stream
    pickedStream = true
    message = null
    if (!Streams.canQueue(stream, settings.realDebridConfigured)) {
      message = torrentText
      return
    }
    val media = mediaFor(meta, args, selectedVideo, settings)
    val title = playerTitle
    scope.launch {
      try {
        val job = api.download(title, stream.sourceId, media)
        queuedSourceId = stream.sourceId
        message = if (job.status == "waiting") waitingText else queuedText
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (error: ApiError) {
        message = if (error.failure == ApiFailure.Forbidden) notAllowedText else null
      }
    }
  }

  /** OK in the panel picks a row; Play or To library in the action row then acts on it. */
  fun chooseSource(stream: StreamDto) {
    selectedStream = stream
    pickedStream = true
    chosenInPanel = true
    message = null
    closeToPlay = true
    closeSources()
  }

  /** OK while the sources are still coming; the wait ends when they all answer or the deadline passes. */
  fun armPendingPlay() {
    message = null
    playTimeoutReached = false
    pendingPlay = true
  }

  fun resolvePendingPlay() {
    cancelPendingPlay()
    val stream = preferredStream
    if (stream?.playable == true) play(stream) else message = if (offered.isEmpty()) noSourcesText else torrentText
  }

  fun playPressed() {
    val stream = activeStream
    when {
      pendingPlay -> cancelPendingPlay()
      sourcesFailed -> message = loadErrorText
      // Once a row is chosen, Play acts on that row alone: a playable pick plays, an unplayable
      // one says why, and the wait for another addon never overrides the pick.
      pickedStream -> when {
        stream?.playable == true -> play(stream)
        stream != null -> message = torrentText
        else -> message = emptyText
      }
      stream?.playable == true -> play(stream)
      findingSources -> armPendingPlay()
      // A chosen stream that cannot be played is what the torrent message is for; queuing it is
      // the To library button's job.
      stream != null -> message = torrentText
      else -> message = emptyText
    }
  }

  fun startOverPressed() {
    message = null
    val stream = activeStream
    when {
      sourcesFailed -> message = loadErrorText
      stream?.playable == true -> {
        pickedStream = true
        selectedStream = stream
        onPlay(PlayTarget(progressKey, playerTitle, resume = false, sourceId = stream.sourceId))
      }
      pickedStream -> message = if (stream != null) torrentText else emptyText
      sourcesAsking -> Unit
      else -> message = emptyText
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

  /** Selecting an episode drops the list, the queued state and any message at once. */
  fun selectVideo(video: VideoDto) {
    if (video.id == selectedVideo?.id) return
    cancelPendingPlay()
    selectedVideo = video
    selectedStream = null
    pickedStream = false
    chosenInPanel = false
    streams = emptyList()
    pendingSources = 0
    sourcesLoaded = false
    sourcesFailed = false
    queuedSourceId = null
    message = null
  }

  // The deadline starts when OK arms the wait, not when the first stream lands.
  LaunchedEffect(pendingPlay) {
    if (!pendingPlay) return@LaunchedEffect
    delay(PLAY_WHEN_READY_TIMEOUT_MS)
    playTimeoutReached = true
  }

  // Resolves the armed play once every addon answered, or at the deadline with something playable.
  LaunchedEffect(pendingPlay, sourcesAsking, preferredStream, playTimeoutReached) {
    if (!pendingPlay) return@LaunchedEffect
    val playable = preferredStream?.playable == true
    if (sourcesAsking && !(playTimeoutReached && playable)) return@LaunchedEffect
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
          isSeries && !sourcesOpen && actionRowFocused
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
        stringResource(
          if (isSeries) R.string.tv_detail_eyebrow_series else R.string.tv_detail_eyebrow_movie,
          args.addonName,
        ).uppercase(),
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
      if (resuming && storedDuration > 0) {
        val fraction = (storedPosition / storedDuration).toFloat()
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
            modifier = Modifier
              .testTag(TagCatalogToLibrary)
              .onFocusChanged { toLibraryFocused = it.isFocused },
          )
        }
        FocusButton(
          text = stringResource(R.string.tv_sources_count, visible.size.toString()),
          onClick = {
            cancelPendingPlay()
            sourcesOpen = true
          },
          leading = if (sourcesAsking) ({ TvSpinner() }) else null,
          modifier = Modifier.focusRequester(sourcesOpenerFocus).testTag(TagCatalogSources),
        )
      }
      if (chosenInPanel) {
        activeStream?.let { stream ->
          val caption = listOfNotNull(
            stream.addonName?.takeIf { it.isNotBlank() },
            streamLabel(stream).takeIf { it.isNotBlank() },
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
          // Red for a failure, muted for a neutral notice, green only for a successful queue.
          color = when (shown) {
            queuedText, waitingText -> Tokens.Green
            notAllowedText, torrentText, loadErrorText -> Tokens.Red
            else -> Tokens.Muted
          },
          fontSize = 11.sp,
          modifier = Modifier.testTag(TagCatalogMessage),
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
      val focusIndex = visible.indexOfFirst { it === (chosenStream ?: preferredStream) }.let { if (it >= 0) it else 0 }
      SidePanel(
        title = stringResource(R.string.sources_heading),
        onClose = { closeSources() },
        modifier = Modifier.testTag(TagSourcesPanel),
        initialFocus = sourcesPanelFocus,
      ) {
        when {
          sourcesFailed -> {
            Text(loadErrorText, color = Tokens.Red, fontSize = 12.sp, lineHeight = 17.sp)
            FocusButton(
              text = tryAgainText,
              onClick = { sourcesRetry++ },
              modifier = Modifier.focusRequester(sourcesPanelFocus).testTag(TagCatalogRetry),
            )
          }
          visible.isEmpty() -> {
            Text(if (sourcesAsking) findingSourcesText else emptyText, color = Tokens.Muted, fontSize = 12.sp, lineHeight = 17.sp)
            // Something has to hold the remote while the panel is up, even with no rows yet.
            Box(Modifier.focusRequester(sourcesPanelFocus).focusable().testTag(TagSourcesEmpty))
          }
          else -> visible.forEachIndexed { index, stream ->
            SourceRow(
              stream = stream,
              default = preferredStream === stream,
              chosen = chosenStream === stream,
              anyChosen = chosenStream != null,
              defaultText = defaultText,
              titleLanguage = titleLanguage,
              onClick = { chooseSource(stream) },
              modifier = Modifier
                .testTag(sourceRowTag(index))
                .then(if (index == focusIndex) Modifier.focusRequester(sourcesPanelFocus) else Modifier),
            )
          }
        }
        if (notices.isNotEmpty()) {
          Spacer(Modifier.height(4.dp))
          notices.forEach { notice -> Text(Streams.noticeText(notice), color = Tokens.Muted, fontSize = 10.5.sp, lineHeight = 15.sp) }
        }
      }
    }
  }
}

/** One offered stream: badge, addon, the stream's title and a size/language meta line. */
@Composable
private fun SourceRow(
  stream: StreamDto,
  default: Boolean,
  chosen: Boolean,
  anyChosen: Boolean,
  defaultText: String,
  titleLanguage: String?,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val shape = RoundedCornerShape(8.dp)
  val badge = Streams.streamBadge(stream)
  val badgeColour = when (badge) {
    "HTTP" -> Tokens.Green
    "RD" -> Tokens.Accent
    else -> Tokens.Muted
  }
  val meta = buildList {
    formatSize(Streams.streamSize(stream))?.let(::add)
    addAll(Streams.streamLanguages(stream, titleLanguage).map { Languages.label(it) })
  }
  Surface(
    onClick = onClick,
    modifier = modifier.fillMaxWidth(),
    shape = ClickableSurfaceDefaults.shape(shape = shape),
    colors = ClickableSurfaceDefaults.colors(
      containerColor = if (default) Tokens.Panel2 else Color.Transparent,
      contentColor = Tokens.Text,
      focusedContainerColor = Tokens.Panel2,
      focusedContentColor = Tokens.Text,
      pressedContainerColor = Tokens.Panel2,
      pressedContentColor = Tokens.Text,
    ),
    // Panel rows do not scale on focus: the list viewport would clip the first and last row.
    scale = ClickableSurfaceDefaults.scale(focusedScale = 1f, pressedScale = 1f),
    border = ClickableSurfaceDefaults.border(
      border = Border.None,
      focusedBorder = Border(BorderStroke(1.5.dp, Tokens.Accent2), shape = shape),
    ),
  ) {
    Row(
      modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      Text(badge, color = badgeColour, fontSize = 10.sp, fontWeight = FontWeight.Bold)
      Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(stream.addonName.orEmpty(), color = Tokens.Muted, fontSize = 9.5.sp, maxLines = 1)
        Text(streamLabel(stream), fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (meta.isNotEmpty()) Text(meta.joinToString(" · "), color = Tokens.Muted, fontSize = 10.sp, maxLines = 1)
      }
      // One tick only: on the picked row once the viewer chose one, otherwise on the default.
      when {
        chosen -> Text(if (default) "✓ $defaultText" else "✓", color = Tokens.Green, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
        default && !anyChosen -> Text("✓ $defaultText", color = Tokens.Green, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
        default -> Text(defaultText, color = Tokens.Muted, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
      }
    }
  }
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

private fun streamLabel(stream: StreamDto): String =
  stream.name ?: stream.title?.split("\n")?.firstOrNull() ?: stream.description?.split("\n")?.firstOrNull() ?: ""

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

private fun utcToday(): String {
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
