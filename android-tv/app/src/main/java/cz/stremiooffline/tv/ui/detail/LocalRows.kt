package cz.stremiooffline.tv.ui.detail

import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.StreamDto

/** Whether the files belong to a series rather than to the versions of one film. */
internal fun isEpisodeDetail(detail: DetailData): Boolean =
  detail.files.any { it.season != null || it.episode != null }

/**
 * The rows a local title contributes to the Sources panel: every file of a film, ordered largest
 * reported size first, or every copy of the one episode the panel was opened on.
 */
internal fun ownFileRows(detail: DetailData, file: BrowseItem.File?): List<StreamDto> {
  if (file == null) return emptyList()
  val files = (if (isEpisodeDetail(detail)) copiesOf(detail.files, file) else detail.files)
    .sortedByDescending { it.size }
  return files.map(::libraryFileRow)
}

private fun episodeKey(file: BrowseItem.File): String =
  if (file.season != null && file.episode != null) "${file.season}:${file.episode}" else file.path

private fun copiesOf(files: List<BrowseItem.File>, file: BrowseItem.File): List<BrowseItem.File> {
  val key = episodeKey(file)
  return files.filter { episodeKey(it) == key }
}
