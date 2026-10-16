package cz.stremiooffline.tv.ui.resume

import androidx.annotation.StringRes
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.HomeCard
import cz.stremiooffline.tv.data.ResumeFilter
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.data.displayTitle
import cz.stremiooffline.tv.data.progressFraction
import cz.stremiooffline.tv.ui.catalog.CatalogDetailArgs
import cz.stremiooffline.tv.ui.components.CardRowInset
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.components.ShimmerCards
import cz.stremiooffline.tv.ui.components.WideCard
import cz.stremiooffline.tv.ui.components.leftToNeighbour
import cz.stremiooffline.tv.ui.detail.RemoteDetailData
import cz.stremiooffline.tv.ui.detail.PlayTarget
import cz.stremiooffline.tv.ui.home.HomeAction
import cz.stremiooffline.tv.ui.home.actionFor
import cz.stremiooffline.tv.ui.home.cardLabel
import cz.stremiooffline.tv.ui.home.captionOf
import cz.stremiooffline.tv.ui.home.remoteDetailOf
import cz.stremiooffline.tv.ui.theme.Tokens

fun resumeFilterTag(filter: ResumeFilter): String = "resume_filter_" + filter.wire

/** The grid key of one resume card, and the tag a test focuses it by. */
fun resumeCardTag(key: String): String = "resume:$key"

/** The one Continue watching section: the merged cards Home's resume row draws, paged past
 *  that row's bound and narrowed by filter chips. OK follows the one rule the Home row reads. */
@Composable
fun ResumeRoute(
  api: TvApi,
  /** A card that names the file it was written from plays it, exactly as on Home. */
  onPlay: (PlayTarget) -> Unit,
  onOpenCatalog: (CatalogDetailArgs) -> Unit,
  /** A remote media-server card opens its own playable detail. */
  onOpenRemote: (RemoteDetailData) -> Unit = {},
  modifier: Modifier = Modifier,
  restoreToken: Int = 0,
  refreshToken: Int = 0,
) {
  val viewModel = viewModel<ResumeViewModel>(factory = ResumeViewModel.factory(api))
  LaunchedEffect(Unit) { viewModel.start() }
  // Re-entering the section, or returning from a detail: a forgotten title may be gone.
  LaunchedEffect(refreshToken) { if (refreshToken > 0) viewModel.refresh() }
  LaunchedEffect(restoreToken) { if (restoreToken > 0) viewModel.refresh() }

  val state = viewModel.state
  val gridFocus = remember { FocusRequester() }
  val filterFocus = remember { ResumeFilter.entries.associateWith { FocusRequester() } }
  val cardFocus = remember { mutableMapOf<String, FocusRequester>() }

  // The remembered card takes focus once the rows land; an empty filter leaves the remote on its chip.
  LaunchedEffect(state.loading, state.filter, state.items.size, restoreToken, refreshToken) {
    if (state.loading) return@LaunchedEffect
    val keys = state.items.map { it.key }
    if (keys.isEmpty()) {
      runCatching { filterFocus.getValue(state.filter).requestFocus() }
      return@LaunchedEffect
    }
    val wanted = viewModel.selectedKey.takeIf { it in keys } ?: keys.first()
    runCatching { (cardFocus[wanted] ?: gridFocus).requestFocus() }
  }

  Column(
    modifier = modifier.fillMaxSize().padding(start = Tokens.SafeX, top = Tokens.SafeY, end = Tokens.SafeX),
    verticalArrangement = Arrangement.spacedBy(9.dp),
  ) {
    Text(
      stringResource(R.string.nav_resume).uppercase(),
      color = Tokens.Accent,
      fontSize = 10.sp,
      fontWeight = FontWeight.Bold,
      letterSpacing = 1.8.sp,
    )
    Text(
      stringResource(R.string.resume_title),
      color = Tokens.Text,
      fontSize = 26.sp,
      fontWeight = FontWeight.ExtraBold,
      letterSpacing = (-0.8).sp,
    )
    Row(horizontalArrangement = Arrangement.spacedBy(9.dp), verticalAlignment = Alignment.CenterVertically) {
      ResumeFilter.entries.forEachIndexed { index, filter ->
        FocusButton(
          text = stringResource(filterLabel(filter)),
          onClick = { viewModel.select(filter) },
          kind = if (filter == state.filter) FocusButtonKind.Primary else FocusButtonKind.Normal,
          modifier = Modifier
            .focusRequester(filterFocus.getValue(filter))
            .testTag(resumeFilterTag(filter))
            .then(if (index > 0) Modifier.leftToNeighbour(filterFocus.getValue(ResumeFilter.entries[index - 1])) else Modifier),
        )
      }
    }

    Box(Modifier.weight(1f).fillMaxWidth()) {
      when {
        state.loading -> ShimmerCards()
        state.error -> ResumeError(onRetry = { viewModel.retry() })
        state.items.isEmpty() -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
          Text(stringResource(filterEmptyTitle(state.filter)), color = Tokens.Text, fontSize = 18.sp, fontWeight = FontWeight.ExtraBold)
          Text(stringResource(filterEmptyText(state.filter)), color = Tokens.Muted, fontSize = 12.sp)
        }
        else -> BoxWithConstraints(Modifier.fillMaxSize()) {
          val columns = (((maxWidth.value + 18f) / 208f).toInt()).coerceAtLeast(1)
          LazyVerticalGrid(
            columns = GridCells.Fixed(columns),
            modifier = Modifier.focusRequester(gridFocus).focusGroup(),
            contentPadding = PaddingValues(start = CardRowInset, top = 10.dp, end = CardRowInset, bottom = 40.dp),
            horizontalArrangement = Arrangement.spacedBy(18.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
          ) {
            itemsIndexed(state.items, key = { _, card -> card.key }) { index, card ->
              val requester = remember(card.key) { FocusRequester() }
              cardFocus[card.key] = requester
              val label = cardLabel(card)?.let { stringResource(it) }
              WideCard(
                label = card.displayTitle,
                imageUrl = card.wide?.let(api::url),
                fallbackImageUrl = card.poster?.let(api::url),
                progress = card.progressFraction,
                completed = false,
                caption = captionOf(card, label),
                cardTag = resumeCardTag(card.key),
                onClick = { openResume(card, onPlay, onOpenCatalog, onOpenRemote) },
                modifier = Modifier
                  .focusRequester(requester)
                  .onFocusChanged {
                    if (it.isFocused) {
                      viewModel.selectedKey = card.key
                      cardFocus[card.key] = requester
                      if (index >= state.items.size - columns) viewModel.loadMore()
                    }
                  },
              )
            }
          }
        }
      }
    }
  }
}

/** Where OK goes: the one rule Home reads, handed to this screen's own callbacks. */
private fun openResume(
  card: HomeCard,
  onPlay: (PlayTarget) -> Unit,
  onOpenCatalog: (CatalogDetailArgs) -> Unit,
  onOpenRemote: (RemoteDetailData) -> Unit,
) {
  when (val action = actionFor(card)) {
    is HomeAction.Play -> onPlay(action.target)
    is HomeAction.OpenCatalog -> onOpenCatalog(action.args)
    is HomeAction.OpenRemote -> onOpenRemote(action.data)
    is HomeAction.OpenLibrary -> Unit
  }
}

@StringRes
private fun filterLabel(filter: ResumeFilter): Int = when (filter) {
  ResumeFilter.All -> R.string.resume_filter_all
  ResumeFilter.Movies -> R.string.resume_filter_movies
  ResumeFilter.Series -> R.string.resume_filter_series
}

@StringRes
private fun filterEmptyTitle(filter: ResumeFilter): Int = when (filter) {
  ResumeFilter.All -> R.string.resume_empty_all_title
  ResumeFilter.Movies -> R.string.resume_empty_movies_title
  ResumeFilter.Series -> R.string.resume_empty_series_title
}

@StringRes
private fun filterEmptyText(filter: ResumeFilter): Int = when (filter) {
  ResumeFilter.All -> R.string.resume_empty_all_text
  ResumeFilter.Movies -> R.string.resume_empty_movies_text
  ResumeFilter.Series -> R.string.resume_empty_series_text
}

@Composable
private fun ResumeError(onRetry: () -> Unit) {
  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    FocusButton(stringResource(R.string.tv_try_again), onClick = onRetry, kind = FocusButtonKind.Primary)
  }
}
