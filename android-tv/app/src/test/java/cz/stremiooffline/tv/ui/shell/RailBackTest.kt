package cz.stremiooffline.tv.ui.shell

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The Back rule of the shell. Robolectric does not deliver `Key.Back` to a Compose `BackHandler`,
 * so the decision itself (focus the rail, arm leaving, leave) is a pure function and tested here,
 * while the focus moves the handler performs are covered by [ShellTest].
 */
class RailBackTest {

  @Test
  fun `back with the rail unfocused focuses the rail`() {
    assertEquals(RailBackAction.FocusRail, railBackAction(railFocused = false, exitArmed = false))
  }

  @Test
  fun `back on the rail arms leaving the first time and leaves the second`() {
    assertEquals(RailBackAction.ArmExit, railBackAction(railFocused = true, exitArmed = false))
    assertEquals(RailBackAction.Exit, railBackAction(railFocused = true, exitArmed = true))
  }

  @Test
  fun `one back on the rail does not leave`() {
    val state = RailBackState()
    assertEquals(RailBackAction.FocusRail, state.onBack(railFocused = false))
    assertEquals(RailBackAction.ArmExit, state.onBack(railFocused = true))
  }

  @Test
  fun `the second back within the window leaves`() {
    val state = RailBackState()
    state.onBack(railFocused = false)
    state.onBack(railFocused = true)
    assertEquals(RailBackAction.Exit, state.onBack(railFocused = true))
  }

  @Test
  fun `an expired window arms leaving again instead of leaving`() {
    val state = RailBackState()
    state.onBack(railFocused = false)
    state.onBack(railFocused = true)
    state.disarm()
    assertEquals(RailBackAction.ArmExit, state.onBack(railFocused = true))
  }
}
