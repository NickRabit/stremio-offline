package cz.stremiooffline.tv.data

import cz.stremiooffline.tv.ui.library.posterMosaicUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BrowseMosaicTest {

  private fun items(json: String) = browseItems(
    BrowseJson.decodeFromString(BrowsePage.serializer(), json.trimIndent()),
  )

  @Test
  fun `a library and a folder decode the composed mosaic`() {
    val items = items(
      """
      {
        "path": "",
        "total": 2,
        "pending": false,
        "items": [
          {"kind": "library", "path": "lib_1", "name": "Films", "mosaic": "/api/library/mosaic?dir=Films&v=1"},
          {"kind": "folder", "path": "Films/It", "name": "It", "mosaic": "/api/library/mosaic?dir=Films%2FIt&v=1"}
        ]
      }
      """,
    )

    assertEquals("/api/library/mosaic?dir=Films&v=1", items[0].mosaicImage)
    assertEquals("/api/library/mosaic?dir=Films%2FIt&v=1", items[1].mosaicImage)
  }

  @Test
  fun `an item without a composed mosaic decodes null`() {
    val items = items(
      """
      {
        "path": "",
        "total": 2,
        "pending": false,
        "items": [
          {"kind": "library", "path": "lib_1", "name": "Films"},
          {"kind": "folder", "path": "Films/It", "name": "It", "posters": ["/a.jpg", "/b.jpg"]}
        ]
      }
      """,
    )

    assertNull(items[0].mosaicImage)
    assertNull(items[1].mosaicImage)
  }

  @Test
  fun `posterMosaicUrl adds the shape when it is missing`() {
    assertEquals(
      "/api/library/mosaic?dir=Films&v=stamp&shape=poster",
      posterMosaicUrl("/api/library/mosaic?dir=Films&v=stamp"),
    )
    assertEquals("/api/library/mosaic?shape=poster", posterMosaicUrl("/api/library/mosaic"))
  }

  @Test
  fun `posterMosaicUrl replaces a shape and keeps the other parameters`() {
    assertEquals(
      "/api/library/mosaic?dir=Films&shape=poster&v=stamp",
      posterMosaicUrl("/api/library/mosaic?dir=Films&shape=wide&v=stamp"),
    )
    assertEquals("/api/library/mosaic?shape=poster", posterMosaicUrl("/api/library/mosaic?shape=wide"))
  }
}
