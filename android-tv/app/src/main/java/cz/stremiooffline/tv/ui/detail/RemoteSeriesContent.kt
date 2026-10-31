package cz.stremiooffline.tv.ui.detail

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
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
import cz.stremiooffline.tv.data.RelatedTitleDto
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.VideoDto
import cz.stremiooffline.tv.ui.catalog.ActionCaption
import cz.stremiooffline.tv.ui.catalog.DetailAction
import cz.stremiooffline.tv.ui.catalog.DetailActionHeight
import cz.stremiooffline.tv.ui.catalog.DetailActionRow
import cz.stremiooffline.tv.ui.catalog.DownloadIcon
import cz.stremiooffline.tv.ui.catalog.episodeLine
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.components.ShimmerCards
import cz.stremiooffline.tv.ui.library.RemoteErrorKind
import cz.stremiooffline.tv.ui.library.TagRemoteLoadMore
import cz.stremiooffline.tv.ui.library.TagRemoteSeriesOverview
import cz.stremiooffline.tv.ui.library.TagRemoteSeriesPrimary
import cz.stremiooffline.tv.ui.library.TagRemoteSeriesToLibrary
import cz.stremiooffline.tv.ui.library.remoteItemTag
import cz.stremiooffline.tv.ui.theme.Tokens

internal class RemoteSeriesUiState {
  val extras = TitleExtrasState()
  val caption = ActionCaption()
  val primary = FocusRequester()
  val seasons = FocusRequester()
  val episode = FocusRequester()
  val error = FocusRequester()
  var season by mutableStateOf<Int?>(null)
  var selectedEpisodeId by mutableStateOf<String?>(null)
  var actionsFocused by mutableStateOf(false)
  var started by mutableStateOf(false)
  var restoreEpisodeFocus by mutableStateOf(false)
}

internal fun RemoteItemDto.asVideo(): VideoDto = VideoDto(
  id = id,
  name = name,
  season = season,
  episode = episode,
  overview = overview,
  thumbnail = wide ?: poster,
)

@Composable
internal fun RemoteSeriesContent(
  data: RemoteDetailData,
  metadata: RemoteMetadata,
  items: List<RemoteItemDto>,
  videos: List<VideoDto>,
  currentSeason: Int?,
  selectedVideo: VideoDto?,
  selectedItem: RemoteItemDto?,
  imageUrl: (String?) -> String?,
  ui: RemoteSeriesUiState,
  loading: Boolean,
  error: RemoteErrorKind?,
  appendFailed: Boolean,
  staleCursor: Boolean,
  copyNotice: String?,
  copyBusy: Boolean,
  canCopy: Boolean,
  onOpenEpisode: (RemoteItemDto) -> Unit,
  onCopy: (RemoteItemDto) -> Unit,
  onRetry: () -> Unit,
  onRetryAppend: () -> Unit,
  onLoadMore: () -> Unit,
  onSearchPerson: (String) -> Unit,
  onOpenRelated: (RelatedTitleDto) -> Unit,
) {
  val scope = rememberCoroutineScope()
  Box(Modifier.fillMaxSize()) {
    val art = imageUrl(data.item.wide ?: data.item.poster)
    if (art != null) {
      AsyncImage(
        model = art,
        contentDescription = null,
        contentScale = ContentScale.Crop,
        modifier = Modifier.fillMaxSize(),
      )
    }
    Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Tokens.Panel2.copy(alpha = 0.35f), Tokens.Bg, Tokens.Bg))))
    Column(
      Modifier
        .fillMaxSize()
        .clipToBounds()
        .verticalScroll(ui.extras.scroll)
        .padding(start = Tokens.SafeX, top = Tokens.SafeY, end = Tokens.SafeX),
      verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
      if (copyNotice != null) {
        Text(copyNotice, color = Tokens.Red, fontSize = 11.sp)
      }
      Text(
        eyebrow(data),
        color = Tokens.Accent,
        fontSize = 10.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 1.8.sp,
      )
      Text(
        metadata.seriesName ?: metadata.item.name,
        color = Tokens.Text,
        fontSize = 42.sp,
        fontWeight = FontWeight.ExtraBold,
        letterSpacing = (-1.2).sp,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.fillMaxWidth(0.82f),
      )
      TitleExtraFacts(
        state = ui.extras,
        name = metadata.seriesName ?: metadata.item.name,
        metaLine = listOfNotNull(
          data.provider.ifBlank { null },
          data.libraryName.ifBlank { null },
          stringResource(R.string.media_server_read_only),
        ).joinToString(" · "),
        uiLanguage = null,
      )
      selectedVideo?.let {
        Text(
          episodeLine(it),
          color = Tokens.Muted,
          fontSize = 11.5.sp,
          fontWeight = FontWeight.Medium,
        )
      }
      val overview = metadata.item.overview ?: data.item.overview
      if (!overview.isNullOrBlank()) {
        Text(
          overview,
          color = Tokens.Text.copy(alpha = 0.82f),
          fontSize = 12.5.sp,
          lineHeight = 18.sp,
          maxLines = 3,
          overflow = TextOverflow.Ellipsis,
          modifier = Modifier.fillMaxWidth(0.76f).testTag(TagRemoteSeriesOverview),
        )
      }
      DetailActionRow(
        primary = {
          FocusButton(
            text = stringResource(R.string.tv_play),
            onClick = { selectedItem?.let(onOpenEpisode) },
            kind = FocusButtonKind.Primary,
            height = DetailActionHeight,
            enabled = selectedItem != null,
            modifier = Modifier.focusRequester(ui.primary).testTag(TagRemoteSeriesPrimary),
          )
        },
        startOver = null,
        sources = null,
        toLibrary = selectedItem?.takeIf { canCopy }?.let {
          DetailAction(
            label = stringResource(R.string.save_to_library),
            icon = DownloadIcon,
            tag = TagRemoteSeriesToLibrary,
            enabled = !copyBusy,
            onClick = { onCopy(it) },
          )
        },
        favourite = null,
        unwatched = null,
        watched = null,
        caption = ui.caption,
        modifier = Modifier
          .scrollToTopOnFocus(ui.extras, scope)
          .onFocusChanged { ui.actionsFocused = it.hasFocus }
          .onPreviewKeyEvent { event ->
            if (event.type == KeyEventType.KeyDown && event.key == Key.DirectionDown) {
              runCatching {
                (if (videos.any { it.season != null }) ui.seasons else ui.episode).requestFocus()
              }.isSuccess
            } else {
              false
            }
          },
      )
      when {
        loading -> Box(Modifier.fillMaxWidth().height(260.dp)) { ShimmerCards() }
        error != null -> Box(Modifier.fillMaxWidth().height(220.dp), contentAlignment = Alignment.Center) {
          Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(11.dp)) {
            Text(
              stringResource(if (error == RemoteErrorKind.Offline) R.string.media_server_offline else R.string.media_server_error),
              color = Tokens.Muted,
              fontSize = 12.sp,
            )
            FocusButton(
              stringResource(R.string.tv_try_again),
              onClick = onRetry,
              kind = FocusButtonKind.Primary,
              modifier = Modifier.focusRequester(ui.error),
            )
          }
        }
        videos.isNotEmpty() -> SeriesRows(
          videos = videos,
          season = currentSeason,
          onSeason = { season ->
            ui.season = season
            ui.selectedEpisodeId = videos.firstOrNull { it.season == season }?.id
          },
          resumeEpisode = null,
          focusVideo = selectedVideo,
          seriesPosition = 0.0,
          seriesDuration = 0.0,
          imageUrl = imageUrl,
          onSelect = { video -> items.firstOrNull { it.id == video.id }?.let(onOpenEpisode) },
          focusRequester = ui.episode,
          seasonFocus = ui.seasons,
          extras = ui.extras,
          onUpFromSeasons = { runCatching { ui.primary.requestFocus() }.isSuccess },
          onEpisodeFocused = { video -> ui.selectedEpisodeId = video.id },
          onNearEnd = onLoadMore,
          onMenu = if (canCopy) { video -> items.firstOrNull { it.id == video.id }?.let(onCopy) } else null,
          cardTag = { video -> remoteItemTag(video.id.orEmpty()) },
        )
        else -> Text(
          stringResource(R.string.media_server_empty_items),
          color = Tokens.Muted,
          fontSize = 12.sp,
        )
      }
      if (appendFailed || staleCursor) {
        FocusButton(
          stringResource(R.string.tv_try_again),
          onClick = if (staleCursor) onRetry else onRetryAppend,
          modifier = Modifier.testTag(TagRemoteLoadMore),
        )
      }
      TitleExtrasRows(
        state = ui.extras,
        imageUrl = imageUrl,
        onPerson = onSearchPerson,
        onRelated = onOpenRelated,
        onUpFromRows = {
          runCatching { (if (videos.isNotEmpty()) ui.episode else ui.primary).requestFocus() }
        },
      )
    }
  }
}
