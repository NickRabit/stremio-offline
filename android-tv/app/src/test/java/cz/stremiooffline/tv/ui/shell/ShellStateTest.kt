package cz.stremiooffline.tv.ui.shell

import org.junit.Assert.assertEquals
import org.junit.Test

/** The rail-race fix: the shell reports the section the user actually picked, not the start one. */
class ShellStateTest {

  @Test
  fun `the start section is selected at first`() {
    assertEquals(Section.Library, ShellState(Section.Library).selected)
  }

  @Test
  fun `picking a section changes the selected one`() {
    val state = ShellState(Section.Catalog)
    state.pick(Section.Home)
    assertEquals(Section.Home, state.selected)
  }
}
