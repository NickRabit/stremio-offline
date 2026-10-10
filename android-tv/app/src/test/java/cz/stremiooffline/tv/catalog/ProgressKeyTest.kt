package cz.stremiooffline.tv.catalog

import org.junit.Assert.assertEquals
import org.junit.Test

class ProgressKeyTest {

  @Test
  fun `a movie keys on its meta id`() {
    assertEquals("movie:tt1", ProgressKey.of("movie", "tt1"))
  }

  @Test
  fun `an episode keys on its video id`() {
    assertEquals("series:tt1:1:2", ProgressKey.of("series", "tt1", "tt1:1:2"))
  }
}
