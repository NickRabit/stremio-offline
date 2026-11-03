package cz.stremiooffline.tv.ui.detail

import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.LibraryApi
import kotlinx.coroutines.CancellationException

/**
 * Every video under a show's folder, its season folders included, read level by level the way the
 * library grid reads them. Null when a level could not be read, so the caller falls back to the
 * folder grid rather than draw half a show.
 */
internal suspend fun seriesFiles(api: LibraryApi, path: String, depth: Int = 0): List<BrowseItem.File>? {
  val found = ArrayList<BrowseItem.File>()
  var skip = 0
  while (true) {
    val page = try {
      api.browse(path, limit = SeriesPage, skip = skip)
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (_: ApiError) {
      return null
    }
    for (item in page.items) {
      when (item) {
        is BrowseItem.File -> found += item
        is BrowseItem.Folder -> if (depth < 3) found += seriesFiles(api, item.path, depth + 1) ?: return null
        else -> Unit
      }
    }
    skip += page.items.size
    if (page.items.isEmpty() || skip >= page.total || found.size >= 4000) break
  }
  return found
}

private const val SeriesPage = 120
