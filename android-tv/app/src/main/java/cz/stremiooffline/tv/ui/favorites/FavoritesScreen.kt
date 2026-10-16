package cz.stremiooffline.tv.ui.favorites

import androidx.annotation.StringRes
import androidx.compose.foundation.BorderStroke
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
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
import androidx.tv.material3.Border
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.FavoriteFilter
import cz.stremiooffline.tv.data.FavoriteItemDto
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.RemoteItemDto
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.ui.catalog.CatalogDetailArgs
import cz.stremiooffline.tv.ui.components.CardRowInset
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.components.PosterCard
import cz.stremiooffline.tv.ui.components.ShimmerCards
import cz.stremiooffline.tv.ui.components.leftToNeighbour
import cz.stremiooffline.tv.ui.detail.DetailData
import cz.stremiooffline.tv.ui.detail.RemoteDetailData
import cz.stremiooffline.tv.ui.theme.Tokens
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

fun favoritesFilterTag(filter: FavoriteFilter): String = "favorites_filter_" + filter.wire

/** The grid key of one favourite, and the tag a test focuses it by. */
fun favoriteCardTag(item: FavoriteItemDto): String = item.key

/** The one Favourites section: a single grid of library, catalogue and media-server stars,
 *  narrowed by filter chips. A library entry opens the library detail (browsing a folder first),
 *  a catalogue entry opens the catalogue detail, and a media-server entry its own playable detail. */
@Composable
fun FavoritesRoute(
  api: TvApi,
  onOpenDetail: (DetailData) -> Unit,
  onOpenCatalog: (CatalogDetailArgs) -> Unit,
  /** A remote media-server star opens its own playable detail. */
  onOpenRemote: (RemoteDetailData) -> Unit = {},
  /** A library folder that is not one title's own files opens the library at that path instead. */
  onOpenLibrary: (String) -> Unit = {},
  modifier: Modifier = Modifier,
  restoreToken: Int = 0,
  refreshToken: Int = 0,
) {
  val viewModel = viewModel<FavoritesViewModel>(factory = FavoritesViewModel.factory(api))
  LaunchedEffect(Unit) { viewModel.start() }
  // Re-entering the section, or returning from a detail: the star state may have changed.
  LaunchedEffect(refreshToken) { if (refreshToken > 0) viewModel.refresh() }
  LaunchedEffect(restoreToken) { if (restoreToken > 0) viewModel.refresh() }

  val state = viewModel.state
  val scope = rememberCoroutineScope()
  val gridFocus = remember { FocusRequester() }
  val filterFocus = remember { FavoriteFilter.entries.associateWith { FocusRequester() } }
  val cardFocus = remember { mutableMapOf<String, FocusRequester>() }

  // The first card (or the remembered one) takes focus once the rows land; an empty filter leaves
  // the remote on its chip.
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
      stringResource(R.string.nav_favorites).uppercase(),
      color = Tokens.Accent,
      fontSize = 10.sp,
      fontWeight = FontWeight.Bold,
      letterSpacing = 1.8.sp,
    )
    Text(
      stringResource(R.string.favorites_title),
      color = Tokens.Text,
      fontSize = 26.sp,
      fontWeight = FontWeight.ExtraBold,
      letterSpacing = (-0.8).sp,
    )
    Row(horizontalArrangement = Arrangement.spacedBy(9.dp), verticalAlignment = Alignment.CenterVertically) {
      FavoriteFilter.entries.forEachIndexed { index, filter ->
        FocusButton(
          text = stringResource(filterLabel(filter)),
          onClick = { viewModel.select(filter) },
          kind = if (filter == state.filter) FocusButtonKind.Primary else FocusButtonKind.Normal,
          modifier = Modifier
            .focusRequester(filterFocus.getValue(filter))
            .testTag(favoritesFilterTag(filter))
            .then(if (index > 0) Modifier.leftToNeighbour(filterFocus.getValue(FavoriteFilter.entries[index - 1])) else Modifier),
        )
      }
    }

    Box(Modifier.weight(1f).fillMaxWidth()) {
      when {
        state.loading -> ShimmerCards()
        state.error -> FavoritesError(onRetry = { viewModel.retry() })
        state.items.isEmpty() -> Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
          if (state.partial) {
            Text(
              stringResource(R.string.media_server_personal_partial),
              color = Tokens.Red,
              fontSize = 11.sp,
              maxLines = 1,
            )
          }
          Text(
            stringResource(filterEmpty(filter = state.filter)),
            color = Tokens.Muted,
            fontSize = 12.sp,
          )
        }
        else -> BoxWithConstraints(Modifier.fillMaxSize()) {
          val columns = (((maxWidth.value + 18f) / 128f).toInt()).coerceAtLeast(1)
          Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
            // A media server that answered partially never hides the stars that did land.
            if (state.partial) {
              Text(
                stringResource(R.string.media_server_personal_partial),
                color = Tokens.Red,
                fontSize = 11.sp,
                maxLines = 1,
              )
            }
            LazyVerticalGrid(
              columns = GridCells.Fixed(columns),
              modifier = Modifier.focusRequester(gridFocus).focusGroup(),
              contentPadding = PaddingValues(start = CardRowInset, top = 10.dp, end = CardRowInset, bottom = 40.dp),
              horizontalArrangement = Arrangement.spacedBy(18.dp),
              verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
              itemsIndexed(state.items, key = { _, item -> item.key }) { index, item ->
                val requester = remember(item.key) { FocusRequester() }
                cardFocus[item.key] = requester
                PosterCard(
                  name = favoriteTitle(item),
                  imageUrl = favoriteImage(item)?.let(api::url),
                  progress = favoriteProgress(item),
                  caption = favoriteCaption(item),
                  cardTag = item.key,
                  onClick = { openFavorite(item, api, scope, onOpenDetail, onOpenCatalog, onOpenRemote, onOpenLibrary) },
                  modifier = Modifier
                    .focusRequester(requester)
                    .onFocusChanged {
                      if (it.isFocused) {
                        viewModel.selectedKey = item.key
                        cardFocus[item.key] = requester
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
}

/** Where OK goes: the catalogue detail, the library detail, or the library at a folder path. */
private fun openFavorite(
  item: FavoriteItemDto,
  api: TvApi,
  scope: CoroutineScope,
  onOpenDetail: (DetailData) -> Unit,
  onOpenCatalog: (CatalogDetailArgs) -> Unit,
  onOpenRemote: (RemoteDetailData) -> Unit,
  onOpenLibrary: (String) -> Unit,
) {
  when (item) {
    is FavoriteItemDto.Catalog -> onOpenCatalog(
      CatalogDetailArgs(
        meta = MetaDto(id = item.id, type = item.type, name = item.name, poster = item.poster),
        addonName = "",
        type = item.type,
      ),
    )
    is FavoriteItemDto.Remote -> onOpenRemote(
      RemoteDetailData(
        libraryId = item.libraryId,
        libraryName = item.libraryName,
        provider = item.provider,
        item = RemoteItemDto(
          id = item.itemId,
          name = item.title,
          type = item.itemType,
          season = item.season,
          episode = item.episode,
          poster = item.poster,
          wide = item.wide,
        ),
      ),
    )
    is FavoriteItemDto.Library -> if (item.title != null) {
      // A copy bound to a catalogue title is that title: one star, one click, file or folder alike.
      onOpenCatalog(
        CatalogDetailArgs(
          meta = MetaDto(id = item.title.id, type = item.title.type, name = item.label, poster = item.poster),
          addonName = "",
          type = item.title.type,
        ),
      )
    } else if (item.itemKind != "folder") {
      onOpenDetail(
        DetailData.ofFile(
          BrowseItem.File(
            path = item.path,
            label = item.label,
            year = item.year,
            poster = item.poster,
            wide = item.wide,
            progress = item.progress,
            favorite = true,
          ),
        ),
      )
    } else {
      scope.launch {
        val page = runCatching { api.browse(item.path, limit = FavoritesViewModel.PAGE, skip = 0) }.getOrNull()
        val files = page?.items?.filterIsInstance<BrowseItem.File>().orEmpty()
        if (page != null && files.isNotEmpty() && files.size == page.items.size) {
          onOpenDetail(
            DetailData.ofFolder(
              BrowseItem.Folder(
                path = item.path,
                name = item.label,
                year = item.year,
                poster = item.poster,
                wide = item.wide,
                fileCount = files.size,
                favorite = true,
              ),
              files,
            ),
          )
        } else {
          onOpenLibrary(item.path)
        }
      }
    }
  }
}

private fun favoriteTitle(item: FavoriteItemDto): String = when (item) {
  is FavoriteItemDto.Library -> item.label
  is FavoriteItemDto.Catalog -> item.name
  is FavoriteItemDto.Remote -> item.title
}

private fun favoriteImage(item: FavoriteItemDto): String? = when (item) {
  is FavoriteItemDto.Library -> item.poster ?: item.wide
  is FavoriteItemDto.Catalog -> item.poster
  is FavoriteItemDto.Remote -> item.poster ?: item.wide
}

private fun favoriteCaption(item: FavoriteItemDto): String? = when (item) {
  is FavoriteItemDto.Library -> item.year
  is FavoriteItemDto.Catalog -> item.year
  // A list never names its source, and the card projection carries no year of its own.
  is FavoriteItemDto.Remote -> null
}

private fun favoriteProgress(item: FavoriteItemDto): Float? {
  val progress = (item as? FavoriteItemDto.Library)?.progress ?: return null
  if (progress.duration <= 0 || progress.position <= 0) return null
  return (progress.position / progress.duration).toFloat().coerceIn(0f, 1f)
}

@StringRes
private fun filterLabel(filter: FavoriteFilter): Int = when (filter) {
  FavoriteFilter.All -> R.string.favorites_filter_all
  FavoriteFilter.Movies -> R.string.favorites_filter_movies
  FavoriteFilter.Series -> R.string.favorites_filter_series
}

@StringRes
private fun filterEmpty(filter: FavoriteFilter): Int = when (filter) {
  FavoriteFilter.All -> R.string.favorites_empty_all_text
  FavoriteFilter.Movies -> R.string.favorites_empty_movies_text
  FavoriteFilter.Series -> R.string.favorites_empty_series_text
}

@Composable
private fun FavoritesError(onRetry: () -> Unit) {
  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    FocusButton(stringResource(R.string.tv_try_again), onClick = onRetry, kind = FocusButtonKind.Primary)
  }
}
