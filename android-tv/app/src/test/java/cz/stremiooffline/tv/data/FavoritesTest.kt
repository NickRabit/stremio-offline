package cz.stremiooffline.tv.data

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FavoritesTest {

  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun `both kinds decode and an unknown kind is dropped`() {
    val page = json.decodeFromString<FavoritesPageDto>(
      """{"items":[{"kind":"library","path":"lib_1/It.mkv","label":"It","itemKind":"file"},""" +
        """{"kind":"catalog","type":"series","id":"tt2","name":"Show","poster":"/api/image/x"},""" +
        """{"kind":"mystery","path":"x"}],"total":3,"pending":false}"""
    )

    val items = favoriteItems(page)
    assertEquals(2, items.size)
    assertEquals("library:lib_1/It.mkv", items[0].key)
    val catalog = items[1] as FavoriteItemDto.Catalog
    assertEquals("series", catalog.type)
    assertEquals("tt2", catalog.id)
    assertEquals("catalog:series:tt2", catalog.key)
    assertTrue(page.pending.not())
  }
}
