package cz.stremiooffline.tv.ui.search

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import cz.stremiooffline.tv.data.GlobalSearchApi
import cz.stremiooffline.tv.data.GlobalSearchLibraryDto

@Composable
internal fun rememberScopedGlobalSearch(
  api: GlobalSearchApi,
  library: GlobalSearchLibraryDto?,
  sources: Set<SourceClass>,
  active: Boolean,
  query: String,
  polling: Boolean = true,
): GlobalSearchViewModel {
  val key = "${library?.libraryId.orEmpty()}|${library?.path.orEmpty()}|${library?.parentId.orEmpty()}|" +
    sources.sortedBy { it.ordinal }.joinToString(",") { it.wire }
  val viewModel = remember(key) {
    GlobalSearchViewModel(api, library = library, sources = sources)
  }
  LaunchedEffect(viewModel, active, query) {
    if (!active) {
      viewModel.setActive(false)
      viewModel.leave()
      return@LaunchedEffect
    }
    viewModel.setActive(polling)
    viewModel.submit(query)
  }
  LaunchedEffect(viewModel, active, polling) {
    if (active) viewModel.setActive(polling)
  }
  DisposableEffect(viewModel) {
    onDispose {
      viewModel.setActive(false)
      viewModel.leave()
    }
  }
  return viewModel
}
