package cz.stremiooffline.tv.ui.shell

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The rail-race fix: before the navigation back stack resolves (route `null`), the shell must still
 * report the section the user is actually on, not the start section.
 */
class ShellStateTest {

  @Test
  fun `an unresolved route keeps the picked section`() {
    val state = ShellState(Section.Library)
    assertEquals(Section.Library, state.current(route = null))
  }

  @Test
  fun `picking a section changes what an unresolved route answers`() {
    val state = ShellState(Section.Catalog)
    state.pick(Section.Home)
    assertEquals(Section.Home, state.current(route = null))
  }

  @Test
  fun `a resolved route wins over the picked section`() {
    val state = ShellState(Section.Catalog)
    state.pick(Section.Home)
    assertEquals(Section.Library, state.current(route = Section.Library.route))
  }
}
