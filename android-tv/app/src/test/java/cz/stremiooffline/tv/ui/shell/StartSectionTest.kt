package cz.stremiooffline.tv.ui.shell

import org.junit.Assert.assertEquals
import org.junit.Test

/** The account's Start page setting maps to the rail section the app opens on. */
class StartSectionTest {

  @Test
  fun `the start view picks the section`() {
    assertEquals(Section.Home, startSection("home"))
    assertEquals(Section.Library, startSection("library"))
    assertEquals(Section.Catalog, startSection("catalog"))
  }

  @Test
  fun `an unknown or missing start view falls back to Home`() {
    assertEquals(Section.Home, startSection(null))
    assertEquals(Section.Home, startSection(""))
    assertEquals(Section.Home, startSection("anything"))
    assertEquals(Section.Home, startSection("following"))
  }
}
