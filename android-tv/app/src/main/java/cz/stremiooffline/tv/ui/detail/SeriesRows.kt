package cz.stremiooffline.tv.ui.detail

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.VideoDto
import cz.stremiooffline.tv.ui.catalog.episodeCardTag
import cz.stremiooffline.tv.ui.catalog.seasonChipTag
import cz.stremiooffline.tv.ui.catalog.seasonsOf
import cz.stremiooffline.tv.ui.components.CardRowInset
import cz.stremiooffline.tv.ui.components.WideCard
import cz.stremiooffline.tv.ui.theme.Tokens

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
  /** A card's own progress and finished mark, when every episode keeps its own position; left
   *  null, only [resumeEpisode] shows progress and the episodes before it read as finished. */
  cardProgress: ((VideoDto) -> Float?)? = null,
  cardCompleted: ((VideoDto) -> Boolean)? = null,
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
    // The tabs' own padding lines their text up with the cards below.
    contentPadding = PaddingValues(horizontal = CardRowInset - SeasonTabPadding),
    horizontalArrangement = Arrangement.spacedBy(4.dp),
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
      SeasonTab(
        text = if (value == 0) stringResource(R.string.episodes_specials) else stringResource(R.string.episodes_season_number, value.toString()),
        current = value == current,
        onClick = { onSeason(value) },
        modifier = Modifier
          .testTag(seasonChipTag(value))
          .then(if (index == focusedSeason) Modifier.focusRequester(seasonFocus) else Modifier)
          .onFocusChanged { if (it.hasFocus) focusedSeason = index },
      )
    }
  }
  val episodes = videos.filter { it.season == current }.ifEmpty { videos }
  // The episode the detail stands for (the one to continue) is in view from the start, not only
  // once focus walks down to the row; while the viewer moves inside the row, focus scrolls it.
  val episodeState = remember(current) { LazyListState() }
  var episodesFocused by remember { mutableStateOf(false) }
  val focusIndex = episodes.indexOfFirst { focusVideo?.id != null && it.id == focusVideo.id }
  LaunchedEffect(current, focusIndex) {
    // One earlier card stays fully in view, so the row still reads as a sequence.
    if (focusIndex > 1 && !episodesFocused) episodeState.scrollToItem(focusIndex - 1)
  }
  LazyRow(
    state = episodeState,
    contentPadding = PaddingValues(horizontal = CardRowInset),
    horizontalArrangement = Arrangement.spacedBy(18.dp),
    modifier = Modifier
      .onFocusChanged { episodesFocused = it.hasFocus }
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
      val progress = if (cardProgress != null) {
        cardProgress(video)
      } else if (video.id != null && video.id == resumeEpisode?.id && seriesDuration > 0) {
        (seriesPosition / seriesDuration).toFloat()
      } else {
        null
      }
      WideCard(
        label = video.numbered ?: video.label,
        caption = video.title ?: video.name,
        imageUrl = imageUrl(video.thumbnail),
        progress = progress,
        completed = cardCompleted?.invoke(video) ?: (resumeIndex >= 0 && index < resumeIndex),
        cardTag = cardTag(video),
        selected = index == focusIndex,
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

private val SeasonTabPadding = 14.dp

/** One season in the picker: plain text, the current season underlined, the focused one filled. */
@Composable
private fun SeasonTab(text: String, current: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
  var focused by remember { mutableStateOf(false) }
  val shape = RoundedCornerShape(999.dp)
  Surface(
    onClick = onClick,
    modifier = modifier.onFocusChanged { focused = it.isFocused },
    shape = ClickableSurfaceDefaults.shape(shape = shape),
    scale = ClickableSurfaceDefaults.scale(focusedScale = 1.04f),
    colors = ClickableSurfaceDefaults.colors(
      containerColor = Color.Transparent,
      focusedContainerColor = Tokens.Accent,
    ),
  ) {
    Column(
      Modifier.padding(horizontal = SeasonTabPadding, vertical = 6.dp),
      horizontalAlignment = Alignment.CenterHorizontally,
    ) {
      Text(
        text,
        color = if (focused || current) Tokens.Text else Tokens.Muted,
        fontSize = 13.sp,
        fontWeight = if (current) FontWeight.Bold else FontWeight.Medium,
        maxLines = 1,
      )
      Spacer(Modifier.height(3.dp))
      Box(
        Modifier
          .width(18.dp)
          .height(2.dp)
          .background(if (current && !focused) Tokens.Accent else Color.Transparent, shape),
      )
    }
  }
}

