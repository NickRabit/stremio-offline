package cz.stremiooffline.tv.ui.shell

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * Which section the shell treats as current. Picking a section on the rail updates this at once,
 * so the rail focuses the right item even on the first frames. It is the shell's only navigation
 * state; a route, where one is given, wins.
 */
class ShellState(start: Section) {
  var selected: Section by mutableStateOf(start)
    private set

  fun pick(section: Section) {
    selected = section
  }

  fun current(route: String?): Section =
    Section.entries.firstOrNull { it.route == route } ?: selected
}
