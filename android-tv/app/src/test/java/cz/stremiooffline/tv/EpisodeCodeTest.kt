package cz.stremiooffline.tv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The one episode label the library detail, the catalogue cards and Home all read. */
class EpisodeCodeTest {

  @Test
  fun `a season and an episode become S1 dot E2`() {
    assertEquals("S1 · E2", episodeCode(1, 2))
    assertEquals("S12 · E4", episodeCode(12, 4))
  }

  @Test
  fun `a missing number reads as nothing`() {
    assertNull(episodeCode(null, 2))
    assertNull(episodeCode(1, null))
    assertNull(episodeCode(null, null))
  }
}
