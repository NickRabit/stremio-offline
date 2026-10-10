package cz.stremiooffline.tv

import org.junit.Assert.assertEquals
import org.junit.Test

class VersionCodeTest {

  @Test
  fun `the code grows with the shared version`() {
    assertEquals(5_036, Versions.code("0.5.36"))
    assertEquals(1_002_003, Versions.code("1.2.3"))
  }
}
