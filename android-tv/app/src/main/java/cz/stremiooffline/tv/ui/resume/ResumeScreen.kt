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
import cz.stremiooffline.tv.catalog.ResumeEpisode
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.HomeCard
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.ProgressDto
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
import cz.stremiooffline.tv.ui.detail.DetailData
import cz.stremiooffline.tv.ui.detail.RemoteDetailData
import cz.stremiooffline.tv.ui.home.cardLabel
import cz.stremiooffline.tv.ui.home.captionOf
import cz.stremiooffline.tv.ui.home.remoteDetailOf
import cz.stremiooffline.tv.ui.theme.Tokens

fun resumeFilterTag(filter: ResumeFilter): String = "resume_filter_" + filter.wire

/** The grid key of one resume card, and the tag a test focuses it by. */
fun resumeCardTag(key: String): String = "resume:$key"

/** The one Continue watching section: the merged cards Home's resume row draws, paged past
 *  that row's bound and narrowed by filter chips. A library card opens the library detail, a
 *  catalogue card the catalogue detail on the episode it remembers. */
@Composable
fun ResumeRoute(
  api: TvApi,
  onOpenDetail: (DetailData) -> Unit,
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
                onClick = { openResume(card, onOpenDetail, onOpenCatalog, onOpenRemote) },
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

/** Where OK goes: the library detail of a file, or the catalogue detail on the remembered episode. */
private fun openResume(
  card: HomeCard,
  onOpenDetail: (DetailData) -> Unit,
  onOpenCatalog: (CatalogDetailArgs) -> Unit,
  onOpenRemote: (RemoteDetailData) -> Unit,
) {
  when (card) {
    is HomeCard.ResumeFile -> onOpenDetail(
      DetailData.ofFile(
        BrowseItem.File(
          path = card.path,
          label = card.title,
          season = card.season,
          episode = card.episode,
          progress = card.progress?.let { ProgressDto(it.position, it.duration) },
          poster = card.poster,
          wide = card.wide,
        ),
      ).copy(forgetKeys = card.forgetKeys),
    )
    is HomeCard.ResumeCatalogue -> onOpenCatalog(
      CatalogDetailArgs(
        meta = MetaDto(id = card.id, type = card.type, name = card.name, poster = card.poster),
        addonName = "",
        type = card.type,
        episode = card.season?.let { season -> card.episode?.let { episode -> ResumeEpisode(card.key, season, episode) } },
        forgetKeys = card.forgetKeys,
      ),
    )
    is HomeCard.Remote -> onOpenRemote(remoteDetailOf(card))
    else -> Unit
  }
}

@StringRes
private fun filterLabel(filter: ResumeFilter): Int = when (filter) {
  ResumeFilter.All -> R.string.resume_filter_all
  ResumeFilter.Library -> R.string.resume_filter_library
  ResumeFilter.Catalog -> R.string.resume_filter_catalog
  ResumeFilter.Remote -> R.string.resume_filter_remote
}

@StringRes
private fun filterEmptyTitle(filter: ResumeFilter): Int = when (filter) {
  ResumeFilter.All -> R.string.resume_empty_all_title
  ResumeFilter.Library -> R.string.resume_empty_library_title
  ResumeFilter.Catalog -> R.string.resume_empty_catalog_title
  ResumeFilter.Remote -> R.string.resume_empty_remote_title
}

@StringRes
private fun filterEmptyText(filter: ResumeFilter): Int = when (filter) {
  ResumeFilter.All -> R.string.resume_empty_all_text
  ResumeFilter.Library -> R.string.resume_empty_library_text
  ResumeFilter.Catalog -> R.string.resume_empty_catalog_text
  ResumeFilter.Remote -> R.string.resume_empty_remote_text
}

@Composable
private fun ResumeError(onRetry: () -> Unit) {
  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    FocusButton(stringResource(R.string.tv_try_again), onClick = onRetry, kind = FocusButtonKind.Primary)
  }
}
