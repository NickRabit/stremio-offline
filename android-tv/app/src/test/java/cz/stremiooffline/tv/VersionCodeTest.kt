package cz.stremiooffline.tv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VersionCodeTest {

  @Test
  fun `the code grows with the shared version`() {
    assertEquals(5_036, Versions.code("0.5.36"))
    assertEquals(1_002_003, Versions.code("1.2.3"))
  }

  /** The value Obtainium compares, so it must only ever grow: 0.5.36 < 0.5.37 < 0.6.0 < 1.0.0. */
  @Test
  fun `the version code only grows`() {
    val codes = listOf("0.5.36", "0.5.37", "0.6.0", "1.0.0").map(Versions::code)
    assertEquals(5_036, codes.first())
    for (index in 1 until codes.size) {
      assertTrue("${codes[index - 1]} < ${codes[index]}", codes[index - 1] < codes[index])
    }
  }

  @Test
  fun `only a major or minor difference is a version mismatch`() {
    assertFalse(Versions.differsInMinor("0.5.36", "0.5.37"))
    assertFalse(Versions.differsInMinor("0.5.36", "0.5.36"))
    assertTrue(Versions.differsInMinor("0.5.36", "0.6.0"))
    assertTrue(Versions.differsInMinor("1.0.0", "0.5.36"))
    assertFalse(Versions.differsInMinor(null, "0.5.36"))
    assertFalse(Versions.differsInMinor("0.5.36", null))
  }
}
