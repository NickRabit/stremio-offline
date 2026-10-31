package cz.stremiooffline.tv.ui.detail

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
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
import androidx.compose.ui.unit.dp
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.VideoDto
import cz.stremiooffline.tv.ui.catalog.episodeCardTag
import cz.stremiooffline.tv.ui.catalog.seasonChipTag
import cz.stremiooffline.tv.ui.catalog.seasonsOf
import cz.stremiooffline.tv.ui.components.CardRowInset
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.components.WideCard

@Composable
internal fun SeriesRows(
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
  extras: TitleExtrasState,
  onUpFromSeasons: (() -> Boolean)? = null,
  onEpisodeFocused: (VideoDto) -> Unit = {},
  onNearEnd: () -> Unit = {},
  onMenu: ((VideoDto) -> Unit)? = null,
  cardTag: (VideoDto) -> String = ::episodeCardTag,
) {
  val seasons = seasonsOf(videos)
  val current = season ?: seasons.firstOrNull()
  val seasonState = remember { LazyListState() }
  var focusedSeason by remember { mutableIntStateOf(seasons.indexOf(current)) }
  LaunchedEffect(focusedSeason) {
    if (focusedSeason >= 0) seasonState.animateScrollToItem(focusedSeason)
  }
  LazyRow(
    state = seasonState,
    contentPadding = PaddingValues(horizontal = CardRowInset),
    horizontalArrangement = Arrangement.spacedBy(8.dp),
    modifier = Modifier.onPreviewKeyEvent { event ->
      if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
      when (event.key) {
        Key.DirectionDown -> runCatching { focusRequester.requestFocus() }.isSuccess
        Key.DirectionUp -> onUpFromSeasons?.invoke() ?: false
        else -> false
      }
    },
  ) {
    itemsIndexed(seasons, key = { _, value -> value }) { index, value ->
      FocusButton(
        text = stringResource(R.string.episodes_season_number, value.toString()),
        onClick = { onSeason(value) },
        kind = if (value == current) FocusButtonKind.Primary else FocusButtonKind.Normal,
        modifier = Modifier
          .testTag(seasonChipTag(value))
          .then(if (index == focusedSeason) Modifier.focusRequester(seasonFocus) else Modifier)
          .onFocusChanged { if (it.hasFocus) focusedSeason = index },
      )
    }
  }
  val episodes = videos.filter { it.season == current }.ifEmpty { videos }
  LazyRow(
    contentPadding = PaddingValues(horizontal = CardRowInset),
    horizontalArrangement = Arrangement.spacedBy(18.dp),
    modifier = Modifier
      .onPreviewKeyEvent { event ->
        if (event.type == KeyEventType.KeyDown && event.key == Key.DirectionUp) {
          runCatching { seasonFocus.requestFocus() }.isSuccess
        } else {
          false
        }
      }
      .downIntoExtras(extras),
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
        cardTag = cardTag(video),
        onClick = { onSelect(video) },
        modifier = Modifier
          .then(if (video.id != null && video.id == focusVideo?.id) Modifier.focusRequester(focusRequester) else Modifier)
          .onFocusChanged {
            if (it.isFocused) {
              onEpisodeFocused(video)
              if (index >= episodes.size - 2) onNearEnd()
            }
          }
          .onPreviewKeyEvent { event ->
            if (event.type == KeyEventType.KeyDown && (event.key == Key.Menu || event.key == Key.Info) && onMenu != null) {
              onMenu(video)
              true
            } else {
              false
            }
          },
      )
    }
  }
}
