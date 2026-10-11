package cz.stremiooffline.tv.ui.shell

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.setValue

/**
 * Which section the shell treats as current. Picking a section on the rail updates this at once,
 * so the rail focuses the right item even on the first frames. It is the shell's only navigation
 * state.
 */
class ShellState(start: Section) {
  var selected: Section by mutableStateOf(start)
    private set

  fun pick(section: Section) {
    selected = section
  }
}

/** Saveable so an activity recreation -- the locale change a Settings pick makes -- comes back to
 *  the section the viewer was on instead of the account's start page. */
val ShellStateSaver: Saver<ShellState, String> = Saver(
  save = { it.selected.route },
  restore = { route -> ShellState(Section.entries.firstOrNull { it.route == route } ?: Section.Catalog) },
)
