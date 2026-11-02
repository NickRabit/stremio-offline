package cz.stremiooffline.tv.ui.detail

import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.BrowseResult
import cz.stremiooffline.tv.data.LibraryApi
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class LocalSeriesDetailTest {

  private fun episode(season: Int, number: Int) = BrowseItem.File(
    path = "Shows/Show/0$season serie/Show - S0${season}E0$number.mkv",
    label = "Show - S0${season}E0$number",
    season = season,
    episode = number,
  )

  @Test
  fun `a show's files are read through its season folders`() = runBlocking {
    val first = episode(1, 1)
    val second = episode(1, 2)
    val tree = mapOf(
      "Shows/Show" to listOf<BrowseItem>(BrowseItem.Folder(path = "Shows/Show/01 serie", titleType = "series")),
      "Shows/Show/01 serie" to listOf<BrowseItem>(first, second),
    )
    val api = object : LibraryApi {
      override suspend fun browse(path: String?, limit: Int, skip: Int, query: String): BrowseResult {
        val items = tree[path].orEmpty()
        return BrowseResult(path.orEmpty(), items.drop(skip).take(limit), items.size, false)
      }
    }
    assertEquals(listOf(first.path, second.path), seriesFiles(api, "Shows/Show")?.map { it.path })
  }
}
