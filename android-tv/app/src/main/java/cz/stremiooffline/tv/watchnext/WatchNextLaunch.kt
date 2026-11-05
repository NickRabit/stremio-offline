package cz.stremiooffline.tv.watchnext

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

object WatchNextLaunch {
  var pendingKey: String? by mutableStateOf(null)
}
