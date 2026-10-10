package cz.stremiooffline.tv.ui.library

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
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
import androidx.compose.foundation.focusGroup
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.tv.material3.Text
import cz.stremiooffline.tv.R
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.TvApi
import cz.stremiooffline.tv.ui.components.FocusButton
import cz.stremiooffline.tv.ui.components.FocusButtonKind
import cz.stremiooffline.tv.ui.components.PosterCard
import cz.stremiooffline.tv.ui.components.ShimmerCards
import cz.stremiooffline.tv.ui.detail.DetailData
import cz.stremiooffline.tv.ui.detail.episodeLabel
import cz.stremiooffline.tv.ui.theme.Tokens
import kotlinx.coroutines.launch

@Composable
fun LibraryRoute(
  api: TvApi,
  onOpenDetail: (DetailData) -> Unit,
  modifier: Modifier = Modifier,
  restoreToken: Int = 0,
  pendingDelayMs: Long = 1_500L,
) {
  val viewModel = viewModel<LibraryViewModel>(factory = LibraryViewModel.factory(api, pendingDelayMs))
  LaunchedEffect(Unit) { if (viewModel.state.pages.isEmpty()) viewModel.start() }

  val state = viewModel.state
  val scope = rememberCoroutineScope()
  var selectedPath by rememberSaveable { mutableStateOf("") }
  val requesters = remember { mutableMapOf<String, FocusRequester>() }
  val gridFocus = remember { FocusRequester() }
  val fallbackTitle = stringResource(R.string.tv_library_title)

  // Bumped whenever Back pops a level, so the return restores the card that opened that level.
  var backToken by remember { mutableIntStateOf(0) }
  var restoreKey by remember { mutableStateOf("") }
  // The card that opened each nested page, in page-stack order, so Back can focus it again.
  val openedBy = remember { mutableListOf<String>() }

  BackHandler(enabled = state.pages.size > 1) {
    restoreKey = openedBy.removeLastOrNull() ?: ""
    if (viewModel.back()) backToken++
  }

  // A new page focuses its own first card; a return restores the card that opened the page.
  LaunchedEffect(state.loading, state.pages.size, state.current?.items?.size, restoreToken, backToken) {
    if (!state.loading && !state.current?.items.isNullOrEmpty()) {
      val items = state.current!!.items
      val target = restoreKey.takeIf { key -> key.isNotEmpty() && items.any { it.path.ifEmpty { it.title } == key } }
      restoreKey = ""
      val requester = target?.let { requesters[it] } ?: gridFocus
      runCatching { requester.requestFocus() }
    }
  }

  fun openFolder(folder: BrowseItem.Folder) {
    openedBy.add(folder.path.ifEmpty { folder.title })
    restoreKey = ""
    scope.launch {
      val result = runCatching { api.browse(folder.path, limit = LibraryViewModel.PAGE, skip = 0) }.getOrNull()
      if (result == null) {
        viewModel.open(folder.path, folder.title)
        return@launch
      }
      val files = result.items.filterIsInstance<BrowseItem.File>()
      if (files.isNotEmpty() && files.size == result.items.size) {
        onOpenDetail(DetailData.ofFolder(folder, files))
      } else {
        viewModel.push(result.path.ifEmpty { folder.path }, folder.title, result.items, result.total)
      }
    }
  }

  Column(
    modifier = modifier.fillMaxSize().padding(start = Tokens.SafeX, top = Tokens.SafeY, end = Tokens.SafeX),
    verticalArrangement = Arrangement.spacedBy(9.dp),
  ) {
    Text(
      stringResource(R.string.nav_library).uppercase(),
      color = Tokens.Accent,
      fontSize = 10.sp,
      fontWeight = FontWeight.Bold,
      letterSpacing = 1.8.sp,
    )
    Text(
      stringResource(R.string.tv_library_title),
      color = Tokens.Text,
      fontSize = 26.sp,
      fontWeight = FontWeight.ExtraBold,
      letterSpacing = (-0.8).sp,
    )
    if (state.pages.size > 1) {
      Text(
        state.pages.joinToString("  ›  ") { it.title.ifEmpty { fallbackTitle } },
        color = Tokens.Muted,
        fontSize = 10.sp,
        fontWeight = FontWeight.Medium,
      )
    }

    Box(Modifier.weight(1f).fillMaxWidth()) {
      when {
        state.loading -> ShimmerCards()
        state.error -> ErrorPanel { viewModel.retry() }
        state.current?.items.isNullOrEmpty() -> Text(
          stringResource(R.string.tv_library_empty),
          color = Tokens.Muted,
          fontSize = 12.sp,
        )
        else -> {
          val items = state.current!!.items
          BoxWithConstraints(Modifier.fillMaxSize()) {
            val columns = (((maxWidth.value + 18f) / 128f).toInt()).coerceAtLeast(1)
            LazyVerticalGrid(
              columns = GridCells.Fixed(columns),
              modifier = Modifier.focusRequester(gridFocus).focusGroup(),
              // Room for the focused card's scale and ring so the first row is not clipped.
              contentPadding = PaddingValues(start = 10.dp, top = 10.dp, bottom = 40.dp),
              horizontalArrangement = Arrangement.spacedBy(18.dp),
              verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
              itemsIndexed(items, key = { _, item -> item.path.ifEmpty { item.title } }) { index, item ->
                val key = item.path.ifEmpty { item.title }
                val requester = remember(key) { FocusRequester() }
                requesters[key] = requester
                PosterCard(
                  name = item.title,
                  imageUrl = (item.poster ?: item.wide)?.let(api::url),
                  progress = progressFraction(item),
                  caption = caption(item),
                  cardTag = item.path.ifEmpty { item.title },
                  onClick = {
                    when (item) {
                      is BrowseItem.Library -> viewModel.open(item.path, item.title)
                      is BrowseItem.Folder -> openFolder(item)
                      is BrowseItem.File -> onOpenDetail(DetailData.ofFile(item))
                    }
                  },
                  modifier = Modifier
                    .focusRequester(requester)
                    .onFocusChanged {
                      if (it.isFocused) {
                        selectedPath = key
                        requesters[key] = requester
                        if (index >= items.size - columns) viewModel.loadMore()
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

@Composable
private fun ErrorPanel(onRetry: () -> Unit) {
  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    Column(verticalArrangement = Arrangement.spacedBy(11.dp), horizontalAlignment = Alignment.CenterHorizontally) {
      Text(stringResource(R.string.tv_load_error), color = Tokens.Muted, fontSize = 12.sp)
      FocusButton(stringResource(R.string.tv_try_again), onClick = onRetry, kind = FocusButtonKind.Primary)
    }
  }
}

@Composable
private fun caption(item: BrowseItem): String =
  when (item) {
    is BrowseItem.Library -> stringResource(R.string.tv_library_files, item.fileCount.toString())
    is BrowseItem.Folder -> listOfNotNull(
      item.year?.takeIf { it.isNotBlank() },
      stringResource(R.string.tv_library_files, item.fileCount.toString()),
    ).joinToString(" · ")
    is BrowseItem.File -> item.year?.takeIf { it.isNotBlank() } ?: episodeLabel(item)
  }

private fun progressFraction(item: BrowseItem): Float? {
  val file = item as? BrowseItem.File ?: return null
  val duration = file.progress?.duration ?: 0.0
  val position = file.progress?.position ?: 0.0
  if (duration <= 0 || position <= 0) return null
  return (position / duration).toFloat()
}
