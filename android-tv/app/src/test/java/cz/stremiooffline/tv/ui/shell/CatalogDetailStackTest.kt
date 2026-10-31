package cz.stremiooffline.tv.ui.shell

import cz.stremiooffline.tv.data.MetaDto
import cz.stremiooffline.tv.data.RelatedTitleDto
import cz.stremiooffline.tv.ui.catalog.CatalogDetailArgs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CatalogDetailStackTest {

  private fun args(id: String) = CatalogDetailArgs(
    meta = MetaDto(id = id, type = "movie", name = id),
    addonName = "Cinemeta",
    type = "movie",
  )

  private fun related(id: String) = RelatedTitleDto(type = "movie", id = id, name = id)

  @Test
  fun `Back returns through two related titles and restores each card`() {
    val stack = CatalogDetailStack()
    val first = args("tt1")
    stack.pushRelated(first, related("tt2"))
    val second = stack.detailFor(related("tt2"), first)
    stack.pushRelated(second, related("tt3"))
    val third = stack.detailFor(related("tt3"), second)

    assertEquals("tt3", third.meta.id)
    val previous = stack.pop()
    assertEquals("tt2", previous?.meta?.id)
    assertEquals("tt3", previous?.focusRelatedId)
    val firstAgain = stack.pop()
    assertEquals("tt1", firstAgain?.meta?.id)
    assertEquals("tt2", firstAgain?.focusRelatedId)
    assertNull(stack.pop())
  }

  @Test
  fun `a person search clears the related history`() {
    val stack = CatalogDetailStack()
    stack.pushRelated(args("tt1"), related("tt2"))

    stack.clear()

    assertNull(stack.pop())
  }

  @Test
  fun `the related history keeps at most ten titles`() {
    val stack = CatalogDetailStack()
    var current = args("tt0")
    for (index in 1..12) {
      stack.pushRelated(current, related("tt$index"))
      current = stack.detailFor(related("tt$index"), current)
    }

    assertEquals(10, stack.entries.size)
    assertEquals("tt2", stack.entries.first().meta.id)
  }
}
