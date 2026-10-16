package cz.stremiooffline.tv.ui.catalog

import cz.stremiooffline.tv.data.RemoteItemContext
import cz.stremiooffline.tv.data.StreamDto
import org.junit.Assert.assertEquals
import org.junit.Test

/** The play one row of a Sources panel starts: a media-server version of a title the catalogue can
 *  name is watched under that title, and a version nothing can name under its own item. */
class NativeRowTargetTest {

  private fun remote(sourceId: String, libraryId: String = "rlibA", itemId: String = "iA") = StreamDto(
    sourceId = sourceId,
    kind = "remote",
    playable = true,
    name = "Version $sourceId",
    remoteItem = RemoteItemContext(libraryId = libraryId, itemId = itemId, mediaSourceId = sourceId, progressKey = "remote:$libraryId:$itemId"),
  )

  @Test
  fun `a media-server row of a nameable title plays the title's own key`() {
    val target = nativeRowTarget(remote("ms1"), "Heat", "movie" to "tt1", listOf(remote("ms1")), null)

    assertEquals("movie:tt1", target?.key)
    assertEquals("rlibA", target?.remoteItem?.libraryId)
    assertEquals("ms1", target?.sourceId)
  }

  @Test
  fun `a media-server row nothing can name keeps the item's own key`() {
    val target = nativeRowTarget(remote("ms1"), "A file", null, listOf(remote("ms1")), null)

    assertEquals("remote:rlibA:iA", target?.key)
  }
}
