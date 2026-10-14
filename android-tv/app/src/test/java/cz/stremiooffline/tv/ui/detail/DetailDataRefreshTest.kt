package cz.stremiooffline.tv.ui.detail

import cz.stremiooffline.tv.data.ApiError
import cz.stremiooffline.tv.data.ApiFailure
import cz.stremiooffline.tv.data.BrowseItem
import cz.stremiooffline.tv.data.ProgressDto
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test

/** Re-reading one file's position must tell an empty answer from a failed one. */
class DetailDataRefreshTest {

  private fun file(path: String, progress: ProgressDto?) =
    BrowseItem.File(path = path, label = path.substringAfterLast('/'), progress = progress)

  private fun detail(vararg files: BrowseItem.File) = DetailData(
    gridPath = "Films/It",
    title = "It",
    year = null,
    description = null,
    poster = null,
    wide = null,
    size = 0.0,
    fileCount = files.size,
    files = files.toList(),
  )

  @Test
  fun `a successful null clears the stored position`() = runBlocking {
    val before = detail(file("Films/It/It.mkv", ProgressDto(38.6, 120.0)))

    val refreshed = before.refresh { null }

    assertNull(refreshed.files.single().progress)
  }

  @Test
  fun `a failed read keeps the stored position`() = runBlocking {
    val before = detail(file("Films/It/It.mkv", ProgressDto(38.6, 120.0)))

    val refreshed = before.refresh { throw ApiError(ApiFailure.Generic) }

    assertEquals(ProgressDto(38.6, 120.0), refreshed.files.single().progress)
  }

  @Test
  fun `a cancellation is not swallowed`() {
    val before = detail(file("Films/It/It.mkv", ProgressDto(38.6, 120.0)))

    try {
      runBlocking { before.refresh { _ -> throw CancellationException("gone") } }
      fail("the cancellation must travel out of refresh")
    } catch (expected: CancellationException) {
    }
  }
}
