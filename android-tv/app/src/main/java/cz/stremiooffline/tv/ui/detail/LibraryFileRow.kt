package cz.stremiooffline.tv.ui.detail

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.LibraryTitleDto
import cz.stremiooffline.tv.data.StreamDto
import cz.stremiooffline.tv.data.TvApi
import kotlin.coroutines.cancellation.CancellationException

/**
 * The server's own listing of [file] as a copy of the title it is bound to: the row the catalogue
 * detail shows for it, with the library's name and what was read from the file (resolution,
 * codec, audio and subtitle languages). Null for an unbound file or while nothing has answered,
 * which keeps the detail on the bare file row. When [extras] reads the binding of this same file
 * ([extrasPath]) its answer is awaited and reused instead of asked again.
 */
@Composable
internal fun rememberLibraryFileRow(
  api: TvApi?,
  file: BrowseItem.File?,
  extras: TitleExtrasState,
  extrasPath: String?,
): StreamDto? {
  val path = file?.path
  var row by remember(path) { mutableStateOf<StreamDto?>(null) }
  val shared = path != null && extras.hasLibraryTitle(path)
  LaunchedEffect(api, path, shared) {
    if (api == null || path.isNullOrBlank()) return@LaunchedEffect
    if (path == extrasPath && !shared) return@LaunchedEffect
    val binding = if (shared) extras.cachedLibraryTitle(path) else quiet { api.libraryTitle(path) }
    row = binding?.let { listedCopy(api, it, path) } ?: row
  }
  return row?.let { listed ->
    if (listed.behaviorHints?.videoSize != null || file == null || file.size <= 0) listed
    else listed.copy(behaviorHints = listed.behaviorHints?.copy(videoSize = file.size))
  }
}

private suspend fun listedCopy(api: TvApi, binding: LibraryTitleDto, path: String): StreamDto? {
  if (binding.type.isBlank() || binding.id.isBlank()) return null
  val id = binding.videoId?.takeIf { it.isNotBlank() } ?: binding.id
  return quiet { api.localStreams(binding.type, id) }?.firstOrNull { it.localPath == path }
}

private suspend fun <T> quiet(call: suspend () -> T): T? = try {
  call()
} catch (cancelled: CancellationException) {
  throw cancelled
} catch (_: Exception) {
  null
}
