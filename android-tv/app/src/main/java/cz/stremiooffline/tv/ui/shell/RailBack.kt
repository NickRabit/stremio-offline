package cz.stremiooffline.tv.ui.shell

/** What one Back press does in the shell. */
enum class RailBackAction { FocusRail, ArmExit, Exit }

/** The shell's Back rule, free of Android types so a test can drive it: with the rail unfocused
 *  Back moves focus there; on the rail the first press arms leaving and the second leaves. */
fun railBackAction(railFocused: Boolean, exitArmed: Boolean): RailBackAction = when {
  !railFocused -> RailBackAction.FocusRail
  exitArmed -> RailBackAction.Exit
  else -> RailBackAction.ArmExit
}

/** The armed-for-exit flag with the two-second window, kept behind a decision function. */
class RailBackState {
  private var armed = false

  fun onBack(railFocused: Boolean): RailBackAction {
    val action = railBackAction(railFocused, armed)
    armed = action == RailBackAction.ArmExit
    return action
  }

  fun disarm() {
    armed = false
  }
}
