package cz.stremiooffline.tv.ui.catalog

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.CatalogDto
import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.components.ShimmerCards
import cz.stremiooffline.tv.ui.theme.Tokens

const val TagCatalogSearchChip = "catalog_chip_search"
const val TagCatalogChip = "catalog_chip_catalog"
const val TagCatalogGenreChip = "catalog_chip_genre"
const val TagCatalogRetry = "catalog_retry"
const val TagCatalogPanel = "catalog_panel"

fun catalogOptionTag(index: Int): String = "catalog_option_$index"
fun genreOptionTag(index: Int): String = "genre_option_$index"
const val TagGenreAll = "genre_option_all"

/** Everything the detail needs to open one catalogue title. */
/** [episode] is set when Home opens a remembered episode, so the detail focuses it. */
data class CatalogDetailArgs(
  val meta: MetaDto,
  val addonName: String,
  val type: String,
  val episode: cz.stremiooffline.tv.catalog.ResumeEpisode? = null,
)

private enum class CatalogPanel { Catalogs, Genres }

@Composable
fun CatalogScreen(
  api: TvApi,
  onOpenDetail: (CatalogDetailArgs) -> Unit,
  onOpenSearch: () -> Unit,
  imageUrl: (String?) -> String?,
  modifier: Modifier = Modifier,
  restoreToken: Int = 0,
) {
  val viewModel = viewModel<CatalogViewModel>(factory = CatalogViewModel.factory(api))
  LaunchedEffect(Unit) { viewModel.start() }
  val state = viewModel.state

  val searchFocus = remember { FocusRequester() }
  val catalogFocus = remember { FocusRequester() }
  val genreFocus = remember { FocusRequester() }
  val gridFocus = remember { FocusRequester() }

  var panel by remember { mutableStateOf<CatalogPanel?>(null) }
  var panelOpener by remember { mutableStateOf<FocusRequester?>(null) }
  var firstFocusDone by remember { mutableStateOf(false) }

  // Back to the chip that opened the panel, on the frame the panel and its focus trap are gone.
  fun closePanel() {
    panel = null
  }
  LaunchedEffect(panel) {
    if (panel == null) runCatching { panelOpener?.requestFocus() }
  }

  // The first control takes focus on entry; a return from detail or the player goes to the grid.
  LaunchedEffect(state.loading, state.catalogs.size) {
    if (!firstFocusDone && !state.loading) {
      firstFocusDone = true
      runCatching { (if (state.catalogs.isEmpty()) searchFocus else catalogFocus).requestFocus() }
    }
  }
  LaunchedEffect(restoreToken) {
    if (restoreToken > 0 && state.items.isNotEmpty()) runCatching { gridFocus.requestFocus() }
  }

  Box(modifier.fillMaxSize()) {
    Column(
      modifier = Modifier.fillMaxSize().padding(start = Tokens.SafeX, top = Tokens.SafeY, end = Tokens.SafeX),
      verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
      Text(
        stringResource(R.string.nav_catalog).uppercase(),
        color = Tokens.Accent,
        fontSize = 10.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 1.8.sp,
      )
      Text(
        stringResource(R.string.catalog_title),
        color = Tokens.Text,
        fontSize = 26.sp,
        fontWeight = FontWeight.ExtraBold,
        letterSpacing = (-0.8).sp,
      )
      Row(horizontalArrangement = Arrangement.spacedBy(9.dp), verticalAlignment = Alignment.CenterVertically) {
        FocusButton(
          text = stringResource(R.string.tv_nav_search),
          onClick = onOpenSearch,
          modifier = Modifier.focusRequester(searchFocus).testTag(TagCatalogSearchChip),
        )
        val catalog = state.current
        if (catalog != null) {
          FocusButton(
            text = catalogText(catalog),
            onClick = { panelOpener = catalogFocus; panel = CatalogPanel.Catalogs },
            modifier = Modifier.focusRequester(catalogFocus).testTag(TagCatalogChip),
          )
          if (state.genres.isNotEmpty()) {
            FocusButton(
              text = state.genre.ifEmpty { stringResource(R.string.catalog_all_genres) },
              onClick = { panelOpener = genreFocus; panel = CatalogPanel.Genres },
              modifier = Modifier.focusRequester(genreFocus).testTag(TagCatalogGenreChip),
            )
          }
        }
      }

      Box(Modifier.weight(1f).fillMaxWidth()) {
        when {
          state.loading -> ShimmerCards()
          state.error -> CatalogError(onRetry = { viewModel.retry() })
          else -> PosterGrid(
            items = state.items,
            imageUrl = imageUrl,
            onOpen = { item -> onOpenDetail(CatalogDetailArgs(item, state.current?.addonName.orEmpty(), item.type ?: state.current?.type ?: "movie")) },
            onNearEnd = { viewModel.loadMore() },
            gridFocus = gridFocus,
            modifier = Modifier.fillMaxSize(),
          )
        }
      }
    }

    when (panel) {
      CatalogPanel.Catalogs -> {
        val entry = remember { FocusRequester() }
        val focusIndex = state.catalogIndex.coerceIn(0, (state.catalogs.size - 1).coerceAtLeast(0))
        SidePanel(
          title = stringResource(R.string.nav_catalog),
          onClose = { closePanel() },
          modifier = Modifier.testTag(TagCatalogPanel),
          initialFocus = entry,
        ) {
          state.catalogs.forEachIndexed { index, catalog ->
            PanelOption(
              text = catalogText(catalog),
              selected = index == state.catalogIndex,
              onClick = { viewModel.select(index); closePanel() },
              modifier = Modifier
                .testTag(catalogOptionTag(index))
                .then(if (index == focusIndex) Modifier.focusRequester(entry) else Modifier),
            )
          }
        }
      }

      CatalogPanel.Genres -> {
        val entry = remember { FocusRequester() }
        val focusIndex = state.genres.indexOf(state.genre)
        SidePanel(
          title = stringResource(R.string.catalog_genre),
          onClose = { closePanel() },
          modifier = Modifier.testTag(TagCatalogPanel),
          initialFocus = entry,
        ) {
          PanelOption(
            text = stringResource(R.string.catalog_all_genres),
            selected = state.genre.isEmpty(),
            onClick = { viewModel.setGenre(""); closePanel() },
            modifier = Modifier
              .testTag(TagGenreAll)
              .then(if (focusIndex < 0) Modifier.focusRequester(entry) else Modifier),
          )
          state.genres.forEachIndexed { index, genre ->
            PanelOption(
              text = genre,
              selected = genre == state.genre,
              onClick = { viewModel.setGenre(genre); closePanel() },
              modifier = Modifier
                .testTag(genreOptionTag(index))
                .then(if (index == focusIndex) Modifier.focusRequester(entry) else Modifier),
            )
          }
        }
      }

      null -> Unit
    }
  }
}

@Composable
private fun CatalogError(onRetry: () -> Unit) {
  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    Column(verticalArrangement = Arrangement.spacedBy(11.dp), horizontalAlignment = Alignment.CenterHorizontally) {
      Text(stringResource(R.string.tv_load_error), color = Tokens.Muted, fontSize = 12.sp)
      FocusButton(
        text = stringResource(R.string.tv_try_again),
        onClick = onRetry,
        kind = FocusButtonKind.Primary,
        modifier = Modifier.testTag(TagCatalogRetry),
      )
    }
  }
}

/** The web's catalogue label with its type, so Cinemeta's twin "Popular" lists tell films from series. */
@Composable
internal fun catalogText(catalog: CatalogDto): String = when (catalog.type) {
  "movie" -> "${catalog.label} (${stringResource(R.string.catalog_type_movie)})"
  "series" -> "${catalog.label} (${stringResource(R.string.catalog_type_series)})"
  else -> catalog.label
}
