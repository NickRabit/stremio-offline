package cz.stremiooffline.tv.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BrowseItemTest {

  @Test
  fun `an item of an unknown kind is skipped instead of failing the page`() {
    val page = BrowseJson.decodeFromString(
      BrowsePage.serializer(),
      """
      {
        "path": "",
        "total": 4,
        "pending": false,
        "items": [
          {"kind": "folder", "path": "Films", "name": "Films", "fileCount": 3},
          {"kind": "file", "path": "Films/It.mkv", "label": "It", "season": null, "episode": null, "size": 100,
           "progress": {"position": 10, "duration": 100}},
          {"kind": "library", "path": "lib_1", "name": "Films", "fileCount": 3},
          {"kind": "mystery", "path": "x"}
        ]
      }
      """.trimIndent(),
    )

    val items = browseItems(page)

    assertEquals(3, items.size)
    assertTrue(items[0] is BrowseItem.Folder)
    assertTrue(items[1] is BrowseItem.File)
    assertTrue(items[2] is BrowseItem.Library)
    assertEquals(10.0, (items[1] as BrowseItem.File).progress!!.position, 0.0)
  }
}
