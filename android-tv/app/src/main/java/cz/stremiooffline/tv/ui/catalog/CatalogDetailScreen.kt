package cz.stremiooffline.tv.ui.catalog

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
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
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.components.WideCard
import cz.stremiooffline.tv.ui.detail.PlayTarget
import cz.stremiooffline.tv.ui.theme.Tokens
import java.util.Locale
import kotlinx.coroutines.launch

const val TagCatalogPrimary = "catalog_primary"
const val TagCatalogStartOver = "catalog_start_over"
const val TagCatalogFavourite = "catalog_favourite"
const val TagCatalogToLibrary = "catalog_to_library"
const val TagCatalogSources = "catalog_sources"
const val TagCatalogMessage = "catalog_message"
const val TagSourcesPanel = "catalog_sources_panel"

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
  BackHandler { onBack() }

  val scope = rememberCoroutineScope()
  var settings by remember { mutableStateOf(SettingsResponse()) }
  var meta by remember { mutableStateOf(args.meta) }
  var entries by remember { mutableStateOf<List<ProgressEntryDto>>(emptyList()) }
  var addons by remember { mutableStateOf<List<AddonDto>>(emptyList()) }
  var movieProgress by remember { mutableStateOf<ProgressDto?>(null) }
  var streams by remember { mutableStateOf<List<StreamDto>>(emptyList()) }
  var selectedVideo by remember { mutableStateOf<VideoDto?>(null) }
  var season by remember { mutableStateOf<Int?>(null) }
  var pickedSource by remember { mutableStateOf<StreamDto?>(null) }
  var sourcesOpen by remember { mutableStateOf(false) }
  var favourite by remember { mutableStateOf(false) }
  var queued by remember { mutableStateOf(false) }
  var message by remember { mutableStateOf<String?>(null) }

  val queuedText = stringResource(R.string.save_queued)
  val waitingText = stringResource(R.string.downloads_waiting_debrid)
  val notAllowedText = stringResource(R.string.err_download_library_not_allowed)
  val torrentText = stringResource(R.string.err_torrent_not_playable)
  val defaultText = stringResource(R.string.tv_default)
  val toLibraryText = stringResource(R.string.save_to_library)

  val primaryFocus = remember { FocusRequester() }
  val rowFocus = remember { FocusRequester() }

  // Metadata and the personal state, once. Streams follow the chosen video.
  LaunchedEffect(args.meta.id) {
    settings = runCatching { api.settings() }.getOrDefault(SettingsResponse())
    val detail = runCatching { api.meta(args.type, args.meta.id, settings.uiLanguage) }.getOrNull()
    meta = if (detail != null) mergeMeta(args.meta, detail) else args.meta
    addons = runCatching { api.addons() }.getOrDefault(emptyList())
    entries = runCatching { api.progressList() }.getOrDefault(emptyList())
    favourite = runCatching { api.watchlist() }.getOrDefault(emptyList()).any { it.key == "${args.type}:${args.meta.id}" }
    if (args.type == "series") {
      val videos = meta.videos.orEmpty()
      val watched = Resume.resumeVideo(videos, seriesEntry(entries, meta.id)?.let { Resume.resumeTarget(it).episode })
      val resuming = seriesEntry(entries, meta.id)?.let { Progress.resumePosition(it.position, it.duration) != null } == true
      selectedVideo = (if (resuming) watched else null) ?: nextRelevantEpisode(videos, watched) ?: firstReleased(videos)
      season = defaultSeason(videos)
    } else {
      movieProgress = runCatching { api.progress(ProgressKey.of(args.type, meta.id)) }.getOrNull()
    }
  }

  LaunchedEffect(meta.id, selectedVideo?.id) {
    pickedSource = null
    val type = meta.type ?: args.type
    val id = selectedVideo?.id ?: meta.id
    streams = runCatching { api.streams(type, id) }.getOrDefault(emptyList())
  }

  LaunchedEffect(meta.id) { runCatching { primaryFocus.requestFocus() } }
  LaunchedEffect(restoreToken) { if (restoreToken > 0) runCatching { primaryFocus.requestFocus() } }

  val offered = Streams.offeredStreams(streams)
  val isSeries = (meta.type ?: args.type) == "series"
  val priority = addons.mapIndexed { index, addon -> addon.manifest.name to index }.toMap()
  val visible = Streams.visibleCatalogStreams(
    offered,
    Streams.StreamFilters(sort = Streams.StreamSort.of(settings.streamSort)),
    settings.audioLanguage ?: "en",
    priority,
    settings.realDebridConfigured,
    Languages.titleLanguage(meta.language),
  )
  val notices = Streams.addonNotices(streams)
  val defaultStream = Streams.pickDefaultStream(visible)
  val activeStream = pickedSource ?: defaultStream
  val canQueueActive = activeStream != null && Streams.canQueue(activeStream, settings.realDebridConfigured)

  val resumeEntry = if (isSeries) seriesEntry(entries, meta.id) else null
  val resumeEpisode = if (isSeries) Resume.resumeVideo(meta.videos.orEmpty(), resumeEntry?.let { Resume.resumeTarget(it).episode }) else null
  val storedPosition = if (isSeries) resumeEntry?.position ?: 0.0 else movieProgress?.position ?: 0.0
  val storedDuration = if (isSeries) resumeEntry?.duration ?: 0.0 else movieProgress?.duration ?: 0.0
  val resuming = Progress.resumePosition(storedPosition, storedDuration) != null &&
    (selectedVideo == null || selectedVideo?.id == resumeEpisode?.id)

  val baseTitle = localizedTitle(args.meta, meta, settings.uiLanguage)
  val playerTitle = if (selectedVideo != null) "$baseTitle · ${selectedVideo!!.label}" else baseTitle
  val progressKey = ProgressKey.of(meta.type ?: args.type, meta.id, selectedVideo?.id)

  fun play(stream: StreamDto) {
    pickedSource = stream
    sourcesOpen = false
    onPlay(PlayTarget(key = progressKey, title = playerTitle, resume = resuming, sourceId = stream.sourceId))
  }

  fun queue(stream: StreamDto) {
    pickedSource = stream
    if (!Streams.canQueue(stream, settings.realDebridConfigured)) {
      message = torrentText
      return
    }
    val media = mediaFor(meta, args, selectedVideo, settings)
    val title = playerTitle
    scope.launch {
      try {
        val job = api.download(title, stream.sourceId, media)
        queued = true
        message = if (job.status == "waiting") waitingText else queuedText
      } catch (error: ApiError) {
        message = if (error.failure == ApiFailure.Forbidden) notAllowedText else null
      }
    }
  }

  Box(
    Modifier
      .fillMaxSize()
      .background(Tokens.Bg)
      .onPreviewKeyEvent { event ->
        if (event.type == KeyEventType.KeyDown && event.key == Key.DirectionDown && args.type == "series") {
          runCatching { rowFocus.requestFocus() }
          true
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
      Row(horizontalArrangement = Arrangement.spacedBy(11.dp), verticalAlignment = Alignment.CenterVertically) {
        FocusButton(
          text = stringResource(if (resuming) R.string.tv_resume else R.string.player_play),
          onClick = { activeStream?.let { if (it.playable) play(it) else queue(it) } },
          kind = FocusButtonKind.Primary,
          modifier = Modifier.focusRequester(primaryFocus).testTag(TagCatalogPrimary),
        )
        if (resuming) {
          FocusButton(
            text = stringResource(R.string.tv_start_over),
            onClick = { activeStream?.takeIf { it.playable }?.let { onPlay(PlayTarget(progressKey, playerTitle, resume = false, sourceId = it.sourceId)) } },
            modifier = Modifier.testTag(TagCatalogStartOver),
          )
        }
        FocusButton(
          text = if (favourite) "★" else "☆",
          onClick = {
            val wanted = !favourite
            favourite = wanted
            scope.launch { runCatching { api.setWatchlist(args.type, meta.id, meta.name, meta.poster, wanted) } }
          },
          kind = FocusButtonKind.Icon,
          contentDescription = stringResource(if (favourite) R.string.favorite_remove else R.string.favorite_add),
          modifier = Modifier.testTag(TagCatalogFavourite),
        )
        if (canQueueActive) {
          FocusButton(
            text = if (queued) "✓ $queuedText" else toLibraryText,
            onClick = { activeStream?.let { queue(it) } },
            modifier = Modifier.testTag(TagCatalogToLibrary),
          )
        }
        FocusButton(
          text = stringResource(R.string.tv_sources_count, visible.size.toString()),
          onClick = { sourcesOpen = true },
          modifier = Modifier.testTag(TagCatalogSources),
        )
      }
      val shown = message
      if (shown != null) {
        Text(
          shown,
          color = if (shown == notAllowedText) Tokens.Red else Tokens.Green,
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
          onSelect = { selectedVideo = it },
          focusRequester = rowFocus,
        )
      }
    }

    if (sourcesOpen) {
      SidePanel(title = stringResource(R.string.sources_heading), onClose = { sourcesOpen = false }, modifier = Modifier.testTag(TagSourcesPanel)) {
        if (visible.isEmpty()) {
          Text(stringResource(R.string.sources_none), color = Tokens.Muted, fontSize = 12.sp, lineHeight = 17.sp)
        }
        visible.forEachIndexed { index, stream ->
          SourceRow(
            stream = stream,
            default = defaultStream === stream,
            defaultText = defaultText,
            titleLanguage = Languages.titleLanguage(meta.language),
            onClick = { if (stream.playable) play(stream) else queue(stream) },
            modifier = Modifier.testTag(sourceRowTag(index)),
          )
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
      if (default) Text("✓ $defaultText", color = Tokens.Green, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
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
) {
  val seasons = seasonsOf(videos)
  val current = season ?: seasons.firstOrNull()
  Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
    seasons.forEach { value ->
      FocusButton(
        text = stringResource(R.string.episodes_season_number, value.toString()),
        onClick = { onSeason(value) },
        kind = if (value == current) FocusButtonKind.Primary else FocusButtonKind.Normal,
        modifier = Modifier.testTag(seasonChipTag(value)),
      )
    }
  }
  val episodes = videos.filter { it.season == current }.ifEmpty { videos }
  LazyRow(horizontalArrangement = Arrangement.spacedBy(18.dp)) {
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
